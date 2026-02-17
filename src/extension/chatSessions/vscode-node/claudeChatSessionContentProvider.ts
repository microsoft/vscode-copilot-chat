/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IGitService } from '../../../platform/git/common/gitService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { ClaudeFolderInfo } from '../../agents/claude/common/claudeFolderInfo';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { IClaudeSessionStateService } from '../../agents/claude/node/claudeSessionStateService';
import { IClaudeCodeSessionService } from '../../agents/claude/node/sessionParser/claudeCodeSessionService';
import { IClaudeCodeSessionInfo } from '../../agents/claude/node/sessionParser/claudeSessionSchema';
import { IClaudeSlashCommandService } from '../../agents/claude/vscode-node/claudeSlashCommandService';
import { FolderRepositoryMRUEntry, IFolderRepositoryManager } from '../common/folderRepositoryManager';
import { buildChatHistory } from './chatHistoryBuilder';

// Import the tool permission handlers
import '../../agents/claude/vscode-node/toolPermissionHandlers/index';

// Import the hooks to trigger self-registration
import '../../agents/claude/vscode-node/hooks/index';

// Import the MCP server contributors to trigger self-registration
import '../../agents/claude/vscode-node/mcpServers/index';

const PERMISSION_MODE_OPTION_ID = 'permissionMode';
const FOLDER_OPTION_ID = 'folder';
const MAX_MRU_ENTRIES = 10;

