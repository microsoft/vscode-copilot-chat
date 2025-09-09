/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { TestingServiceCollection } from '../../../../../platform/test/node/services';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { CancellationToken, CancellationTokenSource } from '../../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { CreateSessionOptions, IOpenCodeClient, OpenCodeMessage, OpenCodeSessionData } from '../opencodeClient';
import { OpenCodeSessionService } from '../opencodeSessionService';

class MockOpenCodeClient implements IOpenCodeClient {
	declare _serviceBrand: undefined;

	private _sessions: Map<string, OpenCodeSessionData> = new Map();
	private _nextId = 1;

	async getAllSessions(token?: CancellationToken): Promise<readonly OpenCodeSessionData[]> {
		return Array.from(this._sessions.values());
	}

	async getSession(sessionId: string, token?: CancellationToken): Promise<OpenCodeSessionData | undefined> {
		return this._sessions.get(sessionId);
	}

	async createSession(options?: CreateSessionOptions, token?: CancellationToken): Promise<OpenCodeSessionData> {
		const id = `session-${this._nextId++}`;
		const session: OpenCodeSessionData = {
			id,
			label: options?.label || `Session ${id}`,
			messages: [],
			timestamp: new Date(),
			status: 'active'
		};
		this._sessions.set(id, session);
		return session;
	}

	async sendMessage(options: { content: string; sessionId: string }, token?: CancellationToken): Promise<OpenCodeMessage> {
		const session = this._sessions.get(options.sessionId);
		if (!session) {
			throw new Error(`Session ${options.sessionId} not found`);
		}

		const message: OpenCodeMessage = {
			id: `msg-${Date.now()}`,
			role: 'user',
			content: options.content,
			timestamp: new Date(),
			sessionId: options.sessionId
		};

		// Update session with new message
		const updatedSession: OpenCodeSessionData = {
			...session,
			messages: [...session.messages, message]
		};
		this._sessions.set(options.sessionId, updatedSession);

		return message;
	}

	async deleteSession(sessionId: string, token?: CancellationToken): Promise<void> {
		this._sessions.delete(sessionId);
	}

	// Test helper methods
	addMockSession(session: OpenCodeSessionData): void {
		this._sessions.set(session.id, session);
	}

	clear(): void {
		this._sessions.clear();
		this._nextId = 1;
	}
}

