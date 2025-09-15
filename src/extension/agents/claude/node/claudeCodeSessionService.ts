/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SDKMessage } from '@anthropic-ai/claude-code';
import Anthropic from '@anthropic-ai/sdk';
import type { CancellationToken } from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { ResourceMap, ResourceSet } from '../../../../util/vs/base/common/map';
import { isEqualOrParent } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';

type RawStoredSDKMessage = SDKMessage & {
	readonly parentUuid: string | null;
	readonly sessionId: string;
	readonly timestamp: string;
}
interface SummaryEntry {
	readonly type: 'summary';
	readonly summary: string;
	readonly leafUuid: string;
}
type ClaudeSessionFileEntry = RawStoredSDKMessage | SummaryEntry;

type StoredSDKMessage = SDKMessage & {
	readonly parentUuid: string | null;
	readonly sessionId: string;
	readonly timestamp: Date;
}

export const IClaudeCodeSessionService = createServiceIdentifier<IClaudeCodeSessionService>('IClaudeCodeSessionService');

export interface IClaudeCodeSessionService {
	readonly _serviceBrand: undefined;
	getAllSessions(token: CancellationToken): Promise<readonly IClaudeCodeSession[]>;
	getSession(sessionId: string, token: CancellationToken): Promise<IClaudeCodeSession | undefined>;
}

export class ClaudeCodeSessionService implements IClaudeCodeSessionService {
	declare _serviceBrand: undefined;

	// Simple mtime-based cache
	private _sessionCache = new ResourceMap<readonly IClaudeCodeSession[]>();
	private _fileMtimes = new ResourceMap<number>();

	constructor(
		@IFileSystemService private readonly _fileSystem: IFileSystemService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceService private readonly _workspace: IWorkspaceService,
		@INativeEnvService private readonly _nativeEnvService: INativeEnvService
	) { }

	/**
	 * Collect messages from all sessions in all workspace folders.
	 * - Read all .jsonl files in the .claude/projects/<folder> dir
	 * - Create a map of all messages by uuid
	 * - Find leaf nodes (messages that are never referenced as parents)
	 * - Build message chains from leaf nodes
	 * - These are the complete "sessions" that can be resumed
	 */
	async getAllSessions(token: CancellationToken): Promise<readonly IClaudeCodeSession[]> {
		const folders = this._workspace.getWorkspaceFolders();
		const items: IClaudeCodeSession[] = [];

		for (const folderUri of folders) {
			if (token.isCancellationRequested) {
				return items;
			}

			const slug = this._computeFolderSlug(folderUri);
			const projectDirUri = URI.joinPath(this._nativeEnvService.userHome, '.claude', 'projects', slug);

			// Check if we can use cached data
			const cachedSessions = await this._getCachedSessionsIfValid(projectDirUri, token);
			if (cachedSessions) {
				items.push(...cachedSessions);
				continue;
			}

			// Cache miss or invalid - reload from disk
			const freshSessions = await this._loadSessionsFromDisk(projectDirUri, token);
			this._sessionCache.set(projectDirUri, freshSessions);
			items.push(...freshSessions);
		}

		return items;
	}

	async getSession(claudeCodeSessionId: string, token: CancellationToken): Promise<IClaudeCodeSession | undefined> {
		const all = await this.getAllSessions(token);
		return all.find(session => session.id === claudeCodeSessionId);
	}

	/**
	 * Check if cached sessions are still valid by comparing file modification times
	 */
	private async _getCachedSessionsIfValid(projectDirUri: URI, token: CancellationToken): Promise<readonly IClaudeCodeSession[] | null> {
		if (!this._sessionCache.has(projectDirUri)) {
			return null; // No cache entry
		}

		try {
			const entries = await this._fileSystem.readDirectory(projectDirUri);
			if (token.isCancellationRequested) {
				return null;
			}

			const currentFiles = new ResourceSet();

			// Check if any .jsonl files have changed since our last cache
			for (const [name, type] of entries) {
				if (type !== FileType.File || !name.endsWith('.jsonl')) {
					continue;
				}

				const fileUri = URI.joinPath(projectDirUri, name);
				currentFiles.add(fileUri);

				try {
					const stat = await this._fileSystem.stat(fileUri);
					const cachedMtime = this._fileMtimes.get(fileUri);

					if (!cachedMtime || stat.mtime > cachedMtime) {
						// File has changed or is new
						return null;
					}
				} catch (e) {
					// File might have been deleted, invalidate cache
					return null;
				}
			}

			// Check if any previously cached files have been deleted
			for (const cachedFileUri of this._fileMtimes.keys()) {
				if (isEqualOrParent(cachedFileUri, projectDirUri) && cachedFileUri.path.endsWith('.jsonl')) {
					if (!currentFiles.has(cachedFileUri)) {
						// A previously cached file has been deleted
						return null;
					}
				}
			}

			// All files are unchanged, return cached sessions
			return this._sessionCache.get(projectDirUri) || null;
		} catch (e) {
			// Directory read failed, invalidate cache
			this._logService.error(e, `[ClaudeCodeSessionLoader] Failed to check cache validity for: ${projectDirUri}`);
			return null;
		}
	}

