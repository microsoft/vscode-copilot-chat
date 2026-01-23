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
import { toGitUri } from '../../../platform/git/common/utils';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { derived, IObservable } from '../../../util/vs/base/common/observable';
import * as path from '../../../util/vs/base/common/path';
import { basename, isEqual } from '../../../util/vs/base/common/resources';
import { ChatSessionWorktreeData, ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { isUntitledSessionId } from '../common/utils';

const CHAT_SESSION_WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';

export class ChatSessionWorktreeService extends Disposable implements IChatSessionWorktreeService {
	declare _serviceBrand: undefined;

	readonly isWorktreeSupportedObs: IObservable<boolean>;

	private _sessionWorktrees: Map<string, string | ChatSessionWorktreeProperties> = new Map();
	private _sessionWorktreeChanges: Map<string, vscode.ChatSessionChangedFile2[] | undefined> = new Map();
	private _sessionRepositories = new Map<string, RepoContext | undefined>();

	constructor(
		@IGitCommitMessageService private readonly gitCommitMessageService: IGitCommitMessageService,
		@IGitService private readonly gitService: IGitService,
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext
	) {
		super();
		this.loadWorktreeProperties();

		this.isWorktreeSupportedObs = derived(reader => {
			const activeRepository = this.gitService.activeRepository.read(reader);
			return activeRepository !== undefined;
		});
	}

	private loadWorktreeProperties(): void {
		const data = this.extensionContext.globalState.get<Record<string, string | ChatSessionWorktreeData>>(CHAT_SESSION_WORKTREE_MEMENTO_KEY, {});

		for (const [key, value] of Object.entries(data)) {
			if (typeof value === 'string') {
				// Legacy worktree path
				this._sessionWorktrees.set(key, value);
			} else {
				if (value.version === 1) {
					// Worktree properties v1
					this._sessionWorktrees.set(key, JSON.parse(value.data) satisfies ChatSessionWorktreeProperties);
				} else {
					this.logService.warn(`[ChatSessionWorktreeService][loadWorktreeProperties] Unsupported worktree properties version: ${value.version} for session ${key}`);
				}
			}
		}
	}

	getSessionRepository(sessionId: string): RepoContext | undefined {
		// For untitled sessions, if we have just one repo, then return that as the selected repo
		if (!this._sessionRepositories.get(sessionId) && isUntitledSessionId(sessionId) &&
			this.gitService.repositories
				.filter(repository => repository.kind !== 'worktree').length === 1) {
			return this.gitService.activeRepository.get();
		}
		return this._sessionRepositories.get(sessionId);
	}

	async deleteSessionRepository(sessionId: string) {
		this._sessionRepositories.delete(sessionId);
	}

	async setSessionRepository(sessionId: string, repositoryPath: string) {
		const repository = await this.gitService.getRepository(vscode.Uri.file(repositoryPath));
		this._sessionRepositories.set(sessionId, repository);
	}

	async createWorktree(sessionId: string | undefined, stream?: vscode.ChatResponseStream): Promise<ChatSessionWorktreeProperties | undefined> {
		if (!stream) {
			return this._createWorktree(sessionId);
		}

		return new Promise<ChatSessionWorktreeProperties | undefined>((resolve) => {
			stream.progress(l10n.t('Creating isolated worktree for Background Agent session...'), async progress => {
				const result = await this._createWorktree(sessionId, progress);
				resolve(result);
				if (result) {
					return l10n.t('Created isolated worktree at {0}', basename(vscode.Uri.file(result.worktreePath)));
				}
				return undefined;
			});
		});
	}

	private async _createWorktree(sessionId: string | undefined, progress?: vscode.Progress<vscode.ChatResponsePart>): Promise<ChatSessionWorktreeProperties | undefined> {
		try {
			const activeRepository = sessionId ? this.getSessionRepository(sessionId) : this.gitService.activeRepository.get();
			if (!activeRepository) {
				progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory')));
				this.logService.error('[ChatSessionWorktreeService][_createWorktree] No active repository found to create worktree for isolation.');
				return undefined;
			}

			const branchPrefix = vscode.workspace.getConfiguration('git').get<string>('branchPrefix') ?? '';
			const branch = `${branchPrefix}copilot-worktree-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
			const worktreePath = await this.gitService.createWorktree(activeRepository.rootUri, { branch });

			if (worktreePath && activeRepository.headCommitHash) {
				return {
					autoCommit: true,
					branchName: branch,
					baseCommit: activeRepository.headCommitHash,
					repositoryPath: activeRepository.rootUri.fsPath,
					worktreePath
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

	getWorktreeProperties(sessionId: string): ChatSessionWorktreeProperties | undefined {
		const properties = this._sessionWorktrees.get(sessionId);
		return typeof properties === 'string' ? undefined : properties;
	}

	async setWorktreeProperties(sessionId: string, properties: string | ChatSessionWorktreeProperties): Promise<void> {
		this._sessionWorktrees.set(sessionId, properties);

		const sessionWorktreesProperties = this.extensionContext.globalState.get<Record<string, string | ChatSessionWorktreeData>>(CHAT_SESSION_WORKTREE_MEMENTO_KEY, {});
		sessionWorktreesProperties[sessionId] = { data: JSON.stringify(properties), version: 1 };
		await this.extensionContext.globalState.update(CHAT_SESSION_WORKTREE_MEMENTO_KEY, sessionWorktreesProperties);
	}

	async getWorktreeRepository(sessionId: string): Promise<RepoContext | undefined> {
		const worktreeProperties = this._sessionWorktrees.get(sessionId);
		if (typeof worktreeProperties === 'string' || !worktreeProperties?.repositoryPath) {
			return undefined;
		}

		return this.gitService.getRepository(vscode.Uri.file(worktreeProperties.repositoryPath));
	}

	getWorktreePath(sessionId: string): vscode.Uri | undefined {
		const worktreeProperties = this._sessionWorktrees.get(sessionId);
		if (worktreeProperties === undefined) {
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
		const worktreeProperties = this.getWorktreeProperties(sessionId);

		if (worktreeProperties === undefined || worktreeProperties.autoCommit === false) {
			// Legacy background session that has the changes staged in the worktree.
			// To apply the changes, we need to migrate them from the worktree to the
			// main repository using a stash.
			const worktreePath = this.getWorktreePath(sessionId);
			if (!worktreePath) {
				return;
			}

			const activeRepository = worktreeProperties?.repositoryPath
				? await this.gitService.getRepository(vscode.Uri.file(worktreeProperties.repositoryPath))
				: this.gitService.activeRepository.get();

			if (!activeRepository) {
				return;
			}

			// Migrate the changes from the worktree to the main repository
			await this.gitService.migrateChanges(activeRepository.rootUri, worktreePath, {
				confirmation: false,
				deleteFromSource: false,
				untracked: true
			});

			// Clear worktree changes cache
			this._sessionWorktreeChanges.delete(sessionId);

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

		// Clear worktree changes cache
		this._sessionWorktreeChanges.delete(sessionId);
	}

	async getWorktreeChanges(sessionId: string): Promise<vscode.ChatSessionChangedFile2[] | undefined> {
		if (this._sessionWorktreeChanges.has(sessionId)) {
			return this._sessionWorktreeChanges.get(sessionId);
		}

		// Check whether the session has an associated worktree
		const worktreePath = this.getWorktreePath(sessionId);
		if (!worktreePath) {
			return undefined;
		}

		// Ensure the initial repository discovery is completed and the repository
		// states are initialized in the vscode.git extension. This is needed as these
		// will be the repositories that we use to compute the worktree changes. We do
		// not have to open each worktree individually since the changes are committed
		// so we can get them from the main repository or discovered worktree.
		await this.gitService.initialize();

		// Check whether the worktree belongs to any of the discovered repositories
		const repository = this.gitService.repositories
			.find(r => r.worktrees.some(w => isEqual(vscode.Uri.file(w.path), worktreePath)));

		if (!repository) {
			this._sessionWorktreeChanges.set(sessionId, undefined);
			return undefined;
		}

		// Get worktree properties
		const worktreeProperties = this.getWorktreeProperties(sessionId);

		if (worktreeProperties === undefined || worktreeProperties.autoCommit === false) {
			// These changes are staged in the worktree but not yet committed. Since the
			// changes are not committed, we need to get them from the worktree repository
			// state. To do that we need to open the worktree repository. The source control
			// provider will not be shown in the Source Control view since it is being hidden.
			const worktreeRepository = await this.gitService.getRepository(worktreePath);

			if (!worktreeRepository?.changes) {
				this._sessionWorktreeChanges.set(sessionId, []);
				return [];
			}

			const changes: vscode.ChatSessionChangedFile2[] = [];
			for (const change of [...worktreeRepository.changes.indexChanges, ...worktreeRepository.changes.workingTree]) {
				try {
					const fileStats = await this.gitService.diffIndexWithHEADShortStats(change.uri);
					changes.push(new vscode.ChatSessionChangedFile2(
						change.uri,
						change.status !== 1 /* INDEX_ADDED */
							? change.originalUri
							: undefined,
						change.status !== 2 /* INDEX_DELETED */
							? change.uri
							: undefined,
						fileStats?.insertions ?? 0,
						fileStats?.deletions ?? 0));
				} catch (error) { }
			}

			this._sessionWorktreeChanges.set(sessionId, changes);
			return changes;
		}

		// These changes are committed in the worktree branch but since they are
		// committed we can get the changes from the main repository and we do
		// not need to open the worktree repository.
		const diff = await this.gitService.diffBetweenWithStats(
			repository.rootUri,
			worktreeProperties.baseCommit,
			worktreeProperties.branchName);

		if (!diff) {
			this._sessionWorktreeChanges.set(sessionId, []);
			return [];
		}

		const changes = diff.map(change => {
			return new vscode.ChatSessionChangedFile2(
				change.uri,
				change.status !== 1 /* INDEX_ADDED */
					? toGitUri(change.originalUri, worktreeProperties.baseCommit)
					: undefined,
				change.status !== 6 /* DELETED */
					? toGitUri(change.uri, worktreeProperties.branchName)
					: undefined,
				change.insertions,
				change.deletions);
		});

		this._sessionWorktreeChanges.set(sessionId, changes);
		return changes;
	}

	async handleRequestCompleted(sessionId: string): Promise<void> {
		const worktreeProperties = this.getWorktreeProperties(sessionId);
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
		await this.gitService.commit(vscode.Uri.file(worktreePath), message);
		this.logService.trace(`[ChatSessionWorktreeService] Committed all changes in working directory ${worktreePath}`);

		// Delete worktree changes from cache
		this._sessionWorktreeChanges.delete(sessionId);
	}
}
