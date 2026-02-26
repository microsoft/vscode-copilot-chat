/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode-languageserver-protocol';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitCommitMessageService } from '../../../platform/git/common/gitCommitMessageService';
import { IGitService, RepoContext } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';
import { basename, isEqual } from '../../../util/vs/base/common/resources';
import { IChatSessionMetadataStore } from '../common/chatSessionMetadataStore';
import { ChatSessionWorktreeData, ChatSessionWorktreeFile, ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';

const CHAT_SESSION_WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';

export class ChatSessionWorktreeService extends Disposable implements IChatSessionWorktreeService {
	declare _serviceBrand: undefined;

	private _sessionWorktrees: Map<string, string | ChatSessionWorktreeProperties> = new Map();

	constructor(
		@IGitCommitMessageService private readonly gitCommitMessageService: IGitCommitMessageService,
		@IGitService private readonly gitService: IGitService,
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IChatSessionMetadataStore private readonly metadataStore: IChatSessionMetadataStore,
	) {
		super();
	}

	async createWorktree(repositoryPath: vscode.Uri, stream?: vscode.ChatResponseStream, baseBranch?: string): Promise<ChatSessionWorktreeProperties | undefined> {
		if (!stream) {
			return this._createWorktree(repositoryPath, undefined, baseBranch);
		}

		return new Promise<ChatSessionWorktreeProperties | undefined>((resolve) => {
			stream.progress(l10n.t('Creating isolated worktree for Background Agent session...'), async progress => {
				const result = await this._createWorktree(repositoryPath, progress, baseBranch);
				resolve(result);
				if (result) {
					return l10n.t('Created isolated worktree at {0}', basename(vscode.Uri.file(result.worktreePath)));
				}
				return undefined;
			});
		});
	}

	private async _createWorktree(repositoryPath: vscode.Uri, progress?: vscode.Progress<vscode.ChatResponsePart>, baseBranch?: string): Promise<ChatSessionWorktreeProperties | undefined> {
		try {
			const activeRepository = await this.gitService.getRepository(repositoryPath);
			if (!activeRepository) {
				progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory')));
				this.logService.error('[ChatSessionWorktreeService][_createWorktree] No active repository found to create worktree for isolation.');
				return undefined;
			}

			const branchPrefix = vscode.workspace.getConfiguration('git').get<string>('branchPrefix') ?? '';
			const branch = `${branchPrefix}copilot-worktree-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
			const worktreePath = await this.gitService.createWorktree(activeRepository.rootUri, { branch, commitish: baseBranch });

			if (worktreePath && activeRepository.headCommitHash && activeRepository.headBranchName) {
				let baseCommit: string | undefined = undefined;
				if (baseBranch) {
					const refs = await this.gitService.getRefs(activeRepository.rootUri, { pattern: `refs/heads/${baseBranch}` });
					baseCommit = refs.length === 1 && refs[0].commit ? refs[0].commit : undefined;
				}

				return {
					branchName: branch,
					baseCommit: baseCommit ?? activeRepository.headCommitHash,
					baseBranchName: baseBranch ?? activeRepository.headBranchName,
					repositoryPath: activeRepository.rootUri.fsPath,
					worktreePath,
					version: 2
				} satisfies ChatSessionWorktreeProperties;
			}
			progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory')));
			this.logService.error('[ChatSessionWorktreeService][_createWorktree] Failed to create worktree for isolation.');
			return undefined;
		} catch (error) {
			progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Error creating worktree for isolation: {0}', error instanceof Error ? error.message : String(error))));
			this.logService.error('[ChatSessionWorktreeService][_createWorktree] Error creating worktree for isolation: ', error);
			return undefined;
		}
	}

	getWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties | undefined>;
	getWorktreeProperties(folder: vscode.Uri): Promise<ChatSessionWorktreeProperties | undefined>;
	async getWorktreeProperties(sessionIdOrFolder: string | vscode.Uri): Promise<ChatSessionWorktreeProperties | undefined> {
		if (typeof sessionIdOrFolder === 'string') {
			const properties = this._sessionWorktrees.get(sessionIdOrFolder);
			if (properties !== undefined) {
				return typeof properties === 'string' ? undefined : properties;
			}
			// Fall back to metadata store (file-based)
			return this.metadataStore.getWorktreeProperties(sessionIdOrFolder);
		} else {
			for (const [_, value] of this._sessionWorktrees.entries()) {
				if (typeof value === 'string') {
					continue;
				}
				if (isEqual(vscode.Uri.file(value.worktreePath), sessionIdOrFolder)) {
					return value;
				}
			}
			// Fall back to metadata store (file-based)
			return this.metadataStore.getWorktreeProperties(sessionIdOrFolder);
		}
	}

	async setWorktreeProperties(sessionId: string, properties: ChatSessionWorktreeProperties): Promise<void> {
		this._sessionWorktrees.set(sessionId, properties);

		const sessionWorktreesProperties = this.extensionContext.globalState.get<Record<string, string | ChatSessionWorktreeData>>(CHAT_SESSION_WORKTREE_MEMENTO_KEY, {});
		sessionWorktreesProperties[sessionId] = { data: JSON.stringify(properties), version: properties.version };
		await this.metadataStore.storeWorktreeInfo(sessionId, properties);
		await this.extensionContext.globalState.update(CHAT_SESSION_WORKTREE_MEMENTO_KEY, sessionWorktreesProperties);
	}

	async getWorktreeRepository(sessionId: string): Promise<RepoContext | undefined> {
		const worktreeProperties = await this.getWorktreeProperties(sessionId);
		if (typeof worktreeProperties === 'string' || !worktreeProperties?.repositoryPath) {
			return undefined;
		}

		return this.gitService.getRepository(vscode.Uri.file(worktreeProperties.repositoryPath));
	}

	async getWorktreePath(sessionId: string): Promise<vscode.Uri | undefined> {
		const worktreeProperties = await this.getWorktreeProperties(sessionId);
		if (!worktreeProperties) {
			return undefined;
		} else if (typeof worktreeProperties === 'string') {
			// Legacy worktree path
			return vscode.Uri.file(worktreeProperties);
		} else {
			// Worktree properties v1
			return vscode.Uri.file(worktreeProperties.worktreePath);
		}
	}

	async applyWorktreeChanges(sessionId: string): Promise<void> {
		const worktreeProperties = await this.getWorktreeProperties(sessionId);

		if (worktreeProperties === undefined || (worktreeProperties.version === 1 && worktreeProperties.autoCommit === false)) {
			// Legacy background session that has the changes staged in the worktree.
			// To apply the changes, we need to migrate them from the worktree to the
			// main repository using a stash.
			const worktreePath = await this.getWorktreePath(sessionId);
			if (!worktreePath) {
				return;
			}

			const activeRepository = worktreeProperties?.repositoryPath
				? await this.gitService.getRepository(vscode.Uri.file(worktreeProperties.repositoryPath))
				: this.workspaceService.getWorkspaceFolders().length === 1 ? this.gitService.activeRepository.get() : undefined;

			if (!activeRepository) {
				return;
			}

			// Migrate the changes from the worktree to the main repository
			await this.gitService.migrateChanges(activeRepository.rootUri, worktreePath, {
				confirmation: false,
				deleteFromSource: false,
				untracked: true
			});

			// Delete worktree changes cache
			if (worktreeProperties) {
				this.setWorktreeProperties(sessionId, {
					...worktreeProperties,
					changes: undefined
				});
			}

			return;
		}

		// Background session that has the changes committed in the worktree. To apply the
		// changes, we need to migrate them from the worktree to the main repository using
		// a patch file.
		const patch = await this.gitService.diffBetweenPatch(
			vscode.Uri.file(worktreeProperties.worktreePath),
			worktreeProperties.baseCommit,
			worktreeProperties.branchName,
		);
		if (!patch) {
			return;
		}

		// Write the patch to a temporary file
		const encoder = new TextEncoder();
		const patchFilePath = path.join(worktreeProperties.repositoryPath, '.git', `${worktreeProperties.branchName}.patch`);
		const patchFileUri = vscode.Uri.file(patchFilePath);
		await vscode.workspace.fs.writeFile(patchFileUri, encoder.encode(patch));

		try {
			// Apply patch
			await this.gitService.applyPatch(vscode.Uri.file(worktreeProperties.repositoryPath), patchFilePath);
		} catch (error) {
			this.logService.error(`[ChatSessionWorktreeService][applyWorktreeChanges] Error applying patch file ${patchFilePath} to repository ${worktreeProperties.repositoryPath}: `, error);
			throw error;
		} finally {
			await vscode.workspace.fs.delete(patchFileUri);
		}

		// Update base commit for the worktree after applying the changes
		const ref = await this.gitService.getRefs(vscode.Uri.file(worktreeProperties.repositoryPath), {
			pattern: `refs/heads/${worktreeProperties.branchName}`
		});

		if (ref.length === 1 && ref[0].commit && ref[0].commit !== worktreeProperties.baseCommit) {
			this.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				baseCommit: ref[0].commit
			});
		}

		// Delete worktree changes cache
		this.setWorktreeProperties(sessionId, {
			...worktreeProperties,
			changes: undefined
		});
	}

	async getWorktreeChanges(sessionId: string): Promise<readonly ChatSessionWorktreeFile[] | undefined> {
		this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Getting changes for session ${sessionId}`);

		// Get worktree properties
		const worktreeProperties = await this.getWorktreeProperties(sessionId);
		if (!worktreeProperties) {
			this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] No worktree properties found for session ${sessionId}`);
			return undefined;
		}

		this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: version=${worktreeProperties.version}, branch=${worktreeProperties.branchName}, baseCommit=${worktreeProperties.baseCommit}, repositoryPath=${worktreeProperties.repositoryPath}, worktreePath=${worktreeProperties.worktreePath}, cachedChanges=${worktreeProperties.changes?.length ?? 'none'}`);

		// Return cached changes but only if they are not empty
		// Workaround for https://github.com/microsoft/vscode/issues/297975
		if (worktreeProperties.changes && worktreeProperties.changes.length > 0) {
			this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Returning ${worktreeProperties.changes.length} cached change(s) for session ${sessionId}`);
			return worktreeProperties.changes;
		}

		const worktreePath = vscode.Uri.file(worktreeProperties.worktreePath);

		// Ensure the initial repository discovery is completed and the repository
		// states are initialized in the vscode.git extension. This is needed as these
		// will be the repositories that we use to compute the worktree changes. We do
		// not have to open each worktree individually since the changes are committed
		// so we can get them from the main repository or discovered worktree.
		await this.gitService.initialize();

		if (worktreeProperties.version === 1 && worktreeProperties.autoCommit === false) {
			// These changes are staged in the worktree but not yet committed. Since the
			// changes are not committed, we need to get them from the worktree repository
			// state. To do that we need to open the worktree repository. The source control
			// provider will not be shown in the Source Control view since it is being hidden.
			this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: v1 non-autoCommit, reading staged changes from worktree repository`);
			const worktreeRepository = await this.gitService.getRepository(worktreePath);

			if (!worktreeRepository?.changes) {
				this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: no worktree repository or no changes found, returning empty`);
				this.setWorktreeProperties(sessionId, {
					...worktreeProperties,
					changes: []
				});

				return [];
			}

			this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: indexChanges=${worktreeRepository.changes.indexChanges.length}, workingTree=${worktreeRepository.changes.workingTree.length}`);
			const changes: ChatSessionWorktreeFile[] = [];
			for (const change of [...worktreeRepository.changes.indexChanges, ...worktreeRepository.changes.workingTree]) {
				try {
					const fileStats = await this.gitService.diffIndexWithHEADShortStats(change.uri);
					changes.push({
						filePath: change.uri.fsPath,
						originalFilePath: change.status !== 1 /* INDEX_ADDED */
							? change.originalUri?.fsPath
							: undefined,
						modifiedFilePath: change.status !== 2 /* INDEX_DELETED */
							? change.uri.fsPath
							: undefined,
						statistics: {
							additions: fileStats?.insertions ?? 0,
							deletions: fileStats?.deletions ?? 0
						}
					} satisfies ChatSessionWorktreeFile);
				} catch (error) { }
			}

			this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: computed ${changes.length} staged change(s)`);
			this.setWorktreeProperties(sessionId, {
				...worktreeProperties, changes
			});
			return changes;
		}

		// Open the main repository that contains the worktree. We have to open
		// the repository so that we can run do `git diff` against the repository
		// to get the committed changes in the worktree branch.
		this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: reading committed changes from main repository ${worktreeProperties.repositoryPath}, diffing ${worktreeProperties.baseCommit}..${worktreeProperties.branchName}`);
		const repository = await this.gitService.getRepository(vscode.Uri.file(worktreeProperties.repositoryPath));

		if (!repository) {
			this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: main repository not found at ${worktreeProperties.repositoryPath}`);
			return undefined;
		}

		// These changes are committed in the worktree branch but since they are
		// committed we can get the changes from the main repository and we do
		// not need to open the worktree repository.
		const diff = await this.gitService.diffBetweenWithStats(
			repository.rootUri,
			worktreeProperties.baseCommit,
			worktreeProperties.branchName);

		if (!diff) {
			this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: no diff result, returning empty`);
			this.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				changes: []
			});

			return [];
		}

		this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: diff returned ${diff.length} file(s)`);
		const changes = diff.map(change => {
			// Since the diff was computed using the main repository, the file paths in the diff are relative to the
			// main repository. We need to convert them to absolute paths by joining them with the repository path.
			const worktreeFilePath = path.join(worktreeProperties.worktreePath, path.relative(worktreeProperties.repositoryPath, change.uri.fsPath));
			const worktreeOriginalFilePath = change.originalUri
				? path.join(worktreeProperties.worktreePath, path.relative(worktreeProperties.repositoryPath, change.originalUri.fsPath))
				: undefined;

			return {
				filePath: worktreeFilePath,
				originalFilePath: change.status !== 1 /* INDEX_ADDED */
					? worktreeOriginalFilePath
					: undefined,
				modifiedFilePath: change.status !== 6 /* DELETED */
					? worktreeFilePath
					: undefined,
				statistics: {
					additions: change.insertions,
					deletions: change.deletions
				}
			} satisfies ChatSessionWorktreeFile;
		});

		this.logService.trace(`[ChatSessionWorktreeService ${sessionId}][getWorktreeChanges] Session ${sessionId}: computed ${changes.length} committed change(s)`);
		this.setWorktreeProperties(sessionId, {
			...worktreeProperties, changes
		});

		return changes;
	}

	async getSessionIdForWorktree(folder: vscode.Uri): Promise<string | undefined> {
		for (const [sessionId, value] of this._sessionWorktrees.entries()) {
			if (typeof value === 'string') {
				continue;
			}
			if (isEqual(vscode.Uri.file(value.worktreePath), folder)) {
				return sessionId;
			}
		}
		return this.metadataStore.getSessionIdForWorktree(folder);
	}

	async handleRequestCompleted(sessionId: string): Promise<void> {
		const worktreeProperties = await this.getWorktreeProperties(sessionId);
		if (!worktreeProperties) {
			return;
		}

		const worktreePath = worktreeProperties.worktreePath;

		// Commit all changes in the worktree
		const repository = await this.gitCommitMessageService.getRepository(vscode.Uri.file(worktreePath));
		if (!repository) {
			this.logService.error(`[ChatSessionWorktreeService][handleRequestCompleted] Unable to find repository for working directory ${worktreePath}`);
			throw new Error(`Unable to find repository for working directory ${worktreePath}`);
		}

		if (repository.state.workingTreeChanges.length === 0 && repository.state.indexChanges.length === 0 && repository.state.untrackedChanges.length === 0) {
			this.logService.trace(`[ChatSessionWorktreeService][handleRequestCompleted] No changes to commit in working directory ${worktreePath}`);
			return;
		}

		this.logService.trace(`[ChatSessionWorktreeService][handleRequestCompleted] Generating commit message for working directory ${worktreePath}. Repository state: ${JSON.stringify(repository.state)}`);
		let message = await this.gitCommitMessageService.generateCommitMessage(repository, CancellationToken.None);
		if (!message) {
			// Fallback commit message
			this.logService.warn(`[ChatSessionWorktreeService][handleRequestCompleted] Unable to generate commit message for working directory ${worktreePath}. Repository state: ${JSON.stringify(repository.state)}`);
			message = `Copilot CLI session ${sessionId} changes`;
		}

		// Commit the changes
		await this.gitService.commit(vscode.Uri.file(worktreePath), message, { all: true, noVerify: true, signCommit: false });
		this.logService.trace(`[ChatSessionWorktreeService] Committed all changes in working directory ${worktreePath}`);

		// Delete worktree changes cache
		this.setWorktreeProperties(sessionId, {
			...worktreeProperties,
			changes: undefined
		});
	}
}
