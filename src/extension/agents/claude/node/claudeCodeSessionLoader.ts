/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SDKMessage } from '@anthropic-ai/claude-code';
import * as os from 'os';
import type { CancellationToken } from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { URI } from '../../../../util/vs/base/common/uri';

type RawStoredSDKMessage = SDKMessage & {
	parentUuid: string | null;
	sessionId: string;
	timestamp: string;
}
interface SummaryEntry {
	type: 'summary';
	summary: string;
	leafUuid: string;
}
type ClaudeSessionFileEntry = RawStoredSDKMessage | SummaryEntry;

type StoredSDKMessage = SDKMessage & {
	parentUuid: string | null;
	sessionId: string;
	timestamp: Date;
}

export class ClaudeCodeSessionLoader {
	constructor(
		@IFileSystemService private readonly _fileSystem: IFileSystemService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceService private readonly _workspace: IWorkspaceService,
	) { }

	/**
	 * Collect messages from all sessions in all workspace folders.
	 * - Read all .jsonl files in the .claude/projects/<folder> dir
	 * - Create a map of all messages by uuid
	 * - Find leaf nodes (messages that are never referenced as parents)
	 * - Build message chains from leaf nodes
	 * - These are the complete "sessions" that can be resumed
	 */
	async getAllSessions(token: CancellationToken): Promise<IClaudeCodeSession[]> {
		const folders = this._workspace.getWorkspaceFolders();
		const home = os.homedir();
		const items: IClaudeCodeSession[] = [];

		for (const folderUri of folders) {
			if (token.isCancellationRequested) {
				return items;
			}

			const slug = this._computeFolderSlug(folderUri);
			const projectDirUri = URI.joinPath(URI.file(home), '.claude', 'projects', slug);

			let entries: [string, FileType][] = [];
			try {
				entries = await this._fileSystem.readDirectory(projectDirUri);
			} catch (e) {
				this._logService.error(e, `[ClaudeChatSessionItemProvider] Failed to read directory: ${projectDirUri}`);
				continue;
			}

			const fileTasks: Promise<{ messages: Map<string, StoredSDKMessage>; summaries: Map<string, SummaryEntry> }>[] = [];
			for (const [name, type] of entries) {
				if (type !== FileType.File) {
					continue;
				}

				if (!name.endsWith('.jsonl')) {
					continue;
				}

				const sessionId = name.slice(0, -6); // Remove .jsonl extension
				if (!sessionId) {
					continue;
				}

				const fileUri = URI.joinPath(projectDirUri, name);
				fileTasks.push(this._getMessagesFromSession(fileUri, token));
			}

			const results = await Promise.allSettled(fileTasks);
			if (token.isCancellationRequested) {
				return items;
			}
			const leafNodes = new Set<string>();
			const allMessages = new Map<string, StoredSDKMessage>();
			const allSummaries = new Map<string, SummaryEntry>();
			const referencedAsParent = new Set<string>();
			for (const r of results) {
				if (r.status === 'fulfilled') {
					for (const [uuid, message] of r.value.messages.entries()) {
						allMessages.set(uuid, message);
						if (message.parentUuid) {
							referencedAsParent.add(message.parentUuid);
						}
					}
					for (const [uuid, summary] of r.value.summaries.entries()) {
						allSummaries.set(uuid, summary);
					}
				}
			}

			for (const [uuid] of allMessages) {
				if (!referencedAsParent.has(uuid)) {
					leafNodes.add(uuid);
				}
			}

			for (const leafUuid of leafNodes) {
				const messages: StoredSDKMessage[] = [];
				let currentUuid: string | null = leafUuid;
				let summaryEntry: SummaryEntry | undefined;

				// Follow parent chain to build complete message history
				while (currentUuid) {
					const sdkMessage = allMessages.get(currentUuid);
					summaryEntry = allSummaries.get(currentUuid) ?? summaryEntry;
					if (!sdkMessage) {
						break;
					}

					// Add the SDK message directly
					messages.unshift(sdkMessage);

					currentUuid = sdkMessage.parentUuid;
				}

				// Create session if we have messages
				if (messages.length > 0) {
					const session: IClaudeCodeSession = {
						id: allMessages.get(leafUuid)!.sessionId,
						label: this._generateSessionLabel(summaryEntry, messages),
						messages: messages,
						timestamp: messages[messages.length - 1].timestamp
					};
					items.push(session);
				}
			}
		}

		return items;
	}

	private _reviveStoredSDKMessage(raw: RawStoredSDKMessage): StoredSDKMessage {
		return {
			...raw,
			timestamp: new Date(raw.timestamp)
		};
	}

	private async _getMessagesFromSession(fileUri: URI, token: CancellationToken): Promise<{ messages: Map<string, StoredSDKMessage>; summaries: Map<string, SummaryEntry> }> {
		const messages = new Map<string, StoredSDKMessage>();
		const summaries = new Map<string, SummaryEntry>();
		try {
			// Read and parse the JSONL file
			const content = await this._fileSystem.readFile(fileUri);
			const text = Buffer.from(content).toString('utf8');

			// Parse JSONL content line by line
			const lines = text.trim().split('\n').filter(line => line.trim());

			// Parse each line and build message map
			for (const line of lines) {
				try {
					const entry = JSON.parse(line) as ClaudeSessionFileEntry;

					if ('uuid' in entry && entry.uuid && 'message' in entry) {
						const sdkMessage = this._reviveStoredSDKMessage(entry as RawStoredSDKMessage);
						const uuid = sdkMessage.uuid;
						if (uuid) {
							messages.set(uuid, sdkMessage);
						}
					} else if ('summary' in entry && entry.summary) {
						const summaryEntry = entry as SummaryEntry;
						const uuid = summaryEntry.leafUuid;
						if (uuid) {
							summaries.set(uuid, summaryEntry);
						}
					}
				} catch (parseError) {
					this._logService.warn(`Failed to parse line in ${fileUri}: ${line} - ${parseError}`);
				}
			}
			return { messages, summaries };
		} catch (e) {
			this._logService.error(e, `[ClaudeChatSessionItemProvider] Failed to load session: ${fileUri}`);
			return { messages: new Map(), summaries: new Map() };
		}
	}

	private _computeFolderSlug(folderUri: URI): string {
		return folderUri.path.replace(/[\/\.]/g, '-');
	}

	private _generateSessionLabel(summaryEntry: SummaryEntry | undefined, messages: SDKMessage[]): string {
		// Use summary if available
		if (summaryEntry && summaryEntry.summary) {
			return summaryEntry.summary;
		}

		// Find the first user message to use as label
		const firstUserMessage = messages.find(msg =>
			msg.type === 'user' && 'message' in msg && msg.message?.role === 'user'
		);
		if (firstUserMessage && 'message' in firstUserMessage) {
			const message = firstUserMessage.message;
			let content: string | undefined;

			// Handle both string content and array content formats
			if (typeof message.content === 'string') {
				content = message.content;
			} else if (Array.isArray(message.content) && message.content.length > 0) {
				// Extract text from the first text block in the content array
				const firstTextBlock = message.content.find(block => block.type === 'text' && typeof block.text === 'string');
				if (firstTextBlock && 'text' in firstTextBlock) {
					content = firstTextBlock.text;
				}
			}

			if (content) {
				// Return first line or first 50 characters, whichever is shorter
				const firstLine = content.split('\n')[0];
				return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
			}
		}
		return 'Claude Session';
	}
}

export interface IClaudeCodeSession {
	id: string;
	label: string;
	messages: SDKMessage[];
	timestamp: Date;
}