export class ClaudeChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;

	private readonly _onDidChangeChatSessionProviderOptions = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionProviderOptions = this._onDidChangeChatSessionProviderOptions.event;

	// Track option selections per session (in-memory, committed to session state service on request handling)
	private readonly _sessionPermissionModes = new Map<string, PermissionMode>();
	private readonly _sessionFolders = new Map<string, URI>();

	// Map untitled session IDs to their effective (persistent) session IDs
	private readonly _untitledToEffectiveSessionId = new Map<string, string>();
	private readonly _effectiveToUntitledSessionId = new Map<string, string>();

	private readonly _controller: ClaudeChatSessionItemController;

	/**
	 * Resolves the effective session ID for a given session ID.
	 * For untitled sessions, returns the mapped effective ID; otherwise returns the same ID.
	 */
	private _resolveEffectiveSessionId(sessionId: string): string {
		return this._untitledToEffectiveSessionId.get(sessionId) ?? sessionId;
	}

	constructor(
		private readonly claudeAgentManager: ClaudeAgentManager,
		@IClaudeCodeSessionService private readonly sessionService: IClaudeCodeSessionService,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IClaudeSlashCommandService private readonly slashCommandService: IClaudeSlashCommandService,
		@IFolderRepositoryManager private readonly folderRepositoryManager: IFolderRepositoryManager,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IGitService gitService: IGitService,
	) {
		super();
		this._controller = this._register(new ClaudeChatSessionItemController(sessionService, workspaceService, gitService));

		// Listen for configuration changes to update available options
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.ClaudeAgentAllowDangerouslySkipPermissions.fullyQualifiedId)) {
				this._onDidChangeChatSessionProviderOptions.fire();
			}
		}));

		// Listen for workspace folder changes to update folder options
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._onDidChangeChatSessionProviderOptions.fire();
		}));

		// Listen for state changes and notify UI only if value actually changed from local selection
		this._register(this.sessionStateService.onDidChangeSessionState(e => {
			const updates: { optionId: string; value: string }[] = [];

			if (e.permissionMode !== undefined && e.permissionMode !== this._sessionPermissionModes.get(e.sessionId)) {
				updates.push({ optionId: PERMISSION_MODE_OPTION_ID, value: e.permissionMode });
			}

			if (updates.length > 0) {
				const untitledId = this._effectiveToUntitledSessionId.get(e.sessionId);
				const resource = ClaudeSessionUri.forSessionId(untitledId ?? e.sessionId);
				this._onDidChangeChatSessionOptions.fire({ resource, updates });
			}
		}));
	}

	public override dispose(): void {
		this._sessionPermissionModes.clear();
		this._sessionFolders.clear();
		this._untitledToEffectiveSessionId.clear();
		this._effectiveToUntitledSessionId.clear();
		super.dispose();
	}

	/**
	 * Gets the permission mode for a session
	 */
	public getPermissionModeForSession(sessionId: string): PermissionMode {
		return this._sessionPermissionModes.get(sessionId) ?? this.sessionStateService.getPermissionModeForSession(sessionId);
	}

	/**
	 * Resolves the cwd and additionalDirectories for a session.
	 *
	 * - Single-root workspace: cwd is the one folder, no additionalDirectories
	 * - Multi-root workspace: cwd is the selected folder, additionalDirectories are the rest
	 * - Empty workspace: cwd is the selected MRU folder, no additionalDirectories
	 */
	public getFolderInfoForSession(sessionId: string): ClaudeFolderInfo {
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();

		if (workspaceFolders.length === 1) {
			return {
				cwd: workspaceFolders[0].fsPath,
				additionalDirectories: [],
			};
		}

		// Multi-root or empty workspace: use the selected folder
		const selectedFolder = this._sessionFolders.get(sessionId);

		if (workspaceFolders.length > 1) {
			const cwd = selectedFolder?.fsPath ?? workspaceFolders[0].fsPath;
			const additionalDirectories = workspaceFolders
				.map(f => f.fsPath)
				.filter(p => p !== cwd);
			return { cwd, additionalDirectories };
		}

		// Empty workspace
		if (selectedFolder) {
			return {
				cwd: selectedFolder.fsPath,
				additionalDirectories: [],
			};
		}

		// Fallback for empty workspace with no selection: try MRU
		const mru = this.folderRepositoryManager.getFolderMRU();
		if (mru.length > 0) {
			return {
				cwd: mru[0].folder.fsPath,
				additionalDirectories: [],
			};
		}

		// No folder available at all
		throw new Error('No folder available for Claude session. Open a folder or select one in the session options.');
	}

	// #region Folder Option Helpers

	private _isEmptyWorkspace(): boolean {
		return this.workspaceService.getWorkspaceFolders().length === 0;
	}

	private _getFolderOptionItems(): vscode.ChatSessionProviderOptionItem[] {
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();

		if (this._isEmptyWorkspace()) {
			const mruEntries = this.folderRepositoryManager.getFolderMRU();
			return mruToFolderOptionItems(mruEntries).slice(0, MAX_MRU_ENTRIES);
		}

		return workspaceFolders.map(folder => ({
			id: folder.fsPath,
			name: this.workspaceService.getWorkspaceFolderName(folder),
			icon: new vscode.ThemeIcon('folder'),
		}));
	}

	private _getDefaultFolderForSession(sessionId: string): URI | undefined {
		// Check in-memory selection first
		const selected = this._sessionFolders.get(sessionId);
		if (selected) {
			return selected;
		}

		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length > 0) {
			this._sessionFolders.set(sessionId, workspaceFolders[0]);
			return workspaceFolders[0];
		}

		// Empty workspace: try MRU
		const lastUsed = this.folderRepositoryManager.getLastUsedFolderIdInUntitledWorkspace();
		if (lastUsed) {
			const last = URI.file(lastUsed);
			this._sessionFolders.set(sessionId, last);
			return last;
		}

		const mru = this.folderRepositoryManager.getFolderMRU();
		if (mru.length > 0) {
			const last = mru[0].folder;
			this._sessionFolders.set(sessionId, last);
			return last;
		}

		return undefined;
	}

	// #endregion

	// #region Chat Participant Handler

	createHandler(): ChatExtendedRequestHandler {
		return async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> => {
			const { chatSessionContext } = context;
			if (!chatSessionContext) {
				/* Via @claude */
				// TODO: Think about how this should work
				stream.markdown(vscode.l10n.t("Start a new Claude Agent session"));
				stream.button({ command: `workbench.action.chat.openNewSessionEditor.${ClaudeSessionUri.claudeSessionType}`, title: vscode.l10n.t("Start Session") });
				return {};
			}

			// Try to handle as a slash command first
			const slashResult = await this.slashCommandService.tryHandleCommand(request.prompt, stream, token);
			if (slashResult.handled) {
				return slashResult.result ?? {};
			}

			const sessionId = ClaudeSessionUri.getId(chatSessionContext.chatSessionItem.resource);
			const yieldRequested = () => context.yieldRequested;

			// Resolve the effective session ID first, before lookups, so that
			// all property reads and writes use a consistent key.
			let effectiveSessionId: string;
			let isNewSession: boolean;
			if (chatSessionContext.isUntitled) {
				const existing = this._untitledToEffectiveSessionId.get(sessionId);
				if (existing) {
					effectiveSessionId = existing;
					isNewSession = false;
				} else {
					effectiveSessionId = generateUuid();
					isNewSession = true;
					this._untitledToEffectiveSessionId.set(sessionId, effectiveSessionId);
					this._effectiveToUntitledSessionId.set(effectiveSessionId, sessionId);

					// Transfer all session property selections from the untitled
					// session ID to the effective (persistent) session ID.
					this._transferSessionProperties(sessionId, effectiveSessionId);
				}
			} else {
				effectiveSessionId = sessionId;
				isNewSession = false;
			}

			const modelId = request.model.id;
			const permissionMode = this.getPermissionModeForSession(effectiveSessionId);
			const folderInfo = this.getFolderInfoForSession(effectiveSessionId);

			// Commit UI state to session state service before invoking agent manager
			this.sessionStateService.setModelIdForSession(effectiveSessionId, modelId);
			this.sessionStateService.setPermissionModeForSession(effectiveSessionId, permissionMode);
			this.sessionStateService.setFolderInfoForSession(effectiveSessionId, folderInfo);

			const prompt = request.prompt;
			this._controller.updateItemStatus(effectiveSessionId, vscode.ChatSessionStatus.InProgress, prompt);
			const result = await this.claudeAgentManager.handleRequest(effectiveSessionId, request, context, stream, token, isNewSession, yieldRequested);
			this._controller.updateItemStatus(effectiveSessionId, vscode.ChatSessionStatus.Completed, prompt);

			return result.errorDetails ? { errorDetails: result.errorDetails } : {};
		};
	}

	// #endregion

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		const permissionModeItems: vscode.ChatSessionProviderOptionItem[] = [
			{ id: 'default', name: l10n.t('Ask before edits') },
			{ id: 'acceptEdits', name: l10n.t('Edit automatically') },
			{ id: 'plan', name: l10n.t('Plan mode') },
		];

		// Add bypass permissions option if enabled via setting
		if (this.configurationService.getConfig(ConfigKey.ClaudeAgentAllowDangerouslySkipPermissions)) {
			permissionModeItems.push({ id: 'bypassPermissions', name: l10n.t('Bypass all permissions') });
		}

		const optionGroups: vscode.ChatSessionProviderOptions['optionGroups'] = [
			{
				id: PERMISSION_MODE_OPTION_ID,
				name: l10n.t('Permission Mode'),
				description: l10n.t('Pick Permission Mode'),
				items: permissionModeItems,
			},
		];

		// Add folder option based on workspace type:
		// - Single-root (1 folder): no folder option (implicit)
		// - Multi-root (2+ folders): show workspace folders
		// - Empty workspace (0 folders): show MRU folders + browse command
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length !== 1) {
			const folderItems = this._getFolderOptionItems();
			const folderGroup: vscode.ChatSessionProviderOptionGroup = {
				id: FOLDER_OPTION_ID,
				name: l10n.t('Folder'),
				description: l10n.t('Pick Folder'),
				items: folderItems,
			};
			optionGroups.unshift(folderGroup);
		}

		return { optionGroups };
	}

	async provideHandleOptionsChange(resource: vscode.Uri, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, _token: vscode.CancellationToken): Promise<void> {
		const sessionId = this._resolveEffectiveSessionId(ClaudeSessionUri.getId(resource));
		for (const update of updates) {
			if (update.optionId === PERMISSION_MODE_OPTION_ID) {
				if (!update.value) {
					continue;
				}
				// Store locally; committed to session state service when handling the next request
				this._sessionPermissionModes.set(sessionId, update.value as PermissionMode);
			} else if (update.optionId === FOLDER_OPTION_ID && typeof update.value === 'string') {
				this._sessionFolders.set(sessionId, URI.file(update.value));
			}
		}
	}

	async provideChatSessionContent(sessionResource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const sessionId = this._resolveEffectiveSessionId(ClaudeSessionUri.getId(sessionResource));
		const existingSession = await this.sessionService.getSession(sessionResource, token);
		const history = existingSession ?
			buildChatHistory(existingSession) :
			[];

		const permissionMode = this.getPermissionModeForSession(sessionId);

		const options: Record<string, string | vscode.ChatSessionProviderOptionItem> = {};
		options[PERMISSION_MODE_OPTION_ID] = permissionMode;

		// Include folder option if applicable (multi-root or empty workspace)
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length !== 1) {
			const defaultFolder = this._getDefaultFolderForSession(sessionId);
			if (defaultFolder) {
				// For existing sessions (non-untitled), lock the folder option
				if (existingSession) {
					options[FOLDER_OPTION_ID] = {
						id: defaultFolder.fsPath,
						name: this.workspaceService.getWorkspaceFolderName(defaultFolder)
							|| basename(defaultFolder),
						icon: new vscode.ThemeIcon('folder'),
						locked: true,
					};
				} else {
					options[FOLDER_OPTION_ID] = defaultFolder.fsPath;
				}
			}
		}

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options,
		};
	}

	/**
	 * Transfers all in-memory session property selections (permission mode,
	 * folder) from one session ID to another and removes the old entries.
	 */
	private _transferSessionProperties(fromSessionId: string, toSessionId: string): void {
		const permissionMode = this._sessionPermissionModes.get(fromSessionId);
		if (permissionMode) {
			this._sessionPermissionModes.set(toSessionId, permissionMode);
			this._sessionPermissionModes.delete(fromSessionId);
		}

		const folder = this._sessionFolders.get(fromSessionId);
		if (folder) {
			this._sessionFolders.set(toSessionId, folder);
			this._sessionFolders.delete(fromSessionId);
		}
	}

}

