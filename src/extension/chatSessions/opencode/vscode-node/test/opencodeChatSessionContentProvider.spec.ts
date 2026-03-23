/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock `vscode` and `vscodeTypes` before any imports.
// vi.mock is hoisted, so all class definitions must be inside the factory.
// ---------------------------------------------------------------------------

function makeVscodeClasses() {
	class MarkdownString { constructor(public readonly value: string) { } }
	class ChatResponseMarkdownPart {
		readonly type = 'markdownContent';
		constructor(public readonly value: MarkdownString) { }
	}
	class ChatToolInvocationPart {
		isComplete?: boolean; isConfirmed?: boolean; isError?: boolean;
		constructor(public readonly toolName: string, public readonly toolCallId: string) { }
	}
	class ChatRequestTurn2 {
		constructor(
			public readonly prompt: string,
			public readonly command: string | undefined,
			public readonly references: unknown[],
			public readonly participant: string,
			public readonly toolReferences: unknown[],
			_a?: unknown, _b?: unknown, _c?: unknown,
		) { }
	}
	class ChatResponseTurn2 {
		constructor(
			public readonly response: unknown[],
			public readonly result: object,
			public readonly participant: string,
		) { }
	}
	class Uri {
		static from(c: { scheme: string; path: string }) { return new Uri(c.scheme, c.path); }
		constructor(public readonly scheme: string, public readonly path: string) { }
		toString() { return `${this.scheme}:${this.path}`; }
	}
	return { MarkdownString, ChatResponseMarkdownPart, ChatToolInvocationPart, ChatRequestTurn2, ChatResponseTurn2, Uri };
}

vi.mock('vscode', () => {
	const cls = makeVscodeClasses();
	return {
		...cls,
		ThemeIcon: class { constructor(public readonly id: string) { } },
		Emitter: class {
			readonly event = () => ({ dispose: () => { } });
			fire() { } dispose() { }
		},
		l10n: { t: (s: string, ...args: string[]) => args.reduce((acc: string, a: string, i: number) => acc.replace(`{${i}}`, a), s) },
		chat: { createChatSessionItemController: vi.fn(() => ({ items: { replace: vi.fn() }, dispose: vi.fn() })) },
	};
});

