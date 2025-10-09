/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { Embedding, EmbeddingType, IEmbeddingsComputer, rankEmbeddings } from '../../../../platform/embeddings/common/embeddingsComputer';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { TelemetryCorrelationId } from '../../../../util/common/telemetryCorrelationId';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { StopWatch } from '../../../../util/vs/base/common/stopwatch';
import { isDefined } from '../../../../util/vs/base/common/types';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { PreComputedToolEmbeddingsCache } from './preComputedToolEmbeddingsCache';
import { ToolEmbeddingLocalCache } from './toolEmbeddingsLocalCache';

export interface IToolEmbeddingsCache {
	initialize(): Promise<void>;
	get(tool: LanguageModelToolInformation): Embedding | undefined;
	set(tool: LanguageModelToolInformation, embedding: Embedding): void;
}

interface IInit {
	embeddingType: EmbeddingType;
	caches: readonly IToolEmbeddingsCache[];
}

export interface IToolEmbeddingsComputer {
	_serviceBrand: undefined;

	retrieveSimilarEmbeddingsForAvailableTools(queryEmbedding: Embedding, availableTools: readonly LanguageModelToolInformation[], limit: number, token: CancellationToken): Promise<string[]>;
}

export const IToolEmbeddingsComputer = createServiceIdentifier<IToolEmbeddingsComputer>('IToolEmbeddingsComputer');

/**
 * Manages tool embeddings from both pre-computed cache and runtime computation
 */
export class ToolEmbeddingsComputer implements IToolEmbeddingsComputer {
	declare _serviceBrand: undefined;

	private readonly embeddingsStore = new Map<string, Promise<Embedding | undefined>>();
	private readonly _initialized = new Lazy(() => this.ensureInitialized());
	private readonly _caches: readonly IToolEmbeddingsCache[];
	private readonly _embeddingType: EmbeddingType;

	constructor(
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const { caches, embeddingType } = this.getCaches(instantiationService);
		this._caches = caches;
		this._embeddingType = embeddingType;
	}

	protected getCaches(instantiationService: IInstantiationService): IInit {
		const precomputed = instantiationService.createInstance(PreComputedToolEmbeddingsCache);
		const embeddingType = precomputed.embeddingType;

		return {
			embeddingType,
			caches: [
				precomputed,
				instantiationService.createInstance(ToolEmbeddingLocalCache),
			],
		};
	}

	/**
	 * Legacy method name for backward compatibility
	 */
	public async retrieveSimilarEmbeddingsForAvailableTools(queryEmbedding: Embedding, availableToolNames: readonly LanguageModelToolInformation[], count: number, token: CancellationToken): Promise<string[]> {
		await this._initialized.value;

		if (token.isCancellationRequested) {
			return [];
		}

		const availableEmbeddings = await this.getAvailableToolEmbeddings(availableToolNames, token);
		if (availableEmbeddings.length === 0) {
			return [];
		}

		const rankedEmbeddings = this.rankEmbeddings(queryEmbedding, availableEmbeddings, count);
		const matched = rankedEmbeddings.map(x => x.value);
		this._logService.trace(`[virtual-tools] Matched ${JSON.stringify(matched)} against the query.`);

		return matched;
	}

	private rankEmbeddings(queryEmbedding: Embedding, availableEmbeddings: ReadonlyArray<readonly [string, Embedding]>, count: number) {
		return rankEmbeddings(queryEmbedding, availableEmbeddings, count);
	}

	/**
	 * Ensures pre-computed embeddings are loaded into the store
	 */
	private async ensureInitialized(): Promise<void> {
		await Promise.all(this._caches.map(c => c.initialize()));
	}


	/**
	 * Computes embeddings for missing tools and stores them
	 */
	private computeMissingEmbeddings(missingTools: LanguageModelToolInformation[], token: CancellationToken) {
		if (token.isCancellationRequested || missingTools.length === 0) {
			return;
		}

		const computedEmbeddings = this.computeEmbeddingsForTools(missingTools, token).catch(e => {
			this._logService.error('Failed to compute embeddings for tools', e);
			return undefined;
		});

		for (const tool of missingTools) {
			const promise = computedEmbeddings.then(async (c) => {
				const found = c?.find(([name]) => name === tool.name)?.[1];
				if (found === undefined) {
					this.embeddingsStore.delete(tool.name);
				} else {
					for (const cache of this._caches) {
						cache.set(tool, found);
					}
				}

				return found;
			});

			this.embeddingsStore.set(tool.name, promise);
		}
	}

	/**
	 * Computes embeddings for a list of tool names
	 */
	private async computeEmbeddingsForTools(tools: LanguageModelToolInformation[], token: CancellationToken): Promise<[string, Embedding][] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const toolNames = tools.map(t => t.name);
		const start = new StopWatch();
		const embeddings = await this._embeddingsComputer.computeEmbeddings(this._embeddingType, toolNames, {}, new TelemetryCorrelationId('ToolEmbeddingsComputer::computeEmbeddingsForTools'), token);
		this._logService.trace(`[virtual-tools] Computed embeddings for ${toolNames.length} tools in ${start.elapsed()}ms`);

		if (embeddings?.values.length === 0 || embeddings?.values.length !== toolNames.length) {
			return undefined;
		}

		return toolNames.map((name, index) => [name, embeddings.values[index]]);
	}

	/**
	 * Gets embeddings for available tools as an array suitable for ranking
	 */
	private async getAvailableToolEmbeddings(tools: readonly LanguageModelToolInformation[], token: CancellationToken): Promise<ReadonlyArray<readonly [string, Embedding]>> {
		const fromCaches = new Map(tools.map(t => {
			for (const cache of this._caches) {
				const embedding = cache.get(t);
				if (embedding) {
					return [t.name, embedding] as [string, Embedding];
				}
			}
		}).filter(isDefined));

		const missingTools = tools.filter(t => !this.embeddingsStore.has(t.name) && !fromCaches.has(t.name));
		this.computeMissingEmbeddings(missingTools, token);

		const result: [string, Embedding][] = [];

		for (const { name } of tools) {
			if (token.isCancellationRequested) {
				return result;
			}

			const cached = fromCaches.get(name);
			if (cached) {
				result.push([name, cached]);
				continue;
			}

			const embedding = await this.embeddingsStore.get(name);
			if (embedding) {
				result.push([name, embedding]);
			}
		}

		return result;
	}
}
