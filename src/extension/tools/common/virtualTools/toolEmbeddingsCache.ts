/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Embedding, EmbeddingType, EmbeddingVector, rankEmbeddings } from '../../../../platform/embeddings/common/embeddingsComputer';
import { IEmbeddingsCache } from '../../../../platform/embeddings/common/embeddingsIndex';

class ToolEmbeddingsCache implements IEmbeddingsCache {
	public embeddingType: EmbeddingType = EmbeddingType.text3small_512;

	private embeddings: { [key: string]: { embedding: EmbeddingVector } } | undefined = undefined;
	async getCache<T = { [key: string]: { embedding: EmbeddingVector } }>(): Promise<T | undefined> {
		return this.getEmbeddings() as Promise<T>;
	}

	clearCache(): Promise<void> {
		return Promise.resolve();
	}

	private async getEmbeddings(): Promise<{ [key: string]: { embedding: EmbeddingVector } }> {
		if (!this.embeddings) {
			const embeddingsFile = (await import('./allRoolEmbeddings.json'));
			this.embeddings = {};
			for (const [key, value] of Object.entries(embeddingsFile.default)) {
				this.embeddings[key] = { embedding: value as unknown as EmbeddingVector };
			}
		}

		return this.embeddings;
	}
}

export class ToolEmbeddingsComputer {
	private readonly toolEmbeddingsCache: ToolEmbeddingsCache;

	constructor() {
		this.toolEmbeddingsCache = new ToolEmbeddingsCache();
	}

	public async retrieveSimilarEmbeddingsForAvailableTools(queryEmbedding: Embedding, availableToolNames: Set<string>, count: number): Promise<string[]> {
		const tools = await this.getToolEmbeddingsArray();
		if (!tools || tools.length === 0) {
			return [];
		}

		// Filter to only include available tools
		const availableTools = tools.filter(([toolName]) => availableToolNames.has(toolName));
		if (availableTools.length === 0) {
			return [];
		}

		const rankedEmbeddings = rankEmbeddings(queryEmbedding, availableTools, count);
		return rankedEmbeddings.map(x => x.value);
	}

	private toolEmbeddingsArray: ReadonlyArray<readonly [string, Embedding]> | undefined = undefined;
	private async getToolEmbeddingsArray(): Promise<ReadonlyArray<readonly [string, Embedding]>> {
		if (!this.toolEmbeddingsArray) {
			const arr: [string, Embedding][] = [];
			// Load the embeddings from the cache
			const embeddings = await this.toolEmbeddingsCache.getCache();
			if (embeddings) {
				for (const [key, value] of Object.entries(embeddings)) {
					arr.push([key, { type: EmbeddingType.text3small_512, value: value.embedding }]);
				}
				this.toolEmbeddingsArray = arr as ReadonlyArray<readonly [string, Embedding]>;
			} else {
				this.toolEmbeddingsArray = [];
			}
		}
		return this.toolEmbeddingsArray;
	}
}