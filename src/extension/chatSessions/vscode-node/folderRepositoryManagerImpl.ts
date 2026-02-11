/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { LanguageModelTextPart } from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { raceCancellation } from '../../../util/vs/base/common/async';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { ResourceSet } from '../../../util/vs/base/common/map';
import { isEqual } from '../../../util/vs/base/common/resources';
import { isWelcomeView } from '../../agents/copilotcli/node/copilotCli';
import { ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { createTimeout } from '../../inlineEdits/common/common';
import { IToolsService } from '../../tools/common/toolsService';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import {
	FolderRepositoryInfo,
	FolderRepositoryMRUEntry,
	GetFolderRepositoryOptions,
	IFolderRepositoryManager
} from '../common/folderRepositoryManager';
import { isUntitledSessionId } from '../common/utils';

/**
 * Message shown when user needs to trust a folder to continue.
 */
const UNTRUSTED_FOLDER_MESSAGE = l10n.t('The selected folder is not trusted. Please trust the folder to continue with the {0}.', 'Background Agent');

// #region FolderRepositoryManager (abstract base)

/**
 * Abstract base implementation of IFolderRepositoryManager.
 *
 * This service centralizes all shared folder/repository management logic including:
 * - Tracking folder selection for untitled sessions
 * - Resolving folder/repository/worktree information for new sessions
 * - Creating worktrees for git repositories
 * - Verifying trust status
 * - Tracking MRU (Most Recently Used) folders
 *
 * Subclasses must implement {@link getFolderRepository} to provide session-type-specific
 * resolution of folder information for existing (named) sessions.
 */
export abstract class FolderRepositoryManager extends Disposable implements IFolderRepositoryManager {
	declare _serviceBrand: undefined;

	/**
	 * In-memory storage for untitled session folder selections.
	 * Maps session ID → folder URI.
	 */
	protected readonly _untitledSessionFolders = new Map<string, { uri: vscode.Uri; lastAccessTime: number }>();

	/**
	 * ID of the last used folder in an untitled workspace (for defaulting selection).
	 */
	private _lastUsedFolderIdInUntitledWorkspace: string | undefined;

	constructor(
		protected readonly worktreeService: IChatSessionWorktreeService,
		protected readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
		protected readonly gitService: IGitService,
		protected readonly workspaceService: IWorkspaceService,
		protected readonly logService: ILogService,
		protected readonly toolsService: IToolsService,

	) {
		super();
	}

	/**
	 * @inheritdoc
	 */
	setUntitledSessionFolder(sessionId: string, folderUri: vscode.Uri): void {
		if (!isUntitledSessionId(sessionId)) {
			throw new Error(`Cannot set folder for non-untitled session: ${sessionId}`);
		}

		this._untitledSessionFolders.set(sessionId, { uri: folderUri, lastAccessTime: Date.now() });

		// Update MRU tracking for untitled workspaces
		if (isWelcomeView(this.workspaceService)) {
			this._lastUsedFolderIdInUntitledWorkspace = folderUri.fsPath;
		}
	}

	/**
	 * @inheritdoc
	 */
	getUntitledSessionFolder(sessionId: string): vscode.Uri | undefined {
		return this._untitledSessionFolders.get(sessionId)?.uri;
	}

	/**
	 * @inheritdoc
	 */
	deleteUntitledSessionFolder(sessionId: string): void {
		this._untitledSessionFolders.delete(sessionId);
	}

	/**
	 * @inheritdoc
	 */
	abstract getFolderRepository(
		sessionId: string,
		options: GetFolderRepositoryOptions | undefined,
		token: vscode.CancellationToken
	): Promise<FolderRepositoryInfo>;

	protected async getFolderRepositoryForNewSession(sessionId: string | undefined, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<FolderRepositoryInfo> {
		// Get the selected folder
		const selectedFolder = sessionId ? (this._untitledSessionFolders.get(sessionId)?.uri
			?? this.workspaceFolderService.getSessionWorkspaceFolder(sessionId)) : undefined;

		// If no folder selected and we have a single workspace folder, use active repository
		let repositoryUri: vscode.Uri | undefined;
		let folderUri = selectedFolder;
		let worktree: vscode.Uri | undefined = undefined;
		let worktreeProperties: ChatSessionWorktreeProperties | undefined = undefined;

		// If we have just one folder opened in workspace, use that as default
		// TODO: @DonJayamanne Handle Session View.
		if (!selectedFolder && !isWelcomeView(this.workspaceService) && this.workspaceService.getWorkspaceFolders().length === 1) {
			const activeRepo = this.gitService.activeRepository.get();
			repositoryUri = activeRepo?.rootUri;
			folderUri = repositoryUri ?? this.workspaceService.getWorkspaceFolders()[0];

			// If we're in a single folder workspace, possible the user has opened the worktree folder directly.
			if (sessionId && isUntitledSessionId(sessionId) && folderUri) {
				worktreeProperties = this.worktreeService.getWorktreeProperties(folderUri);
				worktree = worktreeProperties ? vscode.Uri.file(worktreeProperties.worktreePath) : undefined;
				repositoryUri = worktreeProperties ? vscode.Uri.file(worktreeProperties.repositoryPath) : repositoryUri;
			}
		} else if (selectedFolder) {
			// First check if user trusts the folder.
			// We need to do this before looking for git repos to avoid prompting for trust twice.
			// Using getRepository will prompt user to trust the repo, and if not trusted
			// then undefined is returned and we cannot distinguish between "not a git repo" and "not trusted".
			const trusted = await this.workspaceService.requestResourceTrust({
				uri: selectedFolder,
				message: UNTRUSTED_FOLDER_MESSAGE
			});

			if (!trusted) {
				stream.warning(l10n.t('The selected folder is not trusted.'));
				return {
					folder: selectedFolder,
					repository: undefined,
					trusted: false,
					worktree,
					worktreeProperties
				};
			}

			// If we're in a single folder workspace, possible the user has opened the worktree folder directly.
			if (sessionId && isUntitledSessionId(sessionId) && folderUri) {
				worktreeProperties = this.worktreeService.getWorktreeProperties(folderUri);
				worktree = worktreeProperties ? vscode.Uri.file(worktreeProperties.worktreePath) : undefined;
				repositoryUri = worktreeProperties ? vscode.Uri.file(worktreeProperties.repositoryPath) : repositoryUri;
			}

			// Now look for a git repository in the selected folder.
			// If found, use it. If not, proceed without isolation.`
			repositoryUri = worktreeProperties ? vscode.Uri.file(worktreeProperties.repositoryPath) : (await this.gitService.getRepository(selectedFolder, true))?.rootUri;

			// If no git repo found, use folder directly without isolation
			if (!repositoryUri) {
				return {
					folder: selectedFolder,
					repository: undefined,
					trusted: true,
					worktree,
					worktreeProperties
				};
			}
		}

		if (!repositoryUri) {
			// No folder or repository selected
			if (folderUri) {
				const trusted = await this.verifyTrust(folderUri, stream);
				return {
					folder: folderUri,
					repository: undefined,
					trusted,
					worktree,
					worktreeProperties
				};
			}

			return {
				folder: undefined,
				repository: undefined,
				trusted: true,
				worktree,
				worktreeProperties
			};
		}

		// Verify trust on repository path
		const trusted = await this.verifyTrust(repositoryUri, stream);

		if (!trusted) {
			return {
				folder: folderUri ?? repositoryUri,
				repository: repositoryUri,
				trusted: false,
				worktree,
				worktreeProperties
			};
		}

		return {
			folder: folderUri ?? repositoryUri,
			repository: repositoryUri,
			trusted: true,
			worktree,
			worktreeProperties
		};
	}

	/**
	 * @inheritdoc
	 */
	async initializeFolderRepository(
		sessionId: string | undefined,
		options: { stream: vscode.ChatResponseStream; toolInvocationToken: vscode.ChatParticipantToolToken },
		token: vscode.CancellationToken
	): Promise<FolderRepositoryInfo> {
		const { stream, toolInvocationToken } = options;

		let { folder, repository, trusted, worktree, worktreeProperties } = await this.getFolderRepositoryForNewSession(sessionId, stream, token);
		if (trusted === false) {
			return { folder, repository, worktree, worktreeProperties, trusted };
		}
		if (!repository) {
			// No git repository found, proceed without isolation
			return { folder, repository, worktree, worktreeProperties, trusted: true };
		}

		// Check for uncommitted changes and prompt user before creating worktree
		let uncommittedChangesAction: 'move' | 'copy' | 'skip' | 'cancel' | undefined = undefined;
		if ((!sessionId || isUntitledSessionId(sessionId)) && !worktreeProperties) {
			if (await this.checkIfRepoHasUncommittedChanges(sessionId, token)) {
				uncommittedChangesAction = await this.promptForUncommittedChangesAction(sessionId, toolInvocationToken, token);
				if (uncommittedChangesAction === 'cancel') {
					return { folder, repository, worktree, worktreeProperties, trusted: true, cancelled: true };
				}
			}
		}

		// Create worktree for the git repository
		worktreeProperties = worktreeProperties ?? await this.worktreeService.createWorktree(repository, stream);

		if (!worktreeProperties) {
			stream.warning(l10n.t('Failed to create worktree. Proceeding without isolation.'));

			return {
				folder: folder ?? repository,
				repository: repository,
				worktree,
				worktreeProperties,
				trusted
			};
		}

		// Store worktree properties for the session
		// Note: The caller is responsible for calling setWorktreeProperties after getting the real session ID

		this.logService.info(`[FolderRepositoryManager] Created worktree for session ${sessionId}: ${worktreeProperties.worktreePath}`);

		// Migrate changes from active repository to worktree if requested
		if (uncommittedChangesAction === 'move' || uncommittedChangesAction === 'copy') {
			await this.moveOrCopyChangesToWorkTree(
				repository,
				worktree ?? vscode.Uri.file(worktreeProperties.worktreePath),
				uncommittedChangesAction,
				stream,
				token
			);
		}

		return {
			folder: folder ?? repository,
			repository: repository,
			worktree: worktree ?? vscode.Uri.file(worktreeProperties.worktreePath),
			worktreeProperties,
			trusted: true
		};
	}

	/**
	 * @inheritdoc
	 */
	getFolderMRU(): FolderRepositoryMRUEntry[] {
		const latestReposAndFolders: FolderRepositoryMRUEntry[] = [];
		const seenUris = new ResourceSet();

		for (const { uri, lastAccessTime } of this._untitledSessionFolders.values()) {
			if (seenUris.has(uri)) {
				continue;
			}
			seenUris.add(uri);
			latestReposAndFolders.push({
				folder: uri,
				repository: undefined,
				lastAccessed: lastAccessTime,
				isUntitledSessionSelection: true
			});
		}

		// Add recent git repositories
		for (const repo of this.gitService.getRecentRepositories()) {
			if (seenUris.has(repo.rootUri)) {
				continue;
			}
			seenUris.add(repo.rootUri);
			latestReposAndFolders.push({
				folder: repo.rootUri,
				repository: repo.rootUri,
				lastAccessed: repo.lastAccessTime,
				isUntitledSessionSelection: false
			});
		}

		// Add recent workspace folders
		for (const folder of this.workspaceFolderService.getRecentFolders()) {
			if (seenUris.has(folder.folder)) {
				continue;
			}
			seenUris.add(folder.folder);
			latestReposAndFolders.push({
				folder: folder.folder,
				repository: undefined,
				lastAccessed: folder.lastAccessTime,
				isUntitledSessionSelection: false
			});
		}

		// Sort by last access time descending and limit
		latestReposAndFolders.sort((a, b) => b.lastAccessed - a.lastAccessed);

		return latestReposAndFolders;
	}

	async deleteMRUEntry(folder: vscode.Uri): Promise<void> {
		// Remove from untitled session folders if present
		for (const [sessionId, entry] of this._untitledSessionFolders.entries()) {
			if (isEqual(entry.uri, folder)) {
				this._untitledSessionFolders.delete(sessionId);
			}
		}

		await this.workspaceFolderService.deleteRecentFolder(folder);
	}
	/**
	 * Get the last used folder ID in untitled workspace.
	 * Used for defaulting the selection in the folder dropdown.
	 */
	getLastUsedFolderIdInUntitledWorkspace(): string | undefined {
		return this._lastUsedFolderIdInUntitledWorkspace;
	}


	/**
	 * Check for uncommitted changes and prompt user for action.
	 *
	 * @returns The user's chosen action, or `undefined` if there are no uncommitted changes.
	 */
	private async promptForUncommittedChangesAction(
		sessionId: string | undefined,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): Promise<'move' | 'copy' | 'skip' | 'cancel' | undefined> {
		const hasUncommittedChanges = await this.checkIfRepoHasUncommittedChanges(sessionId, token);
		if (!hasUncommittedChanges) {
			return undefined;
		}

		const isDelegation = !sessionId;
		const title = isDelegation
			? l10n.t('Delegate to Background Agent')
			: l10n.t('Uncommitted Changes');
		const message = isDelegation
			? l10n.t('Background Agent will work in an isolated worktree to implement your requested changes.')
			+ '\n\n'
			+ l10n.t('The selected repository has uncommitted changes. Should these changes be included in the new worktree?')
			: l10n.t('The selected repository has uncommitted changes. Should these changes be included in the new worktree?');

		const copyChanges = l10n.t('Copy Changes');
		const moveChanges = l10n.t('Move Changes');
		const skipChanges = l10n.t('Skip Changes');
		const cancel = l10n.t('Cancel');
		const buttons = [copyChanges, moveChanges, skipChanges, cancel];
		const input = {
			title,
			message,
			buttons
		};
		const result = await this.toolsService.invokeTool('vscode_get_confirmation_with_options', { input, toolInvocationToken }, token);

		const firstResultPart = result.content.at(0);
		const selection = firstResultPart instanceof LanguageModelTextPart ? firstResultPart.value : undefined;

		switch (selection?.toUpperCase()) {
			case moveChanges.toUpperCase():
				return 'move';
			case copyChanges.toUpperCase():
				return 'copy';
			case skipChanges.toUpperCase():
				return 'skip';
			default:
				return 'cancel';
		}
	}

	/**
	 * Check if the repository associated with a session has uncommitted changes.
	 */
	private async checkIfRepoHasUncommittedChanges(sessionId: string | undefined, _token: vscode.CancellationToken): Promise<boolean> {
		if (sessionId && isUntitledSessionId(sessionId)) {
			const folder = this._untitledSessionFolders.get(sessionId)?.uri
				?? this.workspaceFolderService.getSessionWorkspaceFolder(sessionId);
			if (folder) {
				const repo = await this.gitService.getRepository(folder, false);
				return repo?.changes
					? (repo.changes.indexChanges.length > 0 || repo.changes.workingTree.length > 0)
					: false;
			}
			// No folder selected, fall through to active repo check
		} else if (sessionId) {
			// Non-untitled session, no need to check
			return false;
		}

		// For delegation (no session) or untitled session without explicit folder selection,
		// check active repository if there's a single workspace folder
		if (!isWelcomeView(this.workspaceService) && this.workspaceService.getWorkspaceFolders().length === 1) {
			const repo = this.gitService.activeRepository.get();
			return repo?.changes
				? (repo.changes.indexChanges.length > 0 || repo.changes.workingTree.length > 0)
				: false;
		}

		return false;
	}

	/**
	 * Verify trust for a folder/repository and report via stream if not trusted.
	 */
	protected async verifyTrust(folderUri: vscode.Uri, stream: vscode.ChatResponseStream): Promise<boolean> {
		const trusted = await this.workspaceService.requestResourceTrust({
			uri: folderUri,
			message: UNTRUSTED_FOLDER_MESSAGE
		});

		if (!trusted) {
			stream.warning(l10n.t('The selected folder is not trusted.'));
			return false;
		}

		return true;
	}

	/**
	 * Move or copy uncommitted changes from the active repository to the worktree.
	 */
	private async moveOrCopyChangesToWorkTree(
		repositoryPath: vscode.Uri,
		worktreePath: vscode.Uri,
		moveOrCopyChanges: 'move' | 'copy',
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		// Migrate changes from active repository to worktree
		const activeRepository = await this.gitService.getRepository(repositoryPath);
		if (!activeRepository) {
			return;
		}
		const hasUncommittedChanges = activeRepository.changes
			? (activeRepository.changes.indexChanges.length > 0 || activeRepository.changes.workingTree.length > 0)
			: false;
		if (!hasUncommittedChanges) {
			return;
		}

		const disposables = new DisposableStore();
		try {
			// Wait for the worktree repository to be ready
			stream.progress(l10n.t('Migrating changes to worktree...'));
			const worktreeRepo = await raceCancellation(new Promise<typeof activeRepository | undefined>((resolve) => {
				disposables.add(this.gitService.onDidOpenRepository(repo => {
					if (isEqual(repo.rootUri, worktreePath)) {
						resolve(repo);
					}
				}));

				this.gitService.getRepository(worktreePath).then(repo => {
					if (repo) {
						resolve(repo);
					}
				});

				disposables.add(createTimeout(10_000, () => resolve(undefined)));
			}), token);

			if (!worktreeRepo) {
				stream.warning(l10n.t('Failed to get worktree repository. Proceeding without migration.'));
			} else {
				await this.gitService.migrateChanges(worktreeRepo.rootUri, activeRepository.rootUri, {
					confirmation: false,
					deleteFromSource: moveOrCopyChanges === 'move',
					untracked: true
				});
				stream.markdown(l10n.t('Changes migrated to worktree.'));
			}
		} catch (error) {
			// Continue even if migration fails
			stream.warning(l10n.t('Failed to migrate some changes: {0}. Continuing with worktree creation.', error instanceof Error ? error.message : String(error)));
		} finally {
			disposables.dispose();
		}
	}
}

// #endregion

// #region CopilotCLIFolderRepositoryManager

/**
 * CopilotCLI-specific implementation that resolves folder information for
 * existing sessions using the CLI session service as a fallback.
 */
export class CopilotCLIFolderRepositoryManager extends FolderRepositoryManager {
	constructor(
		@IChatSessionWorktreeService worktreeService: IChatSessionWorktreeService,
		@IChatSessionWorkspaceFolderService workspaceFolderService: IChatSessionWorkspaceFolderService,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@IGitService gitService: IGitService,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@ILogService logService: ILogService,
		@IToolsService toolsService: IToolsService
	) {
		super(worktreeService, workspaceFolderService, gitService, workspaceService, logService, toolsService);
	}

	/**
	 * @inheritdoc
	 */
	async getFolderRepository(
		sessionId: string,
		options: GetFolderRepositoryOptions | undefined,
		token: vscode.CancellationToken
	): Promise<FolderRepositoryInfo> {
		// For untitled sessions, use what ever is in memory.
		if (isUntitledSessionId(sessionId)) {
			if (options) {
				const { folder, repository, trusted } = await this.getFolderRepositoryForNewSession(sessionId, options?.stream, token);
				return { folder, repository, worktree: undefined, worktreeProperties: undefined, trusted };
			} else {
				const folder = this._untitledSessionFolders.get(sessionId)?.uri
					?? this.workspaceFolderService.getSessionWorkspaceFolder(sessionId);
				return { folder, repository: undefined, worktree: undefined, trusted: undefined, worktreeProperties: undefined };
			}
		}

		// For named sessions, check worktree properties first
		const worktreeProperties = this.worktreeService.getWorktreeProperties(sessionId);
		if (worktreeProperties) {
			const repositoryUri = vscode.Uri.file(worktreeProperties.repositoryPath);
			const worktreeUri = vscode.Uri.file(worktreeProperties.worktreePath);

			// Trust check on repository path (not worktree path)
			let trusted: boolean | undefined;
			if (options) {
				trusted = await this.verifyTrust(repositoryUri, options.stream);
			}

			return {
				folder: repositoryUri,
				repository: repositoryUri,
				worktree: worktreeUri,
				worktreeProperties,
				trusted
			};
		}

		// Check session workspace folder
		const sessionWorkspaceFolder = this.workspaceFolderService.getSessionWorkspaceFolder(sessionId);
		if (sessionWorkspaceFolder) {
			let trusted: boolean | undefined;
			if (options) {
				trusted = await this.verifyTrust(sessionWorkspaceFolder, options.stream);
			}

			return {
				folder: sessionWorkspaceFolder,
				repository: undefined,
				worktree: undefined,
				worktreeProperties: undefined,
				trusted
			};
		}

		// Fall back to CLI session working directory
		const cwd = await this.sessionService.getSessionWorkingDirectory(sessionId, token);
		if (cwd) {
			let trusted: boolean | undefined;
			if (options) {
				trusted = await this.verifyTrust(cwd, options.stream);
			}

			return {
				folder: cwd,
				repository: undefined,
				worktree: undefined,
				worktreeProperties: undefined,
				trusted
			};
		}

		return { folder: undefined, repository: undefined, worktree: undefined, trusted: undefined, worktreeProperties: undefined };
	}
}

// #endregion

// #region ClaudeFolderRepositoryManager

/**
 * Claude-specific implementation that does not support getFolderRepository.
 *
 * The Claude agent manages folder resolution through {@link ClaudeFolderInfo}
 * at the content provider level, so getFolderRepository is never called.
 */
export class ClaudeFolderRepositoryManager extends FolderRepositoryManager {
	constructor(
		@IChatSessionWorktreeService worktreeService: IChatSessionWorktreeService,
		@IChatSessionWorkspaceFolderService workspaceFolderService: IChatSessionWorkspaceFolderService,
		@IGitService gitService: IGitService,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@ILogService logService: ILogService,
		@IToolsService toolsService: IToolsService
	) {
		super(worktreeService, workspaceFolderService, gitService, workspaceService, logService, toolsService);
	}

	/**
	 * Not supported for Claude sessions.
	 *
	 * Claude uses {@link ClaudeFolderInfo} for folder resolution instead of this method.
	 */
	async getFolderRepository(): Promise<FolderRepositoryInfo> {
		throw new Error('getFolderRepository is not supported for Claude sessions');
	}
}

// #endregion
