/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Claude Code Session Service
 *
 * This service provides access to Claude Code chat sessions using the
 * `@anthropic-ai/claude-agent-sdk` methods (`listSessions`, `getSessionMessages`).
 * It handles:
 * - Listing sessions via the SDK
 * - Loading session messages via the SDK with validation
 * - Subagent loading from disk (not yet supported by the SDK)
 *
 * ## Usage
 * ```typescript
 * const service = instantiationService.get(IClaudeCodeSessionService);
 * const sessions = await service.getAllSessions(token);
 * ```
 */

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CancellationToken } from 'vscode';
import { INativeEnvService } from '../../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../../util/common/services';
import { CancellationError } from '../../../../../util/vs/base/common/errors';
import { basename } from '../../../../../util/vs/base/common/resources';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IFolderRepositoryManager } from '../../../../chatSessions/common/folderRepositoryManager';
import { IClaudeCodeSdkService } from '../claudeCodeSdkService';
import { getProjectFolders } from '../claudeProjectFolders';
import {
	buildSubagentSession,
	parseSessionFileContent,
} from './claudeSessionParser';
import {
	AssistantMessageContent,
	IClaudeCodeSession,
	IClaudeCodeSessionInfo,
	ISubagentSession,
	StoredMessage,
	UserMessageContent,
	vAssistantMessageContent,
	vUserMessageContent,
} from './claudeSessionSchema';

// #region Service Interface

export const IClaudeCodeSessionService = createServiceIdentifier<IClaudeCodeSessionService>('IClaudeCodeSessionService');

/**
 * Service to load and manage Claude Code chat sessions.
 * Uses the Claude Agent SDK for session discovery and message loading.
 */
export interface IClaudeCodeSessionService {
	readonly _serviceBrand: undefined;

	/**
	 * Get lightweight metadata for all sessions in the current workspace.
	 */
	getAllSessions(token: CancellationToken): Promise<readonly IClaudeCodeSessionInfo[]>;

	/**
	 * Get a specific session with full content by its resource URI.
	 */
	getSession(resource: URI, token: CancellationToken): Promise<IClaudeCodeSession | undefined>;
}

// #endregion

// #endregion

// #region Message Conversion

/**
 * Convert an SDK SessionMessage to a StoredMessage using validators.
 * Returns null if validation fails.
 */
function convertSessionMessage(msg: SessionMessage): StoredMessage | null {
	if (msg.type === 'user') {
		const result = vUserMessageContent.validate(msg.message);
		if (result.error) {
			return null;
		}
		return {
			uuid: msg.uuid,
			sessionId: msg.session_id,
			timestamp: new Date(0),
			parentUuid: null,
			type: 'user',
			message: result.content as UserMessageContent,
		};
	}

	if (msg.type === 'assistant') {
		const result = vAssistantMessageContent.validate(msg.message);
		if (result.error) {
			return null;
		}
		return {
			uuid: msg.uuid,
			sessionId: msg.session_id,
			timestamp: new Date(0),
			parentUuid: null,
			type: 'assistant',
			message: result.content as AssistantMessageContent,
		};
	}

	return null;
}

/**
 * Derive a display label from session messages.
 * Uses the first genuine user message text.
 */
function labelFromMessages(messages: readonly StoredMessage[]): string {
	for (const msg of messages) {
		if (msg.type !== 'user' || msg.message.role !== 'user') {
			continue;
		}

		const content = (msg.message as UserMessageContent).content;
		let text: string | undefined;

		if (typeof content === 'string') {
			text = content.trim();
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === 'text' && 'text' in block) {
					text = (block as { text: string }).text.trim();
					if (text.length > 0) {
						break;
					}
				}
			}
		}

		if (text !== undefined && text.length > 0) {
			const firstLine = text.split('\n').find(l => l.trim().length > 0) ?? text;
			return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
		}
	}

	return 'Claude Session';
}

// #endregion

// #region Service Implementation

export class ClaudeCodeSessionService implements IClaudeCodeSessionService {
	declare _serviceBrand: undefined;

	/**
	 * Cache of session metadata populated by getAllSessions().
	 * Used by getSession() to retrieve timestamps without a redundant listSessions() call.
	 */
	private readonly _sessionInfoCache = new Map<string, { lastModified: number }>();

	constructor(
		@IClaudeCodeSdkService private readonly _sdkService: IClaudeCodeSdkService,
		@IFileSystemService private readonly _fileSystem: IFileSystemService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceService private readonly _workspace: IWorkspaceService,
		@INativeEnvService private readonly _nativeEnvService: INativeEnvService,
		@IFolderRepositoryManager private readonly _folderRepositoryManager: IFolderRepositoryManager
	) { }