	/**
	 * Load sessions from disk and update file modification time tracking
	 */
	private async _loadSessionsFromDisk(projectDirUri: URI, token: CancellationToken): Promise<readonly IClaudeCodeSession[]> {
		let entries: [string, FileType][] = [];
		try {
			entries = await this._fileSystem.readDirectory(projectDirUri);
		} catch (e) {
			this._logService.error(e, `[ClaudeChatSessionItemProvider] Failed to read directory: ${projectDirUri}`);
			return [];
		}

		const fileTasks: Promise<{ messages: Map<string, StoredSDKMessage>; summaries: Map<string, SummaryEntry>; fileUri: URI }>[] = [];
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
			fileTasks.push(this._getMessagesFromSessionWithUri(fileUri, token));
		}

		const results = await Promise.allSettled(fileTasks);
		if (token.isCancellationRequested) {
			return [];
		}

		const leafNodes = new Set<string>();
		const allMessages = new Map<string, StoredSDKMessage>();
		const allSummaries = new Map<string, SummaryEntry>();
		const referencedAsParent = new Set<string>();

		for (const r of results) {
			if (r.status === 'fulfilled') {
				// Update mtime cache for this file
				try {
					const stat = await this._fileSystem.stat(r.value.fileUri);
					this._fileMtimes.set(r.value.fileUri, stat.mtime);
				} catch (e) {
					// File might have been deleted during processing
				}

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

		const sessions: IClaudeCodeSession[] = [];
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
				sessions.push(session);
			}
		}

		return sessions;
	}

	private _reviveStoredSDKMessage(raw: RawStoredSDKMessage): StoredSDKMessage {
		let revivedMessage: StoredSDKMessage = {
			...raw,
			timestamp: new Date(raw.timestamp)
		};

		// Strip attachments from user messages when loading from disk
		if (revivedMessage.type === 'user' && 'message' in revivedMessage && revivedMessage.message?.role === 'user') {
			const strippedContent = this._stripAttachmentsFromMessageContent(revivedMessage.message.content);
			revivedMessage = {
				...revivedMessage,
				message: {
					...revivedMessage.message,
					content: strippedContent
				}
			};
		}

		return revivedMessage;
	}

	/**
	 * Wrapper for _getMessagesFromSession that includes the fileUri in the result
	 */
	private async _getMessagesFromSessionWithUri(fileUri: URI, token: CancellationToken): Promise<{ messages: Map<string, StoredSDKMessage>; summaries: Map<string, SummaryEntry>; fileUri: URI }> {
		const result = await this._getMessagesFromSession(fileUri, token);
		return { ...result, fileUri };
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
					} else if ('summary' in entry && entry.summary && !entry.summary.toLowerCase().startsWith('api error: 401') && !entry.summary.toLowerCase().startsWith('invalid api key')) {
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

			// Handle both string content and array content formats using our helper
			const strippedContent = this._stripAttachmentsFromMessageContent(message.content);
			if (typeof strippedContent === 'string') {
				content = strippedContent;
			} else if (Array.isArray(strippedContent) && strippedContent.length > 0) {
				// Extract text from the first text block in the content array
				const firstUsefulText = strippedContent
					.filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
					.map(block => block.text)
					.find(text => text.trim().length > 0);
				content = firstUsefulText;
			}

			if (content) {
				// Return first line or first 50 characters, whichever is shorter
				const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? '';
				return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
			}
		}
		return 'Claude Session';
	}

	private _stripAttachments(text: string): string {
		// Remove any <system-reminder> ... </system-reminder> blocks, including newlines
		return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
	}

	/**
	 * Strip attachments from message content, handling both string and array formats
	 */
	private _stripAttachmentsFromMessageContent(content: string | Anthropic.ContentBlockParam[]): string | Anthropic.ContentBlockParam[] {
		if (typeof content === 'string') {
			return this._stripAttachments(content);
		} else if (Array.isArray(content)) {
			return content.map(block => {
				if (block.type === 'text') {
					return {
						...block,
						text: this._stripAttachments((block as Anthropic.TextBlockParam).text)
					};
				}
				return block;
			});
		}
		return content;
	}

}

export interface IClaudeCodeSession {
	readonly id: string;
	readonly label: string;
	readonly messages: readonly SDKMessage[];
	readonly timestamp: Date;
}