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
import { isEqual } from '../../../util/vs/base/common/resources';
import { IChatSessionMetadataStore } from '../common/chatSessionMetadataStore';
import { ChatSessionWorktreeData, ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';

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
			stream.progress(l10n.t('Creating isolated worktree for Copilot CLI session...'), async progress => {
				const result = await this._createWorktree(repositoryPath, progress, baseBranch);
				resolve(result);
				if (result) {
					return l10n.t('Created isolated worktree for branch {0}', result.branchName);
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

			// Attempt to generate a random branch name for the worktree
			const randomBranchName = await this.gitService.generateRandomBranchName(repositoryPath);
			const branchPrefix = vscode.workspace.getConfiguration('git').get<string>('branchPrefix') ?? '';

			const branch = randomBranchName ? `${branchPrefix}copilot/${randomBranchName.substring(branchPrefix.length)}`
				: `${branchPrefix}copilot/worktree-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

			const worktreePath = await this.gitService.createWorktree(activeRepository.rootUri, { branch, commitish: baseBranch });

			if (worktreePath && activeRepository.headCommitHash && activeRepository.headBranchName) {
				const baseBranchName = baseBranch ?? activeRepository.headBranchName;
				const baseBranchProtected = await this.gitService.isBranchProtected(activeRepository.rootUri, baseBranchName);

				let baseCommit: string | undefined = undefined;
				if (baseBranch) {
					const refs = await this.gitService.getRefs(activeRepository.rootUri, { pattern: `refs/heads/${baseBranch}` });
					baseCommit = refs.length === 1 && refs[0].commit ? refs[0].commit : undefined;
				}

				return {
					branchName: branch,
					baseCommit: baseCommit ?? activeRepository.headCommitHash,
					baseBranchName,
					baseBranchProtected,
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
				await this.setWorktreeProperties(sessionId, {
					...worktreeProperties,
					changes: undefined
				});
			}

			return;
		}

		// Copilot CLI session that has the changes committed in the worktree. To apply the
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
			await this.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				baseCommit: ref[0].commit
			});
		}

		// Delete worktree changes cache
		await this.setWorktreeProperties(sessionId, {
			...worktreeProperties,
			changes: undefined
		});
	}

	async mergeWorktreeChanges(sessionId: string, sync?: boolean): Promise<void> {
		const worktreeProperties = await this.getWorktreeProperties(sessionId);
		if (!worktreeProperties || worktreeProperties.version !== 2) {
			this.logService.error(`[ChatSessionWorktreeService][mergeWorktreeChanges] No v2 worktree properties found for session ${sessionId}`);
			throw new Error('Merge is only supported for v2 worktree sessions');
		}

		const repositoryUri = vscode.Uri.file(worktreeProperties.repositoryPath);

		// Checkout the base branch in the main repository
		await this.gitService.checkout(repositoryUri, worktreeProperties.baseBranchName);

		// Merge the worktree branch into the base branch
		await this.gitService.merge(repositoryUri, worktreeProperties.branchName);

		// Sync the main repository with the remote
		if (sync) {
			try {
				await this.gitService.push(repositoryUri);
			} catch (error) {
				this.logService.error(`[ChatSessionWorktreeService][mergeWorktreeChanges] Error pushing changes to remote after merging worktree branch ${worktreeProperties.branchName} into base branch ${worktreeProperties.baseBranchName} for session ${sessionId}: `, error);
			}
		}

		// Get the HEAD commit of the base branch after the merge
		const refs = await this.gitService.getRefs(repositoryUri, {
			pattern: `refs/heads/${worktreeProperties.baseBranchName}`
		});

		if (refs.length === 1 && refs[0].commit) {
			// Update baseCommit to the new HEAD of the base branch
			await this.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				baseCommit: refs[0].commit,
				changes: undefined
			});
		} else {
			// Clear the changes cache even if we couldn't determine the new HEAD
			await this.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				changes: undefined
			});
		}
	}

	async updateWorktreeBranch(sessionId: string): Promise<void> {
		const worktreeProperties = await this.getWorktreeProperties(sessionId);
		if (!worktreeProperties || worktreeProperties.version !== 2) {
			this.logService.error(`[ChatSessionWorktreeService][updateWorktreeBranch] No v2 worktree properties found for session ${sessionId}`);
			throw new Error('Update is only supported for v2 worktree sessions');
		}

		const worktreeUri = vscode.Uri.file(worktreeProperties.worktreePath);

		// Rebase the worktree branch on top of the base branch
		await this.gitService.rebase(worktreeUri, worktreeProperties.baseBranchName);

		// Get the HEAD commit of the base branch after the rebase
		const repositoryUri = vscode.Uri.file(worktreeProperties.repositoryPath);
		const refs = await this.gitService.getRefs(repositoryUri, {
			pattern: `refs/heads/${worktreeProperties.baseBranchName}`
		});

		if (refs.length === 1 && refs[0].commit) {
			// Update baseCommit to the new HEAD of the base branch
			await this.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				baseCommit: refs[0].commit,
				changes: undefined
			});
		} else {
			// Clear the changes cache even if we couldn't determine the new HEAD
			await this.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				changes: undefined
			});
		}
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

		if (worktreeProperties.version === 2 && worktreeProperties.lastCheckpointRef !== undefined) {
			this.logService.trace(`[ChatSessionWorktreeService][handleRequestCompleted] Worktree supports checkpoints, skipping commit of worktree changes for session ${sessionId}`);
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

			// Delete worktree changes cache
			await this.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				changes: undefined
			});

			return;
		}

		let message: string | undefined;
		try {
			this.logService.trace(`[ChatSessionWorktreeService][handleRequestCompleted] Generating commit message for working directory ${worktreePath}. Repository state: ${JSON.stringify(repository.state)}`);
			message = await this.gitCommitMessageService.generateCommitMessage(repository, CancellationToken.None);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logService.error(`[ChatSessionWorktreeService][handleRequestCompleted] Error generating commit message for working directory ${worktreePath}. Repository state: ${JSON.stringify(repository.state)}. Error: ${errorMessage}`);
		}

		if (!message) {
			// Fallback commit message
			this.logService.warn(`[ChatSessionWorktreeService][handleRequestCompleted] Unable to generate commit message for working directory ${worktreePath}. Repository state: ${JSON.stringify(repository.state)}`);
			message = `Copilot CLI session ${sessionId} changes`;
		}

		// Commit the changes
		await this.gitService.commit(vscode.Uri.file(worktreePath), message, { all: true, noVerify: true, signCommit: false });
		this.logService.trace(`[ChatSessionWorktreeService] Committed all changes in working directory ${worktreePath}`);

		// Delete worktree changes cache
		await this.setWorktreeProperties(sessionId, {
			...worktreeProperties,
			changes: undefined
		});
	}
}
