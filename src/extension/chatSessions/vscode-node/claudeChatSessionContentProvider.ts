/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { ClaudeFolderInfo } from '../../agents/claude/common/claudeFolderInfo';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { IClaudeCodeModels, NoClaudeModelsAvailableError } from '../../agents/claude/node/claudeCodeModels';
import { IClaudeSessionStateService } from '../../agents/claude/node/claudeSessionStateService';
import { IClaudeCodeSessionService } from '../../agents/claude/node/sessionParser/claudeCodeSessionService';
import { IClaudeCodeSession } from '../../agents/claude/node/sessionParser/claudeSessionSchema';
import { IClaudeSlashCommandService } from '../../agents/claude/vscode-node/claudeSlashCommandService';
import { FolderRepositoryMRUEntry, IFolderRepositoryManager } from '../common/folderRepositoryManager';
import { buildChatHistory } from './chatHistoryBuilder';
import { ClaudeChatSessionItemProvider, ClaudeSessionUri } from './claudeChatSessionItemProvider';

// Import the tool permission handlers
import '../../agents/claude/vscode-node/toolPermissionHandlers/index';

// Import the hooks to trigger self-registration
import '../../agents/claude/vscode-node/hooks/index';

// Import the MCP server contributors to trigger self-registration
import '../../agents/claude/vscode-node/mcpServers/index';

const MODELS_OPTION_ID = 'model';
const PERMISSION_MODE_OPTION_ID = 'permissionMode';
const FOLDER_OPTION_ID = 'folder';
const MAX_MRU_ENTRIES = 10;

/** Sentinel value indicating no Claude models with Messages API are available */
export const UNAVAILABLE_MODEL_ID = '__unavailable__';

