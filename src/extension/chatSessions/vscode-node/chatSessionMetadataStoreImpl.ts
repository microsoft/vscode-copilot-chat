/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { ThrottledDelayer } from '../../../util/vs/base/common/async';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { dirname, isEqual } from '../../../util/vs/base/common/resources';
import { ChatSessionMetadataFile, IChatSessionMetadataStore, WorkspaceFolderEntry } from '../common/chatSessionMetadataStore';
import { ChatSessionWorktreeData, ChatSessionWorktreeProperties } from '../common/chatSessionWorktreeService';
import { getCopilotCLISessionStateDir } from '../copilotcli/node/cliHelpers';

const WORKSPACE_FOLDER_MEMENTO_KEY = 'github.copilot.cli.sessionWorkspaceFolders';
const WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';
const BULK_METADATA_FILENAME = 'copilotcli.session.metadata.json';

export class ChatSessionMetadataStore extends Disposable implements IChatSessionMetadataStore {
	declare _serviceBrand: undefined;
	private _cache: Record<string, ChatSessionMetadataFile> = {};
	private readonly _sessionStateDir: Uri;

	private readonly _cacheDirectory: Uri;
	private readonly _cacheFile: Uri;
	private readonly _intialize: Lazy<Promise<void>>;
	private readonly _updateStorageDebouncer = this._register(new ThrottledDelayer<void>(1_000));
	constructor(
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();

		this._sessionStateDir = Uri.file(getCopilotCLISessionStateDir());
		this._cacheDirectory = Uri.joinPath(this.extensionContext.globalStorageUri, 'copilotcli');
		this._cacheFile = Uri.joinPath(this._cacheDirectory, BULK_METADATA_FILENAME);
		this._intialize = new Lazy<Promise<void>>(this.initializeStorage.bind(this));
		this._intialize.value.catch(error => {
			this.logService.error('[ChatSessionMetadataStore] Initialization failed: ', error);
		});
	}

	private async initializeStorage(): Promise<void> {
		try {
			this._cache = await this.getGlobalStorageData();
			// In case user closed vscode early or we couldn't save the session information for some reason.
			for (const [sessionId, metadata] of Object.entries(this._cache)) {
				if (sessionId.startsWith('untitled-')) {
					delete this._cache[sessionId];
					continue;
				}
				if (!metadata.writtenToDisc) {
					if ((metadata.workspaceFolder || metadata.worktreeProperties)) {
						this.updateSessionMetadata(sessionId, metadata, false).catch(ex => {
							this.logService.error(ex, `[ChatSessionMetadataStore] Failed to write metadata for session ${sessionId} to session state: `);
						});
					} else {
						// invalid data, we don't need this in our cache.
						delete this._cache[sessionId];
					}
				}
			}
			// Dont' exit from here, keep reaading from global storage.
			// Possible we had a bug and we missed writing some metadata to disc.
		} catch {
			//
		}

		let cacheUpdated = false;
		// Collect workspace folder entries from global state
		const workspaceFolderData = this.extensionContext.globalState.get<Record<string, Partial<WorkspaceFolderEntry>>>(WORKSPACE_FOLDER_MEMENTO_KEY, {});
		for (const [sessionId, entry] of Object.entries(workspaceFolderData)) {
			if (typeof entry === 'string' || !entry.folderPath || !entry.timestamp) {
				continue;
			}
			if (sessionId.startsWith('untitled-')) {
				continue;
			}
			if (sessionId in this._cache && this._cache[sessionId].workspaceFolder) {
				continue;
			}
			cacheUpdated = true;
			this._cache[sessionId] = { workspaceFolder: { folderPath: entry.folderPath, timestamp: entry.timestamp } };
		}

		// Collect worktree entries from global state
		const worktreeData = this.extensionContext.globalState.get<Record<string, string | ChatSessionWorktreeData>>(WORKTREE_MEMENTO_KEY, {});
		for (const [sessionId, value] of Object.entries(worktreeData)) {
			if (typeof value === 'string') {
				continue;
			}
			if (sessionId.startsWith('untitled-')) {
				continue;
			}
			if (sessionId in this._cache && this._cache[sessionId].worktreeProperties) {
				const parsedData: ChatSessionWorktreeProperties = value.version === 1 ? { ...JSON.parse(value.data), version: 1 } : JSON.parse(value.data);
				const changesInFileStorage = this._cache[sessionId].worktreeProperties?.changes;
				const changesInGlobalState = parsedData.changes;
				// There was a bug that resulted in changes not being written to file storage, but they were written to global state.
				// In that case we want to keep the changes from global state, otherwise we might lose data.
				if ((changesInGlobalState || []).length === (changesInFileStorage || []).length) {
					continue;
				}
			}
			cacheUpdated = true;
			{
				const parsedData: ChatSessionWorktreeProperties = value.version === 1 ? { ...JSON.parse(value.data), version: 1 } : JSON.parse(value.data);
				this._cache[sessionId] = { ...this._cache[sessionId], workspaceFolder: undefined, worktreeProperties: parsedData, writtenToDisc: false };
			}
		}

		for (const [sessionId, metadata] of Object.entries(this._cache)) {
			// These promises can run in background and no need to wait for them.
			// Even if user exits early we have all the data in the global storage and we'll restore from that next time.
			if (!metadata.writtenToDisc) {
				if ((metadata.workspaceFolder || metadata.worktreeProperties)) {
					this.updateSessionMetadata(sessionId, metadata, false).catch(ex => {
						this.logService.error(ex, `[ChatSessionMetadataStore] Failed to write metadata for session ${sessionId} to session state: `);
					});
				}
			}
		}

		if (cacheUpdated) {
			// Writing to file is most important.
			await this.writeToGlobalStorage(this._cache);
		}

		// To be enabled after testing. So we dont' blow away the data.
		// this.extensionContext.globalState.update(WORKSPACE_FOLDER_MEMENTO_KEY, undefined);
		// this.extensionContext.globalState.update(WORKTREE_MEMENTO_KEY, undefined);
	}

