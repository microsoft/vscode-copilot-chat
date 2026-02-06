/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Anthropic from '@anthropic-ai/sdk';
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

/** Helper to convert a string prompt to TextBlockParam array for tests */
function toPromptBlocks(text: string): Anthropic.TextBlockParam[] {
	return [{ type: 'text', text }];
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

		await session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, TEST_MODEL_ID);

		expect(stream.output.join('\n')).toContain('Hello from mock!');
	});

	it('queues multiple requests and processes them sequentially', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, undefined));

		const stream1 = new MockChatResponseStream();
		const stream2 = new MockChatResponseStream();

		// Start both requests simultaneously
		const promise1 = session.invoke(toPromptBlocks('First'), {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, TEST_MODEL_ID);
		const promise2 = session.invoke(toPromptBlocks('Second'), {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, TEST_MODEL_ID);

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

		await expect(session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream, source.token, TEST_MODEL_ID)).rejects.toThrow();
	});

	it('cleans up resources when disposed', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, undefined);

		// Dispose the session immediately
		session.dispose();

		// Any new requests should be rejected
		const stream = new MockChatResponseStream();
		await expect(session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, TEST_MODEL_ID))
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
			session1.invoke(toPromptBlocks('Hello from session 1'), {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, TEST_MODEL_ID),
			session2.invoke(toPromptBlocks('Hello from session 2'), {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, TEST_MODEL_ID)
		]);

		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(stream2.output.join('\n')).toContain('Hello from mock!');
	});

	it('initializes with model ID from constructor', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', 'claude-3-opus', undefined));
		const stream = new MockChatResponseStream();

		await session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, 'claude-3-opus');

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
		await session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, 'claude-3-sonnet');
		expect(mockService.queryCallCount).toBe(1);

		// Second request with different model should call setModel on existing session
		const stream2 = new MockChatResponseStream();
		await session.invoke(toPromptBlocks('Hello again'), {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, 'claude-3-opus');
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
		await session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, 'claude-3-sonnet');
		expect(mockService.queryCallCount).toBe(1);

		// Second request with same model should reuse session
		const stream2 = new MockChatResponseStream();
		await session.invoke(toPromptBlocks('Hello again'), {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, 'claude-3-sonnet');
		expect(mockService.queryCallCount).toBe(1); // Same query reused
	});

	it('does not create duplicate tool invocations when tools are used', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		
		// Override the mock to include a tool use
		mockService.createMockGeneratorWithToolUse = async function* (prompt: AsyncIterable<any>): AsyncGenerator<any, void, unknown> {
			for await (const _ of prompt) {
				// Assistant message with tool use
				yield {
					type: 'assistant',
					session_id: 'sess-1',
					message: {
						role: 'assistant',
						content: [
							{ type: 'text', text: 'I will search for files' },
							{ 
								type: 'tool_use',
								id: 'tool_1',
								name: 'Glob',
								input: { pattern: '*.ts' }
							}
						]
					}
				};
				// User message with tool result
				yield {
					type: 'user',
					session_id: 'sess-1',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool_1',
								content: 'file1.ts\nfile2.ts',
								is_error: false
							}
						]
					}
				};
				// Final result
				yield {
					type: 'result',
					subtype: 'error_max_turns',
					uuid: 'mock-uuid',
					session_id: 'sess-1',
					duration_ms: 0,
					duration_api_ms: 0,
					is_error: false,
					num_turns: 1,
					total_cost_usd: 0,
					usage: { input_tokens: 0, output_tokens: 0 },
					permission_denials: []
				};
			}
		};

		(mockService as any).createMockGenerator = mockService.createMockGeneratorWithToolUse;

		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, 'test-session', undefined, undefined));
		
		// Track pushed items
		const pushedItems: any[] = [];
		const stream = new MockChatResponseStream((part: any) => {
			pushedItems.push(part);
		});

		await session.invoke('Search for TypeScript files', {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None);

		// Count how many times a Glob tool invocation was pushed
		const globInvocations = pushedItems.filter((item: any) => 
			item && typeof item === 'object' && 
			item.constructor.name === 'ChatToolInvocationPart' &&
			(item as any).toolName === 'Glob'
		);

		// Should only have ONE tool invocation for Glob, not two
		expect(globInvocations.length).toBe(1);
	});
});