function mruToFolderOptionItems(mruItems: readonly FolderRepositoryMRUEntry[]): vscode.ChatSessionProviderOptionItem[] {
	return mruItems.map(item => ({
		id: item.folder.fsPath,
		name: basename(item.folder),
		icon: new vscode.ThemeIcon(item.repository ? 'repo' : 'folder'),
	}));
}

/**
 * Chat session item controller wrapper for Claude Agent.
 * Reads sessions from ~/.claude/projects/<folder-slug>/, where each file name is a session id (GUID).
 */
export class ClaudeChatSessionItemController extends Disposable {
	private readonly _controller: vscode.ChatSessionItemController;
	private readonly _inProgressItems = new Map<string, vscode.ChatSessionItem>();
	private _showBadge: boolean;

	constructor(
		@IClaudeCodeSessionService private readonly _claudeCodeSessionService: IClaudeCodeSessionService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IGitService private readonly _gitService: IGitService,
	) {
		super();
		this._controller = this._register(vscode.chat.createChatSessionItemController(
			ClaudeSessionUri.claudeSessionType,
			() => this._refreshItems(CancellationToken.None)
		));

		this._showBadge = this._computeShowBadge();

		// Refresh session items and recompute badge when repositories change.
		// _computeShowBadge() reads gitService.repositories synchronously, which
		// may be incomplete while the git extension is still initializing.
		this._register(_gitService.onDidOpenRepository(() => {
			this._showBadge = this._computeShowBadge();
			void this._refreshItems(CancellationToken.None);
		}));
		this._register(_gitService.onDidCloseRepository(() => {
			this._showBadge = this._computeShowBadge();
			void this._refreshItems(CancellationToken.None);
		}));
	}

