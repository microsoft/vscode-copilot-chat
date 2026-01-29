/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import type { CancellationToken } from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { ResourceMap, ResourceSet } from '../../../../util/vs/base/common/map';
import { isEqualOrParent } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';

type RawStoredSDKMessage = SDKMessage & {
	readonly parentUuid: string | null;
	readonly sessionId: string;
	readonly timestamp: string;
	readonly isMeta?: boolean;
}

/**
 * Minimal entry used only for parent-chain resolution.
 * These entries lack a message field and are marked as meta entries
 * so they're filtered from final output but still enable parent traversal.
 */
interface ChainLinkEntry {
	readonly uuid: string;
	readonly parentUuid: string | null;
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

interface ParsedSessionMessage {
	readonly raw: RawStoredSDKMessage | ChainLinkEntry;
	readonly isMeta: boolean;
}

export const IClaudeCodeSessionService = createServiceIdentifier<IClaudeCodeSessionService>('IClaudeCodeSessionService');

/**
 * Service to load and manage Claude Code chat sessions from disk.
 * 
 * Sessions are stored in ~/.claude/projects/<encoded-path>/ where the path
 * encoding replaces filesystem separators with dashes:
 * - Unix: "/Users/name/project" -> "-Users-name-project"
 * - Windows: "C:\Users\name\project" -> "C-Users-name-project"
 * 
 * The service reconstructs complete conversation sessions by:
 * 1. Parsing JSONL files containing SDK messages with parent/child relationships
 * 2. Handling meta messages (system entries) that maintain parent chains
 * 3. Building conversation trees from leaf nodes upward
 * 4. De-duplicating sessions when multiple branches exist
 */
export interface IClaudeCodeSessionService {
	readonly _serviceBrand: undefined;
	getAllSessions(token: CancellationToken): Promise<readonly IClaudeCodeSession[]>;
	getSession(resource: URI, token: CancellationToken): Promise<IClaudeCodeSession | undefined>;
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
	 * Read a directory, returning an empty array if the directory doesn't exist.
	 */
	private async _tryReadDirectory(dirUri: URI): Promise<[string, FileType][]> {
		try {
			return await this._fileSystem.readDirectory(dirUri);
		} catch (e) {
			switch (e.code) {
				case 'FileNotFound':
				case 'DirectoryNotFound':
				case 'ENOENT':
					break;
				default:
					this._logService.error(e, `[ClaudeCodeSessionService] Failed to read directory: ${dirUri}`);
					break;
			}
			return [];
		}
	}

