/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { GraphQLError, GraphQLResponse, isRateLimitError, makeGitHubGraphQLRequest, makeSearchGraphQLRequest, getPullRequestFromGlobalId, addPullRequestCommentGraphQLRequest, PullRequestSearchResult, PullRequestSearchItem, RATE_LIMIT } from '../../common/githubAPI';
import { ILogService } from '../../../log/common/logService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';

describe('isRateLimitError', () => {
	it('should return true when response contains RATE_LIMIT error', () => {
		const response: GraphQLResponse = {
			errors: [
				{
					type: 'RATE_LIMIT',
					code: 'graphql_rate_limit',
					message: 'API rate limit exceeded'
				}
			]
		};
		expect(isRateLimitError(response)).toBe(true);
	});

	it('should return false when response has no errors', () => {
		const response: GraphQLResponse = {
			data: { some: 'data' }
		};
		expect(isRateLimitError(response)).toBe(false);
	});

	it('should return false when response has errors but not RATE_LIMIT', () => {
		const response: GraphQLResponse = {
			errors: [
				{
					type: 'VALIDATION_ERROR',
					message: 'Invalid input'
				}
			]
		};
		expect(isRateLimitError(response)).toBe(false);
	});

	it('should return false when response is undefined', () => {
		expect(isRateLimitError(undefined)).toBe(false);
	});

	it('should return true when response has multiple errors including RATE_LIMIT', () => {
		const response: GraphQLResponse = {
			errors: [
				{
					type: 'VALIDATION_ERROR',
					message: 'Invalid input'
				},
				{
					type: 'RATE_LIMIT',
					code: 'graphql_rate_limit',
					message: 'API rate limit exceeded'
				}
			]
		};
		expect(isRateLimitError(response)).toBe(true);
	});
});

describe('makeGitHubGraphQLRequest', () => {
	it('should detect and log rate limit errors', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				errors: [{
					type: 'RATE_LIMIT',
					code: 'graphql_rate_limit',
					message: 'API rate limit exceeded for user ID 12345'
				}]
			}),
			headers: {
				get: (key: string) => key === 'x-ratelimit-remaining' ? '0' : null
			}
		});

		const mockLogService: ILogService = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		} as any;

		const mockTelemetry: ITelemetryService = {
			sendMSFTTelemetryEvent: vi.fn()
		} as any;

		const mockFetcherService: IFetcherService = {
			fetch: mockFetch
		} as any;

		const result = await makeGitHubGraphQLRequest(
			mockFetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'query { test }',
			'token123'
		);

		expect(result).toBeDefined();
		expect(result?.errors).toBeDefined();
		expect(result?.errors?.[0].type).toBe('RATE_LIMIT');
		expect(mockLogService.error).toHaveBeenCalledWith(
			expect.stringContaining('GraphQL rate limit error')
		);
		expect(mockTelemetry.sendMSFTTelemetryEvent).toHaveBeenCalledWith(
			'githubAPI.rateLimitError',
			expect.objectContaining({
				message: 'API rate limit exceeded for user ID 12345'
			})
		);
	});

	it('should return data when no rate limit error occurs', async () => {
		const mockData = { user: { name: 'John Doe' } };
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: mockData }),
			headers: {
				get: (key: string) => key === 'x-ratelimit-remaining' ? '5000' : null
			}
		});

		const mockLogService: ILogService = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		} as any;

		const mockTelemetry: ITelemetryService = {
			sendMSFTTelemetryEvent: vi.fn()
		} as any;

		const mockFetcherService: IFetcherService = {
			fetch: mockFetch
		} as any;

		const result = await makeGitHubGraphQLRequest(
			mockFetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'query { user { name } }',
			'token123'
		);

		expect(result).toBeDefined();
		expect(result?.data).toEqual(mockData);
		expect(result?.errors).toBeUndefined();
		expect(mockLogService.error).not.toHaveBeenCalled();
	});
});

