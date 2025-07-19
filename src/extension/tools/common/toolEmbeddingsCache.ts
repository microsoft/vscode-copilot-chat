/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { Embedding, EmbeddingType, IEmbeddingsComputer } from '../../../platform/embeddings/common/embeddingsComputer';
import { LRUCache } from '../../../util/common/cache';
import { hash } from '../../../util/vs/base/common/hash';

export interface ToolEmbeddingData {
	readonly name: string;
	readonly description: string;
	readonly schema?: unknown;
}

export class ToolEmbeddingsCache {
	private readonly _cache: LRUCache<Embedding>;
	private readonly _embeddingType = EmbeddingType.text3small_512;

	constructor(
		private readonly _embeddingsComputer: IEmbeddingsComputer,
		cacheSize: number = 256
	) {
		this._cache = new LRUCache<Embedding>(cacheSize);
	}

	/**
	 * Get the cache key for a tool based on its data
	 */
	private _getCacheKey(tool: ToolEmbeddingData): string {
		const contentHash = hash(`${tool.name}|${tool.description}|${JSON.stringify(tool.schema ?? {})}`);
		return `${tool.name}_${contentHash}`;
	}

	/**
	 * Get the text representation of a tool for embedding
	 */
	private _getToolText(tool: ToolEmbeddingData): string {
		let text = `Tool: ${tool.name}\nDescription: ${tool.description}`;

		if (tool.schema) {
			try {
				const schemaStr = JSON.stringify(tool.schema, null, 2);
				text += `\nSchema: ${schemaStr}`;
			} catch {
				// Ignore schema serialization errors
			}
		}

		return text;
	}

	/**
	 * Get embeddings for multiple tools, using cache when possible
	 */
	async getToolEmbeddings(
		tools: ReadonlyArray<ToolEmbeddingData>,
		cancellationToken?: CancellationToken
	): Promise<Map<string, Embedding>> {
		const result = new Map<string, Embedding>();
		const uncachedTools: { tool: ToolEmbeddingData; text: string }[] = [];

		// Check cache first
		for (const tool of tools) {
			const cacheKey = this._getCacheKey(tool);
			const cached = this._cache.get(cacheKey);

			if (cached) {
				result.set(tool.name, cached);
			} else {
				uncachedTools.push({
					tool,
					text: this._getToolText(tool)
				});
			}
		}

		// Compute embeddings for uncached tools
		if (uncachedTools.length > 0) {
			const texts = uncachedTools.map(item => item.text);
			const embeddings = await this._embeddingsComputer.computeEmbeddings(
				this._embeddingType,
				texts,
				{ inputType: 'document' },
				cancellationToken
			);

			if (embeddings) {
				for (let i = 0; i < uncachedTools.length; i++) {
					const { tool } = uncachedTools[i];
					const embedding = embeddings.values[i];

					if (embedding) {
						const cacheKey = this._getCacheKey(tool);
						this._cache.put(cacheKey, embedding);
						result.set(tool.name, embedding);
					}
				}
			}
		}

		return result;
	}

	/**
	 * Get embedding for a query string
	 */
	async getQueryEmbedding(
		query: string,
		cancellationToken?: CancellationToken
	): Promise<Embedding | undefined> {
		const embeddings = await this._embeddingsComputer.computeEmbeddings(
			this._embeddingType,
			[query],
			{ inputType: 'query' },
			cancellationToken
		);

		return embeddings?.values[0];
	}

	/**
	 * Clear the cache
	 */
	clear(): void {
		this._cache.clear();
	}
}