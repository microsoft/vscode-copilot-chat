/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { getGithubRepoIdFromFetchUrl, getOrderedRemoteUrlsFromContext, IGitService, toGithubNwo } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';

/**
 * Maximum number of session memory directories to keep.
 * Older sessions beyond this limit will be cleaned up.
 */
const SESSION_MAX_COUNT = 20;

/**
 * Directory name for memory storage within extension storage.
 */
export const MEMORY_DIR_NAME = 'memory-tool/memories';

/**
 * Repository memory entry format aligned with CAPI service contract.
 * Supports both new format (citations as string[]) and legacy format (citations as string).
 */
export interface RepoMemoryEntry {
	subject: string;
	fact: string;
	citations?: string | string[];
	reason?: string;
	category?: string;
}

/**
 * Type guard to validate if an object is a valid RepoMemoryEntry.
 * Accepts both new format (citations: string[]) and legacy format (citations: string).
 */
export function isRepoMemoryEntry(obj: unknown): obj is RepoMemoryEntry {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const entry = obj as Record<string, unknown>;

	// Required fields
	if (typeof entry.subject !== 'string' || typeof entry.fact !== 'string') {
		return false;
	}

	// Optional fields
	if (entry.citations !== undefined) {
		const isString = typeof entry.citations === 'string';
		const isStringArray = Array.isArray(entry.citations) && entry.citations.every(c => typeof c === 'string');
		if (!isString && !isStringArray) {
			return false;
		}
	}

	if (entry.reason !== undefined && typeof entry.reason !== 'string') {
		return false;
	}

	if (entry.category !== undefined && typeof entry.category !== 'string') {
		return false;
	}

	return true;
}

/**
 * Normalize citations field to string[] format.
 * Handles backward compatibility for legacy string format.
 */
export function normalizeCitations(citations: string | string[] | undefined): string[] | undefined {
	if (citations === undefined) {
		return undefined;
	}
	if (typeof citations === 'string') {
		return citations.split(',').map(c => c.trim()).filter(c => c.length > 0);
	}
	return citations;
}

/**
 * Service for managing agent memory lifecycle, including cleanup of old session memories
 * and synchronization with Copilot Memory CAPI endpoints.
 */
export interface IAgentMemoryService {
	readonly _serviceBrand: undefined;

	/**
	 * Clean up old session memory directories, keeping only the most recent ones.
	 */
	cleanupSessions(): Promise<void>;

	/**
	 * Get the repo memory entries from local filesystem.
	 * Returns undefined if no memories exist for the repo.
	 */
	getRepoMemoryContext(): Promise<RepoMemoryEntry[] | undefined>;

	/**
	 * Check if Copilot Memory sync is enabled for the current repository.
	 * Makes a lightweight API call to the enablement check endpoint.
	 * Returns false if CAPI sync is disabled or if the check fails.
	 */
	checkMemoryEnabled(): Promise<boolean>;

	/**
	 * Fetch memories from the Copilot Memory CAPI endpoint.
	 * Returns undefined if CAPI sync is disabled, not enabled for this repo, or if the request fails.
	 */
	fetchMemoriesFromCAPI(limit?: number): Promise<RepoMemoryEntry[] | undefined>;

	/**
	 * Store a memory to the Copilot Memory CAPI endpoint.
	 * Does nothing if CAPI sync is disabled or not enabled for this repo.
	 */
	storeMemoryToCAPI(memory: RepoMemoryEntry): Promise<void>;
}

export const IAgentMemoryService = createServiceIdentifier<IAgentMemoryService>('IAgentMemoryService');

interface SessionInfo {
	uri: URI;
	mtime: number;
}

export class AgentMemoryService extends Disposable implements IAgentMemoryService {
	declare readonly _serviceBrand: undefined;

	private static readonly SESSIONS_DIR_NAME = 'sessions';
	private static readonly REPO_DIR_NAME = 'repo';