	async updateItemStatus(sessionId: string, status: vscode.ChatSessionStatus, newItemLabel: string): Promise<void> {
		const resource = ClaudeSessionUri.forSessionId(sessionId);
		let item = this._controller.items.get(resource);
		if (!item) {
			const session = await this._claudeCodeSessionService.getSession(resource, CancellationToken.None);
			if (session) {
				item = this._createClaudeChatSessionItem(session);
			} else {
				const newlyCreatedSessionInfo: IClaudeCodeSessionInfo = {
					id: sessionId,
					label: newItemLabel,
					created: Date.now(),
					lastRequestEnded: Date.now(),
					folderName: undefined
				};
				item = this._createClaudeChatSessionItem(newlyCreatedSessionInfo);
			}

			this._controller.items.add(item);
		}

		item.status = status;
		if (status === vscode.ChatSessionStatus.InProgress) {
			const timing = item.timing ? { ...item.timing } : { created: Date.now() };
			timing.lastRequestStarted = Date.now();
			// Clear lastRequestEnded while a request is in progress
			timing.lastRequestEnded = undefined;
			item.timing = timing;
			this._inProgressItems.set(sessionId, item);
		} else {
			this._inProgressItems.delete(sessionId);
			if (status === vscode.ChatSessionStatus.Completed) {
				if (!item.timing) {
					item.timing = {
						created: Date.now(),
						lastRequestEnded: Date.now()
					};
				} else {
					item.timing = { ...item.timing, lastRequestEnded: Date.now() };
				}
			}
		}
	}

