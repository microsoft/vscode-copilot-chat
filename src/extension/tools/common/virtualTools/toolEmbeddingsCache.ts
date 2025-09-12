/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Embedding, EmbeddingType, IEmbeddingsComputer, rankEmbeddings } from '../../../../platform/embeddings/common/embeddingsComputer';
import { EmbeddingCacheType, IEmbeddingsCache, RemoteCacheType, RemoteEmbeddingsCache } from '../../../../platform/embeddings/common/embeddingsIndex';
import { IEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { TelemetryCorrelationId } from '../../../../util/common/telemetryCorrelationId';
import { sanitizeVSCodeVersion } from '../../../../util/common/vscodeVersion';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';

export const EMBEDDING_TYPE_FOR_TOOL_GROUPING = EmbeddingType.text3small_512;

export class PreComputedToolEmbeddingsCache {
	private readonly cache: IEmbeddingsCache;
	private embeddingsMap: Map<string, Embedding> | undefined;

	constructor(
		@ILogService readonly _logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IEnvService envService: IEnvService
	) {
		const cacheVersion = sanitizeVSCodeVersion(envService.getEditorInfo().version);
		this.cache = instantiationService.createInstance(RemoteEmbeddingsCache, EmbeddingCacheType.GLOBAL, 'toolEmbeddings', cacheVersion, EMBEDDING_TYPE_FOR_TOOL_GROUPING, RemoteCacheType.Tools);
	}

	public get embeddingType(): EmbeddingType {
		return this.cache.embeddingType;
	}

	public async getEmbeddings(): Promise<ReadonlyMap<string, Readonly<Embedding>>> {
		if (!this.embeddingsMap) {
			this.embeddingsMap = await this.loadEmbeddings();
		}

		return this.embeddingsMap;
	}

	private async loadEmbeddings() {
		try {
			const embeddingsData = await this.cache.getCache();
			const embeddingsMap = new Map<string, Embedding>();

			if (embeddingsData) {
				for (const [key, embeddingVector] of Object.entries(embeddingsData)) {
					if (embeddingVector === undefined) {
						this._logService.warn(`Tool embedding missing for key: ${key}`);
						continue;
					}
					embeddingsMap.set(key, {
						type: this.embeddingType,
						value: embeddingVector.embedding
					});
				}
			}

			return embeddingsMap;
		} catch (e) {
			this._logService.error('Failed to load pre-computed tool embeddings', e);
			return new Map<string, Embedding>();
		}
	}
}

/**
 * Manages tool embeddings from both pre-computed cache and runtime computation
 */
export class ToolEmbeddingsComputer {
	private readonly embeddingsCache: PreComputedToolEmbeddingsCache;
	private readonly embeddingsStore = new Map<string, Embedding>();
	private isInitialized = false;

	constructor(
		@IEmbeddingsComputer private readonly embeddingsComputer: IEmbeddingsComputer,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this.embeddingsCache = instantiationService.createInstance(PreComputedToolEmbeddingsCache);
	}

	/**
	 * Legacy method name for backward compatibility
	 */
	public async retrieveSimilarEmbeddingsForAvailableTools(queryEmbedding: Embedding, availableToolNames: Set<string>, count: number, token: CancellationToken): Promise<string[]> {
		await this.ensureInitialized();
		await this.ensureToolEmbeddings(availableToolNames, token);

		if (token.isCancellationRequested) {
			return [];
		}

		const availableEmbeddings = this.getAvailableToolEmbeddings(availableToolNames);
		if (availableEmbeddings.length === 0) {
			return [];
		}

		const rankedEmbeddings = this.rankEmbeddings(queryEmbedding, availableEmbeddings, count);
		return rankedEmbeddings.map(x => x.value);
	}

	private rankEmbeddings(queryEmbedding: Embedding, availableEmbeddings: ReadonlyArray<readonly [string, Embedding]>, count: number) {
		return rankEmbeddings(queryEmbedding, availableEmbeddings, count);
	}

	/**
	 * Ensures pre-computed embeddings are loaded into the store
	 */
	private async ensureInitialized(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		const preComputedEmbeddings = await this.embeddingsCache.getEmbeddings();
		for (const [toolName, embedding] of preComputedEmbeddings) {
			this.embeddingsStore.set(toolName, embedding);
		}

		this.isInitialized = true;
	}

	/**
	 * Ensures all required tool embeddings are available (computing missing ones if needed)
	 */
	private async ensureToolEmbeddings(toolNames: Set<string>, token: CancellationToken): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}

		const missingTools = [...toolNames].filter(t => !this.embeddingsStore.has(t));
		await this.computeMissingEmbeddings(missingTools, token);
	}


	/**
	 * Computes embeddings for missing tools and stores them
	 */
	private async computeMissingEmbeddings(missingToolNames: string[], token: CancellationToken): Promise<void> {
		if (token.isCancellationRequested || missingToolNames.length === 0) {
			return;
		}

		try {
			const computedEmbeddings = await this.computeEmbeddingsForTools(missingToolNames, token);
			if (computedEmbeddings) {
				for (const [toolName, embedding] of computedEmbeddings) {
					this.embeddingsStore.set(toolName, embedding);
				}
			}
		} catch (e) {
			this._logService.error('Failed to compute embeddings for tools', e);
		}
	}

	/**
	 * Computes embeddings for a list of tool names
	 */
	private async computeEmbeddingsForTools(toolNames: string[], token: CancellationToken): Promise<[string, Embedding][] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const embeddings = await this.embeddingsComputer.computeEmbeddings(this.embeddingsCache.embeddingType, toolNames, {}, new TelemetryCorrelationId('ToolEmbeddingsComputer::computeEmbeddingsForTools'), token);

		if (embeddings?.values.length === 0 || embeddings?.values.length !== toolNames.length) {
			return undefined;
		}

		return toolNames.map((name, index) => [name, embeddings.values[index]]);
	}

	/**
	 * Gets embeddings for available tools as an array suitable for ranking
	 */
	private getAvailableToolEmbeddings(availableToolNames: Set<string>): ReadonlyArray<readonly [string, Embedding]> {
		const result: [string, Embedding][] = [];

		for (const toolName of availableToolNames) {
			const embedding = this.embeddingsStore.get(toolName);
			if (embedding) {
				result.push([toolName, embedding]);
			}
		}

		return result;
	}
}