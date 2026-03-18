/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ChatSessionChangedFile2 } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { IGitService } from '../../../platform/git/common/gitService';
import { toGitUri } from '../../../platform/git/common/utils';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IChatSessionWorktreeCheckpointService } from '../common/chatSessionWorktreeCheckpointService';
import { ChatSessionWorktreeFile, ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';

const execFileAsync = promisify(execFile);

const CHECKPOINT_REF_PREFIX = 'refs/sessions/';

function isCheckpointsFeatureEnabled(configurationService: IConfigurationService): boolean {
	return configurationService.getConfig(ConfigKey.Advanced.CLICheckpointsEnabled);
}

function getCheckpointRef(sessionId: string, turnNumber: number): string {
	return `${CHECKPOINT_REF_PREFIX}${sessionId}/checkpoints/turn/${turnNumber}`;
}

export class ChatSessionWorktreeCheckpointService extends Disposable implements IChatSessionWorktreeCheckpointService {
	declare _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IGitExtensionService private readonly gitExtensionService: IGitExtensionService,
		@IGitService private readonly gitService: IGitService,
		@IChatSessionWorktreeService private readonly worktreeService: IChatSessionWorktreeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async handleRequest(sessionId: string): Promise<void> {
		const checkpointSupport = await this.getWorktreeCheckpointSupport(sessionId);
		if (!checkpointSupport) {
			this.logService.trace('[ChatSessionWorktreeCheckpointService][handleRequest] Worktree does not support checkpoints, skipping baseline checkpoint creation');
			return;
		}

		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties || typeof worktreeProperties === 'string' || worktreeProperties.version === 1) {
			this.logService.warn(`[ChatSessionWorktreeCheckpointService][handleRequest] No checkpoint properties found for session ${sessionId}, skipping baseline checkpoint creation`);
			return;
		}

		const latestCheckpointRef = await this._getLatestCheckpointRef(sessionId);
		if (latestCheckpointRef) {
			this.logService.trace(`[ChatSessionWorktreeCheckpointService][handleRequest] Found existing checkpoint ref ${latestCheckpointRef} for session ${sessionId}, skipping baseline checkpoint creation`);
			return;
		}

		// Initialize checkpoint state and capture baseline checkpoint
		const checkpointRef = await this._createCheckpoint(sessionId, worktreeProperties, 0);

		if (checkpointRef) {
			// Update worktree properties
			await this.worktreeService.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				lastCheckpointRef: checkpointRef
			});
		}
	}

	async handleRequestCompleted(sessionId: string): Promise<void> {
		const checkpointSupport = await this.getWorktreeCheckpointSupport(sessionId);
		if (!checkpointSupport) {
			this.logService.trace('[ChatSessionWorktreeCheckpointService][handleRequestCompleted] Worktree does not support checkpoints, skipping post-turn checkpoint');
			return;
		}

		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties || typeof worktreeProperties === 'string' || worktreeProperties.version === 1) {
			this.logService.warn(`[ChatSessionWorktreeCheckpointService][handleRequestCompleted] No checkpoint properties found for session ${sessionId}, skipping post-turn checkpoint`);
			return;
		}

		const latestCheckpointRef = await this._getLatestCheckpointRef(sessionId);
		if (!latestCheckpointRef) {
			this.logService.warn(`[ChatSessionWorktreeCheckpointService][handleRequestCompleted] No existing checkpoint ref found for session ${sessionId} on request completion, skipping post-turn checkpoint`);
			return;
		}

		// Create checkpoint
		const currentTurn = parseInt(latestCheckpointRef.split('/').pop() ?? '0') + 1;
		const checkpointRef = await this._createCheckpoint(sessionId, worktreeProperties, currentTurn);

		if (checkpointRef) {
			// Update worktree properties
			await this.worktreeService.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				changes: undefined,
				lastCheckpointRef: checkpointRef
			});
		}
	}

	async getWorktreeCheckpointSupport(sessionId: string): Promise<boolean> {
		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties || typeof worktreeProperties === 'string' || worktreeProperties.version === 1) {
			return false;
		}

		return worktreeProperties.version === 2 && (
			worktreeProperties.lastCheckpointRef !== undefined || isCheckpointsFeatureEnabled(this.configurationService));
	}

	async getWorktreeChanges(sessionId: string): Promise<readonly vscode.ChatSessionChangedFile2[] | undefined> {
		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties || typeof worktreeProperties === 'string') {
			return undefined;
		}

		// Return cached changes
		if (worktreeProperties.changes) {
			return worktreeProperties.changes
				.map(change => this._toChatSessionChangedFile2(sessionId, change, worktreeProperties));
		}

		try {
			// Ensure the initial repository discovery is completed and the repository
			// states are initialized in the vscode.git extension. This is needed as these
			// will be the repositories that we use to compute the worktree changes. We do
			// not have to open each worktree individually since the changes are committed
			// so we can get them from the main repository or discovered worktree.
			await this.gitService.initialize();

			// Legacy - these changes are staged in the worktree but not yet committed. Since
			// the changes are not committed, we need to get them from the worktree repository
			// state. To do that we need to open the worktree repository. The source control
			// provider will not be shown in the Source Control view since it is being hidden.
			if (worktreeProperties.version === 1 && worktreeProperties.autoCommit === false) {
				const changes = await this._getWorktreeChangesFromIndex(worktreeProperties) ?? [];
				await this.worktreeService.setWorktreeProperties(sessionId, {
					...worktreeProperties, changes
				});

				return changes.map(change => this._toChatSessionChangedFile2(sessionId, change, worktreeProperties));
			}

			// Checkpoints are not present for the session which means that following each turn
			// the changes are committed. We can use the commit history of the worktree branch
			// to compute the changes.
			if (worktreeProperties.version === 2 && !worktreeProperties.lastCheckpointRef) {
				const changes = await this._getWorktreeChangesFromCommits(worktreeProperties) ?? [];
				await this.worktreeService.setWorktreeProperties(sessionId, {
					...worktreeProperties, changes
				});

				return changes.map(change => this._toChatSessionChangedFile2(sessionId, change, worktreeProperties));
			}

			// Use checkpoints to compute the changes
			const changes = await this._getWorktreeChangesUsingCheckpoints(sessionId, worktreeProperties) ?? [];
			await this.worktreeService.setWorktreeProperties(sessionId, {
				...worktreeProperties, changes
			});

			return changes.map(change => this._toChatSessionChangedFile2(sessionId, change, worktreeProperties));
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logService.warn(`[ChatSessionWorktreeCheckpointService][getWorktreeChanges] Session ${sessionId}: error computing diff for committed changes, returning empty. Error: ${errorMessage}`);
			await this.worktreeService.setWorktreeProperties(sessionId, {
				...worktreeProperties, changes: []
			});

			return [];
		}
	}

	private async _getWorktreeChangesFromIndex(worktreeProperties: ChatSessionWorktreeProperties): Promise<readonly ChatSessionWorktreeFile[] | undefined> {
		const worktreePath = vscode.Uri.file(worktreeProperties.worktreePath);
		const worktreeRepository = await this.gitService.getRepository(worktreePath);

		if (!worktreeRepository?.changes) {
			return [];
		}

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

		return changes;
	}

	private async _getWorktreeChangesFromCommits(worktreeProperties: ChatSessionWorktreeProperties): Promise<readonly ChatSessionWorktreeFile[] | undefined> {
		// Open the main repository that contains the worktree. We have to open
		// the repository so that we can run do `git diff` against the repository
		// to get the committed changes in the worktree branch.
		const repository = await this.gitService.getRepository(vscode.Uri.file(worktreeProperties.repositoryPath));

		if (!repository) {
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
			return [];
		}

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

		return changes;
	}

	private async _getWorktreeChangesUsingCheckpoints(sessionId: string, worktreeProperties: ChatSessionWorktreeProperties): Promise<readonly ChatSessionWorktreeFile[] | undefined> {
		const firstCheckpointRef = getCheckpointRef(sessionId, 0);
		const lastCheckpointRef = await this._getLatestCheckpointRef(sessionId);
		if (!lastCheckpointRef) {
			this.logService.warn(`[ChatSessionWorktreeCheckpointService][_getWorktreeChangesUsingCheckpoints] No checkpoint ref found for session ${sessionId}, cannot determine in-progress changes`);
			return undefined;
		}

		// We need to open the worktree repository since we need access to the worktree repository's
		// working tree in order to compute the diff statistics against the latest checkpoint
		const worktreeRepository = await this.gitService.getRepository(vscode.Uri.file(worktreeProperties.worktreePath));

		if (!worktreeRepository) {
			this.logService.warn(`[ChatSessionWorktreeCheckpointService][_getWorktreeChangesUsingCheckpoints] Unable to open worktree repository for session ${sessionId} at path ${worktreeProperties.worktreePath}`);
			return undefined;
		}

		const diff = await this.gitService.diffBetweenWithStats2(
			worktreeRepository.rootUri, `${firstCheckpointRef}..${lastCheckpointRef}`);

		if (!diff) {
			return [];
		}

		const changes = diff.map(change => ({
			filePath: change.uri.fsPath,
			originalFilePath: change.status !== 1 /* INDEX_ADDED */
				? change.originalUri?.fsPath
				: undefined,
			modifiedFilePath: change.status !== 6 /* DELETED */
				? change.uri.fsPath
				: undefined,
			statistics: {
				additions: change.insertions,
				deletions: change.deletions
			}
		} satisfies ChatSessionWorktreeFile));

		return changes;
	}

	private async _getLatestCheckpointRef(sessionId: string): Promise<string | undefined> {
		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties || typeof worktreeProperties === 'string') {
			return undefined;
		}

		const gitPath = this._getGitPath();
		if (!gitPath) {
			this.logService.warn('[ChatSessionWorktreeCheckpointService][_getLatestCheckpointRef] Git binary path not available');
			return undefined;
		}

		try {
			const refPattern = `${CHECKPOINT_REF_PREFIX}${sessionId}/checkpoints/turn/`;
			const refs = await this._runGit(gitPath, worktreeProperties.worktreePath, [
				'for-each-ref', '--sort=-committerdate', '--format=%(refname)', refPattern]);

			return refs ? refs.split('\n')[0] : undefined;
		} catch (error) {
			this.logService.error(`[ChatSessionWorktreeCheckpointService][_getLatestCheckpointRef] Failed to get latest checkpoint ref for session ${sessionId}: `, error);
			return undefined;
		}
	}

	private async _createCheckpoint(sessionId: string, worktreeProperties: ChatSessionWorktreeProperties, turnNumber: number): Promise<string | undefined> {
		const gitPath = this._getGitPath();
		if (!gitPath) {
			this.logService.warn('[ChatSessionWorktreeCheckpointService][_createCheckpoint] Git binary path not available');
			return undefined;
		}

		const worktreePath = worktreeProperties.worktreePath;
		const checkpointIndexFile = path.join(worktreeProperties.repositoryPath, '.git', `${worktreeProperties.branchName}/${generateUuid()}.index`);

		try {
			await fs.mkdir(path.dirname(checkpointIndexFile), { recursive: true });

			// Populate temp index with HEAD tree
			await this._runGit(gitPath, worktreePath, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: checkpointIndexFile });

			// Stage entire working directory into temp index
			await this._runGit(gitPath, worktreePath, ['add', '-A', '--', '.'], { GIT_INDEX_FILE: checkpointIndexFile });

			// Write the temp index as a tree object
			const treeOid = await this._runGit(gitPath, worktreePath, ['write-tree'], { GIT_INDEX_FILE: checkpointIndexFile });

			// Create a parentless commit pointing to the tree
			const commitOid = await this._runGit(gitPath, worktreePath, ['commit-tree', treeOid, '-m', `Session ${sessionId} - checkpoint turn ${turnNumber}`]);

			// Point a new ref at the commit
			const checkpointRef = getCheckpointRef(sessionId, turnNumber);
			await this._runGit(gitPath, worktreePath, ['update-ref', checkpointRef, commitOid]);

			this.logService.trace(`[ChatSessionWorktreeCheckpointService][_createCheckpoint] Captured checkpoint turn ${turnNumber} for session ${sessionId} at ${checkpointRef}`);
			return checkpointRef;
		} catch (error) {
			this.logService.error(`[ChatSessionWorktreeCheckpointService][_createCheckpoint] Failed to capture checkpoint turn ${turnNumber} for session ${sessionId}: `, error);
			return undefined;
		} finally {
			await fs.rm(checkpointIndexFile, { recursive: true, force: true });
		}
	}

	private async _runGit(gitPath: string, cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
		const result = await execFileAsync(gitPath, args, {
			cwd,
			encoding: 'utf8',
			env: env ? { ...process.env, ...env } : undefined,
		});

		if (result.stderr) {
			this.logService.trace(`[ChatSessionWorktreeCheckpointService][_runGit] git ${args[0]} stderr: ${result.stderr.trim()}`);
		}

		return result.stdout.trim();
	}

	private _getGitPath(): string | undefined {
		return this.gitExtensionService.getExtensionApi()?.git.path;
	}

	private _toChatSessionChangedFile2(sessionId: string, change: ChatSessionWorktreeFile, worktreeProperties: ChatSessionWorktreeProperties): ChatSessionChangedFile2 {
		const originalFileRef = worktreeProperties.version === 2 && worktreeProperties.lastCheckpointRef
			? getCheckpointRef(sessionId, 0)
			: worktreeProperties.baseCommit;

		const modifiedFileRef = worktreeProperties.version === 2 && worktreeProperties.lastCheckpointRef
			? worktreeProperties.lastCheckpointRef
			: worktreeProperties.branchName;

		return new vscode.ChatSessionChangedFile2(
			vscode.Uri.file(change.filePath),
			change.originalFilePath
				? toGitUri(vscode.Uri.file(change.originalFilePath), originalFileRef)
				: undefined,
			change.modifiedFilePath
				? toGitUri(vscode.Uri.file(change.modifiedFilePath), modifiedFileRef)
				: undefined,
			change.statistics.additions,
			change.statistics.deletions);
	}
}
