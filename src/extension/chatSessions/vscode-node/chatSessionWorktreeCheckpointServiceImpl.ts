/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { Uri } from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IChatSessionWorktreeCheckpointService } from '../common/chatSessionWorktreeCheckpointService';
import { ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';


const CHECKPOINT_REF_PREFIX = 'refs/sessions/';

function getCheckpointRef(sessionId: string, turnNumber: number): string {
	return `${CHECKPOINT_REF_PREFIX}${sessionId}/checkpoints/turn/${turnNumber}`;
}

export class ChatSessionWorktreeCheckpointService extends Disposable implements IChatSessionWorktreeCheckpointService {
	declare _serviceBrand: undefined;

	constructor(
		@IChatSessionWorktreeService private readonly worktreeService: IChatSessionWorktreeService,
		@IGitService private readonly gitService: IGitService,
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
				firstCheckpointRef: checkpointRef,
				baseCheckpointRef: checkpointRef,
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
		const checkpointRef = await this._createCheckpoint(sessionId, worktreeProperties, currentTurn, latestCheckpointRef);

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
		return worktreeProperties?.version === 2 && worktreeProperties.autoCommit === false;
	}

	private async _getLatestCheckpointRef(sessionId: string): Promise<string | undefined> {
		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties || typeof worktreeProperties === 'string') {
			return undefined;
		}

		try {
			const refPattern = `${CHECKPOINT_REF_PREFIX}${sessionId}/checkpoints/turn/`;
			const refs = await this.gitService.exec(Uri.file(worktreeProperties.worktreePath), [
				'for-each-ref', '--sort=-committerdate', '--format=%(refname)', refPattern]);

			return refs ? refs.split('\n')[0] : undefined;
		} catch (error) {
			this.logService.error(`[ChatSessionWorktreeCheckpointService][_getLatestCheckpointRef] Failed to get latest checkpoint ref for session ${sessionId}: `, error);
			return undefined;
		}
	}

	private async _createCheckpoint(sessionId: string, worktreeProperties: ChatSessionWorktreeProperties, turnNumber: number, parentCheckpointRef?: string): Promise<string | undefined> {
		const worktreePathUri = Uri.file(worktreeProperties.worktreePath);
		const checkpointIndexFile = path.join(worktreeProperties.repositoryPath, '.git', `${worktreeProperties.branchName}/${generateUuid()}.index`);

		try {
			await fs.mkdir(path.dirname(checkpointIndexFile), { recursive: true });

			// Resolve parent checkpoint ref
			const parentCommitOid = parentCheckpointRef
				? await this.gitService.exec(worktreePathUri, ['rev-parse', parentCheckpointRef])
				: undefined;

			// Populate temp index from previous checkpoint tree (or HEAD for the baseline)
			await this.gitService.exec(worktreePathUri, ['read-tree', parentCommitOid ?? 'HEAD'], { GIT_INDEX_FILE: checkpointIndexFile });

			// Stage entire working directory into temp index
			await this.gitService.exec(worktreePathUri, ['add', '-A', '--', '.'], { GIT_INDEX_FILE: checkpointIndexFile });

			// Write the temp index as a tree object
			const treeOid = await this.gitService.exec(worktreePathUri, ['write-tree'], { GIT_INDEX_FILE: checkpointIndexFile });

			// Create a commit pointing to the tree, chained to the previous checkpoint
			const commitTreeArgs = ['commit-tree', treeOid, ...(parentCommitOid ? ['-p', parentCommitOid] : []), '-m', `Session ${sessionId} - checkpoint turn ${turnNumber}`];
			const commitOid = await this.gitService.exec(worktreePathUri, commitTreeArgs);

			// Point a new ref at the commit
			const checkpointRef = getCheckpointRef(sessionId, turnNumber);
			await this.gitService.exec(worktreePathUri, ['update-ref', checkpointRef, commitOid]);

			this.logService.trace(`[ChatSessionWorktreeCheckpointService][_createCheckpoint] Captured checkpoint turn ${turnNumber} for session ${sessionId} at ${checkpointRef}`);
			return checkpointRef;
		} catch (error) {
			this.logService.error(`[ChatSessionWorktreeCheckpointService][_createCheckpoint] Failed to capture checkpoint turn ${turnNumber} for session ${sessionId}: `, error);
			return undefined;
		} finally {
			await fs.rm(checkpointIndexFile, { recursive: true, force: true });
		}
	}
}