	private async _refreshItems(token: vscode.CancellationToken): Promise<void> {
		const sessions = await this._claudeCodeSessionService.getAllSessions(token);
		const items = sessions.map(session => this._createClaudeChatSessionItem(session));
		items.push(...this._inProgressItems.values());
		this._controller.items.replace(items);
	}

	private _createClaudeChatSessionItem(session: IClaudeCodeSessionInfo): vscode.ChatSessionItem {
		let badge: vscode.MarkdownString | undefined;
		if (session.folderName && this._showBadge) {
			badge = new vscode.MarkdownString(`$(folder) ${session.folderName}`);
			badge.supportThemeIcons = true;
		}

		const item = this._controller.createChatSessionItem(ClaudeSessionUri.forSessionId(session.id), session.label);
		item.badge = badge;
		item.tooltip = `Claude Code session: ${session.label}`;
		item.timing = {
			created: session.created,
			lastRequestStarted: session.lastRequestStarted,
			lastRequestEnded: session.lastRequestEnded,
		};
		item.iconPath = new vscode.ThemeIcon('claude');
		return item;
	}

	private _computeShowBadge(): boolean {
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			return true; // Empty window
		}
		if (workspaceFolders.length > 1) {
			return true; // Multi-root workspace
		}

		// Single-root workspace with multiple git repositories
		const repositories = this._gitService.repositories
			.filter(repository => repository.kind !== 'worktree');
		return repositories.length > 1;
	}
}

export namespace ClaudeSessionUri {
	export const claudeSessionType = 'claude-code';

	export function forSessionId(sessionId: string): vscode.Uri {
		return vscode.Uri.from({ scheme: ClaudeSessionUri.claudeSessionType, path: '/' + sessionId });
	}

	export function getId(resource: vscode.Uri): string {
		if (resource.scheme !== ClaudeSessionUri.claudeSessionType) {
			throw new Error('Invalid resource scheme for Claude Code session');
		}

		return resource.path.slice(1);
	}
}
