/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitService } from '../../../platform/git/common/gitService';
import { parseGitChangesRaw } from '../../../platform/git/vscode-node/utils';
import { DiffChange } from '../../../platform/git/vscode/git';
import { ILogService } from '../../../platform/log/common/logService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { SequencerByKey } from '../../../util/vs/base/common/async';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap, ResourceSet } from '../../../util/vs/base/common/map';
import * as path from '../../../util/vs/base/common/path';
import { isEqual } from '../../../util/vs/base/common/resources';
import { generateUuid } from '../../../util/vs/base/common/uuid';
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
	private recentFolders: { folder: vscode.Uri; lastAccessTime: number }[] = [];
	private readonly deletedFolders = new ResourceSet();
	private readonly workspaceChangesSequencer = new SequencerByKey<string>();

	constructor(
		@IGitService private readonly gitService: IGitService,
		@ILogService private readonly logService: ILogService,
		@IChatSessionMetadataStore private readonly metadataStore: IChatSessionMetadataStore,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();
	}

	public async deleteRecentFolder(folder: vscode.Uri): Promise<void> {
		this.recentFolders = this.recentFolders.filter(entry => !isEqual(entry.folder, folder));
		this.deletedFolders.add(folder);
	}

	public async getRecentFolders(): Promise<{ folder: vscode.Uri; lastAccessTime: number }[]> {
		const items = await this.metadataStore.getUsedWorkspaceFolders();
		this.recentFolders = coalesce(items.map(item => {
			if (!item.folderPath) {
				return;
			}
			const folder = vscode.Uri.file(item.folderPath);
			if (this.deletedFolders.has(folder)) {
				return;
			}
			return {
				folder,
				lastAccessTime: item.timestamp
			};
		})).sort((a, b) => b.lastAccessTime - a.lastAccessTime);
		return this.recentFolders;
	}
	async deleteTrackedWorkspaceFolder(sessionId: string): Promise<void> {
		this.workspaceState.delete(sessionId);
		await this.metadataStore.deleteSessionMetadata(sessionId);
	}

	async trackSessionWorkspaceFolder(sessionId: string, workspaceFolderUri: string, repositoryFolderUri?: string): Promise<void> {
		const entry: WorkspaceFolderEntry = {
			folderPath: workspaceFolderUri,
			repositoryPath: repositoryFolderUri,
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
		// Clear changes cache
		this.workspaceFolderChanges.delete(workspaceFolderUri);
	}

	async getWorkspaceChanges(workspaceFolderUri: vscode.Uri): Promise<readonly ChatSessionWorktreeFile[] | undefined> {
		return this.workspaceChangesSequencer.queue(workspaceFolderUri.toString(), async () => {

			const cachedChanges = this.workspaceFolderChanges.get(workspaceFolderUri);
			if (cachedChanges) {
				return cachedChanges;
			}

			const repository = await this.gitService.getRepository(workspaceFolderUri);
			if (!repository?.changes) {
				return [];
			}

			// Check for untracked changes
			const hasUntrackedChanges = [
				...repository.changes?.workingTree ?? [],
				...repository.changes?.untrackedChanges ?? [],
			].some(change => change.status === 7 /* UNTRACKED */);

			const diffChanges: DiffChange[] = [];

			if (hasUntrackedChanges) {
				// Tracked + untracked changes
				const tmpDirName = `vscode-sessions-${generateUuid()}`;
				const diffIndexFile = path.join(this.extensionContext.globalStorageUri.fsPath, tmpDirName, 'diff.index');

				try {
					// Create temp index file directory
					await fs.mkdir(path.dirname(diffIndexFile), { recursive: true });

					// Populate temp index from HEAD
					await this.gitService.exec(repository.rootUri, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: diffIndexFile });

					// Stage entire working directory into temp index
					await this.gitService.exec(repository.rootUri, ['add', '-A', '--', '.'], { GIT_INDEX_FILE: diffIndexFile });

					// Diff the temp index with the base branch
					const result = await this.gitService.exec(repository.rootUri, ['diff', '--cached', '--raw', '--numstat', '--diff-filter=ADMR', '-z', '--'], { GIT_INDEX_FILE: diffIndexFile });
					diffChanges.push(...parseGitChangesRaw(repository.rootUri.fsPath, result));
				} catch (error) {
					this.logService.error(`[ChatSessionWorkspaceFolderService][getWorkspaceChanges] Error while processing workspace changes: ${error}`);
					return [];
				} finally {
					try {
						await fs.rm(path.dirname(diffIndexFile), { recursive: true, force: true });
					} catch (error) {
						this.logService.error(`[ChatSessionWorkspaceFolderService][getWorkspaceChanges] Error while cleaning up temp index file: ${error}`);
					}
				}
			} else {
				// Tracked changes
				const result = await this.gitService.exec(repository.rootUri, ['diff', '--raw', '--numstat', '--diff-filter=ADMR', '-z', '--']);
				diffChanges.push(...parseGitChangesRaw(repository.rootUri.fsPath, result));
			}

			const changes = diffChanges.map(change => ({
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

			this.workspaceFolderChanges.set(workspaceFolderUri, changes);
			return changes;
		});
	}

	clearWorkspaceChanges(workspaceFolderUri: vscode.Uri): void {
		this.workspaceFolderChanges.delete(workspaceFolderUri);
	}
}
