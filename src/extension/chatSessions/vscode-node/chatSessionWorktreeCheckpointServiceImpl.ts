/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IGitExtensionService } from '../../../platform/git/common/gitExtensionService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IChatSessionWorktreeCheckpointService } from '../common/chatSessionWorktreeCheckpointService';
import { ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';

const execFileAsync = promisify(execFile);

const CHECKPOINT_REF_PREFIX = 'refs/vscode-sessions/';

function isCheckpointsFeatureEnabled(configurationService: IConfigurationService): boolean {
	return configurationService.getConfig(ConfigKey.Advanced.CLICheckpointsEnabled);
}

export class ChatSessionWorktreeCheckpointService extends Disposable implements IChatSessionWorktreeCheckpointService {
	declare _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IGitExtensionService private readonly gitExtensionService: IGitExtensionService,
		@IChatSessionWorktreeService private readonly worktreeService: IChatSessionWorktreeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async handleRequest(sessionId: string): Promise<void> {
		if (!isCheckpointsFeatureEnabled(this.configurationService)) {
			this.logService.trace('[ChatSessionWorktreeCheckpointService][handleRequest] Checkpoints feature is disabled, skipping checkpoint handling');
			return;
		}

		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties || typeof worktreeProperties === 'string') {
			return;
		}

		const latestCheckpointRef = await this._getLatestCheckpointRef(sessionId);
		if (latestCheckpointRef) {
			this.logService.trace(`[ChatSessionWorktreeCheckpointService][handleRequest] Found existing checkpoint ref ${latestCheckpointRef} for session ${sessionId}, skipping baseline capture`);
			return;
		}

		// Initialize checkpoint state and capture baseline checkpoint
		await this._createCheckpoint(sessionId, worktreeProperties, 0);
	}

	async handleRequestCompleted(sessionId: string): Promise<void> {
		if (!isCheckpointsFeatureEnabled(this.configurationService)) {
			this.logService.trace('[ChatSessionWorktreeCheckpointService][handleRequestCompleted] Checkpoints feature is disabled, skipping checkpoint handling');
			return;
		}

		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties || typeof worktreeProperties === 'string') {
			return;
		}

		const latestCheckpointRef = await this._getLatestCheckpointRef(sessionId);
		if (!latestCheckpointRef) {
			this.logService.warn(`[ChatSessionWorktreeCheckpointService][handleRequestCompleted] No existing checkpoint ref found for session ${sessionId} on request completion, skipping post-turn checkpoint`);
			return;
		}

		// Advance turn and capture post-turn checkpoint
		const turnNumberStr = latestCheckpointRef.split('/').pop() ?? '0';
		await this._createCheckpoint(sessionId, worktreeProperties, parseInt(turnNumberStr, 10) + 1);
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

	private async _createCheckpoint(sessionId: string, worktreeProperties: ChatSessionWorktreeProperties, turnNumber: number): Promise<void> {
		const gitPath = this._getGitPath();
		if (!gitPath) {
			this.logService.warn('[ChatSessionWorktreeCheckpointService][_createCheckpoint] Git binary path not available');
			return;
		}

		const worktreePath = worktreeProperties.worktreePath;
		const turnIndexFile = path.join(worktreeProperties.repositoryPath, '.git', `${worktreeProperties.branchName}/${generateUuid()}.index`);

		try {
			await fs.mkdir(path.dirname(turnIndexFile), { recursive: true });

			const ref = `${CHECKPOINT_REF_PREFIX}${sessionId}/checkpoints/turn/${turnNumber}`;

			// 1. Populate temp index with HEAD tree
			await this._runGit(gitPath, worktreePath, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: turnIndexFile });

			// 2. Stage entire working directory into temp index
			await this._runGit(gitPath, worktreePath, ['add', '-A', '--', '.'], { GIT_INDEX_FILE: turnIndexFile });

			// 3. Write the temp index as a tree object
			const treeOid = await this._runGit(gitPath, worktreePath, ['write-tree'], { GIT_INDEX_FILE: turnIndexFile });

			// 4. Create a parentless commit pointing to that tree
			const commitOid = await this._runGit(gitPath, worktreePath, ['commit-tree', treeOid, '-m', `Session ${sessionId} - checkpoint turn ${turnNumber}`]);

			// 5. Point a hidden ref at the commit
			await this._runGit(gitPath, worktreePath, ['update-ref', ref, commitOid]);

			this.logService.trace(`[ChatSessionWorktreeCheckpointService][_createCheckpoint] Captured checkpoint turn ${turnNumber} for session ${sessionId} at ${ref}`);
		} catch (error) {
			this.logService.error(`[ChatSessionWorktreeCheckpointService][_createCheckpoint] Failed to capture checkpoint turn ${turnNumber} for session ${sessionId}: `, error);
		} finally {
			await fs.rm(turnIndexFile, { recursive: true, force: true });
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
}
