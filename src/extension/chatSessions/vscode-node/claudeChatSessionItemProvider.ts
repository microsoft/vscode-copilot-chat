/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Event } from '../../../util/vs/base/common/event';
import { basename } from '../../../util/vs/base/common/resources';
import { ThemeIcon } from '../../../util/vs/base/common/themables';
import { URI } from '../../../util/vs/base/common/uri';

/**
 * Chat session item provider for Claude Code.
 * Reads sessions from ~/.claude/projects/<folder-slug>/, where each file name is a session id (GUID).
 */
export class ClaudeChatSessionItemProvider implements vscode.ChatSessionItemProvider {
	public readonly onDidChangeChatSessionItems = Event.None;

	constructor(
		@IFileSystemService private readonly _fileSystem: IFileSystemService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceService private readonly _workspace: IWorkspaceService,
	) { }

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const folders = this._workspace.getWorkspaceFolders();
		const home = os.homedir();
		const items: vscode.ChatSessionItem[] = [];

		for (const folderUri of folders) {
			if (token.isCancellationRequested) {
				return items;
			}

			const slug = this._computeFolderSlug(folderUri);
			const projectDirUri = URI.joinPath(URI.file(home), '.claude', 'projects', slug);

			let entries: [string, FileType][] = [];
			try {
				entries = await this._fileSystem.readDirectory(projectDirUri as any);
			} catch (e) {
				this._logService.error(e, `[ClaudeChatSessionItemProvider] Failed to read directory: ${projectDirUri}`);
				continue;
			}

			const fileTasks: Promise<{ item: vscode.ChatSessionItem; mtime: number } | undefined>[] = [];
			for (const [name, type] of entries) {
				if ((type & FileType.File) === 0) {
					continue;
				}
				const sessionId = name;
				if (!sessionId) {
					continue;
				}
				const fileUri = URI.joinPath(projectDirUri, name);
				fileTasks.push((async () => {
					try {
						if (token.isCancellationRequested) {
							return undefined;
						}
						const [stat, firstLine] = await Promise.all([
							this._fileSystem.stat(fileUri as any),
							this._readFirstLine(fileUri as any, token),
						]);
						if (!stat) {
							return undefined;
						}
						const label = this._buildLabelFromFirstLine(firstLine);
						const item: vscode.ChatSessionItem = {
							id: sessionId,
							label,
							description: basename(folderUri),
							tooltip: 'Claude Code session',
							iconPath: ThemeIcon.fromId('star')
						};
						return { item, mtime: stat.mtime ?? 0 };
					} catch (e) {
						this._logService.error(e, `[ClaudeChatSessionItemProvider] Failed to load session: ${fileUri}`);
						return undefined;
					}
				})());
			}

			const results = await Promise.allSettled(fileTasks);
			if (token.isCancellationRequested) {
				return items;
			}
			const folderItems: { item: vscode.ChatSessionItem; mtime: number }[] = [];
			let hasAnySuccess = false;
			for (const r of results) {
				if (r.status === 'fulfilled' && r.value) {
					folderItems.push(r.value);
					hasAnySuccess = true;
				}
			}

			if (!hasAnySuccess && entries.length > 0) {
				throw new Error(`[ClaudeChatSessionItemProvider] All session files failed to load in: ${projectDirUri}`);
			}

			folderItems.sort((a, b) => b.mtime - a.mtime);
			for (const fi of folderItems) {
				items.push(fi.item);
			}
		}

		return items;
	}

	// public async provideNewChatSessionItem(): Promise<vscode.ChatSessionItem> {
	// 	const sessionId = generateUuid();
	// 	return {
	// 		id: sessionId,
	// 		label: 'Claude Code',
	// 		description: 'Start a new session',
	// 		tooltip: 'Claude Code new chat session',
	// 	};
	// }

	private _computeFolderSlug(folderUri: URI): string {
		return folderUri.path.replace(/\//g, '-');
	}

	private async _readFirstLine(fileUri: URI, token: vscode.CancellationToken): Promise<string | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const data = await this._fileSystem.readFile(fileUri as any);
		const text = new TextDecoder('utf-8').decode(data);
		const idx = text.indexOf('\n');
		return (idx === -1 ? text : text.slice(0, idx)).trim() || undefined;
	}

	private _buildLabelFromFirstLine(firstLine: string | undefined): string {
		if (!firstLine) {
			return 'Claude Code';
		}
		// Try to parse JSON and extract a summary/title if present
		try {
			if (firstLine.startsWith('{')) {
				const obj = JSON.parse(firstLine);
				if (obj && obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary.trim()) {
					return obj.summary.trim();
				}
				if (typeof obj?.title === 'string' && obj.title.trim()) {
					return obj.title.trim();
				}
				// Extract content from user messages as fallback
				if (obj && obj.type === 'user' && obj.message?.content && typeof obj.message.content === 'string' && obj.message.content.trim()) {
					return obj.message.content.trim();
				}
			}
		} catch {
			return 'Claude Code';
		}

		return firstLine;
	}
}