	private getMetadataFileUri(sessionId: string): vscode.Uri {
		return Uri.joinPath(this._sessionStateDir, sessionId, 'vscode.metadata.json');
	}

	async deleteSessionMetadata(sessionId: string): Promise<void> {
		await this._intialize.value;
		if (sessionId in this._cache) {
			delete this._cache[sessionId];
			const data = await this.getGlobalStorageData();
			delete data[sessionId];
			await this.writeToGlobalStorage(data);
		}
	}

	async storeWorktreeInfo(sessionId: string, properties: ChatSessionWorktreeProperties): Promise<void> {
		await this._intialize.value;
		const metadata: ChatSessionMetadataFile = { worktreeProperties: properties };
		this._cache[sessionId] = metadata;
		await this.updateSessionMetadata(sessionId, metadata);
		this.updateGlobalStorage();
	}

	async storeWorkspaceFolderInfo(sessionId: string, entry: WorkspaceFolderEntry): Promise<void> {
		await this._intialize.value;
		const metadata: ChatSessionMetadataFile = { workspaceFolder: entry };
		this._cache[sessionId] = metadata;
		await this.updateSessionMetadata(sessionId, metadata);
		this.updateGlobalStorage();
	}

	getWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties | undefined>;
	getWorktreeProperties(folder: Uri): Promise<ChatSessionWorktreeProperties | undefined>;
	async getWorktreeProperties(sessionId: string | Uri): Promise<ChatSessionWorktreeProperties | undefined> {
		await this._intialize.value;
		if (typeof sessionId === 'string') {
			const metadata = await this.getSessionMetadata(sessionId);
			return metadata?.worktreeProperties;
		} else {
			const folder = sessionId;
			for (const metadata of Object.values(this._cache)) {
				if (!metadata.worktreeProperties?.worktreePath) {
					continue;
				}
				if (isEqual(Uri.file(metadata.worktreeProperties.worktreePath), folder)) {
					return metadata.worktreeProperties;
				}
			}
		}
	}
	async getSessionIdForWorktree(folder: vscode.Uri): Promise<string | undefined> {
		await this._intialize.value;
		for (const [sessionId, value] of Object.entries(this._cache)) {
			if (value.worktreeProperties?.worktreePath && isEqual(vscode.Uri.file(value.worktreeProperties.worktreePath), folder)) {
				return sessionId;
			}
		}
		return undefined;
	}

