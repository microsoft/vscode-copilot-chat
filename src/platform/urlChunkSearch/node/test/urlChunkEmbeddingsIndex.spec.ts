/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'vitest';
import type { AuthenticationGetSessionOptions, AuthenticationSession } from 'vscode';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { CopilotToken } from '../../../authentication/common/copilotToken';
import { FileChunkWithEmbedding } from '../../../chunking/common/chunk';
import { ChunkableContent, ComputeBatchInfo, EmbeddingsComputeQos, IChunkingEndpointClient } from '../../../chunking/common/chunkingEndpointClient';
import { Embedding, EmbeddingType, Embeddings, IEmbeddingsComputer } from '../../../embeddings/common/embeddingsComputer';
import { ILogService } from '../../../log/common/logService';
import { TestLogService } from '../../../testing/common/testLogService';
import { IGithubAvailableEmbeddingTypesService, MockGithubAvailableEmbeddingTypesService } from '../../../workspaceChunkSearch/common/githubAvailableEmbeddingTypes';
import { InstantiationServiceBuilder } from '../../../../util/common/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Event } from '../../../../util/vs/base/common/event';
import { URI } from '../../../../util/vs/base/common/uri';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { UrlChunkEmbeddingsIndex } from '../urlChunkEmbeddingsIndex';

const testEmbeddingType = EmbeddingType.text3small_512;

const mockAuthSession: AuthenticationSession = {
	accessToken: 'test-token',
	id: 'test-id',
	account: { id: 'test-account', label: 'Test Account' },
	scopes: ['user:email'],
};

function createTestEmbedding(value: number[]): Embedding {
	return { type: testEmbeddingType, value };
}

function createMockChunkWithEmbedding(text: string): FileChunkWithEmbedding {
	return {
		chunk: {
			file: URI.parse('https://example.com/test.sh'),
			text,
			rawText: text,
			range: new Range(0, 0, 0, text.length),
			isFullFile: false,
		},
		chunkHash: 'hash',
		embedding: createTestEmbedding([1, 0, 0]),
	};
}

class MockEmbeddingsComputer implements IEmbeddingsComputer {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly _result: Embeddings | Error) { }

	async computeEmbeddings(_type: EmbeddingType, _inputs: readonly string[]): Promise<Embeddings> {
		if (this._result instanceof Error) {
			throw this._result;
		}
		return this._result;
	}
}

class MockChunkingEndpointClient implements IChunkingEndpointClient {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly _chunks: readonly FileChunkWithEmbedding[]) { }

	async computeChunks(_authToken: string, _embeddingType: EmbeddingType, _content: ChunkableContent, _batchInfo: ComputeBatchInfo, _qos: EmbeddingsComputeQos, _cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined, _telemetryInfo: unknown, _token: CancellationToken) {
		return this._chunks;
	}

	async computeChunksAndEmbeddings(_authToken: string, _embeddingType: EmbeddingType, _content: ChunkableContent, _batchInfo: ComputeBatchInfo, _qos: EmbeddingsComputeQos, _cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined, _telemetryInfo: unknown, _token: CancellationToken) {
		return this._chunks;
	}
}

/**
 * Minimal authentication service mock that provides a fake token for URL chunk embedding tests.
 */
class TestUrlAuthenticationService {
	declare readonly _serviceBrand: undefined;

	readonly isMinimalMode = false;
	readonly onDidAuthenticationChange: Event<void> = Event.None;
	readonly onDidAccessTokenChange: Event<void> = Event.None;
	readonly onDidAdoAuthenticationChange: Event<void> = Event.None;
	readonly anyGitHubSession: AuthenticationSession | undefined = mockAuthSession;
	readonly permissiveGitHubSession: AuthenticationSession | undefined = undefined;
	readonly copilotToken: undefined = undefined;

	getGitHubSession(_kind: 'permissive' | 'any', _options: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		return Promise.resolve(mockAuthSession);
	}

	getCopilotToken(_force?: boolean): Promise<CopilotToken> {
		return Promise.reject(new Error('Not implemented in test mock'));
	}

	resetCopilotToken(_httpError?: number): void { }

	getAdoAccessTokenBase64(_options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}

	dispose(): void { }
}

