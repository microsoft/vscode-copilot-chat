/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock `vscode` before any imports that pull it in.
// vi.mock is hoisted, so all classes must be defined inline in the factory.
// ---------------------------------------------------------------------------

// Both `vscode` and `vscodeTypes` must be mocked since vscodeTypes re-exports vscode classes.
// vi.mock is hoisted, so classes must be defined inline in the factory.

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
	const { MarkdownString, ChatResponseMarkdownPart, ChatToolInvocationPart, ChatRequestTurn2, ChatResponseTurn2, Uri } = makeVscodeClasses();
	return {
		MarkdownString, ChatResponseMarkdownPart, ChatToolInvocationPart, ChatRequestTurn2, ChatResponseTurn2, Uri,
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
	const { MarkdownString, ChatResponseMarkdownPart, ChatToolInvocationPart, ChatRequestTurn2, ChatResponseTurn2 } = makeVscodeClasses();
	return {
		ChatResponseMarkdownPart, ChatToolInvocationPart, ChatRequestTurn2, ChatResponseTurn2, MarkdownString,
		// stub everything else as no-ops
		Position: class { constructor(public l: number, public c: number) { } },
		Range: class { constructor(public s: unknown, public e: unknown) { } },
		Selection: class { },
		Uri: { from: (c: { scheme: string; path: string }) => c },
	};
});

// ---------------------------------------------------------------------------
// Import after mock
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { OpenCodeMessage } from '../../node/opencodeSessionService';
import { OpenCodeChatSessionContentProvider } from '../opencodeChatSessionContentProvider';

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
// Access private _buildChatHistory via casting
// ---------------------------------------------------------------------------

function buildHistory(messages: OpenCodeMessage[]) {
	const provider = Object.create(OpenCodeChatSessionContentProvider.prototype);
	return (provider as any)._buildChatHistory(messages);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Duck-type checkers since mocked classes aren't accessible by reference outside the factory
const isRequestTurn = (t: unknown): t is vscode.ChatRequestTurn2 => typeof (t as any).prompt === 'string';
const isResponseTurn = (t: unknown): t is vscode.ChatResponseTurn2 => Array.isArray((t as any).response);
const isMarkdownPart = (t: unknown) => typeof (t as any).value?.value === 'string';
const isToolPart = (t: unknown): t is vscode.ChatToolInvocationPart =>
	typeof (t as any).toolName === 'string' && typeof (t as any).toolCallId === 'string';

describe('OpenCodeChatSessionContentProvider._buildChatHistory', () => {
	describe('user messages', () => {
		it('creates ChatRequestTurn2 from a user text message', () => {
			const history = buildHistory([userMessage('u1', 'hello world')]);

			expect(history).toHaveLength(1);
			expect(isRequestTurn(history[0])).toBe(true);
			expect((history[0] as vscode.ChatRequestTurn2).prompt).toBe('hello world');
		});

		it('concatenates multiple text parts in a single user message', () => {
			const history = buildHistory([userMessageMultiPart('u1', ['foo ', 'bar'])]);

			expect(history).toHaveLength(1);
			expect((history[0] as vscode.ChatRequestTurn2).prompt).toBe('foo bar');
		});

		it('skips user messages with no text', () => {
			const msg: OpenCodeMessage = { id: 'u1', role: 'user', parts: [] };
			const history = buildHistory([msg]);
			expect(history).toHaveLength(0);
		});
	});

	describe('assistant messages', () => {
		it('creates ChatResponseTurn2 from an assistant text message', () => {
			const history = buildHistory([assistantTextMessage('a1', 'response text')]);

			expect(history).toHaveLength(1);
			expect(isResponseTurn(history[0])).toBe(true);
			const turn = history[0] as vscode.ChatResponseTurn2;
			expect(turn.response).toHaveLength(1);
			expect(isMarkdownPart(turn.response[0])).toBe(true);
			expect((turn.response[0] as any).value.value).toBe('response text');
		});

		it('includes tool-invocation parts as completed ChatToolInvocationPart', () => {
			const history = buildHistory([assistantWithTool('a1', 'tid-1', 'bash', 'some text')]);

			expect(history).toHaveLength(1);
			const turn = history[0] as vscode.ChatResponseTurn2;
			const toolPart = turn.response.find(isToolPart);
			expect(toolPart).toBeDefined();
			expect((toolPart as any).toolName).toBe('bash');
			expect((toolPart as any).toolCallId).toBe('tid-1');
			expect((toolPart as any).isComplete).toBe(true);
			expect((toolPart as any).isConfirmed).toBe(true);
		});

		it('skips assistant messages with no renderable parts', () => {
			const msg: OpenCodeMessage = { id: 'a1', role: 'assistant', parts: [{ type: 'tool-result', toolResult: { id: 'r1' } }] };
			const history = buildHistory([msg]);
			expect(history).toHaveLength(0);
		});
	});

	describe('mixed conversation', () => {
		it('preserves turn order across user and assistant messages', () => {
			const messages = [
				userMessage('u1', 'first question'),
				assistantTextMessage('a1', 'first answer'),
				userMessage('u2', 'follow-up'),
				assistantTextMessage('a2', 'second answer'),
			];
			const history = buildHistory(messages);

			expect(history).toHaveLength(4);
			expect(isRequestTurn(history[0])).toBe(true);
			expect(isResponseTurn(history[1])).toBe(true);
			expect(isRequestTurn(history[2])).toBe(true);
			expect(isResponseTurn(history[3])).toBe(true);
		});

		it('returns empty history for an empty message list', () => {
			expect(buildHistory([])).toHaveLength(0);
		});
	});
});
