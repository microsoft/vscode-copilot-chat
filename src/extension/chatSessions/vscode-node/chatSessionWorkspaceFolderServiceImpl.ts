/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { isUntitledSessionId } from '../common/utils';

const CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY = 'github.copilot.cli.sessionWorkspaceFolders';

// Maximum age of entries in milliseconds (30 days)
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Maximum number of entries to keep
const MAX_ENTRIES = 1_500;
const ENTRIES_TO_PRUNE = 500;

interface WorkspaceFolderEntry {
	readonly folderPath: string;
	readonly timestamp: number;
}

/**
 * Service for tracking workspace folder selections for chat sessions.
 * This is used in multi-root workspaces where some folders may not have git repositories.
 */
export class ChatSessionWorkspaceFolderService extends Disposable implements IChatSessionWorkspaceFolderService {
	declare _serviceBrand: undefined;

	private _sessionWorkspaceFolders = new Map<string, WorkspaceFolderEntry>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext
	) {
		super();
		this.loadWorkspaceFolders();
	}

	private loadWorkspaceFolders(): void {
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});
		const now = Date.now();
		let needsCleanup = false;

		for (const [sessionId, entry] of Object.entries(data)) {
			if (isUntitledSessionId(sessionId)) {
				continue; // Skip untitled sessions that may have been saved.
			}
			// Check if entry is too old
			if (now - entry.timestamp > MAX_ENTRY_AGE_MS) {
				needsCleanup = true;
				continue; // Skip old entries
			}
			this._sessionWorkspaceFolders.set(sessionId, entry);
		}

		this.logService.trace(`[ChatSessionWorkspaceFolderService] Loaded ${this._sessionWorkspaceFolders.size} workspace folder mappings`);

		// Cleanup old entries
		if (needsCleanup) {
			void this.cleanupOldEntries();
		}
	}

	private async cleanupOldEntries(): Promise<void> {
		const newData: Record<string, WorkspaceFolderEntry> = {};
		const entries = Array.from(this._sessionWorkspaceFolders.entries())
			.map(([sessionId, entry]) => ({ sessionId, entry }));

		// Sort by timestamp (newest first) and keep only MAX_ENTRIES - ENTRIES_TO_PRUNE
		entries.sort((a, b) => b.entry.timestamp - a.entry.timestamp);
		const entriesToKeep = entries.slice(0, MAX_ENTRIES - ENTRIES_TO_PRUNE);

		// Update in-memory map if we had to trim
		if (entries.length > MAX_ENTRIES - ENTRIES_TO_PRUNE) {
			this._sessionWorkspaceFolders.clear();
			for (const { sessionId, entry } of entriesToKeep) {
				this._sessionWorkspaceFolders.set(sessionId, entry);
			}
		}

		// Build new data object
		for (const { sessionId, entry } of entriesToKeep) {
			newData[sessionId] = entry;
		}

		await this.extensionContext.globalState.update(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, newData);
		this.logService.trace(`[ChatSessionWorkspaceFolderService] Cleaned up old entries, kept ${entriesToKeep.length}`);
	}

	public getRecentFolders(): { folder: vscode.Uri; lastAccessTime: number }[] {
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});
		const recentFolders: { folder: vscode.Uri; lastAccessTime: number }[] = [];
		for (const entry of Object.values(data)) {
			if (typeof entry === 'string') {
				continue;
			}
			if (isUntitledSessionId(entry.folderPath)) {
				continue; // Skip untitled sessions that may have been saved.
			}
			recentFolders.push({ folder: vscode.Uri.file(entry.folderPath), lastAccessTime: entry.timestamp });
		}
		recentFolders.sort((a, b) => b.lastAccessTime - a.lastAccessTime);
		return recentFolders;
	}
	async deleteTrackedWorkspaceFolder(sessionId: string): Promise<void> {
		this._sessionWorkspaceFolders.delete(sessionId);
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});
		delete data[sessionId];
		await this.extensionContext.globalState.update(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, data);
	}

	async trackSessionWorkspaceFolder(sessionId: string, workspaceFolderUri: string): Promise<void> {
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});

		const entry: WorkspaceFolderEntry = {
			folderPath: workspaceFolderUri,
			timestamp: Date.now()
		};
		this._sessionWorkspaceFolders.set(sessionId, entry);
		data[sessionId] = entry;

		await this.extensionContext.globalState.update(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, data);

		this.logService.trace(`[ChatSessionWorkspaceFolderService] Tracked workspace folder ${workspaceFolderUri} for session ${sessionId}`);

		// Check if we need to cleanup
		if (Object.keys(data).length > MAX_ENTRIES) {
			void this.cleanupOldEntries();
		}
	}

	getSessionWorkspaceFolder(sessionId: string): vscode.Uri | undefined {
		const entry = this._sessionWorkspaceFolders.get(sessionId);
		if (!entry) {
			return undefined;
		}

		// Update timestamp on access
		const updatedEntry: WorkspaceFolderEntry = {
			folderPath: entry.folderPath,
			timestamp: Date.now()
		};
		this._sessionWorkspaceFolders.set(sessionId, updatedEntry);
		void this.updateEntryTimestamp(sessionId, updatedEntry);

		return vscode.Uri.file(entry.folderPath);
	}

	private async updateEntryTimestamp(sessionId: string, entry: WorkspaceFolderEntry): Promise<void> {
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});
		data[sessionId] = entry;
		await this.extensionContext.globalState.update(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, data);
	}
}
