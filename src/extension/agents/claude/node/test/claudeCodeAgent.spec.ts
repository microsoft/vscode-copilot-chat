/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CancellationToken, CancellationTokenSource } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { MockChatResponseStream, TestChatRequest } from '../../../../test/node/testHelpers';
import { ClaudeAgentManager, ClaudeCodeSession } from '../claudeCodeAgent';
import { IClaudeCodeSdkService } from '../claudeCodeSdkService';
import { ClaudeLanguageModelServer } from '../claudeLanguageModelServer';
import { MockClaudeCodeSdkService } from './mockClaudeCodeSdkService';

function createMockLangModelServer(): ClaudeLanguageModelServer {
	return {
		incrementUserInitiatedMessageCount: vi.fn()
	} as unknown as ClaudeLanguageModelServer;
}

const TEST_MODEL_ID = 'claude-3-sonnet';

describe('ClaudeAgentManager', () => {
	const store = new DisposableStore();
	let instantiationService: IInstantiationService;
	let mockService: MockClaudeCodeSdkService;

	beforeEach(() => {
		const services = store.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);

		// Reset mock service call count
		mockService = accessor.get(IClaudeCodeSdkService) as MockClaudeCodeSdkService;
		mockService.queryCallCount = 0;
	});

	afterEach(() => {
		store.clear();
		vi.resetAllMocks();
	});

	it('reuses a live session across requests and streams assistant text', async () => {
		const manager = instantiationService.createInstance(ClaudeAgentManager);

		// Use MockChatResponseStream to capture markdown output
		const stream1 = new MockChatResponseStream();

		const req1 = new TestChatRequest('Hi');
		const res1 = await manager.handleRequest(undefined, req1, { history: [] } as any, stream1, CancellationToken.None, TEST_MODEL_ID);

		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(res1.claudeSessionId).toBe('sess-1');

		// Second request should reuse the same live session (SDK query created only once)
		const stream2 = new MockChatResponseStream();

		const req2 = new TestChatRequest('Again');
		const res2 = await manager.handleRequest(res1.claudeSessionId, req2, { history: [] } as any, stream2, CancellationToken.None, TEST_MODEL_ID);

		expect(stream2.output.join('\n')).toContain('Hello from mock!');
		expect(res2.claudeSessionId).toBe('sess-1');

		// Verify session continuity by checking that the same session ID was returned
		expect(res1.claudeSessionId).toBe(res2.claudeSessionId);

		// Verify that the service's query method was called only once (proving session reuse)
		expect(mockService.queryCallCount).toBe(1);
	});
});

describe('ClaudeCodeSession', () => {
	const store = new DisposableStore();
	let instantiationService: IInstantiationService;

	beforeEach(() => {
		const services = store.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
	});

	afterEach(() => {
		store.clear();
		vi.resetAllMocks();
	});

	it('processes a single request correctly', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, undefined));
		const stream = new MockChatResponseStream();

		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, TEST_MODEL_ID);

		expect(stream.output.join('\n')).toContain('Hello from mock!');
	});

	it('queues multiple requests and processes them sequentially', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, undefined));

		const stream1 = new MockChatResponseStream();
		const stream2 = new MockChatResponseStream();

		// Start both requests simultaneously
		const promise1 = session.invoke('First', {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, TEST_MODEL_ID);
		const promise2 = session.invoke('Second', {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, TEST_MODEL_ID);

		// Wait for both to complete
		await Promise.all([promise1, promise2]);

		// Both should have received responses
		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(stream2.output.join('\n')).toContain('Hello from mock!');
	});

	it('cancels pending requests when cancelled', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, undefined));
		const stream = new MockChatResponseStream();
		const source = new CancellationTokenSource();
		source.cancel();

		await expect(session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, source.token, TEST_MODEL_ID)).rejects.toThrow();
	});

	it('cleans up resources when disposed', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, undefined);

		// Dispose the session immediately
		session.dispose();

		// Any new requests should be rejected
		const stream = new MockChatResponseStream();
		await expect(session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, TEST_MODEL_ID))
			.rejects.toThrow('Session disposed');
	});

	it('handles multiple sessions with different session IDs', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer1 = createMockLangModelServer();
		const mockServer2 = createMockLangModelServer();
		const session1 = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer1, 'session-1', TEST_MODEL_ID, undefined));
		const session2 = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer2, 'session-2', TEST_MODEL_ID, undefined));

		expect(session1.sessionId).toBe('session-1');
		expect(session2.sessionId).toBe('session-2');

		const stream1 = new MockChatResponseStream();
		const stream2 = new MockChatResponseStream();

		// Both sessions should work independently
		await Promise.all([
			session1.invoke('Hello from session 1', {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, TEST_MODEL_ID),
			session2.invoke('Hello from session 2', {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, TEST_MODEL_ID)
		]);

		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(stream2.output.join('\n')).toContain('Hello from mock!');
	});

	it('initializes with model ID from constructor', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', 'claude-3-opus', undefined));
		const stream = new MockChatResponseStream();

		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, 'claude-3-opus');

		expect(stream.output.join('\n')).toContain('Hello from mock!');
	});

	it('calls setModel when model changes instead of restarting session', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		mockService.queryCallCount = 0;
		mockService.setModelCallCount = 0;

		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', 'claude-3-sonnet', undefined));

		// First request with initial model
		const stream1 = new MockChatResponseStream();
		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, 'claude-3-sonnet');
		expect(mockService.queryCallCount).toBe(1);

		// Second request with different model should call setModel on existing session
		const stream2 = new MockChatResponseStream();
		await session.invoke('Hello again', {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, 'claude-3-opus');
		expect(mockService.queryCallCount).toBe(1); // Same query reused
		expect(mockService.setModelCallCount).toBe(1); // setModel was called
		expect(mockService.lastSetModel).toBe('claude-3-opus');
	});

	it('does not restart session when same model is used', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		mockService.queryCallCount = 0;

		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', 'claude-3-sonnet', undefined));

		// First request
		const stream1 = new MockChatResponseStream();
		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, 'claude-3-sonnet');
		expect(mockService.queryCallCount).toBe(1);

		// Second request with same model should reuse session
		const stream2 = new MockChatResponseStream();
		await session.invoke('Hello again', {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, 'claude-3-sonnet');
		expect(mockService.queryCallCount).toBe(1); // Same query reused
	});
});