describe('makeSearchGraphQLRequest', () => {
	it('should return RATE_LIMIT constant on rate limit error', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				errors: [{
					type: 'RATE_LIMIT',
					code: 'graphql_rate_limit',
					message: 'API rate limit exceeded'
				}]
			}),
			headers: {
				get: (key: string) => key === 'x-ratelimit-remaining' ? '0' : null
			}
		});

		const mockLogService: ILogService = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		} as any;

		const mockTelemetry: ITelemetryService = {
			sendMSFTTelemetryEvent: vi.fn()
		} as any;

		const mockFetcherService: IFetcherService = {
			fetch: mockFetch
		} as any;

		const result = await makeSearchGraphQLRequest(
			mockFetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'token123',
			'test query'
		);

		expect(result).toBe(RATE_LIMIT);
		expect(mockLogService.error).toHaveBeenCalledWith(
			expect.stringContaining('Rate limit exceeded')
		);
	});

	it('should return search results on success', async () => {
		const mockPRs: PullRequestSearchItem[] = [{
			id: 'PR_1',
			number: 1,
			title: 'Test PR',
			state: 'open',
			url: 'https://github.com/test/repo/pull/1',
			createdAt: '2024-01-01',
			updatedAt: '2024-01-02',
			author: { login: 'testuser' },
			repository: {
				owner: { login: 'test' },
				name: 'repo'
			},
			additions: 10,
			deletions: 5,
			files: { totalCount: 2 },
			fullDatabaseId: 123,
			headRefOid: 'abc123',
			body: 'Test body'
		}];

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: {
					search: {
						nodes: mockPRs,
						pageInfo: { hasNextPage: false, endCursor: null },
						issueCount: 1
					}
				}
			}),
			headers: {
				get: (key: string) => key === 'x-ratelimit-remaining' ? '5000' : null
			}
		});

		const mockLogService: ILogService = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		} as any;

		const mockTelemetry: ITelemetryService = {
			sendMSFTTelemetryEvent: vi.fn()
		} as any;

		const mockFetcherService: IFetcherService = {
			fetch: mockFetch
		} as any;

		const result = await makeSearchGraphQLRequest(
			mockFetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'token123',
			'test query'
		);

		expect(result).toEqual(mockPRs);
		expect(mockLogService.error).not.toHaveBeenCalled();
	});
});

describe('getPullRequestFromGlobalId', () => {
	it('should return RATE_LIMIT constant on rate limit error', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				errors: [{
					type: 'RATE_LIMIT',
					code: 'graphql_rate_limit',
					message: 'API rate limit exceeded'
				}]
			}),
			headers: {
				get: (key: string) => key === 'x-ratelimit-remaining' ? '0' : null
			}
		});

		const mockLogService: ILogService = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		} as any;

		const mockTelemetry: ITelemetryService = {
			sendMSFTTelemetryEvent: vi.fn()
		} as any;

		const mockFetcherService: IFetcherService = {
			fetch: mockFetch
		} as any;

		const result = await getPullRequestFromGlobalId(
			mockFetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'token123',
			'PR_kwDOAbc123'
		);

		expect(result).toBe(RATE_LIMIT);
		expect(mockLogService.error).toHaveBeenCalledWith(
			expect.stringContaining('Rate limit exceeded')
		);
	});
});

describe('addPullRequestCommentGraphQLRequest', () => {
	it('should return RATE_LIMIT constant on rate limit error', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				errors: [{
					type: 'RATE_LIMIT',
					code: 'graphql_rate_limit',
					message: 'API rate limit exceeded'
				}]
			}),
			headers: {
				get: (key: string) => key === 'x-ratelimit-remaining' ? '0' : null
			}
		});

		const mockLogService: ILogService = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		} as any;

		const mockTelemetry: ITelemetryService = {
			sendMSFTTelemetryEvent: vi.fn()
		} as any;

		const mockFetcherService: IFetcherService = {
			fetch: mockFetch
		} as any;

		const result = await addPullRequestCommentGraphQLRequest(
			mockFetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'token123',
			'PR_kwDOAbc123',
			'Test comment'
		);

		expect(result).toBe(RATE_LIMIT);
		expect(mockLogService.error).toHaveBeenCalledWith(
			expect.stringContaining('Rate limit exceeded')
		);
	});

	it('should return comment on success', async () => {
		const mockComment = {
			id: 'IC_123',
			body: 'Test comment',
			createdAt: '2024-01-01',
			author: { login: 'testuser' },
			url: 'https://github.com/test/repo/issues/1#issuecomment-123'
		};

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: {
					addComment: {
						commentEdge: {
							node: mockComment
						}
					}
				}
			}),
			headers: {
				get: (key: string) => key === 'x-ratelimit-remaining' ? '5000' : null
			}
		});

		const mockLogService: ILogService = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		} as any;

		const mockTelemetry: ITelemetryService = {
			sendMSFTTelemetryEvent: vi.fn()
		} as any;

		const mockFetcherService: IFetcherService = {
			fetch: mockFetch
		} as any;

		const result = await addPullRequestCommentGraphQLRequest(
			mockFetcherService,
			mockLogService,
			mockTelemetry,
			'https://api.github.com',
			'token123',
			'PR_kwDOAbc123',
			'Test comment'
		);

		expect(result).toEqual(mockComment);
		expect(mockLogService.error).not.toHaveBeenCalled();
	});
});
