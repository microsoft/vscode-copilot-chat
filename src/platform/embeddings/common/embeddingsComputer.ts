/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { EMBEDDING_MODEL } from '../../configuration/common/configurationService';
import { EmbeddingsEndpointFamily } from '../../endpoint/common/endpointProvider';

/**
 * Fully qualified type of the embedding.
 *
 * This includes both the model identifier and the dimensions.
 */
export class EmbeddingType {
	public static readonly text3small_512 = new EmbeddingType('text-embedding-3-small-512');
	public static readonly metis_1024_I16_Binary = new EmbeddingType('metis-1024-I16-Binary');

	constructor(
		public readonly id: string
	) { }

	public toString(): string {
		return this.id;
	}

	public equals(other: EmbeddingType): boolean {
		return this.id === other.id;
	}
}

type EmbeddingQuantization = 'float32' | 'float16' | 'binary';

export interface EmbeddingTypeInfo {
	readonly model: EMBEDDING_MODEL;
	readonly family: EmbeddingsEndpointFamily;
	readonly dimensions: number;
	readonly quantization: {
		readonly query: EmbeddingQuantization;
		readonly document: EmbeddingQuantization;
	};
}

const wellKnownEmbeddingMetadata = Object.freeze<Record<string, EmbeddingTypeInfo>>({
	[EmbeddingType.text3small_512.id]: {
		model: EMBEDDING_MODEL.TEXT3SMALL,
		family: 'text3small',
		dimensions: 512,
		quantization: {
			query: 'float32',
			document: 'float32'
		},
	},
	[EmbeddingType.metis_1024_I16_Binary.id]: {
		model: EMBEDDING_MODEL.Metis_1024_I16_Binary,
		family: 'metis',
		dimensions: 1024,
		quantization: {
			query: 'float16',
			document: 'binary'
		},
	},
});

export function getWellKnownEmbeddingTypeInfo(type: EmbeddingType): EmbeddingTypeInfo | undefined {
	return wellKnownEmbeddingMetadata[type.id];
}

export type EmbeddingVector = readonly number[];

export interface Embedding {
	readonly type: EmbeddingType;
	readonly value: EmbeddingVector;
}

export interface Embeddings {
	readonly type: EmbeddingType;
	readonly values: readonly Embedding[];
}

export interface EmbeddingDistance {
	readonly embeddingType: EmbeddingType;
	readonly value: number;
}

export const IEmbeddingsComputer = createServiceIdentifier<IEmbeddingsComputer>('IEmbeddingsComputer');

export type ComputeEmbeddingsOptions = {
	readonly inputType?: 'document' | 'query';
	readonly parallelism?: number;
};

export interface IEmbeddingsComputer {

	readonly _serviceBrand: undefined;

	/**
	 * Computes embeddings for the given strings.
	 *
	 * @param inputs The strings to compute embeddings for.
	 *
	 * @returns The embeddings, or if there is a failure/no embeddings, undefined.
	 */
	computeEmbeddings(
		type: EmbeddingType,
		inputs: readonly string[],
		options?: ComputeEmbeddingsOptions,
		token?: CancellationToken,
	): Promise<Embeddings | undefined>;
}

function dotProduct(a: EmbeddingVector, b: EmbeddingVector): number {
	if (a.length !== b.length) {
		console.warn('Embeddings do not have same length for computing dot product');
	}

	let dotProduct = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dotProduct += a[i] * b[i];
	}
	return dotProduct;
}

/**
 * Gets the similarity score from 0-1 between two embeddings.
 */
export function distance(queryEmbedding: Embedding, otherEmbedding: Embedding): EmbeddingDistance {
	if (!queryEmbedding.type.equals(otherEmbedding.type)) {
		throw new Error(`Embeddings must be of the same type to compute similarity. Got: ${queryEmbedding.type.id} and ${otherEmbedding.type.id}`);
	}

	return {
		embeddingType: queryEmbedding.type,
		value: dotProduct(otherEmbedding.value, queryEmbedding.value),
	};
}

/**
 * Rank the embedding items by their cosine similarity to a query
 *
 * @returns The top {@linkcode maxResults} items.
 */
export function rankEmbeddings<T>(
	queryEmbedding: Embedding,
	items: ReadonlyArray<readonly [T, Embedding]>,
	maxResults: number,
	options?: {
		readonly minDistance?: number;
		readonly maxSpread?: number;
	}
): Array<{ readonly value: T; readonly distance: EmbeddingDistance }> {
	const minThreshold = options?.minDistance ?? 0;

	const results = items
		.map(([value, embedding]): { readonly distance: EmbeddingDistance; readonly value: T } => {
			return { distance: distance(embedding, queryEmbedding), value };
		})
		.filter(entry => entry.distance.value > minThreshold)
		.sort((a, b) => b.distance.value - a.distance.value)
		.slice(0, maxResults)
		.map(entry => {
			return {
				distance: entry.distance,
				value: entry.value,
			};
		});

	if (results.length && typeof options?.maxSpread === 'number') {
		const minScore = results.at(0)!.distance.value * (1.0 - options.maxSpread);
		const out = results.filter(x => x.distance.value >= minScore);
		return out;
	}

	return results;
}
