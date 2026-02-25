/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { IChatSessionMetadataStore, WorkspaceFolderEntry } from '../common/chatSessionMetadataStore';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { ChatSessionWorktreeFile } from '../common/chatSessionWorktreeService';

/**
 * Service for tracking workspace folder selections for chat sessions.
 * This is used in multi-root workspaces where some folders may not have git repositories.
 */
export class ChatSessionWorkspaceFolderService extends Disposable implements IChatSessionWorkspaceFolderService {
	declare _serviceBrand: undefined;

	private readonly workspaceFolderChanges = new ResourceMap<ChatSessionWorktreeFile[]>();
	private readonly workspaceState = new Map<string, WorkspaceFolderEntry>();
	constructor(
		@IGitService private readonly gitService: IGitService,
		@ILogService private readonly logService: ILogService,
		@IChatSessionMetadataStore private readonly metadataStore: IChatSessionMetadataStore,
	) {
		super();
	}

	public async deleteRecentFolder(folder: vscode.Uri): Promise<void> {
		// TODO: Need to re-vist this.
	}

	public async getRecentFolders(): Promise<{ folder: vscode.Uri; lastAccessTime: number }[]> {
		const items = await this.metadataStore.getUsedWorkspaceFolders();
		return coalesce(items.map(item => {
			if (!item.folderPath) {
				return;
			}
			return {
				folder: vscode.Uri.file(item.folderPath ?? ''),
				lastAccessTime: item.timestamp
			};
		})).sort((a, b) => b.lastAccessTime - a.lastAccessTime);
	}
	async deleteTrackedWorkspaceFolder(sessionId: string): Promise<void> {
		this.workspaceState.delete(sessionId);
		await this.metadataStore.deleteSessionMetadata(sessionId);
	}

	async trackSessionWorkspaceFolder(sessionId: string, workspaceFolderUri: string): Promise<void> {
		const entry: WorkspaceFolderEntry = {
			folderPath: workspaceFolderUri,
			timestamp: Date.now()
		};
		this.workspaceState.set(sessionId, entry);
		this.metadataStore.storeWorkspaceFolderInfo(sessionId, entry);
		this.logService.trace(`[ChatSessionWorkspaceFolderService] Tracked workspace folder ${workspaceFolderUri} for session ${sessionId}`);
	}

	async getSessionWorkspaceFolder(sessionId: string): Promise<vscode.Uri | undefined> {
		const entry = this.workspaceState.get(sessionId);
		if (entry?.folderPath) {
			return vscode.Uri.file(entry.folderPath);
		}
		return await this.metadataStore.getSessionWorkspaceFolder(sessionId);
	}

	async handleRequestCompleted(workspaceFolderUri: vscode.Uri): Promise<void> {
		// Stage all changes
		await this.gitService.add(workspaceFolderUri, []);

		// Clear changes cache
		this.workspaceFolderChanges.delete(workspaceFolderUri);
	}

	async getWorkspaceChanges(workspaceFolderUri: vscode.Uri, sessionId: string): Promise<readonly ChatSessionWorktreeFile[] | undefined> {
		this.logService.trace(`[ChatSessionWorkspaceFolderService ${sessionId}][getWorkspaceChanges] Getting changes for workspace folder ${workspaceFolderUri.toString()}`);

		const cachedChanges = this.workspaceFolderChanges.get(workspaceFolderUri);
		if (cachedChanges) {
			this.logService.trace(`[ChatSessionWorkspaceFolderService ${sessionId}][getWorkspaceChanges] Returning ${cachedChanges.length} cached change(s) for ${workspaceFolderUri.toString()}`);
			return cachedChanges;
		}

		const repository = await this.gitService.getRepository(workspaceFolderUri);
		if (!repository?.changes) {
			this.logService.trace(`[ChatSessionWorkspaceFolderService ${sessionId}][getWorkspaceChanges] No repository or no changes found for ${workspaceFolderUri.toString()}`);
			return [];
		}

		this.logService.trace(`[ChatSessionWorkspaceFolderService ${sessionId}][getWorkspaceChanges] Repository found for ${workspaceFolderUri.toString()}: indexChanges=${repository.changes.indexChanges.length}, workingTree=${repository.changes.workingTree.length}`);

		const changes: ChatSessionWorktreeFile[] = [];
		for (const change of [...repository.changes.indexChanges, ...repository.changes.workingTree]) {
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

		this.logService.trace(`[ChatSessionWorkspaceFolderService ${sessionId}][getWorkspaceChanges] Computed ${changes.length} change(s) for ${workspaceFolderUri.toString()}`);

		this.workspaceFolderChanges.set(workspaceFolderUri, changes);
		return changes;
	}
}
