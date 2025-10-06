/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Embedding, EmbeddingType, IEmbeddingsComputer, rankEmbeddings } from '../../../platform/embeddings/common/embeddingsComputer';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService, fileSystemServiceReadAsJSON } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { VSBuffer } from '../../../util/vs/base/common/buffer';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import {
	IMemoryItem,
	IMemoryListOptions,
	IMemorySearchOptions,
	IMemorySearchResult,
	IMemoryService,
	IMemoryStoreOptions
} from '../common/memoryService';

interface IMemoryStorage {
	memories: IMemoryItem[];
	version: string;
}

export class MemoryServiceImpl extends Disposable implements IMemoryService {
	private readonly _storageUri: URI;
	// Directory where individual memory files are stored
	private readonly _storageDir: URI;
	private readonly _memories = new Map<string, IMemoryItem>();
	private _isLoaded = false;
	private _embeddingsComputer: IEmbeddingsComputer | undefined;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		super();

		// Determine storage location in priority order:
		// 1) user-configured setting `copilot.memoryStoragePath` (accepts file path or URI)
		// 2) first workspace folder (workspace root)
		// 3) extensionContext.storageUri or extensionContext.globalStorageUri (original behavior)
		let baseStorageUri: URI | undefined;

		// 1) Try configured path
		try {
			const configured = this.configurationService.getNonExtensionConfig<string>('copilot.memoryStoragePath');
			if (configured && configured.trim().length > 0) {
				try {
					if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(configured)) {
						baseStorageUri = URI.parse(configured);
					} else {
						// If relative path provided and a workspace folder exists, resolve against it
						const absPathRegex = /^[A-Za-z]:\\|^\//;
						const workspaceFolders = this.workspaceService.getWorkspaceFolders();
						if (workspaceFolders && workspaceFolders.length > 0 && !absPathRegex.test(configured)) {
							const ws = workspaceFolders[0].fsPath;
							const path = require('path');
							baseStorageUri = URI.file(path.resolve(ws, configured));
						} else {
							baseStorageUri = URI.file(configured);
						}
					}
					this.logService.info(`Using configured copilot.memoryStoragePath: ${configured}`);
				} catch (err) {
					this.logService.warn(`Invalid copilot.memoryStoragePath: ${configured} - ${err}`);
				}
			}
		} catch (err) {
			this.logService.debug(`Failed to read configuration copilot.memoryStoragePath: ${err}`);
		}

		// 2) Use workspace root if no configured path
		if (!baseStorageUri) {
			try {
				const workspaceFolders = this.workspaceService.getWorkspaceFolders();
				if (workspaceFolders && workspaceFolders.length > 0) {
					const wsUriStr = workspaceFolders[0].toString();
					baseStorageUri = URI.parse(wsUriStr);
					this.logService.info(`Using workspace root for memories: ${wsUriStr}`);
				}
			} catch (err) {
				this.logService.debug(`Failed to use workspace folder as storage location: ${err}`);
			}
		}

		// 3) Fallback to previous behavior
		if (!baseStorageUri) {
			const storageUri = this.extensionContext.storageUri || this.extensionContext.globalStorageUri;
			if (!storageUri) {
				throw new Error('No storage URI available for memory service');
			}
			baseStorageUri = storageUri;
			this.logService.info(`Using extension storage location for memories: ${baseStorageUri.toString()}`);
		}

		this._storageDir = URI.joinPath(baseStorageUri, 'copilot-memories');
		this._storageUri = URI.joinPath(baseStorageUri, 'copilot-memories.json');
	}

	private async ensureLoaded(): Promise<void> {
		if (this._isLoaded) {
			return;
		}

		try {
			// Ensure storage directory exists
			try {
				await this.fileSystemService.stat(this._storageDir);
			} catch {
				await this.fileSystemService.createDirectory(this._storageDir);
			}

			// Attempt migration from single file (copilot-memories.json) if present
			try {
				const data = await fileSystemServiceReadAsJSON.readJSON<IMemoryStorage>(this.fileSystemService, this._storageUri);
				if (data?.memories && data.memories.length > 0) {
					for (const memory of data.memories) {
						memory.timestamp = new Date(memory.timestamp);
						// Write each memory into its own file
						const id = memory.id || generateUuid();
						memory.id = id;
						const fileUri = URI.joinPath(this._storageDir, `${id}.json`);
						await this.fileSystemService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(memory, null, 2)).buffer);
						this._memories.set(id, memory);
					}
					// Remove old single-file storage after migration
					try {
						await this.fileSystemService.delete(this._storageUri);
					} catch {
						// Non-fatal
					}
					this.logService.info(`Migrated ${data.memories.length} memories from single-file storage`);
				}
			} catch (err) {
				// If readJSON failed because file doesn't exist, ignore
			}

			// Load individual memory files
			const entries = await this.fileSystemService.readDirectory(this._storageDir);
			for (const [name, type] of entries) {
				if (type === 1 /* file */ && name.endsWith('.json')) {
					try {
						const fileUri = URI.joinPath(this._storageDir, name);
						const mem = await fileSystemServiceReadAsJSON.readJSON<IMemoryItem>(this.fileSystemService, fileUri);
						mem.timestamp = new Date(mem.timestamp);
						this._memories.set(mem.id, mem);
					} catch (err) {
						this.logService.warn(`Failed to read memory file ${name}: ${err}`);
					}
				}
			}
			this.logService.info(`Loaded ${this._memories.size} memories from storage`);
		} catch (error) {
			if (error.code !== 'ENOENT') {
				this.logService.warn(`Failed to load memories from storage: ${error}`);
			}
		}

		this._isLoaded = true;
	}

	// Save an individual memory file
	private async saveMemoryToFile(memory: IMemoryItem): Promise<void> {
		const fileUri = URI.joinPath(this._storageDir, `${memory.id}.json`);
		await this.fileSystemService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(memory, null, 2)).buffer);
	}

	private async getEmbeddingsComputer(): Promise<IEmbeddingsComputer | undefined> {
		if (!this._embeddingsComputer) {
			try {
				// Use the same embedding computer as the workspace search
				this._embeddingsComputer = this.instantiationService.createInstance(
					(await import('../../../platform/embeddings/common/remoteEmbeddingsComputer')).RemoteEmbeddingsComputer
				);
			} catch (error) {
				this.logService.warn(`Failed to create embeddings computer: ${error}`);
			}
		}
		return this._embeddingsComputer;
	}

	async storeMemory(memory: Omit<IMemoryItem, 'id' | 'embedding'>, options?: IMemoryStoreOptions): Promise<IMemoryItem> {
		await this.ensureLoaded();

		const id = generateUuid();
		let embedding: Embedding | undefined;

		// Generate embedding if requested and embeddings computer is available
		if (options?.generateEmbedding !== false) {
			const embeddingsComputer = await this.getEmbeddingsComputer();
			if (embeddingsComputer) {
				try {
					const embeddings = await embeddingsComputer.computeEmbeddings(
						EmbeddingType.text3small_512,
						[memory.content]
					);
					if (embeddings.values.length > 0) {
						embedding = embeddings.values[0];
					}
				} catch (error) {
					this.logService.warn(`Failed to generate embedding for memory: ${error}`);
				}
			}
		}

		const newMemory: IMemoryItem = {
			...memory,
			id,
			embedding,
			metadata: { ...memory.metadata, ...options?.metadata }
		};

		this._memories.set(id, newMemory);
		try {
			await this.saveMemoryToFile(newMemory);
		} catch (err) {
			this.logService.error(`Failed to save memory file for ID ${id}: ${err}`);
			throw err;
		}

		this.logService.debug(`Stored memory with ID: ${id}`);
		return newMemory;
	}

	async searchMemories(query: string, options?: IMemorySearchOptions): Promise<IMemorySearchResult[]> {
		await this.ensureLoaded();

		const results: IMemorySearchResult[] = [];
		const memories = Array.from(this._memories.values());

		// Filter by tags if specified
		const filteredMemories = options?.tags?.length
			? memories.filter(m => options.tags!.some(tag => m.tags.includes(tag)))
			: memories;

		// Filter by date range if specified
		const dateFilteredMemories = options?.dateRange
			? filteredMemories.filter(m => {
				const timestamp = m.timestamp.getTime();
				const start = options.dateRange!.start?.getTime() || 0;
				const end = options.dateRange!.end?.getTime() || Date.now();
				return timestamp >= start && timestamp <= end;
			})
			: filteredMemories;

		// Semantic search if enabled and embeddings are available
		if (options?.semanticSearch !== false) {
			const embeddingsComputer = await this.getEmbeddingsComputer();
			if (embeddingsComputer) {
				try {
					const queryEmbeddings = await embeddingsComputer.computeEmbeddings(
						EmbeddingType.text3small_512,
						[query]
					);

					if (queryEmbeddings.values.length > 0) {
						const queryEmbedding = queryEmbeddings.values[0];
						const memoriesWithEmbeddings = dateFilteredMemories.filter(m => m.embedding);

						if (memoriesWithEmbeddings.length > 0) {
							const ranked = rankEmbeddings(
								queryEmbedding,
								memoriesWithEmbeddings.map(m => [m, m.embedding!] as const),
								options?.maxResults || 50
							);

							for (const { value: memory, distance } of ranked) {
								if (distance.value >= (options?.threshold || 0.1)) {
									results.push({
										memory,
										similarity: distance.value,
										matchType: 'semantic'
									});
								}
							}
						}
					}
				} catch (error) {
					this.logService.warn(`Failed to perform semantic search: ${error}`);
				}
			}
		}

		// Text search if enabled or semantic search failed
		if (options?.textSearch !== false || results.length === 0) {
			const queryLower = query.toLowerCase();
			for (const memory of dateFilteredMemories) {
				const contentLower = memory.content.toLowerCase();
				if (contentLower.includes(queryLower)) {
					// Simple text similarity based on substring match position and length
					const similarity = Math.max(0.1, query.length / memory.content.length);

					// Avoid duplicates from semantic search
					if (!results.some(r => r.memory.id === memory.id)) {
						results.push({
							memory,
							similarity,
							matchType: 'text'
						});
					}
				}
			}
		}

		// Tag-based search
		if (options?.tags?.length) {
			for (const memory of dateFilteredMemories) {
				const matchingTags = memory.tags.filter(tag =>
					options.tags!.some(searchTag => tag.toLowerCase().includes(searchTag.toLowerCase()))
				);

				if (matchingTags.length > 0 && !results.some(r => r.memory.id === memory.id)) {
					results.push({
						memory,
						similarity: matchingTags.length / memory.tags.length,
						matchType: 'tag'
					});
				}
			}
		}

		// Sort by similarity (descending) and limit results
		results.sort((a, b) => b.similarity - a.similarity);

		const maxResults = options?.maxResults || 10;
		return results.slice(0, maxResults);
	}

	async listMemories(options?: IMemoryListOptions): Promise<IMemoryItem[]> {
		await this.ensureLoaded();

		let memories = Array.from(this._memories.values());

		// Filter by tags
		if (options?.tags?.length) {
			memories = memories.filter(m =>
				options.tags!.some(tag => m.tags.includes(tag))
			);
		}

		// Sort
		const sortBy = options?.sortBy || 'timestamp';
		const sortOrder = options?.sortOrder || 'desc';

		memories.sort((a, b) => {
			let comparison = 0;

			switch (sortBy) {
				case 'timestamp':
					comparison = a.timestamp.getTime() - b.timestamp.getTime();
					break;
				case 'content':
					comparison = a.content.localeCompare(b.content);
					break;
				default:
					comparison = 0;
			}

			return sortOrder === 'asc' ? comparison : -comparison;
		});

		// Pagination
		const offset = options?.offset || 0;
		const limit = options?.limit || memories.length;

		return memories.slice(offset, offset + limit);
	}

	async getMemory(id: string): Promise<IMemoryItem | undefined> {
		await this.ensureLoaded();
		return this._memories.get(id);
	}

	async updateMemory(id: string, updates: Partial<Omit<IMemoryItem, 'id'>>): Promise<IMemoryItem> {
		await this.ensureLoaded();

		const existing = this._memories.get(id);
		if (!existing) {
			throw new Error(`Memory with ID ${id} not found`);
		}

		// Regenerate embedding if content changed
		let embedding = existing.embedding;
		if (updates.content && updates.content !== existing.content) {
			const embeddingsComputer = await this.getEmbeddingsComputer();
			if (embeddingsComputer) {
				try {
					const embeddings = await embeddingsComputer.computeEmbeddings(
						EmbeddingType.text3small_512,
						[updates.content]
					);
					if (embeddings.values.length > 0) {
						embedding = embeddings.values[0];
					}
				} catch (error) {
					this.logService.warn(`Failed to generate embedding for updated memory: ${error}`);
				}
			}
		}

		const updated: IMemoryItem = {
			...existing,
			...updates,
			id, // Ensure ID doesn't change
			embedding: embedding || existing.embedding,
		};

		this._memories.set(id, updated);
		try {
			await this.saveMemoryToFile(updated);
		} catch (err) {
			this.logService.error(`Failed to save updated memory file for ID ${id}: ${err}`);
			throw err;
		}

		return updated;
	}

	async deleteMemory(id: string): Promise<void> {
		await this.ensureLoaded();

		if (!this._memories.has(id)) {
			throw new Error(`Memory with ID ${id} not found`);
		}

		this._memories.delete(id);
		const fileUri = URI.joinPath(this._storageDir, `${id}.json`);
		try {
			await this.fileSystemService.delete(fileUri);
		} catch (err) {
			// Non-fatal: log and continue
			this.logService.warn(`Failed to delete memory file for ID ${id}: ${err}`);
		}

		this.logService.debug(`Deleted memory with ID: ${id}`);
	}

	async getTags(): Promise<string[]> {
		await this.ensureLoaded();

		const tagSet = new Set<string>();
		for (const memory of this._memories.values()) {
			memory.tags.forEach(tag => tagSet.add(tag));
		}

		return Array.from(tagSet).sort();
	}

	async clearMemories(tags?: string[]): Promise<void> {
		await this.ensureLoaded();

		if (tags?.length) {
			// Delete only memories with specified tags
			const toDelete: string[] = [];
			for (const [id, memory] of this._memories) {
				if (memory.tags.some(tag => tags.includes(tag))) {
					toDelete.push(id);
				}
			}
			toDelete.forEach(id => this._memories.delete(id));
			// Remove files for deleted memories
			for (const id of toDelete) {
				const fileUri = URI.joinPath(this._storageDir, `${id}.json`);
				try {
					await this.fileSystemService.delete(fileUri);
				} catch {
					// ignore
				}
			}
		} else {
			// Delete all memories
			this._memories.clear();
			// Remove all files in storage dir
			try {
				const entries = await this.fileSystemService.readDirectory(this._storageDir);
				for (const [name, type] of entries) {
					if (type === 1 && name.endsWith('.json')) {
						const fileUri = URI.joinPath(this._storageDir, name);
						try { await this.fileSystemService.delete(fileUri); } catch { /* ignore */ }
					}
				}
			} catch {
				// ignore
			}
		}

		this.logService.info(`Cleared ${tags ? 'tagged' : 'all'} memories`);
	}

	async exportMemories(format: 'json' | 'markdown', options?: IMemoryListOptions): Promise<string> {
		const memories = await this.listMemories(options);

		switch (format) {
			case 'json':
				return JSON.stringify(memories, null, 2);

			case 'markdown': {
				const markdown = memories.map(memory => {
					const date = memory.timestamp.toLocaleDateString();
					const tags = memory.tags.length > 0 ? `\n**Tags:** ${memory.tags.join(', ')}` : '';
					return `## Memory (${date})\n\n${memory.content}${tags}\n\n---\n`;
				}).join('\n');

				return `# Copilot Memories Export\n\n${markdown}`;
			}

			default:
				throw new Error(`Unsupported export format: ${format}`);
		}
	}

	async importMemories(data: string, format: 'json' | 'markdown'): Promise<IMemoryItem[]> {
		const imported: IMemoryItem[] = [];

		switch (format) {
			case 'json': {
				const parsed = JSON.parse(data) as IMemoryItem[];
				for (const memory of parsed) {
					// Generate new IDs to avoid conflicts
					const newMemory = await this.storeMemory({
						content: memory.content,
						tags: memory.tags || [],
						timestamp: new Date(memory.timestamp),
						source: memory.source || 'import',
						metadata: memory.metadata
					});
					imported.push(newMemory);
				}
				break;
			}

			default:
				throw new Error(`Unsupported import format: ${format}`);
		}

		this.logService.info(`Imported ${imported.length} memories`);
		return imported;
	}
}