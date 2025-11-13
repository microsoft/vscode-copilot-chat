/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'vitest';
import { makeGitHubAPIRequest, makeGitHubGraphQLRequest } from '../../common/githubAPI';
import type { IFetcherService } from '../../../networking/common/fetcherService';
import type { ILogService } from '../../../log/common/logService';
import type { ITelemetryService } from '../../../telemetry/common/telemetry';

suite('GitHub API Type Safety', () => {
	// Mock services for testing
	const createMockFetcherService = (mockResponse: any): IFetcherService => ({
		fetch: async () => mockResponse,
	} as any);

	const mockLogService: ILogService = {
		error: () => { },
		warn: () => { },
		debug: () => { },
		info: () => { },
	} as any;

	const mockTelemetry: ITelemetryService = {
		sendMSFTTelemetryEvent: () => { },
	} as any;

	test('makeGitHubAPIRequest should return typed result on success', async () => {
		const mockResponse = {
			ok: true,
			json: async () => ({ id: 123, name: 'test-repo' }),
			headers: new Map([['x-ratelimit-remaining', '5000']]),
		};
		const fetcherService = createMockFetcherService(mockResponse);

		const result = await makeGitHubAPIRequest<{ id: number; name: string }>(
			fetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'repos/owner/repo',
			'GET',
			'token'
		);

		assert.ok(result);
		assert.strictEqual(result.id, 123);
		assert.strictEqual(result.name, 'test-repo');
	});

	test('makeGitHubAPIRequest should return undefined on error', async () => {
		const mockResponse = {
			ok: false,
			status: 404,
		};
		const fetcherService = createMockFetcherService(mockResponse);

		const result = await makeGitHubAPIRequest<{ id: number }>(
			fetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'repos/owner/nonexistent',
			'GET',
			'token'
		);

		assert.strictEqual(result, undefined);
	});

	test('makeGitHubAPIRequest should return error status when returnStatusCodeOnError is true', async () => {
		const mockResponse = {
			ok: false,
			status: 403,
		};
		const fetcherService = createMockFetcherService(mockResponse);

		const result = await makeGitHubAPIRequest<{ id: number }>(
			fetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'repos/owner/forbidden',
			'GET',
			'token',
			undefined,
			undefined,
			'json',
			undefined,
			true
		) as { status: number } | { id: number } | undefined;

		assert.ok(result);
		assert.ok('status' in result);
		assert.strictEqual((result as { status: number }).status, 403);
	});

	test('makeGitHubAPIRequest should handle text responses', async () => {
		const mockResponse = {
			ok: true,
			text: async () => 'plain text response',
			headers: new Map([['x-ratelimit-remaining', '5000']]),
		};
		const fetcherService = createMockFetcherService(mockResponse);

		const result = await makeGitHubAPIRequest<string>(
			fetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'some/endpoint',
			'GET',
			'token',
			undefined,
			undefined,
			'text'
		);

		assert.strictEqual(result, 'plain text response');
	});

	test('makeGitHubGraphQLRequest should return typed result on success', async () => {
		const mockResponse = {
			ok: true,
			json: async () => ({
				data: {
					repository: {
						name: 'test-repo',
						stargazerCount: 100
					}
				}
			}),
			headers: new Map([['x-ratelimit-remaining', '5000']]),
		};
		const fetcherService = createMockFetcherService(mockResponse);

		interface GraphQLResponse {
			data: {
				repository: {
					name: string;
					stargazerCount: number;
				};
			};
		}

		const result = await makeGitHubGraphQLRequest<GraphQLResponse>(
			fetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'query { repository { name stargazerCount } }',
			'token'
		);

		assert.ok(result);
		assert.strictEqual(result.data.repository.name, 'test-repo');
		assert.strictEqual(result.data.repository.stargazerCount, 100);
	});

	test('makeGitHubGraphQLRequest should return undefined on error', async () => {
		const mockResponse = {
			ok: false,
			status: 500,
		};
		const fetcherService = createMockFetcherService(mockResponse);

		const result = await makeGitHubGraphQLRequest<{ data: any }>(
			fetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'query { invalid }',
			'token'
		);

		assert.strictEqual(result, undefined);
	});

	test('Type safety: makeGitHubAPIRequest result should be undefined-safe', async () => {
		const mockResponse = {
			ok: true,
			json: async () => ({ value: 42 }),
			headers: new Map([['x-ratelimit-remaining', '5000']]),
		};
		const fetcherService = createMockFetcherService(mockResponse);

		const result = await makeGitHubAPIRequest<{ value: number }>(
			fetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'test',
			'GET',
			'token'
		);

		// This should compile without errors - TypeScript knows result could be undefined
		const value = result?.value;
		assert.strictEqual(value, 42);
	});
});
