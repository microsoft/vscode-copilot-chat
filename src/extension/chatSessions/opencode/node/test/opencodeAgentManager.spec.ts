/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeMessage } from '../opencodeSessionService';
import { OpenCodeAgentManager } from '../opencodeAgentManager';
import { IOpenCodeSdkService } from '../opencodeSdkService';
import { IOpenCodeSessionService } from '../opencodeSessionService';
import { ILogService } from '../../../../../platform/log/common/logService';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeLogService(): ILogService {
	return {
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
		warn: vi.fn(), error: vi.fn(), flush: vi.fn(),
		critical: vi.fn(), dispose: vi.fn(),
		getLevel: vi.fn(() => 0), onDidChangeLogLevel: { event: vi.fn() } as any,
	} as unknown as ILogService;
}

function makeSdkService(overrides: Partial<IOpenCodeSdkService> = {}): IOpenCodeSdkService {
	return {
		ensureServer: vi.fn().mockResolvedValue('http://127.0.0.1:12345'),
		listSessions: vi.fn().mockResolvedValue([]),
		getSession: vi.fn().mockResolvedValue(undefined),
		createSession: vi.fn().mockResolvedValue({ id: 'new-session', title: '', directory: '', projectID: '' }),
		getSessionMessages: vi.fn().mockResolvedValue([]),
		sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
		deleteSession: vi.fn().mockResolvedValue(undefined),
		subscribeToEvents: vi.fn().mockResolvedValue(() => { }),
		stopServer: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as IOpenCodeSdkService;
}

function makeSessionService(overrides: Partial<IOpenCodeSessionService> = {}): IOpenCodeSessionService {
	return {
		listSessions: vi.fn().mockResolvedValue([]),
		getSession: vi.fn().mockResolvedValue(undefined),
		createSession: vi.fn().mockResolvedValue({ id: 'new-session', title: '', directory: '', projectID: '' }),
		getSessionMessages: vi.fn().mockResolvedValue([]),
		sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
		deleteSession: vi.fn().mockResolvedValue(undefined),
		invalidateSession: vi.fn(),
		...overrides,
	} as unknown as IOpenCodeSessionService;
}

function makeResponseStream() {
	const pushed: unknown[] = [];
	const markdown: string[] = [];
	return {
		pushed,
		markdown,
		stream: {
			markdown: vi.fn((text: string) => markdown.push(text)),
			push: vi.fn((part: unknown) => pushed.push(part)),
			button: vi.fn(),
			anchor: vi.fn(),
			progress: vi.fn(),
			reference: vi.fn(),
		} as any,
	};
}

function makeManager(
	sdk: IOpenCodeSdkService,
	session: IOpenCodeSessionService,
	log = makeLogService()
): OpenCodeAgentManager {
	// Bypass DI decorators by constructing directly
	const mgr = Object.create(OpenCodeAgentManager.prototype);
	(mgr as any).sdkService = sdk;
	(mgr as any).sessionService = session;
	(mgr as any).logService = log;
	(mgr as any)._activeRequests = new Map();
	(mgr as any)._store = { add: () => { }, clear: () => { } };
	(mgr as any)._isDisposed = false;
	return mgr;
}

function makeToken(cancelled = false) {
	return {
		isCancellationRequested: cancelled,
		onCancellationRequested: (_cb: () => void) => ({ dispose: () => { } }),
	} as any;
}

// ---------------------------------------------------------------------------
// Helpers to make test messages
// ---------------------------------------------------------------------------

function textMessage(id: string, text: string): OpenCodeMessage {
	return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

function toolMessage(id: string, toolId: string, toolName: string, input?: Record<string, unknown>): OpenCodeMessage {
	return {
		id, role: 'assistant', parts: [{
			type: 'tool-invocation',
			toolInvocation: { id: toolId, name: toolName, state: { input } }
		}]
	};
}

function toolResultMessage(id: string, toolId: string, isError = false, result?: unknown): OpenCodeMessage {
	return {
		id, role: 'assistant', parts: [
			{ type: 'tool-invocation', toolInvocation: { id: toolId, name: 'bash', state: {} } },
			{ type: 'tool-result', toolResult: { id: toolId, is_error: isError, result } }
		]
	};
}

// ---------------------------------------------------------------------------
// Tests: text delta rendering
// ---------------------------------------------------------------------------

describe('OpenCodeAgentManager - text delta rendering', () => {
	it('renders new text on streaming update', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => {
				eventCallback = cb;
				return () => { };
			}),
		});

		const messages: OpenCodeMessage[] = [];
		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: vi.fn().mockImplementation(async () => messages),
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream, markdown } = makeResponseStream();

		// Start request (promise resolves when session.idle fires)
		const requestPromise = mgr.handleRequest({
			sessionId: 'sess-1',
			prompt: 'hello',
			token: makeToken(),
			responseStream: stream,
		});

		// Wait for subscribeToEvents to be called
		await vi.waitFor(() => expect(eventCallback).toBeDefined());

		// Simulate first streaming update
		messages.push(textMessage('msg-1', 'Hello '));
		await eventCallback!({ type: 'message.updated', properties: { sessionID: 'sess-1' } });

		// Simulate second update (appending more text)
		messages[0] = textMessage('msg-1', 'Hello world');
		await eventCallback!({ type: 'message.updated', properties: { sessionID: 'sess-1' } });

		// Fire idle to complete
		await eventCallback!({ type: 'session.idle', properties: { sessionID: 'sess-1' } });
		await requestPromise;

		// Should have rendered the initial chunk and only the delta, not the full text twice
		const combined = markdown.join('');
		expect(combined).toBe('Hello world');
	});

	it('does not duplicate text across multiple streaming events', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => { eventCallback = cb; return () => { }; }),
		});

		const messages: OpenCodeMessage[] = [textMessage('msg-1', 'Part A')];
		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: vi.fn().mockImplementation(async () => messages),
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream, markdown } = makeResponseStream();
		const requestPromise = mgr.handleRequest({ sessionId: 'sess-1', prompt: 'hi', token: makeToken(), responseStream: stream });

		await vi.waitFor(() => expect(eventCallback).toBeDefined());

		await eventCallback!({ type: 'message.updated', properties: { sessionID: 'sess-1' } });
		// same content again — no delta
		await eventCallback!({ type: 'message.updated', properties: { sessionID: 'sess-1' } });
		await eventCallback!({ type: 'session.idle', properties: { sessionID: 'sess-1' } });
		await requestPromise;

		expect(markdown.join('')).toBe('Part A');
	});
});

