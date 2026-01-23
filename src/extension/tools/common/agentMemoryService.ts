/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../platform/log/common/logService';
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

export interface RepoMemoryEntry {
	subject: string;
	fact: string;
	citations?: string;
}

/**
 * Service for managing agent memory lifecycle, including cleanup of old session memories.
 */
export interface IAgentMemoryService {
	readonly _serviceBrand: undefined;

	/**
	 * Clean up old session memory directories, keeping only the most recent ones.
	 */
	cleanupSessions(): Promise<void>;

	/**
	 * Get the repo memory entries.
	 * Returns undefined if no memories exist for the repo.
	 */
	getRepoMemoryContext(): Promise<RepoMemoryEntry[] | undefined>;
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

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@ILogService private readonly logService: ILogService
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
				const entry = JSON.parse(line) as { subject?: string; fact?: string; citations?: string };
				if (entry.subject && entry.fact) {
					entries.push({
						subject: entry.subject,
						fact: entry.fact,
						citations: entry.citations
					});
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
}
