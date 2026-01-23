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
import { MockClaudeCodeSdkService } from './mockClaudeCodeSdkService';

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
		const res1 = await manager.handleRequest(undefined, req1, { history: [] } as any, stream1, CancellationToken.None);

		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(res1.claudeSessionId).toBe('sess-1');

		// Second request should reuse the same live session (SDK query created only once)
		const stream2 = new MockChatResponseStream();

		const req2 = new TestChatRequest('Again');
		const res2 = await manager.handleRequest(res1.claudeSessionId, req2, { history: [] } as any, stream2, CancellationToken.None);

		expect(stream2.output.join('\n')).toContain('Hello from mock!');
		expect(res2.claudeSessionId).toBe('sess-1');

		// Verify session continuity by checking that the same session ID was returned
		expect(res1.claudeSessionId).toBe(res2.claudeSessionId);

		// Verify that the service's query method was called only once (proving session reuse)
		expect(mockService.queryCallCount).toBe(1);
	});

	it('rewinds files through the manager', async () => {
		const manager = instantiationService.createInstance(ClaudeAgentManager);

		// Create a session first
		const stream = new MockChatResponseStream();
		const req = new TestChatRequest('Hi');
		const res = await manager.handleRequest(undefined, req, { history: [] } as any, stream, CancellationToken.None);

		expect(res.claudeSessionId).toBe('sess-1');

		// Now call rewindFiles through the manager
		const result = await manager.rewindFiles(res.claudeSessionId!, 'test-message-id', false);

		expect(mockService.rewindFilesCallCount).toBe(1);
		expect(mockService.lastRewindMessageId).toBe('test-message-id');
		expect(result.canRewind).toBe(true);
	});

	it('returns error when rewinding non-existent session', async () => {
		const manager = instantiationService.createInstance(ClaudeAgentManager);

		// Try to rewind a session that doesn't exist
		const result = await manager.rewindFiles('non-existent-session', 'test-message-id', false);

		expect(result.canRewind).toBe(false);
		expect(result.error).toBe('Session not found');
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
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', undefined, undefined));
		const stream = new MockChatResponseStream();

		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None);

		expect(stream.output.join('\n')).toContain('Hello from mock!');
	});

	it('queues multiple requests and processes them sequentially', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', undefined, undefined));

		const stream1 = new MockChatResponseStream();
		const stream2 = new MockChatResponseStream();

		// Start both requests simultaneously
		const promise1 = session.invoke('First', {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None);
		const promise2 = session.invoke('Second', {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None);

		// Wait for both to complete
		await Promise.all([promise1, promise2]);

		// Both should have received responses
		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(stream2.output.join('\n')).toContain('Hello from mock!');
	});

	it('cancels pending requests when cancelled', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', undefined, undefined));
		const stream = new MockChatResponseStream();
		const source = new CancellationTokenSource();
		source.cancel();

		await expect(session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, source.token)).rejects.toThrow();
	});

	it('cleans up resources when disposed', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const session = instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', undefined, undefined);

		// Dispose the session immediately
		session.dispose();

		// Any new requests should be rejected
		const stream = new MockChatResponseStream();
		await expect(session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None))
			.rejects.toThrow('Session disposed');
	});

	it('handles multiple sessions with different session IDs', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const session1 = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'session-1', undefined, undefined));
		const session2 = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'session-2', undefined, undefined));

		expect(session1.sessionId).toBe('session-1');
		expect(session2.sessionId).toBe('session-2');

		const stream1 = new MockChatResponseStream();
		const stream2 = new MockChatResponseStream();

		// Both sessions should work independently
		await Promise.all([
			session1.invoke('Hello from session 1', {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None),
			session2.invoke('Hello from session 2', {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None)
		]);

		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(stream2.output.join('\n')).toContain('Hello from mock!');
	});

	it('initializes with model ID from constructor', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', 'claude-3-opus', undefined));
		const stream = new MockChatResponseStream();

		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None);

		expect(stream.output.join('\n')).toContain('Hello from mock!');
	});

	it('calls setModel when model changes instead of restarting session', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		mockService.queryCallCount = 0;
		mockService.setModelCallCount = 0;

		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', 'claude-3-sonnet', undefined));

		// First request with initial model
		const stream1 = new MockChatResponseStream();
		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None);
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
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		mockService.queryCallCount = 0;

		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', 'claude-3-sonnet', undefined));

		// First request
		const stream1 = new MockChatResponseStream();
		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, 'claude-3-sonnet');
		expect(mockService.queryCallCount).toBe(1);

		// Second request with same model should reuse session
		const stream2 = new MockChatResponseStream();
		await session.invoke('Hello again', {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, 'claude-3-sonnet');
		expect(mockService.queryCallCount).toBe(1); // Same query reused
	});

	it('rewinds files when rewindFiles is called', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', undefined, undefined));

		// First invoke to create the query generator
		const stream = new MockChatResponseStream();
		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None);

		// Now call rewindFiles
		const result = await session.rewindFiles('test-message-id', false);

		expect(mockService.rewindFilesCallCount).toBe(1);
		expect(mockService.lastRewindMessageId).toBe('test-message-id');
		expect(mockService.lastRewindDryRun).toBe(false);
		expect(result.canRewind).toBe(true);
		expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
	});

	it('returns error when rewindFiles is called without active session', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', undefined, undefined));

		// Call rewindFiles without invoking first
		const result = await session.rewindFiles('test-message-id', false);

		expect(result.canRewind).toBe(false);
		expect(result.error).toBe('No active session');
	});

	it('supports dry run mode for rewindFiles', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', undefined, undefined));

		// First invoke to create the query generator
		const stream = new MockChatResponseStream();
		await session.invoke('Hello', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None);

		// Now call rewindFiles with dry run
		const result = await session.rewindFiles('test-message-id', true);

		expect(mockService.rewindFilesCallCount).toBe(1);
		expect(mockService.lastRewindDryRun).toBe(true);
		expect(result.canRewind).toBe(true);
	});
});
