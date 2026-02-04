/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
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
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
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

/**
 * Implementation of IFolderRepositoryManager.
 *
 * This service centralizes all folder/repository management logic including:
 * - Tracking folder selection for untitled sessions
 * - Resolving folder/repository/worktree information for sessions
 * - Creating worktrees for git repositories
 * - Verifying trust status
 * - Tracking MRU (Most Recently Used) folders
 */
export class FolderRepositoryManager extends Disposable implements IFolderRepositoryManager {
	declare _serviceBrand: undefined;

	/**
	 * In-memory storage for untitled session folder selections.
	 * Maps session ID → folder URI.
	 */
	private readonly _untitledSessionFolders = new Map<string, { uri: vscode.Uri; lastAccessTime: number }>();

	/**
	 * ID of the last used folder in an untitled workspace (for defaulting selection).
	 */
	private _lastUsedFolderIdInUntitledWorkspace: string | undefined;

	constructor(
		@IChatSessionWorktreeService private readonly worktreeService: IChatSessionWorktreeService,
		@IChatSessionWorkspaceFolderService private readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@IGitService private readonly gitService: IGitService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ILogService private readonly logService: ILogService
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

	private async getFolderRepositoryForNewSession(sessionId: string | undefined, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<Omit<FolderRepositoryInfo, 'worktree' | 'worktreeProperties'>> {
		// Get the selected folder
		const selectedFolder = sessionId ? (this._untitledSessionFolders.get(sessionId)?.uri
			?? this.workspaceFolderService.getSessionWorkspaceFolder(sessionId)) : undefined;

		// If no folder selected and we have a single workspace folder, use active repository
		let repositoryUri: vscode.Uri | undefined;
		let folderUri = selectedFolder;

		// If we have just one folder opened in workspace, use that as default
		// TODO: @DonJayamanne Handle Session View.
		if (!selectedFolder && !isWelcomeView(this.workspaceService) && this.workspaceService.getWorkspaceFolders().length === 1) {
			const activeRepo = this.gitService.activeRepository.get();
			repositoryUri = activeRepo?.rootUri;
			folderUri = repositoryUri ?? this.workspaceService.getWorkspaceFolders()[0];
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
					trusted: false
				};
			}

			// Now look for a git repository in the selected folder.
			// If found, use it. If not, proceed without isolation.`
			repositoryUri = (await this.gitService.getRepository(selectedFolder, true))?.rootUri;

			// If no git repo found, use folder directly without isolation
			if (!repositoryUri) {
				return {
					folder: selectedFolder,
					repository: undefined,
					trusted: true
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
					trusted
				};
			}

			return {
				folder: undefined,
				repository: undefined,
				trusted: true
			};
		}

		// Verify trust on repository path
		const trusted = await this.verifyTrust(repositoryUri, stream);

		if (!trusted) {
			return {
				folder: folderUri ?? repositoryUri,
				repository: repositoryUri,
				trusted: false
			};
		}

		return {
			folder: folderUri ?? repositoryUri,
			repository: repositoryUri,
			trusted: true
		};
	}

	/**
	 * @inheritdoc
	 */
	async initializeFolderRepository(
		sessionId: string | undefined,
		options: { stream: vscode.ChatResponseStream; uncommittedChangesAction?: 'move' | 'copy' | 'skip' },
		token: vscode.CancellationToken
	): Promise<FolderRepositoryInfo> {
		const { stream, uncommittedChangesAction } = options;

		const { folder, repository, trusted } = await this.getFolderRepositoryForNewSession(sessionId, stream, token);
		if (trusted === false) {
			return { folder, repository, worktree: undefined, worktreeProperties: undefined, trusted };
		}
		if (!repository) {
			// No git repository found, proceed without isolation
			return { folder, repository, worktree: undefined, worktreeProperties: undefined, trusted: true };
		}

		// Create worktree for the git repository
		const worktreeProperties = await this.worktreeService.createWorktree(repository, stream);

		if (!worktreeProperties) {
			stream.warning(l10n.t('Failed to create worktree. Proceeding without isolation.'));

			return {
				folder: folder ?? repository,
				repository: repository,
				worktree: undefined,
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
				vscode.Uri.file(worktreeProperties.worktreePath),
				uncommittedChangesAction,
				stream,
				token
			);
		}

		return {
			folder: folder ?? repository,
			repository: repository,
			worktree: vscode.Uri.file(worktreeProperties.worktreePath),
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
	 * Verify trust for a folder/repository and report via stream if not trusted.
	 */
	private async verifyTrust(folderUri: vscode.Uri, stream: vscode.ChatResponseStream): Promise<boolean> {
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
