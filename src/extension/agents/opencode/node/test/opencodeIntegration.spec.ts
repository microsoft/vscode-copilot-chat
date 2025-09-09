/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { TestingServiceCollection } from '../../../../../platform/test/node/services';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { CancellationToken, CancellationTokenSource } from '../../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { IOpenCodeClient, OpenCodeMessage, OpenCodeSessionData, CreateSessionOptions } from '../opencodeClient';
import { OpenCodeAgentManager } from '../opencodeAgentManager';
import { IOpenCodeServerManager, IOpenCodeServerConfig } from '../opencodeServerManager';
import { OpenCodeSessionService } from '../opencodeSessionService';
import { OpenCodeChatSessionContentProvider } from '../../vscode-node/opencodeContentProvider';
import { OpenCodeChatSessionItemProvider, OpenCodeSessionDataStore } from '../../vscode-node/opencodeItemProvider';

/**
 * Mock implementation for integration testing
 */
class IntegrationMockOpenCodeClient implements IOpenCodeClient {
	declare _serviceBrand: undefined;

	private _sessions: Map<string, OpenCodeSessionData> = new Map();
	private _nextId = 1;
	private _isConfigured = false;

	configure(config: IOpenCodeServerConfig): void {
		this._isConfigured = true;
	}

	async getAllSessions(token?: CancellationToken): Promise<readonly OpenCodeSessionData[]> {
		if (!this._isConfigured) {
			throw new Error('OpenCodeClient not configured');
		}
		return Array.from(this._sessions.values());
	}

	async getSession(sessionId: string, token?: CancellationToken): Promise<OpenCodeSessionData | undefined> {
		if (!this._isConfigured) {
			throw new Error('OpenCodeClient not configured');
		}
		return this._sessions.get(sessionId);
	}

	async createSession(options?: CreateSessionOptions, token?: CancellationToken): Promise<OpenCodeSessionData> {
		if (!this._isConfigured) {
			throw new Error('OpenCodeClient not configured');
		}

		const id = `session-${this._nextId++}`;
		const session: OpenCodeSessionData = {
			id,
			label: options?.label || `Session ${id}`,
			messages: options?.initialMessage ? [{
				id: `msg-init-${id}`,
				role: 'user',
				content: options.initialMessage,
				timestamp: new Date(),
				sessionId: id
			}] : [],
			timestamp: new Date(),
			status: 'active'
		};
		this._sessions.set(id, session);
		return session;
	}

	async sendMessage(options: { content: string; sessionId: string }, token?: CancellationToken): Promise<OpenCodeMessage> {
		if (!this._isConfigured) {
			throw new Error('OpenCodeClient not configured');
		}

		const session = this._sessions.get(options.sessionId);
		if (!session) {
			throw new Error(`Session ${options.sessionId} not found`);
		}

		const userMessage: OpenCodeMessage = {
			id: `msg-${Date.now()}-user`,
			role: 'user',
			content: options.content,
			timestamp: new Date(),
			sessionId: options.sessionId
		};

		// Simulate assistant response
		const assistantMessage: OpenCodeMessage = {
			id: `msg-${Date.now()}-assistant`,
			role: 'assistant',
			content: `Echo: ${options.content}`,
			timestamp: new Date(),
			sessionId: options.sessionId
		};

		// Update session with both messages
		const updatedSession: OpenCodeSessionData = {
			...session,
			messages: [...session.messages, userMessage, assistantMessage],
			status: 'active'
		};
		this._sessions.set(options.sessionId, updatedSession);

		return assistantMessage;
	}

	// WebSocket methods (mocked for integration testing)
	connectWebSocket(): Promise<void> { return Promise.resolve(); }
	disconnectWebSocket(): Promise<void> { return Promise.resolve(); }
	isConnected(): boolean { return this._isConfigured; }
	onSessionUpdated = vi.fn();
	onMessageReceived = vi.fn();
	onSessionCreated = vi.fn();
	onSessionDeleted = vi.fn();
}

class IntegrationMockServerManager implements IOpenCodeServerManager {
	declare _serviceBrand: undefined;

	private _isRunning = false;
	private _config: IOpenCodeServerConfig = {
		url: 'http://localhost:4096',
		port: 4096,
		hostname: '127.0.0.1'
	};

	async start(token?: CancellationToken): Promise<IOpenCodeServerConfig> {
		this._isRunning = true;
		return this._config;
	}

	async stop(): Promise<void> {
		this._isRunning = false;
	}

	getConfig(): IOpenCodeServerConfig {
		return this._config;
	}

	isRunning(): boolean {
		return this._isRunning;
	}
}

// Mock VS Code types
function createMockChatRequest(prompt: string): vscode.ChatRequest {
	return {
		prompt,
		command: undefined,
		references: [],
		location: undefined as any,
		attempt: 0,
		enableCommandDetection: false
	};
}

function createMockChatContext(): vscode.ChatContext {
	return {
		history: []
	};
}

function createMockChatResponseStream(): vscode.ChatResponseStream {
	const responses: any[] = [];
	const stream = {
		markdown: vi.fn((content: string) => responses.push({ type: 'markdown', content })),
		anchor: vi.fn(),
		button: vi.fn(),
		filetree: vi.fn(),
		progress: vi.fn(),
		reference: vi.fn(),
		push: vi.fn(),
		_getResponses: () => responses
	};
	return stream as any;
}

