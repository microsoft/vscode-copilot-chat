/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { IChatSessionWorktreeCheckpointService } from '../common/chatSessionWorktreeCheckpointService';
import { IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { CopilotCLIChatSessionItemProvider } from './copilotCLIChatSessionsContribution';

export class ChatSessionRepositoryTracker extends Disposable {
	private readonly trackers = new DisposableMap<string>();
	private readonly trackersRefCount = new Map<string, number>();

	constructor(
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
		@IChatSessionWorktreeCheckpointService private readonly checkpointService: IChatSessionWorktreeCheckpointService,
		@IChatSessionWorktreeService private readonly worktreeService: IChatSessionWorktreeService,
		@IGitService private readonly gitService: IGitService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Only track repository changes in the sessions app
		if (vscode.workspace.isAgentSessionsWorkspace) {
			this.logService.trace('[ChatSessionRepositoryTracker][constructor] Initializing workspace folder event handler');
			this._register(vscode.workspace.onDidChangeWorkspaceFolders(e => this.onDidChangeWorkspaceFolders(e)));
		}
	}

	async trackRepositoryChanges(sessionId: string): Promise<IDisposable> {
		this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Tracking repository changes for session ${sessionId}.`);

		// Only track repository changes in the sessions app
		if (!vscode.workspace.isAgentSessionsWorkspace) {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Not the agent sessions workspace. Skipping repository tracking for session ${sessionId}.`);
			return toDisposable(() => { });
		}

		// 
		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties) {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] No worktree properties found for session ${sessionId}.`);
			return toDisposable(() => { });
		}

		// Only track repository changes when the session supports worktree checkpoints
		if (!(await this.checkpointService.getWorktreeCheckpointSupport(sessionId))) {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Session does not support worktree checkpoints. Skipping repository tracking for session ${sessionId}.`);
			return toDisposable(() => { });
		}

		// Open the repository so that we can track state changes
		const worktreePath = worktreeProperties.worktreePath;
		const worktreeRepositoryState = await this.gitService.getRepositoryState(vscode.Uri.file(worktreePath));
		if (!worktreeRepositoryState) {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] No repository state found for worktree ${worktreePath}.`);
			return toDisposable(() => { });
		}

		if (this.trackers.has(worktreePath)) {
			const refCount = this.trackersRefCount.get(worktreePath) ?? 0;
			this.trackersRefCount.set(worktreePath, refCount + 1);

			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Already tracking repository changes for worktree ${worktreePath}. Incrementing ref count to ${refCount + 1}.`);
			return toDisposable(() => this.disposeTracker(worktreePath));
		}

		// Setup event listeners to track changes in the worktree repository in order to
		// update the worktree properties (ex: changes) while the session is in progress
		const disposables = new DisposableStore();

		// Repository state changes. The event will fire every single
		// time `git status` is being run in the worktree repository.
		disposables.add(worktreeRepositoryState.onDidChange(async () => {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Repository state changed for worktree ${worktreePath}. Updating worktree properties.`);

			const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
			if (!worktreeProperties) {
				this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] No worktree properties found for session ${sessionId}.`);
				return;
			}

			await this.worktreeService.setWorktreeProperties(sessionId, {
				...worktreeProperties,
				changes: undefined
			});

			this.sessionItemProvider.notifySessionsChange();
			await this.sessionItemProvider.refreshSession({ reason: 'update', sessionId });

			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Worktree properties updated for session ${sessionId}. Notifying session item provider of sessions change.`);
		}));

		this.trackers.set(worktreePath, disposables);
		this.trackersRefCount.set(worktreePath, 1);

		return toDisposable(() => this.disposeTracker(worktreePath));
	}

	private async onDidChangeWorkspaceFolders(e: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
		this.logService.trace(`[ChatSessionRepositoryTracker][onDidChangeWorkspaceFolders] Workspace folders changed. Added: ${e.added.map(f => f.uri.fsPath).join(', ')}, Removed: ${e.removed.map(f => f.uri.fsPath).join(', ')}`);

		// Add trackers for added workspace folders
		for (const added of e.added) {
			const sessionId = await this.worktreeService.getSessionIdForWorktree(added.uri);
			if (sessionId) {
				await this.trackRepositoryChanges(sessionId);
			}
		}

		// Dispose trackers for removed workspace folders
		for (const removed of e.removed) {
			this.disposeTracker(removed.uri.fsPath);
		}
	}

	private disposeTracker(worktreePath: string): void {
		const refCount = this.trackersRefCount.get(worktreePath);
		if (!refCount) {
			return;
		}

		this.logService.trace(`[ChatSessionRepositoryTracker][disposeTracker] Disposing tracker for worktree ${worktreePath}. Ref count: ${refCount}.`);

		if (refCount === 1) {
			this.trackersRefCount.delete(worktreePath);
			this.trackers.deleteAndDispose(worktreePath);
		} else {
			this.trackersRefCount.set(worktreePath, refCount - 1);
		}
	}

	override dispose(): void {
		this.trackers.dispose();
		this.trackersRefCount.clear();

		super.dispose();
	}
}