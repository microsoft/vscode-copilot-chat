/*---------------------------------------------------------------------------------------------
 *  Azure Chunking Endpoint Client
 *  Replaces ChunkingEndpointClientImpl which sends files to GitHub CAPI.
 *  Performs local naive chunking + computes embeddings via AzureEmbeddingsComputer.
 *--------------------------------------------------------------------------------------------*/

import { CallTracker } from '../../../util/common/telemetryCorrelationId';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { Range } from '../../../util/vs/editor/common/core/range';
import { Embedding, EmbeddingType, IEmbeddingsComputer } from '../../embeddings/common/embeddingsComputer';
import { ILogService } from '../../log/common/logService';
import { FileChunk, FileChunkWithEmbedding, FileChunkWithOptionalEmbedding } from '../../chunking/common/chunk';
import { ChunkableContent, ComputeBatchInfo, EmbeddingsComputeQos, IChunkingEndpointClient } from '../../chunking/common/chunkingEndpointClient';
import { createHash } from 'crypto';

/**
 * Simple local chunking: splits text into chunks of ~100 lines with 10-line overlap.
 */
function naiveChunkText(uri: URI, text: string): FileChunk[] {
	const lines = text.split('\n');
	const chunkSize = 100;
	const overlap = 10;
	const chunks: FileChunk[] = [];

	if (lines.length <= chunkSize) {
		return [{
			text,
			rawText: text,
			file: uri,
			range: new Range(1, 1, lines.length, (lines[lines.length - 1]?.length ?? 0) + 1),
			isFullFile: true,
		}];
	}

	for (let start = 0; start < lines.length; start += chunkSize - overlap) {
		const end = Math.min(start + chunkSize, lines.length);
		const chunkLines = lines.slice(start, end);
		const chunkText = chunkLines.join('\n');
		if (chunkText.trim().length === 0) {
			continue;
		}

		chunks.push({
			text: chunkText,
			rawText: chunkText,
			file: uri,
			range: new Range(start + 1, 1, end, (chunkLines[chunkLines.length - 1]?.length ?? 0) + 1),
			isFullFile: false,
		});

		if (end >= lines.length) {
			break;
		}
	}

	return chunks;
}

function hashText(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class AzureChunkingEndpointClient implements IChunkingEndpointClient {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
		@ILogService private readonly _logService: ILogService,
	) { }

	async computeChunks(
		_authToken: string,
		_embeddingType: EmbeddingType,
		content: ChunkableContent,
		batchInfo: ComputeBatchInfo,
		_qos: EmbeddingsComputeQos,
		cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined,
		_telemetryInfo: CallTracker,
		token: CancellationToken,
	): Promise<readonly FileChunkWithOptionalEmbedding[] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const text = await content.getText();
		batchInfo.sentContentTextLength += text.length;
		batchInfo.recomputedFileCount++;

		const chunks = naiveChunkText(content.uri, text);

		return chunks.map(chunk => {
			const chunkHash = hashText(chunk.text);
			const cached = cache?.get(chunkHash);
			return {
				chunk,
				chunkHash,
				embedding: cached?.embedding,
			};
		});
	}

	async computeChunksAndEmbeddings(
		_authToken: string,
		embeddingType: EmbeddingType,
		content: ChunkableContent,
		batchInfo: ComputeBatchInfo,
		_qos: EmbeddingsComputeQos,
		cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined,
		_telemetryInfo: CallTracker,
		token: CancellationToken,
	): Promise<readonly FileChunkWithEmbedding[] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const text = await content.getText();
		batchInfo.sentContentTextLength += text.length;
		batchInfo.recomputedFileCount++;

		const chunks = naiveChunkText(content.uri, text);
		if (chunks.length === 0) {
			return [];
		}

		// Check cache for already-embedded chunks
		const needsEmbedding: { index: number; text: string }[] = [];
		const results: (FileChunkWithEmbedding | undefined)[] = new Array(chunks.length);

		for (let i = 0; i < chunks.length; i++) {
			const chunkHash = hashText(chunks[i].text);
			const cached = cache?.get(chunkHash);
			if (cached) {
				results[i] = cached;
			} else {
				needsEmbedding.push({ index: i, text: chunks[i].text });
			}
		}

		// Compute embeddings for uncached chunks
		if (needsEmbedding.length > 0) {
			try {
				const texts = needsEmbedding.map(x => x.text);
				const embeddings = await this._embeddingsComputer.computeEmbeddings(
					embeddingType,
					texts,
					undefined,
					undefined,
					token
				);

				for (let j = 0; j < needsEmbedding.length; j++) {
					const { index } = needsEmbedding[j];
					const embedding: Embedding | undefined = embeddings.values[j];
					if (embedding) {
						results[index] = {
							chunk: chunks[index],
							chunkHash: hashText(chunks[index].text),
							embedding,
						};
					}
				}
			} catch (err) {
				this._logService.warn(`AzureChunkingEndpointClient: embeddings failed: ${(err as Error).message}`);
				return undefined;
			}
		}

		return results.filter((r): r is FileChunkWithEmbedding => r !== undefined);
	}
}
