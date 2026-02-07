/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { ChatRequestTurn, ChatResponseMarkdownPart, ChatResponseTurn2, ChatToolInvocationPart } from '../../../../vscodeTypes';
import { IClaudeCodeSession, StoredMessage } from '../../../agents/claude/node/sessionParser/claudeSessionSchema';
import { buildChatHistory } from '../chatHistoryBuilder';

// #region Test Helpers

let _msgCounter = 0;

function userMsg(content: string | Anthropic.Messages.ContentBlockParam[]): StoredMessage {
	const uuid = `user-${++_msgCounter}`;
	return {
		uuid,
		sessionId: 'test-session',
		timestamp: new Date(),
		parentUuid: null,
		type: 'user',
		message: { role: 'user' as const, content },
	} as StoredMessage;
}

function assistantMsg(content: readonly Record<string, unknown>[], model = 'claude-3-sonnet'): StoredMessage {
	const uuid = `asst-${++_msgCounter}`;
	return {
		uuid,
		sessionId: 'test-session',
		timestamp: new Date(),
		parentUuid: null,
		type: 'assistant',
		message: {
			id: uuid,
			type: 'message',
			role: 'assistant' as const,
			content,
			model,
			stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 10 },
		},
	} as StoredMessage;
}

function toolResult(toolUseId: string, content: string, isError = false): StoredMessage {
	return userMsg([{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]);
}

function session(messages: StoredMessage[]): IClaudeCodeSession {
	return {
		id: 'test-session',
		label: 'Test',
		messages,
		timestamp: new Date(),
		subagents: [],
	};
}

interface SnapshotRequest {
	type: 'request';
	prompt: string;
}

interface SnapshotResponse {
	type: 'response';
	parts: Array<Record<string, unknown>>;
}

type SnapshotTurn = SnapshotRequest | SnapshotResponse | { type: 'unknown' };

function getResponseParts(snapshot: SnapshotTurn[], index: number): Array<Record<string, unknown>> {
	const turn = snapshot[index];
	if (turn.type !== 'response') {
		throw new Error(`Expected response at index ${index}, got ${turn.type}`);
	}
	return turn.parts;
}

function mapHistoryForSnapshot(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[]): SnapshotTurn[] {
	return history.map(turn => {
		if (turn instanceof ChatRequestTurn) {
			return {
				type: 'request',
				prompt: turn.prompt,
			};
		} else if (turn instanceof ChatResponseTurn2) {
			return {
				type: 'response',
				parts: turn.response.map(part => {
					if (part instanceof ChatResponseMarkdownPart) {
						return {
							type: 'markdown',
							content: part.value.value,
						};
					} else if (part instanceof ChatToolInvocationPart) {
						return {
							type: 'tool',
							toolName: part.toolName,
							toolCallId: part.toolCallId,
							isError: part.isError,
							isComplete: part.isComplete,
						};
					}
					return { type: 'unknown' };
				}),
			};
		}
		return { type: 'unknown' };
	});
}

// #endregion

describe('buildChatHistory', () => {

	// #region Empty and Minimal Cases

	describe('empty and minimal cases', () => {
		it('returns empty array for session with no messages', () => {
			const result = buildChatHistory(session([]));
			expect(result).toEqual([]);
		});

		it('converts a single user message to a request turn', () => {
			const result = buildChatHistory(session([
				userMsg('Hello'),
			]));
			expect(mapHistoryForSnapshot(result)).toMatchInlineSnapshot(`
				[
				  {
				    "prompt": "Hello",
				    "type": "request",
				  },
				]
			`);
		});

		it('converts a single assistant text message to a response turn', () => {
			const result = buildChatHistory(session([
				assistantMsg([{ type: 'text', text: 'Hi there!' }]),
			]));
			expect(mapHistoryForSnapshot(result)).toMatchInlineSnapshot(`
				[
				  {
				    "parts": [
				      {
				        "content": "Hi there!",
				        "type": "markdown",
				      },
				    ],
				    "type": "response",
				  },
				]
			`);
		});
	});

	// #endregion

	// #region Simple Request/Response Pairs

	describe('simple request/response pairs', () => {
		it('converts a user message followed by an assistant text response', () => {
			const result = buildChatHistory(session([
				userMsg('What is 2+2?'),
				assistantMsg([{ type: 'text', text: 'The answer is 4.' }]),
			]));
			expect(mapHistoryForSnapshot(result)).toMatchInlineSnapshot(`
				[
				  {
				    "prompt": "What is 2+2?",
				    "type": "request",
				  },
				  {
				    "parts": [
				      {
				        "content": "The answer is 4.",
				        "type": "markdown",
				      },
				    ],
				    "type": "response",
				  },
				]
			`);
		});

		it('handles multiple conversation turns', () => {
			const result = buildChatHistory(session([
				userMsg('First question'),
				assistantMsg([{ type: 'text', text: 'First answer' }]),
				userMsg('Second question'),
				assistantMsg([{ type: 'text', text: 'Second answer' }]),
			]));
			expect(result).toHaveLength(4);
			expect(result[0]).toBeInstanceOf(ChatRequestTurn);
			expect(result[1]).toBeInstanceOf(ChatResponseTurn2);
			expect(result[2]).toBeInstanceOf(ChatRequestTurn);
			expect(result[3]).toBeInstanceOf(ChatResponseTurn2);
		});
	});

	// #endregion

	// #region Consecutive Message Grouping

	describe('consecutive message grouping', () => {
		it('combines consecutive user messages into a single request turn', () => {
			const result = buildChatHistory(session([
				userMsg('First part.'),
				userMsg('Second part.'),
				assistantMsg([{ type: 'text', text: 'Response' }]),
			]));
			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(2);
			expect(snapshot[0]).toEqual({
				type: 'request',
				prompt: 'First part.\n\nSecond part.',
			});
		});

		it('combines consecutive assistant messages into a single response turn', () => {
			const result = buildChatHistory(session([
				userMsg('Hello'),
				assistantMsg([{ type: 'text', text: 'Part one.' }]),
				assistantMsg([{ type: 'text', text: 'Part two.' }]),
			]));
			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(2);
			expect(snapshot[1]).toEqual({
				type: 'response',
				parts: [
					{ type: 'markdown', content: 'Part one.' },
					{ type: 'markdown', content: 'Part two.' },
				],
			});
		});
	});

	// #endregion

	// #region Single Tool Call

	describe('single tool call', () => {
		it('creates a tool invocation part for tool_use blocks', () => {
			const result = buildChatHistory(session([
				userMsg('List files'),
				assistantMsg([
					{ type: 'text', text: 'Let me check.' },
					{ type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'ls' } },
				]),
			]));
			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot[1]).toEqual({
				type: 'response',
				parts: [
					{ type: 'markdown', content: 'Let me check.' },
					{ type: 'tool', toolName: 'bash', toolCallId: 'tool-1', isError: false, isComplete: undefined },
				],
			});
		});

		it('marks tool invocations as complete when tool result follows', () => {
			const result = buildChatHistory(session([
				userMsg('List files'),
				assistantMsg([
					{ type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'ls' } },
				]),
				toolResult('tool-1', 'file1.txt\nfile2.txt'),
			]));
			const snapshot = mapHistoryForSnapshot(result);
			// Should be a single response with a completed tool
			expect(snapshot).toHaveLength(2);
			expect(snapshot[1]).toEqual({
				type: 'response',
				parts: [
					{ type: 'tool', toolName: 'bash', toolCallId: 'tool-1', isError: false, isComplete: true },
				],
			});
		});

		it('marks tool invocations as error when tool result is an error', () => {
			const result = buildChatHistory(session([
				userMsg('Run command'),
				assistantMsg([
					{ type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'bad-cmd' } },
				]),
				toolResult('tool-1', 'command not found', true),
			]));
			const snapshot = mapHistoryForSnapshot(result);
			expect(getResponseParts(snapshot, 1)[0]).toMatchObject({
				type: 'tool',
				isError: true,
				isComplete: true,
			});
		});
	});

	// #endregion

	// #region Multi-Round Tool Use (Core Bug Fix)

	describe('multi-round tool use merging', () => {
		it('merges assistant → tool_result → assistant into a single response', () => {
			const result = buildChatHistory(session([
				userMsg('Find and read config'),
				assistantMsg([
					{ type: 'text', text: 'Let me find it.' },
					{ type: 'tool_use', id: 'tool-1', name: 'Glob', input: { pattern: '**/config.*' } },
				]),
				toolResult('tool-1', 'config.json'),
				assistantMsg([
					{ type: 'text', text: 'Found it. Let me read it.' },
					{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'config.json' } },
				]),
				toolResult('tool-2', '{ "key": "value" }'),
				assistantMsg([
					{ type: 'text', text: 'Done.' },
				]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			// Must be exactly 1 request + 1 response
			expect(snapshot).toHaveLength(2);
			expect(snapshot[0].type).toBe('request');
			expect(snapshot[1].type).toBe('response');
			expect(getResponseParts(snapshot, 1)).toHaveLength(5);
		});

		it('merges many rounds of tool use into a single response', () => {
			const result = buildChatHistory(session([
				userMsg('Do complex task'),
				assistantMsg([{ type: 'tool_use', id: 't1', name: 'Glob', input: {} }]),
				toolResult('t1', 'result1'),
				assistantMsg([{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
				toolResult('t2', 'result2'),
				assistantMsg([{ type: 'tool_use', id: 't3', name: 'Grep', input: {} }]),
				toolResult('t3', 'result3'),
				assistantMsg([{ type: 'tool_use', id: 't4', name: 'bash', input: {} }]),
				toolResult('t4', 'result4'),
				assistantMsg([{ type: 'text', text: 'All done.' }]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(2);
			expect(getResponseParts(snapshot, 1)).toHaveLength(5); // 4 tools + 1 text
			expect(getResponseParts(snapshot, 1)[0]).toMatchObject({ type: 'tool', isComplete: true });
			expect(getResponseParts(snapshot, 1)[1]).toMatchObject({ type: 'tool', isComplete: true });
			expect(getResponseParts(snapshot, 1)[2]).toMatchObject({ type: 'tool', isComplete: true });
			expect(getResponseParts(snapshot, 1)[3]).toMatchObject({ type: 'tool', isComplete: true });
			expect(getResponseParts(snapshot, 1)[4]).toMatchObject({ type: 'markdown', content: 'All done.' });
		});

		it('correctly separates two user requests each with their own tool loops', () => {
			const result = buildChatHistory(session([
				// First user request with tool loop
				userMsg('First task'),
				assistantMsg([{ type: 'tool_use', id: 't1', name: 'Glob', input: {} }]),
				toolResult('t1', 'found'),
				assistantMsg([{ type: 'text', text: 'Done with first.' }]),
				// Second user request with tool loop
				userMsg('Second task'),
				assistantMsg([{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
				toolResult('t2', 'content'),
				assistantMsg([{ type: 'text', text: 'Done with second.' }]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(4); // req, resp, req, resp
			expect(snapshot[0]).toMatchObject({ type: 'request', prompt: 'First task' });
			expect(snapshot[1]).toMatchObject({ type: 'response' });
			expect(getResponseParts(snapshot, 1)).toHaveLength(2); // tool + text
			expect(snapshot[2]).toMatchObject({ type: 'request', prompt: 'Second task' });
			expect(snapshot[3]).toMatchObject({ type: 'response' });
			expect(getResponseParts(snapshot, 3)).toHaveLength(2); // tool + text
		});

		it('handles parallel tool calls in a single assistant message', () => {
			const result = buildChatHistory(session([
				userMsg('Search broadly'),
				assistantMsg([
					{ type: 'text', text: 'Searching...' },
					{ type: 'tool_use', id: 't1', name: 'Glob', input: {} },
					{ type: 'tool_use', id: 't2', name: 'Grep', input: {} },
				]),
				// Both tool results come in the same user message
				userMsg([
					{ type: 'tool_result', tool_use_id: 't1', content: 'glob result' },
					{ type: 'tool_result', tool_use_id: 't2', content: 'grep result' },
				]),
				assistantMsg([{ type: 'text', text: 'Found everything.' }]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(2);
			expect(getResponseParts(snapshot, 1)).toHaveLength(4); // text + 2 tools + text
			expect(getResponseParts(snapshot, 1)[1]).toMatchObject({ type: 'tool', isComplete: true });
			expect(getResponseParts(snapshot, 1)[2]).toMatchObject({ type: 'tool', isComplete: true });
		});

		it('handles tool results that arrive in separate user messages', () => {
			const result = buildChatHistory(session([
				userMsg('Do thing'),
				assistantMsg([
					{ type: 'tool_use', id: 't1', name: 'Glob', input: {} },
					{ type: 'tool_use', id: 't2', name: 'Grep', input: {} },
				]),
				// Each tool result as a separate user message (both should be merged)
				toolResult('t1', 'glob result'),
				toolResult('t2', 'grep result'),
				assistantMsg([{ type: 'text', text: 'Done.' }]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(2);
			expect(getResponseParts(snapshot, 1)[0]).toMatchObject({ type: 'tool', isComplete: true });
			expect(getResponseParts(snapshot, 1)[1]).toMatchObject({ type: 'tool', isComplete: true });
		});
	});

	// #endregion

	// #region System Reminder Filtering

	describe('system reminder filtering', () => {
		it('filters out system-reminder blocks from user messages', () => {
			const result = buildChatHistory(session([
				userMsg([
					{ type: 'text', text: '<system-reminder>\nInternal context.\n</system-reminder>' },
					{ type: 'text', text: 'What does this do?' },
				]),
			]));
			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]).toMatchObject({ type: 'request', prompt: 'What does this do?' });
		});

		it('strips system-reminders from legacy string format', () => {
			const result = buildChatHistory(session([
				userMsg('<system-reminder>\nInternal.\n</system-reminder>\n\nActual question'),
			]));
			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot[0]).toMatchObject({ type: 'request', prompt: 'Actual question' });
		});

		it('produces no request turn when user message is only a system-reminder', () => {
			const result = buildChatHistory(session([
				userMsg([
					{ type: 'text', text: '<system-reminder>\nInternal.\n</system-reminder>' },
				]),
				assistantMsg([{ type: 'text', text: 'Hello!' }]),
			]));
			const snapshot = mapHistoryForSnapshot(result);
			// Only the assistant response should appear
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]).toMatchObject({ type: 'response' });
		});

		it('filters system-reminder user messages mid-tool-loop without breaking the response', () => {
			const result = buildChatHistory(session([
				userMsg('Do task'),
				assistantMsg([
					{ type: 'tool_use', id: 't1', name: 'bash', input: {} },
				]),
				// Tool result + system reminder in the same user message group
				userMsg([
					{ type: 'tool_result', tool_use_id: 't1', content: 'done' },
				]),
				userMsg([
					{ type: 'text', text: '<system-reminder>\nReminder.\n</system-reminder>' },
				]),
				assistantMsg([{ type: 'text', text: 'Finished.' }]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			// System-reminder-only user messages should not break the response
			expect(snapshot).toHaveLength(2);
			expect(snapshot[0]).toMatchObject({ type: 'request', prompt: 'Do task' });
			expect(getResponseParts(snapshot, 1)).toHaveLength(2); // tool + text
		});
	});

	// #endregion

	// #region Interrupted Requests

	describe('interrupted requests', () => {
		it('skips user messages that are interruption markers', () => {
			const result = buildChatHistory(session([
				userMsg('Do something'),
				assistantMsg([
					{ type: 'tool_use', id: 't1', name: 'bash', input: {} },
				]),
				toolResult('t1', 'partial'),
				assistantMsg([{ type: 'text', text: 'Working...' }]),
				userMsg('[Request interrupted by user]'),
				assistantMsg([{ type: 'text', text: 'Stopped.' }]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			// The interruption marker should not create a request turn
			// The "Stopped." response merges into a new response (since the interrupted
			// user message broke the assistant grouping but produced no request turn)
			expect(snapshot.filter(s => s.type === 'request')).toHaveLength(1);
		});
	});

	// #endregion

	// #region Thinking Blocks

	describe('thinking blocks', () => {
		it('includes thinking blocks in response parts', () => {
			const result = buildChatHistory(session([
				userMsg('Think about this'),
				assistantMsg([
					{ type: 'thinking', thinking: 'Let me reason...' },
					{ type: 'text', text: 'Here is my answer.' },
				]),
			]));

			// Thinking block + text = 2 parts
			expect(result).toHaveLength(2);
			const response = result[1] as vscode.ChatResponseTurn2;
			expect(response.response).toHaveLength(2);
		});

		it('preserves thinking blocks across multi-round tool use', () => {
			const result = buildChatHistory(session([
				userMsg('Complex task'),
				assistantMsg([
					{ type: 'thinking', thinking: 'First thinking...' },
					{ type: 'tool_use', id: 't1', name: 'Glob', input: {} },
				]),
				toolResult('t1', 'found'),
				assistantMsg([
					{ type: 'thinking', thinking: 'Second thinking...' },
					{ type: 'text', text: 'Done.' },
				]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(2); // 1 request, 1 merged response
		});
	});

	// #endregion

	// #region Edge Cases

	describe('edge cases', () => {
		it('handles tool_use without a corresponding tool_result', () => {
			const result = buildChatHistory(session([
				userMsg('Start'),
				assistantMsg([
					{ type: 'tool_use', id: 't1', name: 'bash', input: {} },
				]),
				// No tool result - session may have been interrupted
			]));

			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(2);
			expect(getResponseParts(snapshot, 1)[0]).toMatchObject({
				type: 'tool',
				isComplete: undefined, // Not completed since no result arrived
			});
		});

		it('handles user message with mixed text and tool_result content', () => {
			const result = buildChatHistory(session([
				userMsg([
					{ type: 'text', text: 'Here is context: ' },
					{ type: 'tool_result', tool_use_id: 'orphan', content: 'result', is_error: false },
				]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			// The text should become a request; the tool_result is processed (but orphaned)
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]).toMatchObject({ type: 'request', prompt: 'Here is context: ' });
		});

		it('handles session starting with assistant message (no preceding user message)', () => {
			const result = buildChatHistory(session([
				assistantMsg([{ type: 'text', text: 'I was already running.' }]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]).toMatchObject({ type: 'response' });
		});

		it('handles tool_result for a tool_use_id that does not exist', () => {
			const result = buildChatHistory(session([
				userMsg('Start'),
				assistantMsg([{ type: 'text', text: 'Response' }]),
				toolResult('nonexistent-id', 'result'),
			]));

			// Should not throw, the orphaned tool result is just ignored
			const snapshot = mapHistoryForSnapshot(result);
			expect(snapshot).toHaveLength(2);
		});

		it('handles empty assistant content blocks', () => {
			const result = buildChatHistory(session([
				userMsg('Hello'),
				assistantMsg([]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			// Empty content produces no parts, so no response turn is created.
			// Only the request turn from the user message exists.
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]).toMatchObject({ type: 'request' });
		});

		it('handles whitespace-only user messages', () => {
			const result = buildChatHistory(session([
				userMsg('   \n\t  '),
				assistantMsg([{ type: 'text', text: 'Response' }]),
			]));

			const snapshot = mapHistoryForSnapshot(result);
			// Whitespace-only should not create a request turn
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]).toMatchObject({ type: 'response' });
		});
	});

	// #endregion

	// #region Real Fixture

	describe('real fixture', () => {
		it('converts real JSONL fixture with tool invocation flow', async () => {
			// This test loads a real Claude Code session fixture and verifies
			// the full conversion pipeline produces the expected output
			const fixturePath = path.join(__dirname, 'fixtures', '4c289ca8-f8bb-4588-8400-88b78beb784d.jsonl');
			const fixtureContent = await readFile(fixturePath, 'utf8');

			// Parse JSONL manually for this standalone test
			const lines = fixtureContent.split('\n').filter(l => l.trim());
			const messages: StoredMessage[] = [];
			for (const line of lines) {
				const entry = JSON.parse(line);
				if (entry.type === 'user' || entry.type === 'assistant') {
					messages.push({
						uuid: entry.uuid ?? `msg-${messages.length}`,
						sessionId: entry.sessionId ?? 'fixture',
						timestamp: new Date(entry.timestamp ?? Date.now()),
						parentUuid: entry.parentUuid ?? null,
						type: entry.type,
						message: entry.message,
					});
				}
			}

			if (messages.length === 0) {
				return; // No messages parsed, skip
			}

			const testSession: IClaudeCodeSession = {
				id: 'fixture-session',
				label: 'Fixture Test',
				messages,
				timestamp: new Date(),
				subagents: [],
			};

			const result = buildChatHistory(testSession);

			// Verify basic structural properties
			const requests = result.filter(t => t instanceof ChatRequestTurn);
			const responses = result.filter(t => t instanceof ChatResponseTurn2);

			// Every request should be followed by a response (allowing leading responses)
			expect(requests.length).toBeGreaterThan(0);
			expect(responses.length).toBeGreaterThan(0);

			// No two consecutive request turns should exist
			for (let i = 0; i < result.length - 1; i++) {
				if (result[i] instanceof ChatRequestTurn) {
					expect(result[i + 1]).toBeInstanceOf(ChatResponseTurn2);
				}
			}
		});
	});

	// #endregion
});
