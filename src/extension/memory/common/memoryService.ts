/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Embedding } from '../../../platform/embeddings/common/embeddingsComputer';

export interface IMemoryItem {
	id: string;
	content: string;
	tags: string[];
	timestamp: Date;
	source: string;
	embedding?: Embedding;
	metadata?: Record<string, any>;
}

export interface IMemorySearchOptions {
	maxResults?: number;
	tags?: string[];
	semanticSearch?: boolean;
	textSearch?: boolean;
	threshold?: number;
	dateRange?: {
		start?: Date;
		end?: Date;
	};
}

export interface IMemorySearchResult {
	memory: IMemoryItem;
	similarity: number;
	matchType: 'semantic' | 'text' | 'tag';
}

export interface IMemoryListOptions {
	tags?: string[];
	limit?: number;
	offset?: number;
	sortBy?: 'timestamp' | 'content' | 'relevance';
	sortOrder?: 'asc' | 'desc';
}

export interface IMemoryStoreOptions {
	generateEmbedding?: boolean;
	metadata?: Record<string, any>;
}

export const IMemoryService = createDecorator<IMemoryService>('memoryService');

export interface IMemoryService {
	/**
	 * Store a new memory item
	 */
	storeMemory(memory: Omit<IMemoryItem, 'id' | 'embedding'>, options?: IMemoryStoreOptions): Promise<IMemoryItem>;

	/**
	 * Search memories using semantic and/or text search
	 */
	searchMemories(query: string, options?: IMemorySearchOptions): Promise<IMemorySearchResult[]>;

	/**
	 * List memories with filtering and sorting
	 */
	listMemories(options?: IMemoryListOptions): Promise<IMemoryItem[]>;

	/**
	 * Get a specific memory by ID
	 */
	getMemory(id: string): Promise<IMemoryItem | undefined>;

	/**
	 * Update an existing memory
	 */
	updateMemory(id: string, updates: Partial<Omit<IMemoryItem, 'id'>>): Promise<IMemoryItem>;

	/**
	 * Delete a memory
	 */
	deleteMemory(id: string): Promise<void>;

	/**
	 * Get all unique tags
	 */
	getTags(): Promise<string[]>;

	/**
	 * Clear all memories (with optional tag filter)
	 */
	clearMemories(tags?: string[]): Promise<void>;

	/**
	 * Export memories to a format (JSON, markdown, etc.)
	 */
	exportMemories(format: 'json' | 'markdown', options?: IMemoryListOptions): Promise<string>;

	/**
	 * Import memories from a format
	 */
	importMemories(data: string, format: 'json' | 'markdown'): Promise<IMemoryItem[]>;
}