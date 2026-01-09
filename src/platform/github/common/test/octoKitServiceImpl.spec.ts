/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { ICAPIClientService } from '../../../endpoint/common/capiClient';
import { ILogService } from '../../../log/common/logService';
import { FetchOptions, IFetcherService, Response } from '../../../networking/common/fetcherService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { FakeHeaders } from '../../../test/node/fetcher';
import { createPlatformServices, ITestingServicesAccessor } from '../../../test/node/services';
import { AssignableActor } from '../githubAPI';
import { OctoKitService } from '../octoKitServiceImpl';

describe('OctoKitService - getAssignableActors', () => {
	let accessor: ITestingServicesAccessor;
	let disposables: DisposableStore;

	beforeEach(() => {
		disposables = new DisposableStore();
	});

	afterEach(() => {
		accessor?.dispose();
		disposables.dispose();
	});

	it('should return empty array when no authentication token available', async () => {
		const testingServiceCollection = createPlatformServices();
		const mockAuthService = new MockAuthenticationService(null);
		testingServiceCollection.define(IAuthenticationService, mockAuthService);
		accessor = testingServiceCollection.createTestingAccessor();

		const octoKitService = accessor.get(IInstantiationService).createInstance(OctoKitService);

		const actors = await octoKitService.getAssignableActors('owner', 'repo', { createIfNone: false });

		expect(actors).toHaveLength(0);
	});

	it('should successfully retrieve actors using suggestedActors API', async () => {
		const mockResponse = {
			data: {
				repository: {
					suggestedActors: {
						nodes: [
							{ __typename: 'User', login: 'user1', avatarUrl: 'https://example.com/avatar1', url: 'https://github.com/user1' },
							{ __typename: 'Bot', login: 'copilot', avatarUrl: 'https://example.com/avatar2', url: 'https://github.com/apps/copilot' },
						],
						pageInfo: {
							hasNextPage: false,
							endCursor: null,
						},
					},
				},
			},
		};

		const testingServiceCollection = createPlatformServices();
		const mockAuthService = new MockAuthenticationService({ accessToken: 'test-token', account: { id: 'test-user', label: 'Test User' } });
		const mockFetcher = new MockFetcherServiceForOctoKit([mockResponse]);

		testingServiceCollection.define(IAuthenticationService, mockAuthService);
		testingServiceCollection.define(IFetcherService, mockFetcher);
		accessor = testingServiceCollection.createTestingAccessor();

		const octoKitService = accessor.get(IInstantiationService).createInstance(OctoKitService);

		const actors = await octoKitService.getAssignableActors('owner', 'repo', { createIfNone: false });

		expect(actors).toHaveLength(2);
		expect(actors[0].login).toBe('user1');
		expect(actors[1].login).toBe('copilot');
		expect(mockFetcher.fetchCallCount).toBe(1);
	});

	it('should fallback to assignableUsers when suggestedActors returns empty', async () => {
		const emptySuggestedActorsResponse = {
			data: {
				repository: {
					suggestedActors: {
						nodes: [],
						pageInfo: {
							hasNextPage: false,
							endCursor: null,
						},
					},
				},
			},
		};

		const assignableUsersResponse = {
			data: {
				repository: {
					assignableUsers: {
						nodes: [
							{ __typename: 'User', login: 'user1', avatarUrl: 'https://example.com/avatar1', url: 'https://github.com/user1' },
							{ __typename: 'User', login: 'user2', avatarUrl: 'https://example.com/avatar2', url: 'https://github.com/user2' },
						],
						pageInfo: {
							hasNextPage: false,
							endCursor: null,
						},
					},
				},
			},
		};

		const testingServiceCollection = createPlatformServices();
		const mockAuthService = new MockAuthenticationService({ accessToken: 'test-token', account: { id: 'test-user', label: 'Test User' } });
		const mockFetcher = new MockFetcherServiceForOctoKit([emptySuggestedActorsResponse, assignableUsersResponse]);

		testingServiceCollection.define(IAuthenticationService, mockAuthService);
		testingServiceCollection.define(IFetcherService, mockFetcher);
		accessor = testingServiceCollection.createTestingAccessor();

		const octoKitService = accessor.get(IInstantiationService).createInstance(OctoKitService);

		const actors = await octoKitService.getAssignableActors('owner', 'repo', { createIfNone: false });

		expect(actors).toHaveLength(2);
		expect(actors[0].login).toBe('user1');
		expect(actors[1].login).toBe('user2');
		expect(mockFetcher.fetchCallCount).toBe(2); // Called both APIs
	});

	it('should fallback to assignableUsers when suggestedActors API not supported', async () => {
		const noSuggestedActorsResponse = {
			data: {
				repository: {},
			},
		};

		const assignableUsersResponse = {
			data: {
				repository: {
					assignableUsers: {
						nodes: [
							{ __typename: 'User', login: 'ghes-user', avatarUrl: 'https://example.com/avatar1', url: 'https://ghes.example.com/ghes-user' },
						],
						pageInfo: {
							hasNextPage: false,
							endCursor: null,
						},
					},
				},
			},
		};

		const testingServiceCollection = createPlatformServices();
		const mockAuthService = new MockAuthenticationService({ accessToken: 'test-token', account: { id: 'test-user', label: 'Test User' } });
		const mockFetcher = new MockFetcherServiceForOctoKit([noSuggestedActorsResponse, assignableUsersResponse]);

		testingServiceCollection.define(IAuthenticationService, mockAuthService);
		testingServiceCollection.define(IFetcherService, mockFetcher);
		accessor = testingServiceCollection.createTestingAccessor();

		const octoKitService = accessor.get(IInstantiationService).createInstance(OctoKitService);

		const actors = await octoKitService.getAssignableActors('owner', 'repo', { createIfNone: false });

		expect(actors).toHaveLength(1);
		expect(actors[0].login).toBe('ghes-user');
		expect(mockFetcher.fetchCallCount).toBe(2);
	});

	it('should handle errors gracefully and return empty array', async () => {
		const testingServiceCollection = createPlatformServices();
		const mockAuthService = new MockAuthenticationService({ accessToken: 'test-token', account: { id: 'test-user', label: 'Test User' } });
		const mockFetcher = new FailingFetcherServiceForOctoKit();

		testingServiceCollection.define(IAuthenticationService, mockAuthService);
		testingServiceCollection.define(IFetcherService, mockFetcher);
		accessor = testingServiceCollection.createTestingAccessor();

		const octoKitService = accessor.get(IInstantiationService).createInstance(OctoKitService);

		const actors = await octoKitService.getAssignableActors('owner', 'repo', { createIfNone: false });

		expect(actors).toHaveLength(0);
	});

	it('should handle GraphQL API errors and return empty array', async () => {
		const errorResponse = {
			errors: [{ message: 'API rate limit exceeded' }],
		};

		const testingServiceCollection = createPlatformServices();
		const mockAuthService = new MockAuthenticationService({ accessToken: 'test-token', account: { id: 'test-user', label: 'Test User' } });
		const mockFetcher = new MockFetcherServiceForOctoKit([errorResponse]);

		testingServiceCollection.define(IAuthenticationService, mockAuthService);
		testingServiceCollection.define(IFetcherService, mockFetcher);
		accessor = testingServiceCollection.createTestingAccessor();

		const octoKitService = accessor.get(IInstantiationService).createInstance(OctoKitService);

		const actors = await octoKitService.getAssignableActors('owner', 'repo', { createIfNone: false });

		expect(actors).toHaveLength(0);
	});

	it('should handle authentication with createIfNone option', async () => {
		const mockResponse = {
			data: {
				repository: {
					suggestedActors: {
						nodes: [
							{ __typename: 'User', login: 'user1', avatarUrl: 'https://example.com/avatar1', url: 'https://github.com/user1' },
						],
						pageInfo: {
							hasNextPage: false,
							endCursor: null,
						},
					},
				},
			},
		};

		const testingServiceCollection = createPlatformServices();
		const mockAuthService = new MockAuthenticationService({ accessToken: 'test-token', account: { id: 'test-user', label: 'Test User' } });
		const mockFetcher = new MockFetcherServiceForOctoKit([mockResponse]);

		testingServiceCollection.define(IAuthenticationService, mockAuthService);
		testingServiceCollection.define(IFetcherService, mockFetcher);
		accessor = testingServiceCollection.createTestingAccessor();

		const octoKitService = accessor.get(IInstantiationService).createInstance(OctoKitService);

		const actors = await octoKitService.getAssignableActors('owner', 'repo', { createIfNone: true });

		expect(actors).toHaveLength(1);
		expect(mockAuthService.createIfNoneCalled).toBe(true);
	});
});

