/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Claude Code Session Service
 *
 * This service provides access to Claude Code chat sessions stored on disk.
 * It handles:
 * - Discovery of session files in the Claude projects directory
 * - Parsing and validation of JSONL session files
 * - Caching for performance
 * - Error reporting for debugging
 *
 * ## Directory Structure
 * Sessions are stored in:
 * - ~/.claude/projects/{workspace-slug}/{session-id}.jsonl
 *
 * The workspace slug is derived from the workspace folder path.
 *
 * ## Usage
 * ```typescript
 * const service = instantiationService.get(IClaudeCodeSessionService);
 * const sessions = await service.getAllSessions(token);
 * ```
 */

import type { CancellationToken } from 'vscode';
import { INativeEnvService } from '../../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../../util/common/services';
import { CancellationError } from '../../../../../util/vs/base/common/errors';
import { ResourceMap, ResourceSet } from '../../../../../util/vs/base/common/map';
import { cwd } from '../../../../../util/vs/base/common/process';
import { isEqualOrParent } from '../../../../../util/vs/base/common/resources';
import { URI } from '../../../../../util/vs/base/common/uri';
import {
	buildSessions,
	buildSubagentSession,
	extractSessionMetadata,
	extractSessionMetadataStreaming,
	parseSessionFileContent,
	ParseError,
	ParseStats,
} from './claudeSessionParser';
import {
	IClaudeCodeSession,
	IClaudeCodeSessionInfo,
	ISubagentSession,
} from './claudeSessionSchema';

// #region Utility Functions

/**
 * Type-safe extraction of error code from unknown error values.
 * Handles Node.js errors, VS Code FileSystemError, and other error types.
 */
function getErrorCode(error: unknown): string | undefined {
	if (error === null || error === undefined) {
		return undefined;
	}
	if (typeof error !== 'object') {
		return undefined;
	}
	if ('code' in error && typeof error.code === 'string') {
		return error.code;
	}
	return undefined;
}

// #endregion

// #region Service Interface

export const IClaudeCodeSessionService = createServiceIdentifier<IClaudeCodeSessionService>('IClaudeCodeSessionService');

/**
 * Service to load and manage Claude Code chat sessions from disk.
 */
export interface IClaudeCodeSessionService {
	readonly _serviceBrand: undefined;

	/**
	 * Get lightweight metadata for all sessions in the current workspace.
	 * This is optimized for listing sessions without loading full content.
	 */
	getAllSessions(token: CancellationToken): Promise<readonly IClaudeCodeSessionInfo[]>;

	/**
	 * Get a specific session with full content by its resource URI.
	 * This loads the complete message history and subagents.
	 */
	getSession(resource: URI, token: CancellationToken): Promise<IClaudeCodeSession | undefined>;

	/**
	 * Get parse errors from the last session load (for debugging).
	 */
	getLastParseErrors(): readonly ParseError[];

	/**
	 * Get parse statistics from the last session load (for debugging).
	 */
	getLastParseStats(): ParseStats | undefined;
}

// #endregion

// #region Service Implementation

export class ClaudeCodeSessionService implements IClaudeCodeSessionService {
	declare _serviceBrand: undefined;

	// Lightweight metadata cache for getAllSessions (keyed by project dir URI)
	private _metadataCache = new ResourceMap<readonly IClaudeCodeSessionInfo[]>();
	private _metadataFileMtimes = new ResourceMap<number>();

	// Full session cache for getSession (keyed by session resource URI)
	private _fullSessionCache = new ResourceMap<IClaudeCodeSession>();

	// Track session directories for subagent detection
	private _sessionDirs = new ResourceMap<Set<string>>();

	// Debugging information
	private _lastParseErrors: ParseError[] = [];
	private _lastParseStats: ParseStats | undefined;

	constructor(
		@IFileSystemService private readonly _fileSystem: IFileSystemService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceService private readonly _workspace: IWorkspaceService,
		@INativeEnvService private readonly _nativeEnvService: INativeEnvService
	) { }