describe('OpenCodeSessionService', () => {
	let mockClient: MockOpenCodeClient;
	let testingServiceCollection: TestingServiceCollection;
	let service: OpenCodeSessionService;
	let token: CancellationToken;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		mockClient = new MockOpenCodeClient();
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));
		testingServiceCollection.set(IOpenCodeClient, mockClient);

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		service = store.add(instantiationService.createInstance(OpenCodeSessionService));

		const tokenSource = store.add(new CancellationTokenSource());
		token = tokenSource.token;
	});

	describe('getAllSessions', () => {
		it('should return empty array when no sessions exist', async () => {
			const sessions = await service.getAllSessions(token);
			expect(sessions).toEqual([]);
		});

		it('should return all sessions from client', async () => {
			// Add mock sessions
			const mockSession1: OpenCodeSessionData = {
				id: 'session-1',
				label: 'Test Session 1',
				messages: [],
				timestamp: new Date('2024-01-01'),
				status: 'active'
			};

			const mockSession2: OpenCodeSessionData = {
				id: 'session-2',
				label: 'Test Session 2',
				messages: [],
				timestamp: new Date('2024-01-02'),
				status: 'idle'
			};

			mockClient.addMockSession(mockSession1);
			mockClient.addMockSession(mockSession2);

			const sessions = await service.getAllSessions(token);
			
			expect(sessions).toHaveLength(2);
			expect(sessions[0].id).toBe('session-1');
			expect(sessions[0].label).toBe('Test Session 1');
			expect(sessions[0].status).toBe('active');
			expect(sessions[1].id).toBe('session-2');
			expect(sessions[1].label).toBe('Test Session 2');
			expect(sessions[1].status).toBe('idle');
		});

		it('should cache sessions and return cached results on subsequent calls', async () => {
			const mockSession: OpenCodeSessionData = {
				id: 'session-1',
				label: 'Test Session',
				messages: [],
				timestamp: new Date(),
				status: 'active'
			};

			mockClient.addMockSession(mockSession);

			// First call should fetch from client
			const sessions1 = await service.getAllSessions(token);
			expect(sessions1).toHaveLength(1);

			// Clear the client data
			mockClient.clear();

			// Second call should return cached data
			const sessions2 = await service.getAllSessions(token);
			expect(sessions2).toHaveLength(1);
			expect(sessions2[0].id).toBe('session-1');
		});
	});

	describe('getSession', () => {
		it('should return undefined for non-existent session', async () => {
			const session = await service.getSession('non-existent', token);
			expect(session).toBeUndefined();
		});

		it('should return session from client when it exists', async () => {
			const mockSession: OpenCodeSessionData = {
				id: 'session-1',
				label: 'Test Session',
				messages: [{
					id: 'msg-1',
					role: 'user',
					content: 'Hello',
					timestamp: new Date(),
					sessionId: 'session-1'
				}],
				timestamp: new Date('2024-01-01'),
				status: 'active'
			};

			mockClient.addMockSession(mockSession);

			const session = await service.getSession('session-1', token);
			
			expect(session).toBeDefined();
			expect(session!.id).toBe('session-1');
			expect(session!.label).toBe('Test Session');
			expect(session!.messages).toHaveLength(1);
			expect(session!.messages[0].content).toBe('Hello');
			expect(session!.status).toBe('active');
		});

		it('should cache individual session and return cached result', async () => {
			const mockSession: OpenCodeSessionData = {
				id: 'session-1',
				label: 'Test Session',
				messages: [],
				timestamp: new Date(),
				status: 'active'
			};

			mockClient.addMockSession(mockSession);

			// First call should fetch from client
			const session1 = await service.getSession('session-1', token);
			expect(session1).toBeDefined();

			// Clear the client data
			mockClient.clear();

			// Second call should return cached data
			const session2 = await service.getSession('session-1', token);
			expect(session2).toBeDefined();
			expect(session2!.id).toBe('session-1');
		});
	});

	describe('createSession', () => {
		it('should create session with default label when no options provided', async () => {
			const session = await service.createSession();
			
			expect(session).toBeDefined();
			expect(session.id).toMatch(/^session-\d+$/);
			expect(session.label).toMatch(/^Session session-\d+$/);
			expect(session.messages).toEqual([]);
			expect(session.status).toBe('active');
		});

		it('should create session with custom label when provided', async () => {
			const options: CreateSessionOptions = {
				label: 'My Custom Session'
			};

			const session = await service.createSession(options);
			
			expect(session).toBeDefined();
			expect(session.label).toBe('My Custom Session');
			expect(session.status).toBe('active');
		});

		it('should invalidate all sessions cache after creating new session', async () => {
			// Create initial session
			await service.createSession({ label: 'Session 1' });

			// Get all sessions to populate cache
			let sessions = await service.getAllSessions(token);
			expect(sessions).toHaveLength(1);

			// Create another session
			await service.createSession({ label: 'Session 2' });

			// Cache should be invalidated, so we should get fresh data
			sessions = await service.getAllSessions(token);
			expect(sessions).toHaveLength(2);
		});
	});

	describe('cache management', () => {
		it('should clear all cached data when clearCache is called', async () => {
			const mockSession: OpenCodeSessionData = {
				id: 'session-1',
				label: 'Test Session',
				messages: [],
				timestamp: new Date(),
				status: 'active'
			};

			mockClient.addMockSession(mockSession);

			// Populate cache
			await service.getAllSessions(token);
			await service.getSession('session-1', token);

			// Clear cache
			service.clearCache();

			// Clear client data
			mockClient.clear();

			// Should now return empty data from client since cache is cleared
			const sessions = await service.getAllSessions(token);
			expect(sessions).toEqual([]);

			const session = await service.getSession('session-1', token);
			expect(session).toBeUndefined();
		});

		it('should invalidate specific session when invalidateSession is called', async () => {
			const mockSession: OpenCodeSessionData = {
				id: 'session-1',
				label: 'Test Session',
				messages: [],
				timestamp: new Date(),
				status: 'active'
			};

			mockClient.addMockSession(mockSession);

			// Populate cache
			await service.getSession('session-1', token);

			// Update client data
			const updatedSession: OpenCodeSessionData = {
				...mockSession,
				label: 'Updated Session'
			};
			mockClient.addMockSession(updatedSession);

			// Invalidate specific session
			service.invalidateSession('session-1');

			// Should fetch fresh data
			const session = await service.getSession('session-1', token);
			expect(session!.label).toBe('Updated Session');
		});
	});
});