function createIndex(chunks: readonly FileChunkWithEmbedding[], embeddingsResult: Embeddings | Error): UrlChunkEmbeddingsIndex {
	const builder = new InstantiationServiceBuilder([
		[IAuthenticationService, new TestUrlAuthenticationService() as unknown as IAuthenticationService],
		[ILogService, new TestLogService()],
		[IEmbeddingsComputer, new MockEmbeddingsComputer(embeddingsResult)],
		[IChunkingEndpointClient, new MockChunkingEndpointClient(chunks)],
		[IGithubAvailableEmbeddingTypesService, new MockGithubAvailableEmbeddingTypesService()],
	]);
	return builder.seal().createInstance(UrlChunkEmbeddingsIndex);
}

suite('UrlChunkEmbeddingsIndex.findInUrls', () => {

	test('returns chunks without scores when query is empty', async () => {
		const testChunks = [createMockChunkWithEmbedding('test content')];
		const validEmbedding: Embeddings = {
			type: testEmbeddingType,
			values: [createTestEmbedding([1, 0, 0])],
		};
		const index = createIndex(testChunks, validEmbedding);

		const result = await index.findInUrls(
			[{ uri: URI.parse('https://example.com/test.sh'), content: 'test content' }],
			'', // empty query
			CancellationToken.None
		);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].length, 1);
		// Chunks should be returned without distance scoring
		assert.strictEqual(result[0][0].distance, undefined);
	});

	test('returns chunks without scores when query is whitespace only', async () => {
		const testChunks = [createMockChunkWithEmbedding('test content')];
		const validEmbedding: Embeddings = {
			type: testEmbeddingType,
			values: [createTestEmbedding([1, 0, 0])],
		};
		const index = createIndex(testChunks, validEmbedding);

		const result = await index.findInUrls(
			[{ uri: URI.parse('https://example.com/test.sh'), content: 'test content' }],
			'   ', // whitespace only query
			CancellationToken.None
		);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].length, 1);
		assert.strictEqual(result[0][0].distance, undefined);
	});

	test('returns chunks without scores when query embedding computation returns empty values', async () => {
		const testChunks = [createMockChunkWithEmbedding('test content')];
		const emptyEmbeddings: Embeddings = {
			type: testEmbeddingType,
			values: [], // empty - simulates failed embedding computation
		};
		const index = createIndex(testChunks, emptyEmbeddings);

		// This previously caused a crash: distance(chunk.embedding, undefined) threw TypeError
		const result = await index.findInUrls(
			[{ uri: URI.parse('https://example.com/test.sh'), content: 'test content' }],
			'some query',
			CancellationToken.None
		);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].length, 1);
		// No crash, chunks returned without scores
		assert.strictEqual(result[0][0].distance, undefined);
	});

	test('returns scored chunks when query and embeddings are valid', async () => {
		const testChunks = [createMockChunkWithEmbedding('test content')];
		const queryEmbeddingValue = [1, 0, 0];
		const validEmbeddings: Embeddings = {
			type: testEmbeddingType,
			values: [createTestEmbedding(queryEmbeddingValue)],
		};
		const index = createIndex(testChunks, validEmbeddings);

		const result = await index.findInUrls(
			[{ uri: URI.parse('https://example.com/test.sh'), content: 'test content' }],
			'some query',
			CancellationToken.None
		);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].length, 1);
		// Chunks should have distance scores when embeddings are valid
		assert.notStrictEqual(result[0][0].distance, undefined);
	});

	test('returns empty arrays when no files provided', async () => {
		const emptyEmbeddings: Embeddings = { type: testEmbeddingType, values: [] };
		const index = createIndex([], emptyEmbeddings);

		const result = await index.findInUrls([], 'some query', CancellationToken.None);

		assert.strictEqual(result.length, 0);
	});

	test('does not crash for shell script URLs with empty query', async () => {
		// Regression test: fetching .sh files with no query previously caused VS Code to crash
		const testChunks = [createMockChunkWithEmbedding('#!/bin/bash\necho "hello"')];
		const emptyEmbeddings: Embeddings = { type: testEmbeddingType, values: [] };
		const index = createIndex(testChunks, emptyEmbeddings);

		// Should not throw
		const result = await index.findInUrls(
			[{ uri: URI.parse('http://localhost:8000/install.sh'), content: '#!/bin/bash\necho "hello"' }],
			'',
			CancellationToken.None
		);

		assert.strictEqual(result.length, 1);
	});
});
