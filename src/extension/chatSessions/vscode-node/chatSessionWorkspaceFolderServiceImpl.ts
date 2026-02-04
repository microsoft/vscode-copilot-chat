/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { isUntitledSessionId } from '../common/utils';
import { isEqual } from '../../../util/vs/base/common/resources';

const CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY = 'github.copilot.cli.sessionWorkspaceFolders';

// Maximum number of entries to keep
const MAX_ENTRIES = 1_500;
const ENTRIES_TO_PRUNE = 500;

interface WorkspaceFolderEntry {
	readonly folderPath?: string;
	readonly timestamp: number;
}

/**
 * Service for tracking workspace folder selections for chat sessions.
 * This is used in multi-root workspaces where some folders may not have git repositories.
 */
export class ChatSessionWorkspaceFolderService extends Disposable implements IChatSessionWorkspaceFolderService {
	declare _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext
	) {
		super();
	}

	private async cleanupOldEntries(): Promise<void> {
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});
		const newData: Record<string, WorkspaceFolderEntry> = {};
		const entries = Object.entries(data)
			.map(([sessionId, entry]) => ({ sessionId, entry }));

		// Sort by timestamp (newest first) and keep only MAX_ENTRIES - ENTRIES_TO_PRUNE
		entries.sort((a, b) => b.entry.timestamp - a.entry.timestamp);
		const entriesToKeep = entries.slice(0, MAX_ENTRIES - ENTRIES_TO_PRUNE);

		// Build new data object
		for (const { sessionId, entry } of entriesToKeep) {
			newData[sessionId] = entry;
		}

		await this.extensionContext.globalState.update(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, newData);
		this.logService.trace(`[ChatSessionWorkspaceFolderService] Cleaned up old entries, kept ${entriesToKeep.length}`);
	}

	public async deleteRecentFolder(folder: vscode.Uri): Promise<void> {
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});
		for (const [sessionId, entry] of Object.entries(data)) {
			if (entry.folderPath === folder.fsPath || !entry.folderPath || isEqual(URI.file(entry.folderPath), folder)) {
				delete data[sessionId];
			}
		}
		return this.extensionContext.globalState.update(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, data);
	}

	public getRecentFolders(): { folder: vscode.Uri; lastAccessTime: number }[] {
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});
		const recentFolders: { folder: vscode.Uri; lastAccessTime: number }[] = [];
		for (const [sessionId, entry] of Object.entries(data)) {
			if (typeof entry === 'string' || !entry.folderPath) {
				continue;
			}
			if (isUntitledSessionId(sessionId)) {
				continue; // Skip untitled sessions that may have been saved.
			}
			recentFolders.push({ folder: vscode.Uri.file(entry.folderPath), lastAccessTime: entry.timestamp });
		}
		recentFolders.sort((a, b) => b.lastAccessTime - a.lastAccessTime);
		return recentFolders;
	}
	async deleteTrackedWorkspaceFolder(sessionId: string): Promise<void> {
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
		data[sessionId] = entry;

		await this.extensionContext.globalState.update(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, data);

		this.logService.trace(`[ChatSessionWorkspaceFolderService] Tracked workspace folder ${workspaceFolderUri} for session ${sessionId}`);

		// Check if we need to cleanup
		if (Object.keys(data).length > MAX_ENTRIES) {
			void this.cleanupOldEntries();
		}
	}

	getSessionWorkspaceFolder(sessionId: string): vscode.Uri | undefined {
		const data = this.extensionContext.globalState.get<Record<string, WorkspaceFolderEntry>>(CHAT_SESSION_WORKSPACE_FOLDER_MEMENTO_KEY, {});

		const entry = sessionId in data ? data[sessionId] : undefined;
		return entry?.folderPath ? URI.file(entry.folderPath) : undefined;
	}
}