export class ClaudeChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;

	private readonly _onDidChangeChatSessionProviderOptions = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionProviderOptions = this._onDidChangeChatSessionProviderOptions.event;

	// Track the last known option values for each session to detect actual changes
	private readonly _lastKnownOptions = new Map<string, { modelId?: string; permissionMode?: PermissionMode }>();

	// Track folder selection per session (in-memory for untitled sessions)
	private readonly _sessionFolders = new Map<string, URI>();

	constructor(
		@IClaudeCodeSessionService private readonly sessionService: IClaudeCodeSessionService,
		@IClaudeCodeModels private readonly claudeCodeModels: IClaudeCodeModels,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IClaudeSlashCommandService private readonly slashCommandService: IClaudeSlashCommandService,
		@IFolderRepositoryManager private readonly folderRepositoryManager: IFolderRepositoryManager,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		super();

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

		// Listen for state changes and notify UI only if value actually changed
		this._register(this.sessionStateService.onDidChangeSessionState(e => {
			const lastKnown = this._lastKnownOptions.get(e.sessionId);
			const updates: { optionId: string; value: string }[] = [];

			if (e.modelId !== undefined && e.modelId !== lastKnown?.modelId) {
				updates.push({ optionId: MODELS_OPTION_ID, value: e.modelId });
				this._updateLastKnown(e.sessionId, { modelId: e.modelId });
			}
			if (e.permissionMode !== undefined && e.permissionMode !== lastKnown?.permissionMode) {
				updates.push({ optionId: PERMISSION_MODE_OPTION_ID, value: e.permissionMode });
				this._updateLastKnown(e.sessionId, { permissionMode: e.permissionMode });
			}

			if (updates.length > 0) {
				const resource = ClaudeSessionUri.forSessionId(e.sessionId);
				this._onDidChangeChatSessionOptions.fire({ resource, updates });
			}
		}));
	}

	private _updateLastKnown(sessionId: string, update: { modelId?: string; permissionMode?: PermissionMode }): void {
		const existing = this._lastKnownOptions.get(sessionId) ?? {};
		this._lastKnownOptions.set(sessionId, { ...existing, ...update });
	}

	public override dispose(): void {
		this._lastKnownOptions.clear();
		this._untitledToSdkSession.clear();
		this._sessionFolders.clear();
		super.dispose();
	}

	/**
	 * Gets the model ID for a session, delegating to state service.
	 * @throws {NoClaudeModelsAvailableError} if no Claude models with Messages API are available
	 */
	public async getModelIdForSession(sessionId: string): Promise<string> {
		const availableModels = await this.claudeCodeModels.getModels();
		if (availableModels.length === 0) {
			throw new NoClaudeModelsAvailableError();
		}

		// Load the session to extract SDK model if needed
		const sessionUri = ClaudeSessionUri.forSessionId(sessionId);
		const session = await this.sessionService.getSession(sessionUri, CancellationToken.None);

		const resolvedModel = await this._resolveModelForSession(session);
		return resolvedModel;
	}

	/**
	 * Gets the permission mode for a session
	 */
	public getPermissionModeForSession(sessionId: string): PermissionMode {
		return this.sessionStateService.getPermissionModeForSession(sessionId);
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
			return workspaceFolders[0];
		}

		// Empty workspace: try MRU
		const lastUsed = this.folderRepositoryManager.getLastUsedFolderIdInUntitledWorkspace();
		if (lastUsed) {
			return URI.file(lastUsed);
		}

		const mru = this.folderRepositoryManager.getFolderMRU();
		if (mru.length > 0) {
			return mru[0].folder;
		}

		return undefined;
	}

	// #endregion

	// #region Chat Participant Handler

	// Track SDK session IDs for untitled sessions that haven't been swapped yet.
	// When VS Code yields mid-request, we can't swap yet (no complete session to display),
	// so we store the SDK session ID to reuse on the next request.
	private readonly _untitledToSdkSession = new Map<string, string>();

	createHandler(
		sessionType: string,
		claudeAgentManager: ClaudeAgentManager,
		sessionItemProvider: ClaudeChatSessionItemProvider,
	): ChatExtendedRequestHandler {
		return async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> => {
			const { chatSessionContext } = context;
			if (!chatSessionContext) {
				/* Via @claude */
				// TODO: Think about how this should work
				stream.markdown(vscode.l10n.t("Start a new Claude Agent session"));
				stream.button({ command: `workbench.action.chat.openNewSessionEditor.${sessionType}`, title: vscode.l10n.t("Start Session") });
				return {};
			}

			// Try to handle as a slash command first
			const slashResult = await this.slashCommandService.tryHandleCommand(request.prompt, stream, token);
			if (slashResult.handled) {
				return slashResult.result ?? {};
			}

			const sessionId = ClaudeSessionUri.getId(chatSessionContext.chatSessionItem.resource);
			let modelId: string;
			try {
				modelId = await this.getModelIdForSession(sessionId);
			} catch (e) {
				if (e instanceof NoClaudeModelsAvailableError) {
					return { errorDetails: { message: e.message } };
				}
				throw e;
			}
			const permissionMode = this.getPermissionModeForSession(sessionId);
			const folderInfo = this.getFolderInfoForSession(sessionId);
			const yieldRequested = () => context.yieldRequested;

			// For untitled sessions, check if we have a stored SDK session from a previous yield
			const untitledKey = chatSessionContext.isUntitled ? chatSessionContext.chatSessionItem.resource.toString() : undefined;
			const effectiveSessionId = chatSessionContext.isUntitled
				? this._untitledToSdkSession.get(untitledKey!)
				: sessionId;

			const result = await claudeAgentManager.handleRequest(effectiveSessionId, request, context, stream, token, modelId, permissionMode, folderInfo, yieldRequested);

			if (chatSessionContext.isUntitled) {
				if (result.claudeSessionId) {
					// Transfer folder selection from untitled session to the new real session ID
					const untitledFolder = this._sessionFolders.get(sessionId);
					if (untitledFolder) {
						this._sessionFolders.set(result.claudeSessionId, untitledFolder);
						this._sessionFolders.delete(sessionId);
					}

					if (context.yieldRequested) {
						// VS Code will follow up immediately - store the SDK session so the
						// next request reuses it instead of creating a new one
						this._untitledToSdkSession.set(untitledKey!, result.claudeSessionId);
					} else {
						// Done yielding (or never yielded) - swap to persistent session
						this._untitledToSdkSession.delete(untitledKey!);
						const swapResource = ClaudeSessionUri.forSessionId(result.claudeSessionId);
						await this.sessionService.waitForSessionReady(swapResource, token);
						sessionItemProvider.swap(chatSessionContext.chatSessionItem, {
							resource: swapResource,
							label: request.prompt ?? 'Claude Agent'
						});
					}
				} else if (!result.errorDetails) {
					// Only show generic warning if we didn't already show a specific error
					stream.warning(vscode.l10n.t("Failed to create a new Claude Agent session."));
				}
			}

			return result.errorDetails ? { errorDetails: result.errorDetails } : {};
		};
	}

	// #endregion

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		const models = await this.claudeCodeModels.getModels();
		let modelItems: vscode.ChatSessionProviderOptionItem[];

		if (models.length === 0) {
			// No Claude models with Messages API available - show unavailable placeholder
			modelItems = [{
				id: UNAVAILABLE_MODEL_ID,
				name: l10n.t('Unavailable'),
				description: l10n.t('No Claude models with Messages API found'),
			}];
		} else {
			modelItems = models.map(model => ({
				id: model.id,
				name: model.name,
				description: model.multiplier !== undefined ? `${model.multiplier}x` : undefined,
			}));
		}

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
			{
				id: MODELS_OPTION_ID,
				name: l10n.t('Model'),
				description: l10n.t('Pick Model'),
				items: modelItems,
			}
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
		const sessionId = ClaudeSessionUri.getId(resource);
		for (const update of updates) {
			if (update.optionId === MODELS_OPTION_ID) {
				// Ignore the unavailable placeholder - it's not a real model
				if (update.value === UNAVAILABLE_MODEL_ID) {
					continue;
				}
				// Update last known first so the event listener won't fire back to UI
				this._updateLastKnown(sessionId, { modelId: update.value });
				void this.claudeCodeModels.setDefaultModel(update.value);
				this.sessionStateService.setModelIdForSession(sessionId, update.value);
			} else if (update.optionId === PERMISSION_MODE_OPTION_ID) {
				// Update last known first so the event listener won't fire back to UI
				this._updateLastKnown(sessionId, { permissionMode: update.value as PermissionMode });
				this.sessionStateService.setPermissionModeForSession(sessionId, update.value as PermissionMode);
			} else if (update.optionId === FOLDER_OPTION_ID && typeof update.value === 'string') {
				this._sessionFolders.set(sessionId, URI.file(update.value));
			}
		}
	}

	async provideChatSessionContent(sessionResource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const sessionId = ClaudeSessionUri.getId(sessionResource);
		const existingSession = await this.sessionService.getSession(sessionResource, token);
		const history = existingSession ?
			buildChatHistory(existingSession) :
			[];

		let model: string | undefined;
		try {
			model = await this._resolveModelForSession(existingSession);
		} catch (e) {
			if (e instanceof NoClaudeModelsAvailableError) {
				model = UNAVAILABLE_MODEL_ID;
			} else {
				throw e;
			}
		}

		const permissionMode = this.sessionStateService.getPermissionModeForSession(sessionId);

		const options: Record<string, string | vscode.ChatSessionProviderOptionItem> = {};
		if (model) {
			options[MODELS_OPTION_ID] = model;
		}
		options[PERMISSION_MODE_OPTION_ID] = permissionMode;

		// Include folder option if applicable (multi-root or empty workspace)
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length !== 1) {
			const defaultFolder = this._getDefaultFolderForSession(sessionId);
			if (defaultFolder) {
				// Store the default selection so getFolderInfoForSession can use it
				if (!this._sessionFolders.has(sessionId)) {
					this._sessionFolders.set(sessionId, defaultFolder);
				}

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
	 * Resolves the model to use for a session with fallback logic:
	 * 1. Stored session state (user's explicit selection)
	 * 2. SDK model from session messages (mapped to endpoint model)
	 * 3. Default model
	 *
	 * Caches the result in session state if resolved from fallback logic.
	 */
	private async _resolveModelForSession(session: IClaudeCodeSession | undefined): Promise<string> {
		// 1. Check stored session state (user's explicit selection or cached value)
		if (session) {
			const cachedModel = await this.sessionStateService.getModelIdForSession(session.id);
			if (cachedModel) {
				// Keep the global default in sync with user's selection
				await this.claudeCodeModels.setDefaultModel(cachedModel);
				return cachedModel;
			}
		}

		// 2. Try SDK model from session messages
		if (session) {
			const sdkModel = this._extractModelFromSession(session);
			if (sdkModel) {
				const model = await this.claudeCodeModels.mapSdkModelToEndpointModel(sdkModel);
				if (model) {
					// Cache the resolved model in session state for future retrieval
					this.sessionStateService.setModelIdForSession(session.id, model);
					// Keep the global default in sync with user's selection
					await this.claudeCodeModels.setDefaultModel(model);
					return model;
				}
			}
		}

		// 3. Fall back to default
		return await this.claudeCodeModels.getDefaultModel();
	}

	/**
	 * Extract the SDK model ID from the session's last assistant message.
	 * Returns the raw model ID from the Anthropic API (e.g., 'claude-opus-4-5-20251101').
	 */
	private _extractModelFromSession(session: IClaudeCodeSession): string | undefined {
		// Iterate backwards to find the most recent assistant message with a model
		for (let i = session.messages.length - 1; i >= 0; i--) {
			const msg = session.messages[i];
			if (
				msg.type === 'assistant' &&
				msg.message.role === 'assistant'
			) {
				return msg.message.model;
			}
		}
		return undefined;
	}

}

function mruToFolderOptionItems(mruItems: readonly FolderRepositoryMRUEntry[]): vscode.ChatSessionProviderOptionItem[] {
	return mruItems.map(item => ({
		id: item.folder.fsPath,
		name: basename(item.folder),
		icon: new vscode.ThemeIcon(item.repository ? 'repo' : 'folder'),
	}));
}