	/**
	 * Get lightweight metadata for all sessions in the current workspace.
	 */
	async getAllSessions(token: CancellationToken): Promise<readonly IClaudeCodeSessionInfo[]> {
		const items: IClaudeCodeSessionInfo[] = [];
		const slugs = this._getProjectSlugs();

		for (const slug of slugs) {
			if (token.isCancellationRequested) {
				return items;
			}

			const projectDirUri = URI.joinPath(this._nativeEnvService.userHome, '.claude', 'projects', slug);

			// Check if we can use cached metadata
			const cachedMetadata = await this._getCachedMetadataIfValid(projectDirUri, token);
			if (cachedMetadata !== null) {
				items.push(...cachedMetadata);
				continue;
			}

			// Cache miss or invalid - reload metadata from disk
			const freshMetadata = await this._loadSessionMetadataFromDisk(projectDirUri, token);
			this._metadataCache.set(projectDirUri, freshMetadata);
			items.push(...freshMetadata);
		}

		return items;
	}

	/**
	 * Get a specific session with full content by its resource URI.
	 */
	async getSession(resource: URI, token: CancellationToken): Promise<IClaudeCodeSession | undefined> {
		// Check full session cache first
		const cached = this._fullSessionCache.get(resource);
		if (cached !== undefined) {
			return cached;
		}

		const targetId = resource.path.slice(1); // Remove leading '/' from path
		const slugs = this._getProjectSlugs();

		for (const slug of slugs) {
			if (token.isCancellationRequested) {
				return undefined;
			}

			const projectDirUri = URI.joinPath(this._nativeEnvService.userHome, '.claude', 'projects', slug);
			const sessionFileUri = URI.joinPath(projectDirUri, `${targetId}.jsonl`);

			// Check if this file exists
			try {
				await this._fileSystem.stat(sessionFileUri);
			} catch {
				continue; // File doesn't exist in this project dir
			}

			// Load and parse the full session
			const session = await this._loadFullSession(targetId, projectDirUri, token);
			if (session !== undefined) {
				this._fullSessionCache.set(resource, session);
				return session;
			}
		}

		return undefined;
	}

	/**
	 * Get parse errors from the last session load (for debugging).
	 */
	getLastParseErrors(): readonly ParseError[] {
		return this._lastParseErrors;
	}

	/**
	 * Get parse statistics from the last session load (for debugging).
	 */
	getLastParseStats(): ParseStats | undefined {
		return this._lastParseStats;
	}

	// #region Directory Discovery