describe('OpenCode Integration Tests', () => {
	let testingServiceCollection: TestingServiceCollection;
	let agentManager: OpenCodeAgentManager;
	let sessionService: OpenCodeSessionService;
	let sessionStore: OpenCodeSessionDataStore;
	let itemProvider: OpenCodeChatSessionItemProvider;
	let contentProvider: OpenCodeChatSessionContentProvider;
	let mockClient: IntegrationMockOpenCodeClient;
	let mockServerManager: IntegrationMockServerManager;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));

		mockClient = new IntegrationMockOpenCodeClient();
		mockServerManager = new IntegrationMockServerManager();

		testingServiceCollection.set(IOpenCodeClient, mockClient);
		testingServiceCollection.set(IOpenCodeServerManager, mockServerManager);

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);

		// Create all components as they would be in real usage
		agentManager = store.add(instantiationService.createInstance(OpenCodeAgentManager));
		sessionService = store.add(instantiationService.createInstance(OpenCodeSessionService));
		sessionStore = instantiationService.createInstance(OpenCodeSessionDataStore);
		itemProvider = store.add(instantiationService.createInstance(OpenCodeChatSessionItemProvider, sessionStore));
		contentProvider = store.add(instantiationService.createInstance(OpenCodeChatSessionContentProvider, agentManager, sessionStore));
	});

	describe('End-to-End Session Flow', () => {
		it('should create a new session and handle chat request', async () => {
			// Step 1: Start with no sessions
			const initialSessions = await itemProvider.provideChatSessionItems(CancellationToken.None);
			expect(initialSessions).toEqual([]);

			// Step 2: Create a new session through agent manager
			const request = createMockChatRequest('Hello OpenCode!');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			const result = await agentManager.handleRequest(undefined, request, context, stream, token);

			// Step 3: Verify session was created
			expect(result).toBeDefined();
			expect(result.sessionId).toBeDefined();
			expect(mockServerManager.isRunning()).toBe(true);

			// Step 4: Verify session appears in item provider
			const sessionsAfterCreation = await sessionService.getAllSessions(token);
			expect(sessionsAfterCreation.length).toBe(1);
			expect(sessionsAfterCreation[0].id).toBe(result.sessionId);
		});

		it('should provide session content through content provider', async () => {
			// Step 1: Create a session with initial content
			const session = await mockClient.createSession({
				label: 'Test Integration Session',
				initialMessage: 'Initial test message'
			});

			// Step 2: Map internal session to OpenCode session
			const internalSessionId = 'internal-session-123';
			sessionStore.setOpenCodeSessionId(internalSessionId, session.id);

			// Step 3: Get session content through content provider
			const chatSession = await contentProvider.provideChatSessionContent(internalSessionId, CancellationToken.None);

			// Step 4: Verify session content
			expect(chatSession).toBeDefined();
			expect(chatSession.id).toBe(internalSessionId);
			expect(chatSession.history.length).toBeGreaterThan(0);

			// Verify the initial message is present
			const firstTurn = chatSession.history[0];
			expect(firstTurn).toBeDefined();
		});

		it('should handle session creation through item provider', async () => {
			// Step 1: Create new session item
			const newSessionItem = await itemProvider.provideNewChatSessionItem({
				label: 'New Test Session'
			});

			// Step 2: Verify session item properties
			expect(newSessionItem).toBeDefined();
			expect(newSessionItem.label).toBe('New Test Session');
			expect(newSessionItem.id).toBeDefined();

			// Step 3: Verify unresolved sessions tracking
			const unresolvedSessions = sessionStore.getUnresolvedSessions();
			expect(unresolvedSessions.size).toBe(1);
		});

		it('should handle session lifecycle with multiple interactions', async () => {
			// Step 1: Create initial session
			const firstRequest = createMockChatRequest('First message');
			const context = createMockChatContext();
			const stream1 = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			const firstResult = await agentManager.handleRequest(undefined, firstRequest, context, stream1, token);
			expect(firstResult.sessionId).toBeDefined();

			// Step 2: Continue conversation in same session
			const secondRequest = createMockChatRequest('Second message');
			const stream2 = createMockChatResponseStream();

			const secondResult = await agentManager.handleRequest(firstResult.sessionId, secondRequest, context, stream2, token);
			expect(secondResult.sessionId).toBe(firstResult.sessionId);

			// Step 3: Verify session has multiple messages
			const session = await sessionService.getSession(firstResult.sessionId!, token);
			expect(session).toBeDefined();
			expect(session!.messages.length).toBeGreaterThan(1);
		});

		it('should handle server restart scenario', async () => {
			// Step 1: Start server and create session
			const request = createMockChatRequest('Test message');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			const result1 = await agentManager.handleRequest(undefined, request, context, stream, token);
			expect(mockServerManager.isRunning()).toBe(true);

			// Step 2: Simulate server stop
			await mockServerManager.stop();
			expect(mockServerManager.isRunning()).toBe(false);

			// Step 3: Make another request (should restart server)
			const request2 = createMockChatRequest('After restart');
			const stream2 = createMockChatResponseStream();

			const result2 = await agentManager.handleRequest(undefined, request2, context, stream2, token);
			expect(mockServerManager.isRunning()).toBe(true);
			expect(result2.sessionId).toBeDefined();
		});
	});

	describe('Error Handling Integration', () => {
		it('should handle client configuration errors gracefully', async () => {
			// Reset client to unconfigured state
			mockClient = new IntegrationMockOpenCodeClient();
			testingServiceCollection.set(IOpenCodeClient, mockClient);

			const request = createMockChatRequest('Test with unconfigured client');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			// Should handle the error by configuring the client
			const result = await agentManager.handleRequest(undefined, request, context, stream, token);
			expect(result).toBeDefined();
		});

		it('should handle cancellation during session operations', async () => {
			const request = createMockChatRequest('Cancellable request');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const tokenSource = new CancellationTokenSource();

			// Cancel before request completes
			tokenSource.cancel();

			await expect(agentManager.handleRequest(undefined, request, context, stream, tokenSource.token))
				.rejects.toThrow();
		});
	});
});