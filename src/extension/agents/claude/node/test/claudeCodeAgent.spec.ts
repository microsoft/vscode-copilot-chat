/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CancellationToken, CancellationTokenSource } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatReferenceBinaryData } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { MockChatResponseStream, TestChatRequest } from '../../../../test/node/testHelpers';
import type { ClaudeFolderInfo } from '../../common/claudeFolderInfo';
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
const TEST_PERMISSION_MODE = 'acceptEdits' as const;
const TEST_FOLDER_INFO: ClaudeFolderInfo = { cwd: '/test/project', additionalDirectories: [] };

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
		const res1 = await manager.handleRequest(undefined, req1, { history: [] } as any, stream1, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO);

		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(res1.claudeSessionId).toBe('sess-1');

		// Second request should reuse the same live session (SDK query created only once)
		const stream2 = new MockChatResponseStream();

		const req2 = new TestChatRequest('Again');
		const res2 = await manager.handleRequest(res1.claudeSessionId, req2, { history: [] } as any, stream2, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO);

		expect(stream2.output.join('\n')).toContain('Hello from mock!');
		expect(res2.claudeSessionId).toBe('sess-1');

		// Verify session continuity by checking that the same session ID was returned
		expect(res1.claudeSessionId).toBe(res2.claudeSessionId);

		// Verify that the service's query method was called only once (proving session reuse)
		expect(mockService.queryCallCount).toBe(1);
	});

	it('resolves image references as ImageBlockParam content blocks', async () => {
		const manager = instantiationService.createInstance(ClaudeAgentManager);
		const stream = new MockChatResponseStream();

		const imageData = new Uint8Array([0x89, 0x50, 0x4E, 0x47]); // PNG magic bytes
		const imageRef: vscode.ChatPromptReference = {
			id: 'image-1',
			name: 'image-1',
			value: new ChatReferenceBinaryData('image/png', () => Promise.resolve(imageData)),
		};
		const req = new TestChatRequest('What is in this image?', [imageRef]);
		await manager.handleRequest(undefined, req, { history: [] } as any, stream, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO);

		expect(mockService.receivedMessages).toHaveLength(1);
		const content = mockService.receivedMessages[0].message.content;
		expect(Array.isArray(content)).toBe(true);

		const blocks = content as Anthropic.ContentBlockParam[];
		const imageBlocks = blocks.filter(b => b.type === 'image');
		expect(imageBlocks).toHaveLength(1);

		const imageBlock = imageBlocks[0] as Anthropic.ImageBlockParam;
		expect(imageBlock.source.type).toBe('base64');
		const source = imageBlock.source as Anthropic.Base64ImageSource;
		expect(source.media_type).toBe('image/png');
		expect(source.data).toBe(Buffer.from(imageData).toString('base64'));

		// The text prompt should still be present
		const textBlocks = blocks.filter(b => b.type === 'text') as Anthropic.TextBlockParam[];
		expect(textBlocks.some(b => b.text === 'What is in this image?')).toBe(true);
	});

	it('normalizes image/jpg to image/jpeg', async () => {
		const manager = instantiationService.createInstance(ClaudeAgentManager);
		const stream = new MockChatResponseStream();

		const imageRef: vscode.ChatPromptReference = {
			id: 'image-1',
			name: 'image-1',
			value: new ChatReferenceBinaryData('image/jpg', () => Promise.resolve(new Uint8Array([0xFF, 0xD8]))),
		};
		const req = new TestChatRequest('Describe this', [imageRef]);
		await manager.handleRequest(undefined, req, { history: [] } as any, stream, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO);

		const blocks = mockService.receivedMessages[0].message.content as Anthropic.ContentBlockParam[];
		const imageBlock = blocks.find(b => b.type === 'image') as Anthropic.ImageBlockParam;
		expect(imageBlock).toBeDefined();
		expect((imageBlock.source as Anthropic.Base64ImageSource).media_type).toBe('image/jpeg');
	});

	it('skips unsupported image MIME types', async () => {
		const manager = instantiationService.createInstance(ClaudeAgentManager);
		const stream = new MockChatResponseStream();

		const imageRef: vscode.ChatPromptReference = {
			id: 'image-1',
			name: 'image-1',
			value: new ChatReferenceBinaryData('image/bmp', () => Promise.resolve(new Uint8Array([0x42, 0x4D]))),
		};
		const req = new TestChatRequest('Describe this', [imageRef]);
		await manager.handleRequest(undefined, req, { history: [] } as any, stream, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO);

		const blocks = mockService.receivedMessages[0].message.content as Anthropic.ContentBlockParam[];
		const imageBlocks = blocks.filter(b => b.type === 'image');
		expect(imageBlocks).toHaveLength(0);
	});

	it('handles mixed image and file references', async () => {
		const manager = instantiationService.createInstance(ClaudeAgentManager);
		const stream = new MockChatResponseStream();

		const imageRef: vscode.ChatPromptReference = {
			id: 'image-1',
			name: 'image-1',
			value: new ChatReferenceBinaryData('image/png', () => Promise.resolve(new Uint8Array([0x89]))),
		};
		const fileRef: vscode.ChatPromptReference = {
			id: 'file-1',
			name: 'file-1',
			value: URI.file('/test/file.ts'),
		};
		const req = new TestChatRequest('Explain both', [imageRef, fileRef]);
		await manager.handleRequest(undefined, req, { history: [] } as any, stream, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO);

		const blocks = mockService.receivedMessages[0].message.content as Anthropic.ContentBlockParam[];
		const imageBlocks = blocks.filter(b => b.type === 'image');
		const textBlocks = blocks.filter(b => b.type === 'text') as Anthropic.TextBlockParam[];
		expect(imageBlocks).toHaveLength(1);
		// File reference should appear in system-reminder text block
		expect(textBlocks.some(b => b.text.includes('/test/file.ts'))).toBe(true);
		// User prompt should still be present
		expect(textBlocks.some(b => b.text === 'Explain both')).toBe(true);
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
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO));
		const stream = new MockChatResponseStream();

		await session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE);

		expect(stream.output.join('\n')).toContain('Hello from mock!');
	});

	it('queues multiple requests and processes them sequentially', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO));

		const stream1 = new MockChatResponseStream();
		const stream2 = new MockChatResponseStream();

		// Start both requests simultaneously
		const promise1 = session.invoke(toPromptBlocks('First'), {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE);
		const promise2 = session.invoke(toPromptBlocks('Second'), {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE);

		// Wait for both to complete
		await Promise.all([promise1, promise2]);

		// Both should have received responses
		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(stream2.output.join('\n')).toContain('Hello from mock!');
	});

	it('cancels pending requests when cancelled', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO));
		const stream = new MockChatResponseStream();
		const source = new CancellationTokenSource();
		source.cancel();

		await expect(session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream, source.token, TEST_MODEL_ID, TEST_PERMISSION_MODE)).rejects.toThrow();
	});

	it('cleans up resources when disposed', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO);

		// Dispose the session immediately
		session.dispose();

		// Any new requests should be rejected
		const stream = new MockChatResponseStream();
		await expect(session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE))
			.rejects.toThrow('Session disposed');
	});

	it('handles multiple sessions with different session IDs', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer1 = createMockLangModelServer();
		const mockServer2 = createMockLangModelServer();
		const session1 = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer1, 'session-1', TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO));
		const session2 = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer2, 'session-2', TEST_MODEL_ID, TEST_PERMISSION_MODE, TEST_FOLDER_INFO));

		expect(session1.sessionId).toBe('session-1');
		expect(session2.sessionId).toBe('session-2');

		const stream1 = new MockChatResponseStream();
		const stream2 = new MockChatResponseStream();

		// Both sessions should work independently
		await Promise.all([
			session1.invoke(toPromptBlocks('Hello from session 1'), {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE),
			session2.invoke(toPromptBlocks('Hello from session 2'), {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, TEST_MODEL_ID, TEST_PERMISSION_MODE)
		]);

		expect(stream1.output.join('\n')).toContain('Hello from mock!');
		expect(stream2.output.join('\n')).toContain('Hello from mock!');
	});

	it('initializes with model ID from constructor', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', 'claude-3-opus', TEST_PERMISSION_MODE, TEST_FOLDER_INFO));
		const stream = new MockChatResponseStream();

		await session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream, CancellationToken.None, 'claude-3-opus', TEST_PERMISSION_MODE);

		expect(stream.output.join('\n')).toContain('Hello from mock!');
	});

	it('calls setModel when model changes instead of restarting session', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		mockService.queryCallCount = 0;
		mockService.setModelCallCount = 0;

		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', 'claude-3-sonnet', TEST_PERMISSION_MODE, TEST_FOLDER_INFO));

		// First request with initial model
		const stream1 = new MockChatResponseStream();
		await session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, 'claude-3-sonnet', TEST_PERMISSION_MODE);
		expect(mockService.queryCallCount).toBe(1);

		// Second request with different model should call setModel on existing session
		const stream2 = new MockChatResponseStream();
		await session.invoke(toPromptBlocks('Hello again'), {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, 'claude-3-opus', TEST_PERMISSION_MODE);
		expect(mockService.queryCallCount).toBe(1); // Same query reused
		expect(mockService.setModelCallCount).toBe(1); // setModel was called
		expect(mockService.lastSetModel).toBe('claude-3-opus');
	});

	it('does not restart session when same model is used', async () => {
		const serverConfig = { port: 8080, nonce: 'test-nonce' };
		const mockServer = createMockLangModelServer();
		const mockService = instantiationService.invokeFunction(accessor => accessor.get(IClaudeCodeSdkService)) as MockClaudeCodeSdkService;
		mockService.queryCallCount = 0;

		const session = store.add(instantiationService.createInstance(ClaudeCodeSession, serverConfig, mockServer, 'test-session', 'claude-3-sonnet', TEST_PERMISSION_MODE, TEST_FOLDER_INFO));

		// First request
		const stream1 = new MockChatResponseStream();
		await session.invoke(toPromptBlocks('Hello'), {} as vscode.ChatParticipantToolToken, stream1, CancellationToken.None, 'claude-3-sonnet', TEST_PERMISSION_MODE);
		expect(mockService.queryCallCount).toBe(1);

		// Second request with same model should reuse session
		const stream2 = new MockChatResponseStream();
		await session.invoke(toPromptBlocks('Hello again'), {} as vscode.ChatParticipantToolToken, stream2, CancellationToken.None, 'claude-3-sonnet', TEST_PERMISSION_MODE);
		expect(mockService.queryCallCount).toBe(1); // Same query reused
	});
});
