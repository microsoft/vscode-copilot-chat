/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createSha256Hash } from '../../../util/common/crypto';
import { CallTracker } from '../../../util/common/telemetryCorrelationId';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { URI } from '../../../util/vs/base/common/uri';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { FileChunkAndScore, FileChunkWithEmbedding } from '../../chunking/common/chunk';
import { ChunkableContent, ComputeBatchInfo, EmbeddingsComputeQos, IChunkingEndpointClient } from '../../chunking/common/chunkingEndpointClient';
import { distance, Embedding, EmbeddingType, IEmbeddingsComputer } from '../../embeddings/common/embeddingsComputer';
import { ILogService } from '../../log/common/logService';

/**
 * The maximum content length to sent to the chunking endpoint.
 */
const maxContentLength = 1.5 * 1024 * 1024; // 1.5 MB


class UrlContent implements ChunkableContent {

	constructor(
		public readonly uri: URI,
		private readonly _originalText: string,
	) { }

	// Markdown - https://github.com/github-linguist/linguist/blob/c27ac0c1daf3865e2b45ee3908d06b5825161d17/lib/linguist/languages.yml#L4323
	readonly githubLanguageId = 222;

	async getText(): Promise<string> {
		return this._originalText.slice(0, maxContentLength);
	}

	async getContentHash(): Promise<string> {
		return createSha256Hash(await this.getText());
	}
}


export class UrlChunkEmbeddingsIndex extends Disposable {

	private readonly _cache = new SimpleUrlContentCache<readonly FileChunkWithEmbedding[]>();

	constructor(
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
		@IChunkingEndpointClient private readonly _chunkingEndpointClient: IChunkingEndpointClient,
	) {
		super();
	}

	async findInUrls(
		files: ReadonlyArray<{ readonly uri: URI; readonly content: string }>,
		query: string,
		token: CancellationToken,
	): Promise<FileChunkAndScore[][]> {
		const [queryEmbedding, fileChunksAndEmbeddings] = await raceCancellationError(Promise.all([
			this.computeEmbeddings(query, token),
			this.getEmbeddingsForFiles(files.map(file => new UrlContent(file.uri, file.content)), EmbeddingsComputeQos.Batch, token)
		]), token);

		return this.computeChunkScores(fileChunksAndEmbeddings, queryEmbedding);
	}

	private async computeEmbeddings(str: string, token: CancellationToken): Promise<Embedding> {
		const embeddings = await this._embeddingsComputer.computeEmbeddings(EmbeddingType.text3small_512, [str], {}, token);
		if (!embeddings?.values.length) {
			throw new Error('Timeout computing embeddings');
		}

		return embeddings.values[0];
	}

	private async getEmbeddingsForFiles(files: readonly UrlContent[], qos: EmbeddingsComputeQos, token: CancellationToken): Promise<(readonly FileChunkWithEmbedding[])[]> {
		if (!files.length) {
			return [];
		}

		const batchInfo = new ComputeBatchInfo();

		this._logService.trace(`urlChunkEmbeddingsIndex: Getting auth token `);
		const authToken = await this.tryGetAuthToken();
		if (!authToken) {
			this._logService.error('urlChunkEmbeddingsIndex: Unable to get auth token');
			throw new Error('Unable to get auth token');
		}

		const result = await Promise.all(files.map(async file => {
			const result = await this.getChunksAndEmbeddings(authToken, file, batchInfo, qos, token);
			if (!result) {
				return [];
			}
			return result;
		}));
		return result;
	}

	private computeChunkScores(fileChunksAndEmbeddings: (readonly FileChunkWithEmbedding[])[], queryEmbedding: Embedding): FileChunkAndScore[][] {
		return fileChunksAndEmbeddings
			.map(file => file
				.map(({ chunk, embedding }): FileChunkAndScore => ({
					chunk,
					distance: distance(embedding, queryEmbedding),
				}))
			);
	}

	private async getChunksAndEmbeddings(authToken: string, content: UrlContent, batchInfo: ComputeBatchInfo, qos: EmbeddingsComputeQos, token: CancellationToken): Promise<readonly FileChunkWithEmbedding[] | undefined> {
		const existing = await raceCancellationError(this._cache.get(content), token);
		if (existing) {
			return existing;
		}

		const chunksAndEmbeddings = await raceCancellationError(this._chunkingEndpointClient.computeChunksAndEmbeddings(authToken, EmbeddingType.text3small_512, content, batchInfo, qos, new Map(), new CallTracker('UrlChunkEmbeddingsIndex::getChunksAndEmbeddings'), token), token);
		if (chunksAndEmbeddings) {
			this._cache.set(content, chunksAndEmbeddings);
		}

		return chunksAndEmbeddings;
	}

	private async tryGetAuthToken(createIfNone = true): Promise<string | undefined> {
		return (await this._authService.getAnyGitHubSession({ createIfNone }))?.accessToken;
	}
}


class SimpleUrlContentCache<T> {
	private readonly _cache = new ResourceMap<{ hash: string; value: T }>();

	async get(content: UrlContent): Promise<T | undefined> {
		const entry = this._cache.get(content.uri);
		if (!entry) {
			return undefined;
		}

		if (entry.hash !== await content.getContentHash()) {
			return undefined;
		}

		return entry.value;
	}

	async set(content: UrlContent, value: T): Promise<void> {
		const hash = await content.getContentHash();
		this._cache.set(content.uri, { hash, value });
	}
}