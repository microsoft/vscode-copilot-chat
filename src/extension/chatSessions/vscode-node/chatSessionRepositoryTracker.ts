/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { RepositoryState } from '../../../platform/git/vscode/git';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, DisposableMap, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IChatSessionMetadataStore } from '../common/chatSessionMetadataStore';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { ICopilotCLIChatSessionItemProvider } from './copilotCLIChatSessions';

export class ChatSessionRepositoryTracker extends Disposable {
	private readonly trackers = new DisposableMap<string>();
	private readonly repositories = new Map<string, RepositoryState>();

	constructor(
		private readonly sessionItemProvider: ICopilotCLIChatSessionItemProvider,
		@IChatSessionMetadataStore private readonly metadataStore: IChatSessionMetadataStore,
		@IChatSessionWorktreeService private readonly worktreeService: IChatSessionWorktreeService,
		@IChatSessionWorkspaceFolderService private readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
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

		// Add trackers
		for (const added of e.added) {
			await this.trackFolderChanges(added.uri);
		}

		// Dispose trackers
		for (const removed of e.removed) {
			this.disposeFolderTracker(removed.uri);
		}
	}

	private async trackFolderChanges(uri: vscode.Uri): Promise<void> {
		this.logService.trace(`[ChatSessionRepositoryTracker][trackFolderChanges] Tracking file changes for ${uri.toString()}.`);

		// Open the repository so that we can track state changes
		const repositoryState = await this.gitService.getRepositoryState(uri);
		if (!repositoryState) {
			this.logService.trace(`[ChatSessionRepositoryTracker][trackFolderChanges] No repository state found for ${uri.toString()}.`);
			return;
		}

		if (this.repositories.has(uri.fsPath)) {
			const trackedRepositoryState = this.repositories.get(uri.fsPath);

			// If the repository state is the same as the one we are already tracking,
			// do nothing. But if a new repository state is detected, which can happen
			// when the repository is reopened, we need to replace the tracker.
			if (trackedRepositoryState === repositoryState) {
				this.logService.trace(`[ChatSessionRepositoryTracker][trackFolderChanges] Already tracking changes for ${uri.toString()}.`);
				return;
			}

			this.logService.trace(`[ChatSessionRepositoryTracker][trackFolderChanges] Replacing stale tracker for ${uri.toString()}.`);
			this.trackers.deleteAndDispose(uri.fsPath);
			this.repositories.delete(uri.fsPath);
		}

		// Setup event listeners to track changes in the worktree repository in order to
		// update the worktree properties (ex: changes) while the session is in progress
		const disposables = new DisposableStore();

		// Repository state changes. The event will fire every single
		// time `git status` is being run in the worktree repository.
		disposables.add(repositoryState.onDidChange(async () =>
			await this.onDidChangeRepositoryState(uri)));

		this.trackers.set(uri.fsPath, disposables);
		this.repositories.set(uri.fsPath, repositoryState);
	}

	private async onDidChangeRepositoryState(uri: vscode.Uri): Promise<void> {
		this.logService.trace(`[ChatSessionRepositoryTracker][onDidChangeRepositoryState] Repository state changed for ${uri.toString()}. Updating worktree properties.`);

		const worktreeSessionId = await this.worktreeService.getSessionIdForWorktree(uri);
		const workspaceSessionIds = await this.metadataStore.getSessionIdForWorkspaceFolder(uri);

		if (worktreeSessionId) {
			// Worktree
			const worktreeProperties = await this.worktreeService.getWorktreeProperties(worktreeSessionId);
			if (!worktreeProperties) {
				this.logService.trace(`[ChatSessionRepositoryTracker][onDidChangeRepositoryState] No worktree properties found for session ${worktreeSessionId}.`);
				return;
			}

			await this.worktreeService.setWorktreeProperties(worktreeSessionId, {
				...worktreeProperties,
				changes: undefined
			});

			await this.sessionItemProvider.refreshSession({ reason: 'update', sessionId: worktreeSessionId });
		} else if (workspaceSessionIds.length > 0) {
			// Workspace
			this.workspaceFolderService.clearWorkspaceChanges(uri);

			// This is still using the old ChatSessionItem API so there is no need to refresh each session
			// associated with the workspace folder. When the new controller API is fully adopted we will
			// have to refresh each session.
			await this.sessionItemProvider.refreshSession({ reason: 'update', sessionId: '' });
		} else {
			this.logService.trace(`[ChatSessionRepositoryTracker][onDidChangeRepositoryState] No session associated with ${uri.toString()}.`);
		}
	}

	private disposeFolderTracker(uri: vscode.Uri): void {
		if (!this.trackers.has(uri.fsPath)) {
			return;
		}

		this.logService.trace(`[ChatSessionRepositoryTracker][disposeFolderTracker] Disposing tracker for ${uri.toString()}.`);

		this.trackers.deleteAndDispose(uri.fsPath);
		this.repositories.delete(uri.fsPath);
	}

	override dispose(): void {
		this.trackers.dispose();
		this.repositories.clear();

		super.dispose();
	}
}