	/**
	 * Read a directory, returning an empty array if the directory doesn't exist.
	 */
	private async _tryReadDirectory(dirUri: URI): Promise<[string, FileType][]> {
		try {
			return await this._fileSystem.readDirectory(dirUri);
		} catch (e) {
			const code = getErrorCode(e);
			switch (code) {
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
	 * Compute the workspace slug from a folder URI.
	 * Matches the Claude Code slug format.
	 *
	 * @example
	 * // Windows: drive letter is uppercased, path separators become hyphens
	 * '/c:/Users/test/project' → 'C--Users-test-project'
	 *
	 * // macOS/Linux: leading slash becomes hyphen, path separators become hyphens
	 * '/Users/test/project' → '-Users-test-project'
	 */
	private _computeFolderSlug(folderUri: URI): string {
		return folderUri.path
			.replace(/^\/([a-z]):/i, (_, driveLetter: string) => driveLetter.toUpperCase() + '-')
			.replace(/[\/ .]/g, '-');
	}

	/**
	 * Get the project directory slugs to scan for sessions.
	 * Handles single vs multi-folder workspaces and provides error handling for cwd resolution.
	 */
	private _getProjectSlugs(): string[] {
		const folders = this._workspace.getWorkspaceFolders();

		if (folders.length === 1) {
			return [this._computeFolderSlug(folders[0])];
		}

		let cwdUri: URI | undefined;
		try {
			cwdUri = URI.file(cwd());
		} catch (error) {
			this._logService.error('[ClaudeCodeSessionService] Failed to resolve current working directory for session discovery', error);
			if (folders.length > 0) {
				cwdUri = folders[0];
			}
		}

		if (cwdUri) {
			return [this._computeFolderSlug(cwdUri)];
		}

		return [];
	}

	// #endregion

	// #region Caching

	/**
	 * Check if cached metadata is still valid by comparing file modification times.
	 */
	private async _getCachedMetadataIfValid(
		projectDirUri: URI,
		token: CancellationToken
	): Promise<readonly IClaudeCodeSessionInfo[] | null> {
		if (!this._metadataCache.has(projectDirUri)) {
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
				const cachedMtime = this._metadataFileMtimes.get(fileUri);

				if (cachedMtime === undefined || stat.mtime > cachedMtime) {
					// File has changed or is new - also invalidate full session cache for this file
					const sessionId = name.slice(0, -6);
					const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
					this._fullSessionCache.delete(sessionResource);
					return null;
				}
			} catch {
				// File might have been deleted, invalidate cache
				return null;
			}
		}

		// Check if any previously cached files have been deleted
		for (const cachedFileUri of this._metadataFileMtimes.keys()) {
			if (isEqualOrParent(cachedFileUri, projectDirUri) && cachedFileUri.path.endsWith('.jsonl')) {
				if (!currentFiles.has(cachedFileUri)) {
					// A previously cached file has been deleted
					return null;
				}
			}
		}

		// All files are unchanged, return cached metadata
		return this._metadataCache.get(projectDirUri) ?? null;
	}

	// #endregion

	// #region Metadata Loading (Lightweight)

	/**
	 * Load lightweight session metadata from disk.
	 * This extracts only id, label, and timestamp from each session file.
	 */
	private async _loadSessionMetadataFromDisk(
		projectDirUri: URI,
		token: CancellationToken
	): Promise<readonly IClaudeCodeSessionInfo[]> {
		const entries = await this._tryReadDirectory(projectDirUri);
		if (entries.length === 0) {
			return [];
		}

		// Track session directories for later use in getSession
		const sessionDirs = new Set<string>();
		const metadataTasks: Promise<{ metadata: IClaudeCodeSessionInfo | null; fileUri: URI } | null>[] = [];

		for (const [name, type] of entries) {
			if (type === FileType.Directory) {
				sessionDirs.add(name);
				continue;
			}

			if (type !== FileType.File || !name.endsWith('.jsonl')) {
				continue;
			}

			const sessionId = name.slice(0, -6);
			if (sessionId.length === 0) {
				continue;
			}

			const fileUri = URI.joinPath(projectDirUri, name);
			metadataTasks.push(this._extractSessionMetadata(sessionId, fileUri, token));
		}

		this._sessionDirs.set(projectDirUri, sessionDirs);

		const results = await Promise.allSettled(metadataTasks);
		if (token.isCancellationRequested) {
			return [];
		}

		const metadataList: IClaudeCodeSessionInfo[] = [];
		for (const r of results) {
			if (r.status === 'fulfilled' && r.value !== null && r.value.metadata !== null) {
				metadataList.push(r.value.metadata);

				// Update mtime cache
				try {
					const stat = await this._fileSystem.stat(r.value.fileUri);
					this._metadataFileMtimes.set(r.value.fileUri, stat.mtime);
				} catch {
					// File might have been deleted during processing
				}
			}
		}

		return metadataList;
	}

	/**
	 * Extract metadata from a single session file using streaming.
	 * This minimizes memory usage by reading line-by-line and stopping early
	 * once all needed metadata is found.
	 *
	 * Falls back to the synchronous approach when streaming fails (e.g., in tests
	 * using mock file systems where the file doesn't exist on disk).
	 */
	private async _extractSessionMetadata(
		sessionId: string,
		fileUri: URI,
		token: CancellationToken
	): Promise<{ metadata: IClaudeCodeSessionInfo | null; fileUri: URI } | null> {
		try {
			const stat = await this._fileSystem.stat(fileUri);
			if (token.isCancellationRequested) {
				return null;
			}

			const fileMtime = new Date(stat.mtime);

			// Try streaming first (preferred for large files)
			try {
				// Create an AbortController to bridge CancellationToken to AbortSignal
				const abortController = new AbortController();
				const cancellationListener = token.onCancellationRequested(() => {
					abortController.abort();
				});

				try {
					const metadata = await extractSessionMetadataStreaming(
						fileUri.fsPath,
						sessionId,
						fileMtime,
						abortController.signal
					);
					return { metadata, fileUri };
				} finally {
					cancellationListener.dispose();
				}
			} catch (streamError) {
				// If streaming fails (e.g., file not found on disk in test environment
				// using mocked file system), fall back to the sync approach
				const streamErrorCode = getErrorCode(streamError);
				if (streamErrorCode === 'ENOENT') {
					// File doesn't exist on disk - use IFileSystemService fallback
					const content = await this._fileSystem.readFile(fileUri, true);
					const text = Buffer.from(content).toString('utf8');
					const metadata = extractSessionMetadata(text, sessionId, fileMtime);
					return { metadata, fileUri };
				}
				// Re-throw other errors
				throw streamError;
			}
		} catch (e) {
			const code = getErrorCode(e);
			if (code !== 'FileNotFound' && code !== 'ENOENT') {
				const message = e instanceof Error ? e.message : String(e);
				if (!message.includes('Operation cancelled')) {
					this._logService.debug(`[ClaudeCodeSessionService] Failed to extract metadata: ${fileUri}`);
				}
			}
			return null;
		}
	}

	// #endregion

	// #region Full Session Loading

	/**
	 * Load a full session with all messages and subagents.
	 */
	private async _loadFullSession(
		sessionId: string,
		projectDirUri: URI,
		token: CancellationToken
	): Promise<IClaudeCodeSession | undefined> {
		const sessionFileUri = URI.joinPath(projectDirUri, `${sessionId}.jsonl`);

		try {
			const content = await this._fileSystem.readFile(sessionFileUri, true);
			if (token.isCancellationRequested) {
				return undefined;
			}

			const text = Buffer.from(content).toString('utf8');
			const parseResult = parseSessionFileContent(text, sessionFileUri.fsPath);

			// Store errors and stats for debugging
			this._lastParseErrors = [...parseResult.errors];
			this._lastParseStats = parseResult.stats;

			// Build session from parsed data
			const buildResult = buildSessions(
				parseResult.messages,
				parseResult.summaries,
				parseResult.chainLinks
			);

			if (buildResult.sessions.length === 0) {
				return undefined;
			}

			// Find the session with matching ID (should be exactly one after deduplication)
			let session = buildResult.sessions.find(s => s.id === sessionId);
			if (session === undefined) {
				// Fallback to first session if ID doesn't match exactly
				session = buildResult.sessions[0];
			}

			// Load subagents if available
			const sessionDirs = this._sessionDirs.get(projectDirUri);
			if (sessionDirs?.has(sessionId)) {
				const subagentsDirUri = URI.joinPath(projectDirUri, sessionId, 'subagents');
				const { subagents } = await this._loadSubagentsForSession(sessionId, subagentsDirUri, token);
				if (subagents.length > 0) {
					session = { ...session, subagents };
				}
			}

			return session;
		} catch (e) {
			const code = getErrorCode(e);
			if (code !== 'FileNotFound' && code !== 'ENOENT') {
				this._logService.error(e, `[ClaudeCodeSessionService] Failed to load full session: ${sessionFileUri}`);
			}
			return undefined;
		}
	}

	// #endregion

	// #region Subagent Loading

	/**
	 * Load all subagents for a specific session.
	 */
	private async _loadSubagentsForSession(
		sessionId: string,
		subagentsDirUri: URI,
		token: CancellationToken
	): Promise<{ sessionId: string; subagents: ISubagentSession[] }> {
		const entries = await this._tryReadDirectory(subagentsDirUri);
		if (entries.length === 0) {
			return { sessionId, subagents: [] };
		}

		const subagentTasks: Promise<ISubagentSession | null>[] = [];

		for (const [name, type] of entries) {
			if (type !== FileType.File) {
				continue;
			}

			// Match agent-{id}.jsonl pattern
			if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) {
				continue;
			}

			const agentId = name.slice(6, -6); // Extract ID from agent-{id}.jsonl
			if (agentId.length === 0) {
				continue;
			}

			const fileUri = URI.joinPath(subagentsDirUri, name);
			subagentTasks.push(this._parseSubagentFile(agentId, fileUri, token));
		}

		const results = await Promise.allSettled(subagentTasks);
		if (token.isCancellationRequested) {
			return { sessionId, subagents: [] };
		}

		const subagents: ISubagentSession[] = [];
		for (const r of results) {
			if (r.status === 'fulfilled' && r.value !== null) {
				subagents.push(r.value);
			}
		}

		// Sort by timestamp
		subagents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

		return { sessionId, subagents };
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

			// Build subagent session from parsed result
			return buildSubagentSession(agentId, parseResult.messages, parseResult.chainLinks);
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