vi.mock('../../../../../vscodeTypes', () => {
	const cls = makeVscodeClasses();
	return {
		...cls,
		Position: class { constructor(public l: number, public c: number) { } },
		Range: class { constructor(public s: unknown, public e: unknown) { } },
		Selection: class { },
	};
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { OpenCodeMessage } from '../../node/opencodeSessionService';
import { OpenCodeChatSessionContentProvider } from '../opencodeChatSessionContentProvider';
import { IOpenCodeSessionService } from '../../node/opencodeSessionService';
import { IOpenCodeSdkService } from '../../node/opencodeSdkService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { OpenCodeAgentManager } from '../../node/opencodeAgentManager';
import { OpenCodeSessionUri } from '../../common/opencodeSessionUri';

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

function makeAgentManager(): OpenCodeAgentManager {
	return { handleRequest: vi.fn().mockResolvedValue(undefined) } as any;
}

function makeSdkService(): IOpenCodeSdkService {
	return { ensureServer: vi.fn().mockResolvedValue('http://127.0.0.1:1234') } as any;
}

function makeSessionService(messages: OpenCodeMessage[] = []): IOpenCodeSessionService {
	return {
		getSessionMessages: vi.fn().mockResolvedValue(messages),
		listSessions: vi.fn().mockResolvedValue([]),
		createSession: vi.fn(),
		getSession: vi.fn(),
		sendMessage: vi.fn(),
		deleteSession: vi.fn(),
		invalidateSession: vi.fn(),
	} as unknown as IOpenCodeSessionService;
}

function makeCancellationToken(cancelled = false) {
	return { isCancellationRequested: cancelled } as any;
}

const TEST_SESSION_URI = OpenCodeSessionUri.forSessionId('test-session');

function makeProvider(messages: OpenCodeMessage[] = []) {
	const log = makeLogService();
	const sdk = makeSdkService();
	const session = makeSessionService(messages);
	const agentMgr = makeAgentManager();
	// Construct directly — DI decorators are metadata-only
	const provider = new OpenCodeChatSessionContentProvider(agentMgr as any, session as any, sdk as any, log as any);
	return { provider, session, sdk, agentMgr, log };
}

// ---------------------------------------------------------------------------
// Duck-type checkers (mocked classes aren't accessible by reference outside factory)
// ---------------------------------------------------------------------------

const isRequestTurn = (t: unknown): t is vscode.ChatRequestTurn2 =>
	typeof (t as any).prompt === 'string';
const isResponseTurn = (t: unknown): t is vscode.ChatResponseTurn2 =>
	Array.isArray((t as any).response);
const isMarkdownPart = (t: unknown) =>
	typeof (t as any).value?.value === 'string';
const isToolPart = (t: unknown) =>
	typeof (t as any).toolName === 'string' && typeof (t as any).toolCallId === 'string';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMessage(id: string, text: string): OpenCodeMessage {
	return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function userMessageMultiPart(id: string, parts: string[]): OpenCodeMessage {
	return { id, role: 'user', parts: parts.map(t => ({ type: 'text' as const, text: t })) };
}

function assistantTextMessage(id: string, text: string): OpenCodeMessage {
	return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

function assistantWithTool(id: string, toolId: string, toolName: string, text?: string): OpenCodeMessage {
	const parts: OpenCodeMessage['parts'] = [];
	if (text) { parts.push({ type: 'text', text }); }
	parts.push({ type: 'tool-invocation', toolInvocation: { id: toolId, name: toolName, state: {} } });
	return { id, role: 'assistant', parts };
}

// ---------------------------------------------------------------------------
// Tests via provideChatSessionContent (public API)
// ---------------------------------------------------------------------------

describe('OpenCodeChatSessionContentProvider.provideChatSessionContent', () => {
	describe('user messages', () => {
		it('creates ChatRequestTurn2 from a user text message', async () => {
			const { provider } = makeProvider([userMessage('u1', 'hello world')]);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken());

			expect(session.history).toHaveLength(1);
			expect(isRequestTurn(session.history[0])).toBe(true);
			expect((session.history[0] as vscode.ChatRequestTurn2).prompt).toBe('hello world');
		});

		it('concatenates multiple text parts in a single user message', async () => {
			const { provider } = makeProvider([userMessageMultiPart('u1', ['foo ', 'bar'])]);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken());

			expect(session.history).toHaveLength(1);
			expect((session.history[0] as vscode.ChatRequestTurn2).prompt).toBe('foo bar');
		});

		it('skips user messages with no text', async () => {
			const msg: OpenCodeMessage = { id: 'u1', role: 'user', parts: [] };
			const { provider } = makeProvider([msg]);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken());
			expect(session.history).toHaveLength(0);
		});
	});

	describe('assistant messages', () => {
		it('creates ChatResponseTurn2 from an assistant text message', async () => {
			const { provider } = makeProvider([assistantTextMessage('a1', 'response text')]);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken());

			expect(session.history).toHaveLength(1);
			expect(isResponseTurn(session.history[0])).toBe(true);
			const turn = session.history[0] as vscode.ChatResponseTurn2;
			expect(turn.response).toHaveLength(1);
			expect(isMarkdownPart(turn.response[0])).toBe(true);
			expect((turn.response[0] as any).value.value).toBe('response text');
		});

		it('includes tool-invocation parts as completed ChatToolInvocationPart', async () => {
			const { provider } = makeProvider([assistantWithTool('a1', 'tid-1', 'bash', 'some text')]);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken());

			expect(session.history).toHaveLength(1);
			const turn = session.history[0] as vscode.ChatResponseTurn2;
			const toolPart = turn.response.find(isToolPart);
			expect(toolPart).toBeDefined();
			expect((toolPart as any).toolName).toBe('bash');
			expect((toolPart as any).toolCallId).toBe('tid-1');
			expect((toolPart as any).isComplete).toBe(true);
			expect((toolPart as any).isConfirmed).toBe(true);
		});

		it('skips assistant messages with no renderable parts', async () => {
			const msg: OpenCodeMessage = { id: 'a1', role: 'assistant', parts: [{ type: 'tool-result', toolResult: { id: 'r1' } }] };
			const { provider } = makeProvider([msg]);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken());
			expect(session.history).toHaveLength(0);
		});
	});

	describe('mixed conversation', () => {
		it('preserves turn order across user and assistant messages', async () => {
			const messages = [
				userMessage('u1', 'first question'),
				assistantTextMessage('a1', 'first answer'),
				userMessage('u2', 'follow-up'),
				assistantTextMessage('a2', 'second answer'),
			];
			const { provider } = makeProvider(messages);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken());

			expect(session.history).toHaveLength(4);
			expect(isRequestTurn(session.history[0])).toBe(true);
			expect(isResponseTurn(session.history[1])).toBe(true);
			expect(isRequestTurn(session.history[2])).toBe(true);
			expect(isResponseTurn(session.history[3])).toBe(true);
		});

		it('returns empty history for an empty message list', async () => {
			const { provider } = makeProvider([]);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken());
			expect(session.history).toHaveLength(0);
		});
	});

	describe('cancellation', () => {
		it('returns empty history when token is already cancelled', async () => {
			const { provider } = makeProvider([userMessage('u1', 'hi')]);
			const session = await provider.provideChatSessionContent(TEST_SESSION_URI, makeCancellationToken(true));
			expect(session.history).toHaveLength(0);
		});
	});
});
