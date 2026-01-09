/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { ILogService } from '../../../log/common/logService';
import { FetchOptions, IFetcherService, Response } from '../../../networking/common/fetcherService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { createFakeResponse, FakeHeaders } from '../../../test/node/fetcher';
import { createPlatformServices, ITestingServicesAccessor } from '../../../test/node/services';
import {
	AssignableActor,
	getAssignableActorsWithAssignableUsers,
	getAssignableActorsWithSuggestedActors,
} from '../githubAPI';

describe('GitHub API - getAssignableActorsWithSuggestedActors', () => {
	let accessor: ITestingServicesAccessor;
	let disposables: DisposableStore;
	let logService: ILogService;
	let telemetryService: ITelemetryService;

	beforeEach(() => {
		disposables = new DisposableStore();
		accessor = disposables.add(createPlatformServices().createTestingAccessor());
		logService = accessor.get(ILogService);
		telemetryService = accessor.get(ITelemetryService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	it('should successfully retrieve actors with suggestedActors API', async () => {
		const mockResponse = {
			data: {
				repository: {
					suggestedActors: {
						nodes: [
							{ __typename: 'User', login: 'user1', avatarUrl: 'https://example.com/avatar1', url: 'https://github.com/user1' },
							{ __typename: 'Bot', login: 'bot1', avatarUrl: 'https://example.com/avatar2', url: 'https://github.com/apps/bot1' },
						],
						pageInfo: {
							hasNextPage: false,
							endCursor: null,
						},
					},
				},
			},
		};

		const fetcher = new MockFetcherService([mockResponse]);
		const actors = await getAssignableActorsWithSuggestedActors(
			fetcher,
			logService,
			telemetryService,
			'https://api.github.com',
			'test-token',
			'owner',
			'repo'
		);

		expect(actors).toHaveLength(2);
		expect(actors[0].login).toBe('user1');
		expect(actors[1].login).toBe('bot1');
		expect(fetcher.fetchCallCount).toBe(1);
	});

	it('should handle pagination correctly', async () => {
		const firstResponse = {
			data: {
				repository: {
					suggestedActors: {
						nodes: [
							{ __typename: 'User', login: 'user1', avatarUrl: 'https://example.com/avatar1', url: 'https://github.com/user1' },
						],
						pageInfo: {
							hasNextPage: true,
							endCursor: 'cursor1',
						},
					},
				},
			},
		};

		const secondResponse = {
			data: {
				repository: {
					suggestedActors: {
						nodes: [
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

		const fetcher = new MockFetcherService([firstResponse, secondResponse]);
		const actors = await getAssignableActorsWithSuggestedActors(
			fetcher,
			logService,
			telemetryService,
			'https://api.github.com',
			'test-token',
			'owner',
			'repo'
		);

		expect(actors).toHaveLength(2);
		expect(actors[0].login).toBe('user1');
		expect(actors[1].login).toBe('user2');
		expect(fetcher.fetchCallCount).toBe(2);
	});

	it('should return empty array when no suggestedActors field', async () => {
		const mockResponse = {
			data: {
				repository: {},
			},
		};

		const fetcher = new MockFetcherService([mockResponse]);
		const actors = await getAssignableActorsWithSuggestedActors(
			fetcher,
			logService,
			telemetryService,
			'https://api.github.com',
			'test-token',
			'owner',
			'repo'
		);

		expect(actors).toHaveLength(0);
	});

	it('should return empty array when API returns no data', async () => {
		const fetcher = new MockFetcherService([undefined]);
		const actors = await getAssignableActorsWithSuggestedActors(
			fetcher,
			logService,
			telemetryService,
			'https://api.github.com',
			'test-token',
			'owner',
			'repo'
		);

		expect(actors).toHaveLength(0);
	});

	it('should throw error when fetcher fails', async () => {
		const fetcher = new FailingFetcherService();
		
		await expect(
			getAssignableActorsWithSuggestedActors(
				fetcher,
				logService,
				telemetryService,
				'https://api.github.com',
				'test-token',
				'owner',
				'repo'
			)
		).rejects.toThrow('Network error');
	});
});

describe('GitHub API - getAssignableActorsWithAssignableUsers', () => {
	let accessor: ITestingServicesAccessor;
	let disposables: DisposableStore;
	let logService: ILogService;
	let telemetryService: ITelemetryService;

	beforeEach(() => {
		disposables = new DisposableStore();
		accessor = disposables.add(createPlatformServices().createTestingAccessor());
		logService = accessor.get(ILogService);
		telemetryService = accessor.get(ITelemetryService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	it('should successfully retrieve actors with assignableUsers API', async () => {
		const mockResponse = {
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

		const fetcher = new MockFetcherService([mockResponse]);
		const actors = await getAssignableActorsWithAssignableUsers(
			fetcher,
			logService,
			telemetryService,
			'https://api.github.com',
			'test-token',
			'owner',
			'repo'
		);

		expect(actors).toHaveLength(2);
		expect(actors[0].login).toBe('user1');
		expect(actors[1].login).toBe('user2');
		expect(fetcher.fetchCallCount).toBe(1);
	});

	it('should handle pagination correctly', async () => {
		const firstResponse = {
			data: {
				repository: {
					assignableUsers: {
						nodes: [
							{ __typename: 'User', login: 'user1', avatarUrl: 'https://example.com/avatar1', url: 'https://github.com/user1' },
							{ __typename: 'User', login: 'user2', avatarUrl: 'https://example.com/avatar2', url: 'https://github.com/user2' },
						],
						pageInfo: {
							hasNextPage: true,
							endCursor: 'cursor1',
						},
					},
				},
			},
		};

		const secondResponse = {
			data: {
				repository: {
					assignableUsers: {
						nodes: [
							{ __typename: 'User', login: 'user3', avatarUrl: 'https://example.com/avatar3', url: 'https://github.com/user3' },
						],
						pageInfo: {
							hasNextPage: false,
							endCursor: null,
						},
					},
				},
			},
		};

		const fetcher = new MockFetcherService([firstResponse, secondResponse]);
		const actors = await getAssignableActorsWithAssignableUsers(
			fetcher,
			logService,
			telemetryService,
			'https://api.github.com',
			'test-token',
			'owner',
			'repo'
		);

		expect(actors).toHaveLength(3);
		expect(actors[0].login).toBe('user1');
		expect(actors[1].login).toBe('user2');
		expect(actors[2].login).toBe('user3');
		expect(fetcher.fetchCallCount).toBe(2);
	});

	it('should return empty array when no assignableUsers field', async () => {
		const mockResponse = {
			data: {
				repository: {},
			},
		};

		const fetcher = new MockFetcherService([mockResponse]);
		const actors = await getAssignableActorsWithAssignableUsers(
			fetcher,
			logService,
			telemetryService,
			'https://api.github.com',
			'test-token',
			'owner',
			'repo'
		);

		expect(actors).toHaveLength(0);
	});

	it('should return empty array when API returns no data', async () => {
		const fetcher = new MockFetcherService([undefined]);
		const actors = await getAssignableActorsWithAssignableUsers(
			fetcher,
			logService,
			telemetryService,
			'https://api.github.com',
			'test-token',
			'owner',
			'repo'
		);

		expect(actors).toHaveLength(0);
	});

	it('should throw error when fetcher fails', async () => {
		const fetcher = new FailingFetcherService();
		
		await expect(
			getAssignableActorsWithAssignableUsers(
				fetcher,
				logService,
				telemetryService,
				'https://api.github.com',
				'test-token',
				'owner',
				'repo'
			)
		).rejects.toThrow('Network error');
	});
});

// Mock FetcherService that returns predefined responses
class MockFetcherService implements Partial<IFetcherService> {
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

// Fetcher service that simulates API failures
class FailingFetcherService implements Partial<IFetcherService> {
	getUserAgentLibrary(): string {
		return 'test';
	}

	async fetch(url: string, options?: FetchOptions): Promise<Response> {
		throw new Error('Network error');
	}
}
