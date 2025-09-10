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

		// Add message to session (mock behavior)
		const updatedSession: OpenCodeSessionData = {
			...session,
			messages: [...session.messages, message]
		};
		this._sessions.set(options.sessionId, updatedSession);

		return message;
	}

	// Configuration + WebSocket placeholders
	setConfig(config: IOpenCodeServerConfig): void { /* no-op for tests */ }
	connectWebSocket(): Promise<void> { return Promise.resolve(); }
	disconnectWebSocket(): Promise<void> { return Promise.resolve(); }
	async deleteSession(sessionId: string): Promise<void> {
		this._sessions.delete(sessionId);
	}
	onSessionUpdated = vi.fn();
	onMessageReceived = vi.fn();
	onSessionCreated = vi.fn();
	onSessionDeleted = vi.fn();
}

class MockOpenCodeServerManager implements IOpenCodeServerManager {
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

// Mock VS Code types for testing
function createMockChatRequest(prompt: string): vscode.ChatRequest {
	// Provide the minimal shape and cast to satisfy TS; tests only use `prompt`
	const req: any = {
		prompt,
		command: undefined,
		references: [],
		location: undefined,
		attempt: 0,
		enableCommandDetection: false,
		// Additional fields that may be required by the type
		model: undefined,
		tools: undefined,
		toolReferences: [],
		toolInvocationToken: undefined,
		followupQuestions: undefined,
		participant: ''
	};
	return req as vscode.ChatRequest;
}

function createMockChatContext(): vscode.ChatContext {
	return {
		history: []
	};
}

function createMockChatResponseStream(): vscode.ChatResponseStream {
	const stream = {
		markdown: vi.fn(),
		anchor: vi.fn(),
		button: vi.fn(),
		filetree: vi.fn(),
		progress: vi.fn(),
		reference: vi.fn(),
		push: vi.fn()
	};
	return stream as any;
}

describe('OpenCodeAgentManager', () => {
	let testingServiceCollection: TestingServiceCollection;
	let agentManager: OpenCodeAgentManager;
	let mockClient: MockOpenCodeClient;
	let mockServerManager: MockOpenCodeServerManager;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));

		mockClient = new MockOpenCodeClient();
		mockServerManager = new MockOpenCodeServerManager();

		testingServiceCollection.set(IOpenCodeClient, mockClient);
		testingServiceCollection.set(IOpenCodeServerManager, mockServerManager);

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		agentManager = store.add(instantiationService.createInstance(OpenCodeAgentManager));
	});

	describe('handleRequest', () => {
		it('should create a new session when sessionId is undefined', async () => {
			const request = createMockChatRequest('Hello, world!');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			const result = await agentManager.handleRequest(undefined, request, context, stream, token);

			expect(result).toBeDefined();
			expect(result.sessionId).toBeDefined();
			expect(result.sessionId).toMatch(/^session-\d+$/);
		});

		it('should use existing session when sessionId is provided', async () => {
			// First create a session
			const session = await mockClient.createSession({ label: 'Test Session' });

			const request = createMockChatRequest('Continue conversation');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			const result = await agentManager.handleRequest(session.id, request, context, stream, token);

			expect(result).toBeDefined();
			expect(result.sessionId).toBe(session.id);
		});

		it('should handle server startup if not running', async () => {
			// Ensure server is stopped
			await mockServerManager.stop();
			expect(mockServerManager.isRunning()).toBe(false);

			const request = createMockChatRequest('Start server test');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			const result = await agentManager.handleRequest(undefined, request, context, stream, token);

			expect(result).toBeDefined();
			expect(mockServerManager.isRunning()).toBe(true);
		});

		it('should handle cancellation gracefully', async () => {
			const request = createMockChatRequest('This will be cancelled');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const tokenSource = new CancellationTokenSource();

			// Cancel immediately
			tokenSource.cancel();

			await expect(agentManager.handleRequest(undefined, request, context, stream, tokenSource.token))
				.rejects.toThrow();
		});

		it('should handle empty prompt gracefully', async () => {
			const request = createMockChatRequest('');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			const result = await agentManager.handleRequest(undefined, request, context, stream, token);

			expect(result).toBeDefined();
			// Should still create a session even with empty prompt
			expect(result.sessionId).toBeDefined();
		});
	});

	describe('server lifecycle management', () => {
		it('should start server when needed', async () => {
			await mockServerManager.stop();
			expect(mockServerManager.isRunning()).toBe(false);

			const request = createMockChatRequest('Test message');
			const context = createMockChatContext();
			const stream = createMockChatResponseStream();
			const token = new CancellationTokenSource().token;

			await agentManager.handleRequest(undefined, request, context, stream, token);

			expect(mockServerManager.isRunning()).toBe(true);
		});
	});
});