// ---------------------------------------------------------------------------
// Tests: tool invocation lifecycle
// ---------------------------------------------------------------------------

describe('OpenCodeAgentManager - tool invocation rendering', () => {
	it('emits ChatToolInvocationPart for tool-invocation parts', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => { eventCallback = cb; return () => { }; }),
		});

		const messages = [toolMessage('msg-1', 'tool-abc', 'read', { path: '/foo.ts' })];
		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: vi.fn().mockImplementation(async () => messages),
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream, pushed } = makeResponseStream();
		const requestPromise = mgr.handleRequest({ sessionId: 's', prompt: 'x', token: makeToken(), responseStream: stream });

		await vi.waitFor(() => expect(eventCallback).toBeDefined());
		await eventCallback!({ type: 'message.updated', properties: { sessionID: 's' } });
		await eventCallback!({ type: 'session.idle', properties: { sessionID: 's' } });
		await requestPromise;

		const invocationParts = pushed.filter((p: any) => p.toolName !== undefined);
		expect(invocationParts.length).toBeGreaterThan(0);
		expect((invocationParts[0] as any).toolName).toBe('read');
		expect((invocationParts[0] as any).toolCallId).toBe('tool-abc');
	});

	it('marks tool invocation as complete when tool-result arrives', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => { eventCallback = cb; return () => { }; }),
		});

		const messages = [toolResultMessage('msg-1', 'tool-xyz', false, 'success output')];
		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: vi.fn().mockImplementation(async () => messages),
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream, pushed } = makeResponseStream();
		const requestPromise = mgr.handleRequest({ sessionId: 's', prompt: 'x', token: makeToken(), responseStream: stream });

		await vi.waitFor(() => expect(eventCallback).toBeDefined());
		await eventCallback!({ type: 'session.idle', properties: { sessionID: 's' } });
		await requestPromise;

		// Find the final push of the invocation part (should be isComplete=true)
		const completedParts = pushed.filter((p: any) => p.isComplete === true);
		expect(completedParts.length).toBeGreaterThan(0);
		expect((completedParts[0] as any).isConfirmed).toBe(true);
		expect((completedParts[0] as any).isError).toBe(false);
	});

	it('marks tool invocation as error when tool-result is_error=true', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => { eventCallback = cb; return () => { }; }),
		});

		const messages = [toolResultMessage('msg-1', 'tool-err', true, 'something went wrong')];
		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: vi.fn().mockImplementation(async () => messages),
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream, pushed } = makeResponseStream();
		const requestPromise = mgr.handleRequest({ sessionId: 's', prompt: 'x', token: makeToken(), responseStream: stream });

		await vi.waitFor(() => expect(eventCallback).toBeDefined());
		await eventCallback!({ type: 'session.idle', properties: { sessionID: 's' } });
		await requestPromise;

		const errorParts = pushed.filter((p: any) => p.isError === true);
		expect(errorParts.length).toBeGreaterThan(0);
		expect((errorParts[0] as any).isConfirmed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: session.status idle completes the response
// ---------------------------------------------------------------------------

describe('OpenCodeAgentManager - session.status idle', () => {
	it('resolves when session.status has type=idle', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => { eventCallback = cb; return () => { }; }),
		});

		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: vi.fn().mockResolvedValue([textMessage('m1', 'done')]),
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream } = makeResponseStream();
		const requestPromise = mgr.handleRequest({ sessionId: 's', prompt: 'x', token: makeToken(), responseStream: stream });

		await vi.waitFor(() => expect(eventCallback).toBeDefined());
		await eventCallback!({ type: 'session.status', properties: { sessionID: 's', status: { type: 'idle' } } });
		await expect(requestPromise).resolves.toBeUndefined();
	});

	it('does not resolve for session.status with type=running', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => { eventCallback = cb; return () => { }; }),
		});

		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: vi.fn().mockResolvedValue([]),
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream } = makeResponseStream();
		let resolved = false;
		const requestPromise = mgr.handleRequest({ sessionId: 's', prompt: 'x', token: makeToken(), responseStream: stream })
			.then(() => { resolved = true; });

		await vi.waitFor(() => expect(eventCallback).toBeDefined());
		await eventCallback!({ type: 'session.status', properties: { sessionID: 's', status: { type: 'running' } } });

		await new Promise(r => setTimeout(r, 10));
		expect(resolved).toBe(false);

		// Clean up
		await eventCallback!({ type: 'session.idle', properties: { sessionID: 's' } });
		await requestPromise;
	});
});