	/**
	 * Get lightweight metadata for all sessions in the current workspace.
	 * Delegates to the SDK's listSessions() per workspace folder.
	 */
	async getAllSessions(token: CancellationToken): Promise<readonly IClaudeCodeSessionInfo[]> {
		const items: IClaudeCodeSessionInfo[] = [];
		const projectFolders = await getProjectFolders(this._workspace, this._folderRepositoryManager);

		this._sessionInfoCache.clear();

		for (const { folderUri } of projectFolders) {
			if (token.isCancellationRequested) {
				return items;
			}

			const folderName = basename(folderUri);

			try {
				const sdkSessions = await this._sdkService.listSessions({ dir: folderUri.fsPath });

				for (const s of sdkSessions) {
					// Cache metadata for use by getSession()
					this._sessionInfoCache.set(s.sessionId, { lastModified: s.lastModified });

					if (!s.summary && !s.customTitle) {
						continue; // Skip sessions with no displayable label
					}

					items.push({
						id: s.sessionId,
						label: s.customTitle ?? s.summary,
						created: s.lastModified,
						lastRequestEnded: s.lastModified,
						folderName,
					});
				}
			} catch (e) {
				this._logService.debug(`[ClaudeCodeSessionService] Failed to list sessions for ${folderUri.fsPath}: ${e}`);
			}
		}

		return items;
	}

	/**
	 * Get a specific session with full content by its resource URI.
	 * Uses the SDK's getSessionMessages() with validation.
	 */
	async getSession(resource: URI, token: CancellationToken): Promise<IClaudeCodeSession | undefined> {
		const targetId = resource.path.slice(1); // Remove leading '/' from path
		const projectFolders = await getProjectFolders(this._workspace, this._folderRepositoryManager);

		for (const { slug, folderUri } of projectFolders) {
			if (token.isCancellationRequested) {
				return undefined;
			}

			try {
				const sdkMessages = await this._sdkService.getSessionMessages(targetId, { dir: folderUri.fsPath });

				if (sdkMessages.length === 0) {
					continue;
				}

				// Validate and convert messages
				const storedMessages: StoredMessage[] = [];
				for (const msg of sdkMessages) {
					const converted = convertSessionMessage(msg);
					if (converted !== null) {
						storedMessages.push(converted);
					}
				}

				if (storedMessages.length === 0) {
					continue;
				}

				// Load subagents (still file-based — SDK doesn't support this yet)
				const subagents = await this._loadSubagents(targetId, slug, token);

				// Derive label from messages
				const label = labelFromMessages(storedMessages);

				// Use cached timestamp from getAllSessions() if available,
				// avoiding a redundant listSessions() call (O(n * 128KB))
				const cachedInfo = this._sessionInfoCache.get(targetId);
				const lastModified = cachedInfo?.lastModified;
				const now = Date.now();

				const session: IClaudeCodeSession = {
					id: targetId,
					label,
					created: lastModified ?? now,
					lastRequestStarted: lastModified,
					lastRequestEnded: lastModified ?? now,
					messages: storedMessages,
					subagents,
				};

				return session;
			} catch (e) {
				this._logService.debug(`[ClaudeCodeSessionService] Failed to load session ${targetId} from ${folderUri.fsPath}: ${e}`);
				continue;
			}
		}

		return undefined;
	}

	// #region Subagent Loading

	/**
	 * Load subagent sessions from disk.
	 * The SDK does not yet expose subagent data, so we fall back to file-based loading.
	 */
	private async _loadSubagents(
		sessionId: string,
		slug: string,
		token: CancellationToken
	): Promise<readonly ISubagentSession[]> {
		const projectDirUri = URI.joinPath(this._nativeEnvService.userHome, '.claude', 'projects', slug);
		const subagentsDirUri = URI.joinPath(projectDirUri, sessionId, 'subagents');

		let entries: [string, FileType][];
		try {
			entries = await this._fileSystem.readDirectory(subagentsDirUri);
		} catch {
			return [];
		}

		if (entries.length === 0) {
			return [];
		}

		const subagentTasks: Promise<ISubagentSession | null>[] = [];

		for (const [name, type] of entries) {
			if (type !== FileType.File || !name.startsWith('agent-') || !name.endsWith('.jsonl')) {
				continue;
			}

			const agentId = name.slice(6, -6);
			if (agentId.length === 0) {
				continue;
			}

			const fileUri = URI.joinPath(subagentsDirUri, name);
			subagentTasks.push(this._parseSubagentFile(agentId, fileUri, token));
		}

		const results = await Promise.allSettled(subagentTasks);
		if (token.isCancellationRequested) {
			return [];
		}

		const subagents: ISubagentSession[] = [];
		for (const r of results) {
			if (r.status === 'fulfilled' && r.value !== null) {
				subagents.push(r.value);
			}
		}

		subagents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
		return subagents;
	}

	/**
	 * Parse a single subagent file.
	 */
	private async _parseSubagentFile(
		agentId: string,
		fileUri: URI,
		token: CancellationToken
	): Promise<ISubagentSession | null> {
		try {
			const content = await this._fileSystem.readFile(fileUri, true);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			const text = Buffer.from(content).toString('utf8');
			const parseResult = parseSessionFileContent(text, fileUri.fsPath);
			return buildSubagentSession(agentId, parseResult);
		} catch (e) {
			if (e instanceof CancellationError) {
				throw e;
			}
			this._logService.debug(`[ClaudeCodeSessionService] Failed to parse subagent: ${fileUri}`);
			return null;
		}
	}

	// #endregion
}

// #endregion