	async getSessionWorkspaceFolder(sessionId: string): Promise<vscode.Uri | undefined> {
		const metadata = await this.getSessionMetadata(sessionId);
		if (!metadata) {
			return undefined;
		}
		// Prefer worktree properties when both exist (this isn't possible, but if this happens).
		if (metadata.worktreeProperties) {
			return undefined;
		}
		return metadata.workspaceFolder?.folderPath ? Uri.file(metadata.workspaceFolder.folderPath) : undefined;
	}

	async getUsedWorkspaceFolders(): Promise<WorkspaceFolderEntry[]> {
		await this._intialize.value;
		const entries = new ResourceMap<number>();
		for (const metadata of Object.values(this._cache)) {
			if (metadata.workspaceFolder?.folderPath) {
				const folderUri = Uri.file(metadata.workspaceFolder.folderPath);
				entries.set(folderUri, Math.max(entries.get(folderUri) ?? 0, metadata.workspaceFolder.timestamp));
			}
		}
		return Array.from(entries.entries()).map(([folderUri, timestamp]) => ({ folderPath: folderUri.fsPath, timestamp }));
	}
	private async getSessionMetadata(sessionId: string): Promise<ChatSessionMetadataFile | undefined> {
		await this._intialize.value;
		if (sessionId in this._cache) {
			return this._cache[sessionId];
		}

		const fileUri = this.getMetadataFileUri(sessionId);
		try {
			const content = await this.fileSystemService.readFile(fileUri);
			const metadata: ChatSessionMetadataFile = JSON.parse(new TextDecoder().decode(content));
			this._cache[sessionId] = metadata;
			return metadata;
		} catch {
			// So we don't try again.
			this._cache[sessionId] = {};
			await this.updateSessionMetadata(sessionId, {});
			this.updateGlobalStorage();
			return undefined;
		}
	}

	private async updateSessionMetadata(sessionId: string, metadata: ChatSessionMetadataFile, createDirectoryIfNotFound = true): Promise<void> {
		if (sessionId.startsWith('untitled-')) {
			// Don't write metadata for untitled sessions, as they are temporary and can be created in large numbers.
			return;
		}
		const fileUri = this.getMetadataFileUri(sessionId);
		const dirUri = dirname(fileUri);
		// Possible directory doesn't exist, because we're creating the session id even before its created.
		try {
			await this.fileSystemService.stat(dirUri);
		} catch {
			if (!createDirectoryIfNotFound) {
				// Lets not delete the session from our storage, but mark it as written to session state so that we won't try to write to session state again and again.
				this._cache[sessionId] = { ...metadata, writtenToDisc: true };
				this.updateGlobalStorage();
				return;
			}
			await this.fileSystemService.createDirectory(dirUri);
		}

		const content = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
		await this.fileSystemService.writeFile(fileUri, content);
		this._cache[sessionId] = { ...metadata, writtenToDisc: true };
		this.updateGlobalStorage();
		this.logService.trace(`[ChatSessionMetadataStore] Wrote metadata for session ${sessionId}`);
	}

	private async getGlobalStorageData() {
		const data = await this.fileSystemService.readFile(this._cacheFile);
		return JSON.parse(new TextDecoder().decode(data)) as Record<string, ChatSessionMetadataFile>;
	}

	private updateGlobalStorage() {
		this._updateStorageDebouncer.trigger(() => this.updateGlobalStorageImpl()).catch(() => { /* expected on dispose */ });
	}

	private async updateGlobalStorageImpl() {
		try {
			const data = this._cache;
			try {
				const storageData = await this.getGlobalStorageData();
				for (const [sessionId, metadata] of Object.entries(storageData)) {
					if (sessionId in data) {
						// Ignore this.
					} else {
						data[sessionId] = metadata;
					}
				}
			} catch {
				//
			}
			await this.writeToGlobalStorage(data);
		} catch (error) {
			this.logService.error('[ChatSessionMetadataStore] Failed to update global storage: ', error);
		}
	}

	private async writeToGlobalStorage(allMetadata: Record<string, ChatSessionMetadataFile>): Promise<void> {
		try {
			await this.fileSystemService.stat(this._cacheDirectory);
		} catch {
			await this.fileSystemService.createDirectory(this._cacheDirectory);
		}

		const content = new TextEncoder().encode(JSON.stringify(allMetadata, null, 2));
		await this.fileSystemService.writeFile(this._cacheFile, content);
		this.logService.trace(`[ChatSessionMetadataStore] Wrote bulk metadata file with ${Object.keys(allMetadata).length} session(s)`);
	}
}