// ---------------------------------------------------------------------------
// Tests: cancellation
// ---------------------------------------------------------------------------

describe('OpenCodeAgentManager - cancellation', () => {
	it('resolves cleanly on cancellation token', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		let cancelCb: (() => void) | undefined;

		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => { eventCallback = cb; return () => { }; }),
		});

		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: vi.fn().mockResolvedValue([]),
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream } = makeResponseStream();

		const token = {
			isCancellationRequested: false,
			onCancellationRequested: vi.fn().mockImplementation((cb: () => void) => {
				cancelCb = cb;
				return { dispose: () => { } };
			}),
		} as any;

		const requestPromise = mgr.handleRequest({ sessionId: 's', prompt: 'x', token, responseStream: stream });

		await vi.waitFor(() => expect(eventCallback).toBeDefined());
		await vi.waitFor(() => expect(cancelCb).toBeDefined());

		cancelCb!();
		// Should resolve without error (Aborted is caught internally)
		await expect(requestPromise).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: ignores events for other sessions
// ---------------------------------------------------------------------------

describe('OpenCodeAgentManager - session filtering', () => {
	it('ignores events for different session IDs', async () => {
		let eventCallback: ((e: unknown) => Promise<void>) | undefined;
		const sdk = makeSdkService({
			subscribeToEvents: vi.fn().mockImplementation(async (cb) => { eventCallback = cb; return () => { }; }),
		});

		const getMessages = vi.fn().mockResolvedValue([]);
		const sessionSvc = makeSessionService({
			sendMessage: vi.fn().mockResolvedValue({ status: 200 }),
			getSessionMessages: getMessages,
			invalidateSession: vi.fn(),
		});

		const mgr = makeManager(sdk, sessionSvc);
		const { stream } = makeResponseStream();
		const requestPromise = mgr.handleRequest({ sessionId: 'target-session', prompt: 'x', token: makeToken(), responseStream: stream });

		await vi.waitFor(() => expect(eventCallback).toBeDefined());

		// Fire event for a DIFFERENT session
		await eventCallback!({ type: 'message.updated', properties: { sessionID: 'other-session' } });

		// getSessionMessages should NOT have been called from the wrong event
		expect(getMessages).not.toHaveBeenCalled();

		// Properly close
		await eventCallback!({ type: 'session.idle', properties: { sessionID: 'target-session' } });
		await requestPromise;
	});
});