// Mock Authentication Service
class MockAuthenticationService implements Partial<IAuthenticationService> {
	public createIfNoneCalled = false;

	constructor(private readonly session: { accessToken: string; account: { id: string; label: string } } | null) {}

	async getGitHubSession(mode: 'any' | 'permissive', options?: { createIfNone?: boolean; silent?: boolean }) {
		if (options?.createIfNone) {
			this.createIfNoneCalled = true;
		}
		return this.session;
	}
}

// Mock FetcherService for OctoKitService tests
class MockFetcherServiceForOctoKit implements Partial<IFetcherService> {
	public fetchCallCount = 0;
	private responseIndex = 0;

	constructor(private readonly responses: any[]) {}

	getUserAgentLibrary(): string {
		return 'test';
	}

	async fetch(url: string, options?: FetchOptions): Promise<Response> {
		this.fetchCallCount++;
		const response = this.responses[this.responseIndex];
		this.responseIndex++;

		const headers = new FakeHeaders();
		headers['x-ratelimit-remaining'] = '5000';

		return new Response(
			200,
			'OK',
			headers,
			async () => JSON.stringify(response),
			async () => response,
			async () => null,
			'test-stub'
		);
	}
}

// Failing Fetcher service for error testing
class FailingFetcherServiceForOctoKit implements Partial<IFetcherService> {
	getUserAgentLibrary(): string {
		return 'test';
	}

	async fetch(url: string, options?: FetchOptions): Promise<Response> {
		throw new Error('Network error');
	}
}
