/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { URI } from '../../../../util/vs/base/common/uri';
import { EmbeddingType } from '../../../embeddings/common/embeddingsComputer';
import { GithubRepoId } from '../../../git/common/gitService';
import { NullIgnoreService } from '../../../ignore/common/ignoreService';
import { normalizeEndpointUrl, parseGithubCodeSearchResponse } from '../githubCodeSearchService';

describe('normalizeEndpointUrl', () => {
	it('should strip trailing slash', () => {
		expect(normalizeEndpointUrl('http://localhost:8080/')).toBe('http://localhost:8080');
	});

	it('should strip multiple trailing slashes', () => {
		expect(normalizeEndpointUrl('http://localhost:8080///')).toBe('http://localhost:8080');
	});

	it('should not modify URL without trailing slash', () => {
		expect(normalizeEndpointUrl('http://localhost:8080')).toBe('http://localhost:8080');
	});

	it('should handle URL with path', () => {
		expect(normalizeEndpointUrl('http://localhost:8080/api/v1/')).toBe('http://localhost:8080/api/v1');
	});

	it('should handle empty string', () => {
		expect(normalizeEndpointUrl('')).toBe('');
	});
});

describe('parseGithubCodeSearchResponse', () => {
	const mockIgnoreService = NullIgnoreService.Instance;

	it('should parse valid response', async () => {
		const response = {
			results: [
				{
					chunk: {
						hash: 'abc123',
						text: 'function test() { return true; }',
						range: { start: 0, end: 100 },
						line_range: { start: 1, end: 5 },
					},
					distance: 0.5,
					location: {
						path: 'src/test.ts',
						commit_sha: 'commit123',
						repo: {
							nwo: 'owner/repo',
							url: 'https://github.com/owner/repo',
						},
					},
				},
			],
			embedding_model: EmbeddingType.metis_1024_I16_Binary.id,
		};

		const repo = {
			githubRepoId: new GithubRepoId('owner', 'repo'),
			localRepoRoot: URI.file('/workspace'),
			indexedCommit: 'commit123',
		};

		const result = await parseGithubCodeSearchResponse(response, repo, { globPatterns: undefined }, mockIgnoreService);

		expect(result.chunks.length).toBe(1);
		expect(result.outOfSync).toBe(false);
		const firstChunk = result.chunks[0];
		expect(firstChunk).toBeDefined();
		expect(firstChunk!.chunk.text).toBe('function test() { return true; }');
		expect(firstChunk!.distance).toBeDefined();
		expect(firstChunk!.distance!.value).toBe(0.5);
	});

	it('should detect out of sync when commit differs', async () => {
		const response = {
			results: [
				{
					chunk: {
						hash: 'abc123',
						text: 'test code',
						range: { start: 0, end: 50 },
						line_range: { start: 1, end: 3 },
					},
					distance: 0.3,
					location: {
						path: 'src/file.ts',
						commit_sha: 'different_commit',
						repo: {
							nwo: 'owner/repo',
							url: 'https://github.com/owner/repo',
						},
					},
				},
			],
			embedding_model: EmbeddingType.metis_1024_I16_Binary.id,
		};

		const repo = {
			githubRepoId: new GithubRepoId('owner', 'repo'),
			localRepoRoot: URI.file('/workspace'),
			indexedCommit: 'original_commit',
		};

		const result = await parseGithubCodeSearchResponse(response, repo, { globPatterns: undefined }, mockIgnoreService);

		expect(result.outOfSync).toBe(true);
	});

	it('should filter results by glob patterns', async () => {
		const response = {
			results: [
				{
					chunk: {
						hash: 'abc123',
						text: 'test code',
						range: { start: 0, end: 50 },
						line_range: { start: 1, end: 3 },
					},
					distance: 0.3,
					location: {
						path: 'src/file.ts',
						commit_sha: 'commit123',
						repo: {
							nwo: 'owner/repo',
							url: 'https://github.com/owner/repo',
						},
					},
				},
				{
					chunk: {
						hash: 'def456',
						text: 'test code 2',
						range: { start: 0, end: 50 },
						line_range: { start: 1, end: 3 },
					},
					distance: 0.4,
					location: {
						path: 'test/file.spec.ts',
						commit_sha: 'commit123',
						repo: {
							nwo: 'owner/repo',
							url: 'https://github.com/owner/repo',
						},
					},
				},
			],
			embedding_model: EmbeddingType.metis_1024_I16_Binary.id,
		};

		const repo = {
			githubRepoId: new GithubRepoId('owner', 'repo'),
			localRepoRoot: URI.file('/workspace'),
			indexedCommit: 'commit123',
		};

		const result = await parseGithubCodeSearchResponse(
			response,
			repo,
			{ globPatterns: { include: ['**/src/**'], exclude: [] } },
			mockIgnoreService
		);

		expect(result.chunks.length).toBe(1);
		const firstChunk = result.chunks[0];
		expect(firstChunk).toBeDefined();
		expect(firstChunk!.chunk.file.path).toContain('src/file.ts');
	});

	it('should filter results from different repos when skipVerifyRepo is false', async () => {
		const response = {
			results: [
				{
					chunk: {
						hash: 'abc123',
						text: 'test code',
						range: { start: 0, end: 50 },
						line_range: { start: 1, end: 3 },
					},
					distance: 0.3,
					location: {
						path: 'src/file.ts',
						commit_sha: 'commit123',
						repo: {
							nwo: 'other/repo',
							url: 'https://github.com/other/repo',
						},
					},
				},
			],
			embedding_model: EmbeddingType.metis_1024_I16_Binary.id,
		};

		const repo = {
			githubRepoId: new GithubRepoId('owner', 'repo'),
			localRepoRoot: URI.file('/workspace'),
			indexedCommit: 'commit123',
		};

		const result = await parseGithubCodeSearchResponse(response, repo, { globPatterns: undefined }, mockIgnoreService);

		expect(result.chunks.length).toBe(0);
	});

	it('should handle empty results', async () => {
		const response = {
			results: [],
			embedding_model: EmbeddingType.metis_1024_I16_Binary.id,
		};

		const repo = {
			githubRepoId: new GithubRepoId('owner', 'repo'),
			localRepoRoot: undefined,
			indexedCommit: undefined,
		};

		const result = await parseGithubCodeSearchResponse(response, repo, { globPatterns: undefined }, mockIgnoreService);

		expect(result.chunks.length).toBe(0);
		expect(result.outOfSync).toBe(false);
	});
});