	/**
	 * Collect messages from all sessions in all workspace folders.
	 * Process:
	 * 1. Read all .jsonl files in the .claude/projects/<folder> directory
	 * 2. Create a map of all messages indexed by uuid
	 * 3. Find leaf nodes (messages that are never referenced as parents)
	 * 4. Build message chains from leaf nodes by following parent pointers
	 * 5. These complete chains are the "sessions" that can be resumed
	 */
	async getAllSessions(token: CancellationToken): Promise<readonly IClaudeCodeSession[]> {
		const folders = this._workspace.getWorkspaceFolders();
		const items: IClaudeCodeSession[] = [];
		const slugs: string[] = [];

		// Build list of project directory slugs to scan
		if (folders.length === 1) {
			// Single folder - use its slug directly
			slugs.push(this._computeFolderSlug(folders[0]));
		} else {
			// Multi-root or no folder - add the no-project slug
			slugs.push('-');
		}

		for (const slug of slugs) {
			if (token.isCancellationRequested) {
				return items;
			}

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

	async getSession(resource: URI, token: CancellationToken): Promise<IClaudeCodeSession | undefined> {
		const all = await this.getAllSessions(token);
		const targetId = resource.path.slice(1); // Remove leading '/' from path
		return all.find(session => session.id === targetId);
	}

	/**
	 * Check if cached sessions are still valid by comparing file modification times
	 */
	private async _getCachedSessionsIfValid(projectDirUri: URI, token: CancellationToken): Promise<readonly IClaudeCodeSession[] | null> {
		if (!this._sessionCache.has(projectDirUri)) {
			return null; // No cache entry
		}

		const entries = await this._tryReadDirectory(projectDirUri);
		if (entries.length === 0) {
			return null; // Directory empty or gone, invalidate cache
		}
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
	}

	/**
	 * Load sessions from disk and update file modification time tracking
	 */
	private async _loadSessionsFromDisk(projectDirUri: URI, token: CancellationToken): Promise<readonly IClaudeCodeSession[]> {
		const entries = await this._tryReadDirectory(projectDirUri);
		if (entries.length === 0) {
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

			// Filter out agent-*.jsonl files which contain internal agent metadata and system logs,
			// not user-visible conversation sessions.
			if (name.startsWith('agent-')) {
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

		// De-duplicate sessions by sessionId, keeping the one with the most messages.
		// This handles orphaned branches from parallel tool calls where multiple leaf
		// nodes can exist for the same session (e.g., tool_result messages that didn't
		// continue because another parallel branch became the main conversation).
		const sessionById = new Map<string, IClaudeCodeSession>();
		for (const session of sessions) {
			const existing = sessionById.get(session.id);
			if (!existing || session.messages.length > existing.messages.length) {
				sessionById.set(session.id, session);
			}
		}

		return Array.from(sessionById.values());
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
		const summaries = new Map<string, SummaryEntry>();
		try {
			// Read and parse the JSONL file
			// Claude session files can be large (>5MB), so we disable the size limit
			const content = await this._fileSystem.readFile(fileUri, true);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			const text = Buffer.from(content).toString('utf8');

			// Parse JSONL content line by line
			const lines = text.trim().split('\n').filter(line => line.trim());
			const rawMessages = new Map<string, ParsedSessionMessage>();

			// Parse each line and build message map
			for (const line of lines) {
				if (!line) {
					continue;
				}
				
				try {
					const entry = JSON.parse(line) as ClaudeSessionFileEntry;

					if ('uuid' in entry && entry.uuid && 'message' in entry) {
						const rawEntry = entry;
						const uuid = rawEntry.uuid;
						if (!uuid) {
							continue;
						}

						const { isMeta, ...rest } = rawEntry;
						const normalizedRaw = {
							...rest,
							parentUuid: rawEntry.parentUuid ?? null
						} as RawStoredSDKMessage;

						rawMessages.set(uuid, {
							raw: normalizedRaw,
							isMeta: Boolean(isMeta)
						});
					} else if ('uuid' in entry && entry.uuid && 'parentUuid' in entry) {
						// Handle entries without 'message' field (e.g., system messages, metadata entries)
						// These are needed for parent chain linking but should not appear in final output
						const uuid = entry.uuid;
						const parentUuid = ('parentUuid' in entry ? entry.parentUuid : null) as string | null;

						const chainLink: ChainLinkEntry = {
							uuid,
							parentUuid: parentUuid ?? null
						};

						rawMessages.set(uuid, {
							raw: chainLink,
							isMeta: true  // Mark as meta so it's used for linking but filtered from output
						});
					} else if ('summary' in entry && entry.summary && !entry.summary.toLowerCase().startsWith('api error: 401') && !entry.summary.toLowerCase().startsWith('invalid api key')) {
						const summaryEntry = entry as SummaryEntry;
						const uuid = summaryEntry.leafUuid;
						if (uuid) {
							summaries.set(uuid, summaryEntry);
						}
					}
				} catch (parseError) {
					this._logService.warn(`[ClaudeCodeSessionService] Failed to parse line in ${fileUri.toString()}: ${parseError}`);
					// Log a truncated version of the malformed line for debugging
					const truncatedLine = line.length > 200 ? line.substring(0, 200) + '...' : line;
					this._logService.debug(`[ClaudeCodeSessionService] Malformed line content: ${truncatedLine}`);
				}
			}

			const messages = this._reviveStoredMessages(rawMessages);
			return { messages, summaries };
		} catch (e) {
			this._logService.error(e, `[ClaudeCodeSessionService] Failed to load session file: ${fileUri.toString()}`);
			return { messages: new Map(), summaries: new Map() };
		}
	}

	/**
	 * Compute a folder slug for the .claude/projects/ directory.
	 * Encodes filesystem paths by replacing separators with dashes:
	 * - Unix: "/Users/name/project" -> "-Users-name-project"
	 * - Windows: "C:\Users\name\project" -> "C-Users-name-project"
	 */
	private _computeFolderSlug(folderUri: URI): string {
		return folderUri.path
			.replace(/^\/([a-z]):/i, (_, driveLetter) => driveLetter.toUpperCase() + '-')
			.replace(/[\/ .]/g, '-');
	}

	private _generateSessionLabel(summaryEntry: SummaryEntry | undefined, messages: SDKMessage[]): string {
		// Use summary if available
		if (summaryEntry && summaryEntry.summary) {
			return summaryEntry.summary;
		}

		// Find the first user message to use as label
		const firstUserMessage: SDKUserMessage | undefined = messages.find((msg): msg is SDKUserMessage =>
			msg.type === 'user' && 'message' in msg && msg.message?.role === 'user'
		);
		if (firstUserMessage && 'message' in firstUserMessage) {
			const message: Anthropic.MessageParam = firstUserMessage.message;
			let content: string | undefined;

			// Handle both string content and array content formats using our helper
			const strippedContent = this._stripAttachmentsFromMessageContent(message.content);
			if (typeof strippedContent === 'string') {
				content = strippedContent;
			} else if (Array.isArray(strippedContent) && strippedContent.length > 0) {
				// Extract text from the first text block in the content array
				// Use explicit type guards for safer access
				const firstUsefulText = strippedContent
					.filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
					.map(block => block.text)
					.find(text => text && typeof text === 'string' && text.trim().length > 0);
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

	private _normalizeCommandContent(text: string): string {
		const parsed = this._extractCommandContent(text);
		if (parsed !== null) {
			return parsed;
		}
		return this._removeCommandTags(text);
	}

	private _extractCommandContent(text: string): string | null {
		const commandMessageMatch = /<command-message>([\s\S]*?)<\/command-message>/i.exec(text);
		if (!commandMessageMatch) {
			return null;
		}

		const commandMessage = commandMessageMatch[1]?.trim();
		return commandMessage ? `/${commandMessage}` : null;
	}

	private _removeCommandTags(text: string): string {
		return text
			.replace(/<command-message>/gi, '')
			.replace(/<\/command-message>/gi, '')
			.replace(/<command-name>/gi, '')
			.replace(/<\/command-name>/gi, '')
			.trim();
	}

	private _isRawStoredSDKMessage(entry: RawStoredSDKMessage | ChainLinkEntry): entry is RawStoredSDKMessage {
		return 'type' in entry && 'sessionId' in entry && 'timestamp' in entry;
	}

	private _reviveStoredMessages(rawMessages: Map<string, ParsedSessionMessage>): Map<string, StoredSDKMessage> {
		const messages = new Map<string, StoredSDKMessage>();

		for (const [uuid, entry] of rawMessages) {
			if (entry.isMeta) {
				continue;
			}

			// Non-meta entries should always be RawStoredSDKMessage, not ChainLinkEntry
			if (!this._isRawStoredSDKMessage(entry.raw)) {
				continue;
			}

			const parentUuid = this._resolveParentUuid(entry.raw.parentUuid ?? null, rawMessages);
			const revived = this._reviveStoredSDKMessage({
				...entry.raw,
				parentUuid
			});

			if (uuid) {
				messages.set(uuid, revived);
			}
		}

		return messages;
	}

	/**
	 * Resolve parent UUID by traversing through meta messages to find the nearest non-meta parent.
	 * 
	 * Claude session files contain system messages (type: 'system') that don't have a 'message' field
	 * but are needed for maintaining parent chains. This method skips over those meta entries to
	 * connect visible messages in the conversation.
	 * 
	 * Example chain:
	 *   user (uuid-1) → assistant (uuid-2) → system [META] (uuid-3) → user (uuid-4)
	 *   
	 * When resolving uuid-4's parent (uuid-3), this returns uuid-2 (the last non-meta message).
	 * 
	 * @param parentUuid The direct parent UUID from the message
	 * @param rawMessages Map of all parsed messages including meta entries
	 * @returns The nearest non-meta parent UUID, or null if none exists
	 */
	private _resolveParentUuid(parentUuid: string | null, rawMessages: Map<string, ParsedSessionMessage>): string | null {
		let current = parentUuid;
		const visited = new Set<string>();

		while (current) {
			// Cycle detection
			if (visited.has(current)) {
				return current;
			}
			visited.add(current);

			const candidate = rawMessages.get(current);
			if (!candidate) {
				// Parent not found in message map, use as-is
				return current;
			}

			if (!candidate.isMeta) {
				// Found a non-meta message, this is the resolved parent
				return current;
			}

			// This is a meta message, continue traversing to its parent
			current = candidate.raw.parentUuid ?? null;
		}

		return current ?? null;
	}

	/**
	 * Strip attachments from message content, handling both string and array formats
	 */
	private _stripAttachmentsFromMessageContent(content: Anthropic.MessageParam['content']): string | Anthropic.ContentBlockParam[] {
		if (typeof content === 'string') {
			const withoutAttachments = this._stripAttachments(content);
			return this._normalizeCommandContent(withoutAttachments);
		} else if (Array.isArray(content)) {
			const processedBlocks = content.map(block => {
				if (block.type === 'text') {
					const textBlock = block;
					const cleanedText = this._normalizeCommandContent(this._stripAttachments(textBlock.text));
					return {
						...block,
						text: cleanedText
					};
				}
				return block;
			}).filter(block => block.type !== 'text' || block.text.trim().length > 0);
			return processedBlocks;
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