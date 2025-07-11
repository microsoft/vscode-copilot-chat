/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { EmbeddingVector } from '../../src/platform/embeddings/common/embeddingsComputer';
import { SQLiteCache } from './cache';
import { CacheableEmbeddingRequest, IEmbeddingsCache } from './cachingEmbeddingsFetcher';

export const usedEmbeddingsCaches = new Set<string>();

export class EmbeddingsSQLiteCache extends SQLiteCache<CacheableEmbeddingRequest, EmbeddingVector> implements IEmbeddingsCache {
	constructor(salt: string) {
		super('embeddings', salt);
	}
}