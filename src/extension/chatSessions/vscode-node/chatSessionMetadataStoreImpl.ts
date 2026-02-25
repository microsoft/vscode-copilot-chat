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
import { dirname } from '../../../util/vs/base/common/resources';
import { getCopilotCLISessionStateDir } from '../../agents/copilotcli/vscode-node/cliHelpers';
import { ChatSessionMetadataFile, IChatSessionMetadataStore, WorkspaceFolderEntry } from '../common/chatSessionMetadataStore';
import { ChatSessionWorktreeData, ChatSessionWorktreeProperties } from '../common/chatSessionWorktreeService';

const WORKSPACE_FOLDER_MEMENTO_KEY = 'github.copilot.cli.sessionWorkspaceFolders';
const WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';
const BULK_METADATA_FILENAME = 'copilotcli.session.metadata.json';

export class ChatSessionMetadataStore extends Disposable implements IChatSessionMetadataStore {
	declare _serviceBrand: undefined;
	private _cache: Record<string, ChatSessionMetadataFile> = {};
	private readonly _sessionStateDir: Uri;

	private readonly _cacheDirectory: Uri;
	private readonly _cacheFile: Uri;
	private readonly _intiailize: Lazy<Promise<void>>;
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
		this._intiailize = new Lazy<Promise<void>>(this.initializeStorage.bind(this));
		this._intiailize.value.catch(error => {
			this.logService.error('[ChatSessionMetadataStore] Initialization failed: ', error);
		});
	}

	private async initializeStorage(): Promise<void> {
		try {
			this._cache = await this.getGlobalStorageData();
			return;
		} catch {
			//
		}

		const allMetadata: Record<string, ChatSessionMetadataFile> = {};

		// Collect workspace folder entries from global state
		const workspaceFolderData = this.extensionContext.globalState.get<Record<string, Partial<WorkspaceFolderEntry>>>(WORKSPACE_FOLDER_MEMENTO_KEY, {});
		for (const [sessionId, entry] of Object.entries(workspaceFolderData)) {
			if (typeof entry === 'string' || !entry.folderPath || !entry.timestamp) {
				continue;
			}
			if (sessionId.startsWith('untitled-')) {
				continue;
			}
			allMetadata[sessionId] = { ...allMetadata[sessionId], workspaceFolder: { folderPath: entry.folderPath, timestamp: entry.timestamp } };
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
			const parsedData: ChatSessionWorktreeProperties = value.version === 1 ? { ...JSON.parse(value.data), version: 1 } : JSON.parse(value.data);
			allMetadata[sessionId] = { ...allMetadata[sessionId], workspaceFolder: undefined, worktreeProperties: parsedData };
		}

		const promises: Promise<unknown>[] = [];

		// Populate in-memory cache & write to session directory to share across all VS Code instances.
		for (const [sessionId, metadata] of Object.entries(allMetadata)) {
			this._cache[sessionId] = metadata;
			promises.push(this.updateSessionMetadata(sessionId, metadata));
		}

		// Writing to file is most important.
		await this.writeToGlobalStorage(allMetadata);

		// These promises can run in background and no need to wait for them.
		Promise.allSettled(promises); // we assume that user will not exit VS Code immediately, if they do,
		this.extensionContext.globalState.update(WORKSPACE_FOLDER_MEMENTO_KEY, undefined);
		this.extensionContext.globalState.update(WORKTREE_MEMENTO_KEY, undefined);
	}

	private getMetadataFileUri(sessionId: string): vscode.Uri {
		return Uri.joinPath(this._sessionStateDir, sessionId, 'vscode.metadata.json');
	}

	async deleteSessionMetadata(sessionId: string): Promise<void> {
		if (sessionId in this._cache) {
			delete this._cache[sessionId];
			this.updateGllobalStorage();
		}
		try {
			const data = await this.getSessionMetadata(sessionId);
			if (data) {
				await this.updateSessionMetadata(sessionId, {});
			}
		} catch {
			//
		}
	}

	async storeWorktreeInfo(sessionId: string, properties: ChatSessionWorktreeProperties): Promise<void> {
		await this._intiailize.value;
		const metadata: ChatSessionMetadataFile = { worktreeProperties: properties };
		this._cache[sessionId] = metadata;
		await this.updateSessionMetadata(sessionId, metadata);
		this.updateGllobalStorage();
	}

	async storeWorkspaceFolderInfo(sessionId: string, entry: WorkspaceFolderEntry): Promise<void> {
		await this._intiailize.value;
		const metadata: ChatSessionMetadataFile = { workspaceFolder: entry };
		this._cache[sessionId] = metadata;
		await this.updateSessionMetadata(sessionId, metadata);
		this.updateGllobalStorage();
	}

	async getWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties | undefined> {
		await this._intiailize.value;
		const metadata = await this.getSessionMetadata(sessionId);
		return metadata?.worktreeProperties;
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
		await this._intiailize.value;
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
		await this._intiailize.value;
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
			this.updateGllobalStorage();
			return undefined;
		}
	}

	private async updateSessionMetadata(sessionId: string, metadata: ChatSessionMetadataFile): Promise<void> {
		const fileUri = this.getMetadataFileUri(sessionId);
		const dirUri = dirname(fileUri);
		// Possible directory doesn't exist, because we're creating the session id even before its created.
		try {
			await this.fileSystemService.stat(dirUri);
		} catch {
			await this.fileSystemService.createDirectory(dirUri);
		}

		const content = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
		await this.fileSystemService.writeFile(fileUri, content);
		this._cache[sessionId] = { ...metadata, writtenToSessionState: true };
		this.updateGllobalStorage();
		this.logService.trace(`[ChatSessionMetadataStore] Wrote metadata for session ${sessionId}`);
	}

	private async getGlobalStorageData() {
		const data = await this.fileSystemService.readFile(this._cacheFile);
		return JSON.parse(new TextDecoder().decode(data)) as Record<string, ChatSessionMetadataFile>;
	}

	private updateGllobalStorage() {
		this._updateStorageDebouncer.trigger(() => this.updateGllobalStorageImpl());
	}

	private async updateGllobalStorageImpl() {
		try {
			const data = this._cache;
			try {
				const storageData = await this.getGlobalStorageData();
				Object.assign(storageData, data);
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
			try {
				await this.fileSystemService.stat(this._cacheDirectory);
			} catch {
				await this.fileSystemService.createDirectory(this._cacheDirectory);
			}

			const content = new TextEncoder().encode(JSON.stringify(allMetadata, null, 2));
			await this.fileSystemService.writeFile(this._cacheFile, content);
			this.logService.trace(`[ChatSessionMetadataStore] Wrote bulk metadata file with ${Object.keys(allMetadata).length} session(s)`);
		} catch (error) {
			this.logService.error('[ChatSessionMetadataStore] Failed to write bulk metadata file: ', error);
		}
	}
}
