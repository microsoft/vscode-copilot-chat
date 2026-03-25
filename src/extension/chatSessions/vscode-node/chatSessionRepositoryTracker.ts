/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { RepositoryState } from '../../../platform/git/vscode/git';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, DisposableMap, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { ICopilotCLIChatSessionItemProvider } from './copilotCLIChatSessions';

export class ChatSessionRepositoryTracker extends Disposable {
	private readonly trackers = new DisposableMap<string>();
	private readonly trackerRepositoryStates = new Map<string, RepositoryState>();

	constructor(
		private readonly sessionItemProvider: ICopilotCLIChatSessionItemProvider,
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

	private async onDidChangeWorkspaceFolders(e: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
		this.logService.trace(`[ChatSessionRepositoryTracker][onDidChangeWorkspaceFolders] Workspace folders changed. Added: ${e.added.map(f => f.uri.fsPath).join(', ')}, Removed: ${e.removed.map(f => f.uri.fsPath).join(', ')}`);

		// Add trackers for added workspace folders
		for (const added of e.added) {
			const sessionId = await this.worktreeService.getSessionIdForWorktree(added.uri);
			if (!sessionId) {
				continue;
			}

			await this.trackRepositoryChanges(sessionId);
		}

		// Dispose trackers for removed workspace folders
		for (const removed of e.removed) {
			this.disposeTracker(removed.uri.fsPath);
		}
	}

	private async trackRepositoryChanges(sessionId: string): Promise<void> {
		this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Tracking repository changes for session ${sessionId}.`);

		// Only track repository changes in the sessions app
		if (!vscode.workspace.isAgentSessionsWorkspace) {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Not the agent sessions workspace. Skipping repository tracking for session ${sessionId}.`);
			return;
		}

		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (!worktreeProperties) {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] No worktree properties found for session ${sessionId}.`);
			return;
		}

		const worktreePath = worktreeProperties.worktreePath;

		// Open the repository so that we can track state changes
		const worktreeRepositoryState = await this.gitService.getRepositoryState(vscode.Uri.file(worktreePath));
		if (!worktreeRepositoryState) {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] No repository state found for worktree ${worktreePath}.`);
			return;
		}

		if (this.trackers.has(worktreePath)) {
			const trackedRepositoryState = this.trackerRepositoryStates.get(worktreePath);

			// If the repository state is the same as the one we are already tracking,
			// do nothing. But if a new repository state is detected, which can happen
			// when the repository is reopened, we need to replace the tracker.
			if (trackedRepositoryState === worktreeRepositoryState) {
				this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Already tracking repository changes for session ${sessionId} and worktree ${worktreePath}.`);
				return;
			}

			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Replacing stale tracker for worktree ${worktreePath}.`);
			this.trackers.deleteAndDispose(worktreePath);
			this.trackerRepositoryStates.delete(worktreePath);
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

			await this.sessionItemProvider.refreshSession({ reason: 'update', sessionId });

			this.logService.trace(`[ChatSessionRepositoryTracker][trackRepositoryChanges] Worktree properties updated for session ${sessionId}. Notifying session item provider of sessions change.`);
		}));

		this.trackers.set(worktreePath, disposables);
		this.trackerRepositoryStates.set(worktreePath, worktreeRepositoryState);
	}

	private disposeTracker(worktreePath: string): void {
		if (!this.trackers.has(worktreePath)) {
			return;
		}

		this.logService.trace(`[ChatSessionRepositoryTracker][disposeTracker] Disposing tracker for removed workspace ${worktreePath}.`);

		this.trackers.deleteAndDispose(worktreePath);
		this.trackerRepositoryStates.delete(worktreePath);
	}

	override dispose(): void {
		this.trackers.dispose();
		this.trackerRepositoryStates.clear();

		super.dispose();
	}
}