	/**
	 * Session-scoped cache for CAPI enablement checks, keyed by repository NWO.
	 * Prevents redundant API calls within the same session.
	 */
	private readonly capiEnabledCache = new Map<string, boolean>();

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@ILogService private readonly logService: ILogService,
		@ICAPIClientService private readonly capiClientService: ICAPIClientService,
		@IGitService private readonly gitService: IGitService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService
	) {
		super();
	}

	override dispose(): void {
		// Perform cleanup on extension deactivation
		this.cleanupSessions().catch(err => {
			this.logService.error(`[AgentMemoryService] Error during dispose cleanup: ${err}`);
		});
		super.dispose();
	}

	async cleanupSessions(): Promise<void> {
		try {
			const sessionsDir = this.getSessionsDir();
			if (!sessionsDir) {
				return;
			}

			// Check if sessions directory exists
			try {
				const stat = await this.fileSystem.stat(sessionsDir);
				if (stat.type !== FileType.Directory) {
					return;
				}
			} catch {
				// Directory doesn't exist, nothing to clean up
				return;
			}

			// Read all session directories
			const entries = await this.fileSystem.readDirectory(sessionsDir);
			const sessionDirs = entries.filter(([, type]) => type === FileType.Directory);

			if (sessionDirs.length <= SESSION_MAX_COUNT) {
				return; // Nothing to clean up
			}

			// Get mtime for each session directory to sort by recency
			const sessions: SessionInfo[] = [];
			for (const [name] of sessionDirs) {
				const sessionUri = URI.joinPath(sessionsDir, name);
				try {
					const stat = await this.fileSystem.stat(sessionUri);
					sessions.push({
						uri: sessionUri,
						mtime: stat.mtime
					});
				} catch {
					// Skip sessions that can't be stat'd
					continue;
				}
			}

			// Sort by mtime descending (most recent first)
			sessions.sort((a, b) => b.mtime - a.mtime);

			// Delete sessions beyond the limit
			const sessionsToDelete = sessions.slice(SESSION_MAX_COUNT);
			for (const session of sessionsToDelete) {
				try {
					await this.fileSystem.delete(session.uri, { recursive: true });
					this.logService.debug(`[AgentMemoryService] Deleted old session: ${session.uri.fsPath}`);
				} catch (error) {
					this.logService.warn(`[AgentMemoryService] Failed to delete session ${session.uri.fsPath}: ${error}`);
				}
			}

			if (sessionsToDelete.length > 0) {
				this.logService.info(`[AgentMemoryService] Cleaned up ${sessionsToDelete.length} old session(s)`);
			}
		} catch (error) {
			this.logService.error(`[AgentMemoryService] Error during session cleanup: ${error}`);
		}
	}

	private getSessionsDir(): URI | undefined {
		const storageUri = this.extensionContext.storageUri;
		if (!storageUri) {
			return undefined;
		}
		return URI.joinPath(storageUri, MEMORY_DIR_NAME, AgentMemoryService.SESSIONS_DIR_NAME);
	}

	async getRepoMemoryContext(): Promise<RepoMemoryEntry[] | undefined> {
		try {
			const repoDir = this.getRepoDir();
			if (!repoDir) {
				return undefined;
			}

			// Check if repo directory exists
			try {
				const stat = await this.fileSystem.stat(repoDir);
				if (stat.type !== FileType.Directory) {
					return undefined;
				}
			} catch {
				// Directory doesn't exist
				return undefined;
			}

			// Read all memory files in the repo directory
			const memories = await this.readMemoriesRecursively(repoDir, '');
			if (memories.length === 0) {
				return undefined;
			}

			// Sort by mtime descending and take last 10 memories
			memories.sort((a, b) => b.mtime - a.mtime);
			const recentMemories = memories.slice(0, 10);

			// Parse JSONL content and extract memory entries
			const entries: RepoMemoryEntry[] = [];
			for (const memory of recentMemories) {
				const parsed = this.parseMemoryContent(memory.content);
				entries.push(...parsed);
			}

			return entries.length > 0 ? entries : undefined;
		} catch (error) {
			this.logService.warn(`[AgentMemoryService] Error reading repo memories: ${error}`);
			return undefined;
		}
	}

	private parseMemoryContent(content: string): RepoMemoryEntry[] {
		const lines = content.split('\n').filter(line => line.trim());
		const entries: RepoMemoryEntry[] = [];

		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as unknown;
				if (isRepoMemoryEntry(entry)) {
					entries.push(entry);
				}
			} catch {
				// Not valid JSON, skip this line
				continue;
			}
		}

		return entries;
	}

	private async readMemoriesRecursively(baseDir: URI, relativePath: string): Promise<Array<{ path: string; content: string; mtime: number }>> {
		const memories: Array<{ path: string; content: string; mtime: number }> = [];
		const currentDir = relativePath ? URI.joinPath(baseDir, relativePath) : baseDir;

		try {
			const entries = await this.fileSystem.readDirectory(currentDir);

			for (const [name, type] of entries) {
				if (name.startsWith('.')) {
					continue; // Skip hidden files
				}

				const entryPath = relativePath ? `${relativePath}/${name}` : name;

				if (type === FileType.Directory) {
					// Recursively read subdirectories
					const subMemories = await this.readMemoriesRecursively(baseDir, entryPath);
					memories.push(...subMemories);
				} else if (type === FileType.File) {
					try {
						const fileUri = URI.joinPath(baseDir, entryPath);
						const stat = await this.fileSystem.stat(fileUri);
						const content = await this.fileSystem.readFile(fileUri);
						const text = new TextDecoder('utf-8').decode(content);
						memories.push({ path: `/memories/repo/${entryPath}`, content: text, mtime: stat.mtime });
					} catch (error) {
						this.logService.debug(`[AgentMemoryService] Failed to read memory file ${entryPath}: ${error}`);
					}
				}
			}
		} catch (error) {
			this.logService.debug(`[AgentMemoryService] Failed to read directory ${relativePath}: ${error}`);
		}

		return memories;
	}

	private getRepoDir(): URI | undefined {
		const storageUri = this.extensionContext.storageUri;
		if (!storageUri) {
			return undefined;
		}
		return URI.joinPath(storageUri, MEMORY_DIR_NAME, AgentMemoryService.REPO_DIR_NAME);
	}

	/**
	 * Get the GitHub repository NWO (name with owner) for the current workspace.
	 * Returns the NWO in lowercase format (e.g., "microsoft/vscode").
	 */
	private async getRepoNwo(): Promise<string | undefined> {
		try {
			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			if (!workspaceFolders || workspaceFolders.length === 0) {
				return undefined;
			}

			const repo = await this.gitService.getRepository(workspaceFolders[0]);
			if (!repo) {
				return undefined;
			}

			// Try to get GitHub repo info from remote URLs
			for (const remoteUrl of getOrderedRemoteUrlsFromContext(repo)) {
				const repoId = getGithubRepoIdFromFetchUrl(remoteUrl);
				if (repoId) {
					return toGithubNwo(repoId);
				}
			}

			return undefined;
		} catch (error) {
			this.logService.warn(`[AgentMemoryService] Failed to get repo NWO: ${error}`);
			return undefined;
		}
	}

	/**
	 * Check if the chat.copilotMemory.enabled config is enabled.
	 * Uses experiment-based configuration for gradual rollout.
	 */
	private isCAPIMemorySyncConfigEnabled(): boolean {
		return this.configService.getExperimentBasedConfig(ConfigKey.CopilotMemory.Enabled, this.experimentationService);
	}

	async checkMemoryEnabled(): Promise<boolean> {
		try {
			// Check if CAPI sync is enabled via config
			if (!this.isCAPIMemorySyncConfigEnabled()) {
				return false;
			}

			const repoNwo = await this.getRepoNwo();
			if (!repoNwo) {
				return false;
			}

			// Check cache first
			if (this.capiEnabledCache.has(repoNwo)) {
				return this.capiEnabledCache.get(repoNwo)!;
			}

			// Make API call to check enablement
			const response = await this.capiClientService.makeRequest<{ enabled: boolean }>({
				method: 'GET'
			}, {
				type: RequestType.CopilotAgentMemory,
				repo: repoNwo,
				action: 'enabled'
			});

			const enabled = response?.enabled ?? false;

			// Cache the result for this session
			this.capiEnabledCache.set(repoNwo, enabled);

			this.logService.info(`[AgentMemoryService] CAPI memory enabled for ${repoNwo}: ${enabled}`);
			return enabled;
		} catch (error) {
			this.logService.warn(`[AgentMemoryService] Failed to check memory enablement: ${error}`);
			// On error, don't cache and return false
			return false;
		}
	}

	async fetchMemoriesFromCAPI(limit: number = 10): Promise<RepoMemoryEntry[] | undefined> {
		try {
			// Check if CAPI sync is enabled
			const enabled = await this.checkMemoryEnabled();
			if (!enabled) {
				return undefined;
			}

			const repoNwo = await this.getRepoNwo();
			if (!repoNwo) {
				return undefined;
			}

			// Fetch memories from CAPI
			const response = await this.capiClientService.makeRequest<Array<{
				subject: string;
				fact: string;
				citations?: string[];
				reason?: string;
				category?: string;
			}>>({
				method: 'GET'
			}, {
				type: RequestType.CopilotAgentMemory,
				repo: repoNwo,
				action: 'recent',
				limit
			});

			if (!response || !Array.isArray(response)) {
				return undefined;
			}

			// Transform response to RepoMemoryEntry format
			const memories: RepoMemoryEntry[] = response
				.filter(isRepoMemoryEntry)
				.map(entry => ({
					subject: entry.subject,
					fact: entry.fact,
					citations: entry.citations,
					reason: entry.reason,
					category: entry.category
				}));

			this.logService.info(`[AgentMemoryService] Fetched ${memories.length} memories from CAPI for ${repoNwo}`);
			return memories.length > 0 ? memories : undefined;
		} catch (error) {
			this.logService.warn(`[AgentMemoryService] Failed to fetch memories from CAPI: ${error}`);
			return undefined;
		}
	}

	async storeMemoryToCAPI(memory: RepoMemoryEntry): Promise<void> {
		try {
			// Check if CAPI sync is enabled
			const enabled = await this.checkMemoryEnabled();
			if (!enabled) {
				return;
			}

			const repoNwo = await this.getRepoNwo();
			if (!repoNwo) {
				return;
			}

			// Normalize citations to array format for CAPI
			const citations = normalizeCitations(memory.citations) ?? [];

			// Store memory to CAPI
			await this.capiClientService.makeRequest({
				method: 'POST',
				json: {
					subject: memory.subject,
					fact: memory.fact,
					citations,
					reason: memory.reason,
					category: memory.category
				}
			}, {
				type: RequestType.CopilotAgentMemory,
				repo: repoNwo
			});

			this.logService.info(`[AgentMemoryService] Stored memory to CAPI for ${repoNwo}: ${memory.subject}`);
		} catch (error) {
			this.logService.warn(`[AgentMemoryService] Failed to store memory to CAPI: ${error}`);
			// Don't throw - allow local storage to succeed even if CAPI fails
		}
	}
}
