/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	buildSessions,
	buildSubagentSession,
	extractSessionMetadata,
	extractSessionMetadataStreaming,
	parseSessionFileContent,
} from '../claudeSessionParser';
import { StoredMessage } from '../claudeSessionSchema';

describe('claudeSessionParser', () => {
	// ========================================================================
	// parseSessionFileContent
	// ========================================================================

	describe('parseSessionFileContent', () => {
		it('should parse empty content', () => {
			const result = parseSessionFileContent('');

			expect(result.messages.size).toBe(0);
			expect(result.summaries.size).toBe(0);
			expect(result.errors.length).toBe(0);
			expect(result.stats.totalLines).toBe(1);
			expect(result.stats.skippedEmpty).toBe(1);
		});

		it('should parse queue operation', () => {
			const content = '{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-31T00:34:50.025Z","sessionId":"6762c0b9-ee55-42cc-8998-180da7f37462"}';
			const result = parseSessionFileContent(content);

			expect(result.messages.size).toBe(0);
			expect(result.stats.queueOperations).toBe(1);
			expect(result.errors.length).toBe(0);
		});

		it('should parse user message', () => {
			const content = JSON.stringify({
				parentUuid: null,
				isSidechain: false,
				type: 'user',
				message: { role: 'user', content: 'Hello, Claude!' },
				uuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				timestamp: '2026-01-31T00:34:50.049Z',
				cwd: '/Users/test/project',
				version: '2.1.5',
				gitBranch: 'main',
				slug: 'test-session',
				userType: 'external',
			});

			const result = parseSessionFileContent(content);

			expect(result.messages.size).toBe(1);
			expect(result.stats.userMessages).toBe(1);
			expect(result.errors.length).toBe(0);

			const message = result.messages.get('8d4dcda5-3984-42c4-9b9e-d57f64a924dc');
			expect(message).toBeDefined();
			expect(message?.type).toBe('user');
			expect(message?.timestamp).toBeInstanceOf(Date);
		});

		it('should parse assistant message', () => {
			const content = JSON.stringify({
				parentUuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				isSidechain: false,
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello!' }],
					id: 'msg_123',
					model: 'claude-opus-4-5-20251101',
					stop_reason: 'end_turn',
					stop_sequence: null,
				},
				uuid: 'cc74a117-72ce-4ea6-8d01-4401e60ddfeb',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				timestamp: '2026-01-31T00:35:00.000Z',
			});

			const result = parseSessionFileContent(content);

			expect(result.messages.size).toBe(1);
			expect(result.stats.assistantMessages).toBe(1);
			expect(result.errors.length).toBe(0);
		});

		it('should parse assistant message with cache_creation: null in usage (newer SDK format)', () => {
			const content = JSON.stringify({
				parentUuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				isSidechain: false,
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello!' }],
					id: 'msg_123',
					model: 'claude-sonnet-4',
					type: 'message',
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 0,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
						output_tokens: 1,
						cache_creation: null,
					},
				},
				uuid: 'cc74a117-72ce-4ea6-8d01-4401e60ddfeb',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				timestamp: '2026-01-31T00:35:00.000Z',
			});

			const result = parseSessionFileContent(content);

			expect(result.messages.size).toBe(1);
			expect(result.stats.assistantMessages).toBe(1);
			expect(result.stats.chainLinks).toBe(0);
			expect(result.errors.length).toBe(0);

			const message = result.messages.get('cc74a117-72ce-4ea6-8d01-4401e60ddfeb');
			expect(message).toBeDefined();
			expect(message?.type).toBe('assistant');
		});

		it('should not misclassify assistant messages with null usage fields as chain links', () => {
			// Regression test: assistant messages with cache_creation: null were being
			// misclassified as chain links because vObj rejects null, causing the entire
			// assistant message validation to fail and fall through to vChainLinkEntry.
			const lines = [
				JSON.stringify({
					parentUuid: null,
					type: 'user',
					message: { role: 'user', content: 'Hello' },
					uuid: 'uuid-user-1',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:34:50.049Z',
				}),
				JSON.stringify({
					parentUuid: 'uuid-user-1',
					type: 'assistant',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Hi there!' }],
						id: 'msg_1',
						model: 'claude-sonnet-4',
						type: 'message',
						stop_reason: 'end_turn',
						stop_sequence: null,
						usage: {
							input_tokens: 100,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							output_tokens: 50,
							cache_creation: null,
						},
					},
					uuid: 'uuid-assistant-1',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:35:00.000Z',
				}),
			];

			const result = parseSessionFileContent(lines.join('\n'));

			expect(result.messages.size).toBe(2);
			expect(result.stats.userMessages).toBe(1);
			expect(result.stats.assistantMessages).toBe(1);
			expect(result.stats.chainLinks).toBe(0);
			expect(result.errors.length).toBe(0);

			// Verify the session can be built correctly
			const buildResult = buildSessions(result.messages, result.summaries, result.chainLinks);
			expect(buildResult.sessions.length).toBe(1);
			expect(buildResult.sessions[0].messages.length).toBe(2);
			expect(buildResult.sessions[0].messages[1].type).toBe('assistant');
		});

		it('should parse summary entry', () => {
			const content = JSON.stringify({
				type: 'summary',
				summary: 'Implementing dark mode',
				leafUuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
			});

			const result = parseSessionFileContent(content);

			expect(result.summaries.size).toBe(1);
			expect(result.stats.summaries).toBe(1);
			expect(result.summaries.get('8d4dcda5-3984-42c4-9b9e-d57f64a924dc')?.summary).toBe('Implementing dark mode');
		});

		it('should skip API error summaries', () => {
			const content = JSON.stringify({
				type: 'summary',
				summary: 'API error: 401 Unauthorized',
				leafUuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
			});

			const result = parseSessionFileContent(content);

			expect(result.summaries.size).toBe(0);
			expect(result.stats.summaries).toBe(1); // Still counted
		});

		it('should handle multiple lines', () => {
			const lines = [
				'{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-31T00:34:50.025Z","sessionId":"6762c0b9-ee55-42cc-8998-180da7f37462"}',
				JSON.stringify({
					parentUuid: null,
					type: 'user',
					message: { role: 'user', content: 'Hello' },
					uuid: 'uuid-1234-5678-9012-123456789abc',
					sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
					timestamp: '2026-01-31T00:34:50.049Z',
				}),
				JSON.stringify({
					parentUuid: 'uuid-1234-5678-9012-123456789abc',
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }], stop_reason: 'end_turn', stop_sequence: null },
					uuid: 'uuid-aaaa-bbbb-cccc-ddddeeeeeeee',
					sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
					timestamp: '2026-01-31T00:35:00.000Z',
				}),
			];

			const result = parseSessionFileContent(lines.join('\n'));

			expect(result.messages.size).toBe(2);
			expect(result.stats.userMessages).toBe(1);
			expect(result.stats.assistantMessages).toBe(1);
			expect(result.stats.queueOperations).toBe(1);
			expect(result.errors.length).toBe(0);
		});

		it('should handle invalid JSON gracefully', () => {
			const content = 'not valid json\n{"valid":"json"}';
			const result = parseSessionFileContent(content, 'test-file.jsonl');

			// Line 1 fails JSON.parse, Line 2 is valid JSON but doesn't match any schema
			expect(result.stats.errors).toBe(2);
			expect(result.errors.length).toBe(2);
			expect(result.errors[0].message).toContain('test-file.jsonl:1');
		});

		it('should skip empty lines', () => {
			const content = '\n\n{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-31T00:34:50.025Z","sessionId":"6762c0b9-ee55-42cc-8998-180da7f37462"}\n\n';
			const result = parseSessionFileContent(content);

			expect(result.stats.skippedEmpty).toBe(4);
			expect(result.stats.queueOperations).toBe(1);
			expect(result.errors.length).toBe(0);
		});
	});

	// ========================================================================
	// buildSessions
	// ========================================================================

	describe('buildSessions', () => {
		function createTestMessage(overrides: Partial<Omit<StoredMessage, 'type' | 'message'>> & {
			type?: 'user' | 'assistant';
			message?: StoredMessage['message'];
		} = {}): StoredMessage {
			const type = overrides.type ?? 'user';
			const message = overrides.message ?? (type === 'user'
				? { role: 'user' as const, content: 'Test' }
				: { role: 'assistant' as const, content: [] });

			return {
				uuid: 'test-uuid-1234-5678',
				sessionId: 'session-1234-5678',
				timestamp: new Date('2026-01-31T00:34:50Z'),
				parentUuid: null,
				type,
				message,
				...overrides,
			} as StoredMessage;
		}

		it('should build session from single message', () => {
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: null,
				})],
			]);

			const result = buildSessions(messages, new Map(), new Map());

			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].id).toBe('session-1');
			expect(result.sessions[0].messages.length).toBe(1);
		});

		it('should build session with message chain', () => {
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: null,
					timestamp: new Date('2026-01-31T00:01:00Z'),
				})],
				['msg-2', createTestMessage({
					uuid: 'msg-2',
					sessionId: 'session-1',
					parentUuid: 'msg-1',
					type: 'assistant',
					timestamp: new Date('2026-01-31T00:02:00Z'),
				})],
				['msg-3', createTestMessage({
					uuid: 'msg-3',
					sessionId: 'session-1',
					parentUuid: 'msg-2',
					timestamp: new Date('2026-01-31T00:03:00Z'),
				})],
			]);

			const result = buildSessions(messages, new Map(), new Map());

			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBe(3);
			expect(result.sessions[0].messages[0].uuid).toBe('msg-1');
			expect(result.sessions[0].messages[1].uuid).toBe('msg-2');
			expect(result.sessions[0].messages[2].uuid).toBe('msg-3');
		});

		it('should use summary for session label', () => {
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: null,
				})],
			]);

			const summaries = new Map([
				['msg-1', { type: 'summary' as const, summary: 'Testing dark mode', leafUuid: 'msg-1' }],
			]);

			const result = buildSessions(messages, summaries, new Map());

			expect(result.sessions[0].label).toBe('Testing dark mode');
		});

		it('should extract label from first user message if no summary', () => {
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: null,
					message: { role: 'user', content: 'Help me fix this bug' },
				})],
			]);

			const result = buildSessions(messages, new Map(), new Map());

			expect(result.sessions[0].label).toBe('Help me fix this bug');
		});

		it('should strip system reminders from label', () => {
			const content = '<system-reminder>Some context</system-reminder>\nActual question here';
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: null,
					message: { role: 'user', content },
				})],
			]);

			const result = buildSessions(messages, new Map(), new Map());

			expect(result.sessions[0].label).toBe('Actual question here');
		});

		it('should truncate long labels', () => {
			const longContent = 'A'.repeat(100);
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: null,
					message: { role: 'user', content: longContent },
				})],
			]);

			const result = buildSessions(messages, new Map(), new Map());

			expect(result.sessions[0].label.length).toBe(50);
			expect(result.sessions[0].label.endsWith('...')).toBe(true);
		});

		it('should deduplicate sessions by ID', () => {
			// Two leaf nodes for the same session (parallel branches)
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: null,
				})],
				['msg-2a', createTestMessage({
					uuid: 'msg-2a',
					sessionId: 'session-1',
					parentUuid: 'msg-1',
				})],
				['msg-2b', createTestMessage({
					uuid: 'msg-2b',
					sessionId: 'session-1',
					parentUuid: 'msg-1',
				})],
				['msg-3', createTestMessage({
					uuid: 'msg-3',
					sessionId: 'session-1',
					parentUuid: 'msg-2a',
				})],
			]);

			const result = buildSessions(messages, new Map(), new Map());

			// Should only have one session (the one with more messages)
			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBe(3); // msg-1 -> msg-2a -> msg-3
		});

		it('should resolve parent through chain links', () => {
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: null,
				})],
				['msg-3', createTestMessage({
					uuid: 'msg-3',
					sessionId: 'session-1',
					parentUuid: 'chain-link-1', // Points to chain link, not direct message
				})],
			]);

			const chainLinks = new Map<string, { uuid: string; parentUuid: string | null }>([
				['chain-link-1', { uuid: 'chain-link-1', parentUuid: 'msg-1' }],
			]);

			const result = buildSessions(messages, new Map(), chainLinks);

			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBe(2);
		});

		it('should handle cycle detection', () => {
			// Scenario: msg-3 points to msg-2, msg-2 points to msg-1, msg-1 points back to msg-2 (cycle)
			// msg-3 is the leaf (not referenced by anyone)
			const messages = new Map<string, StoredMessage>([
				['msg-1', createTestMessage({
					uuid: 'msg-1',
					sessionId: 'session-1',
					parentUuid: 'msg-2', // Circular reference back to msg-2
				})],
				['msg-2', createTestMessage({
					uuid: 'msg-2',
					sessionId: 'session-1',
					parentUuid: 'msg-1', // Points to msg-1
				})],
				['msg-3', createTestMessage({
					uuid: 'msg-3',
					sessionId: 'session-1',
					parentUuid: 'msg-2', // Points to msg-2 which is in a cycle
				})],
			]);

			const result = buildSessions(messages, new Map(), new Map());

			// Should not hang, should produce some output (msg-3 is the only leaf)
			expect(result.sessions.length).toBe(1);
			// Session should contain at least some messages (stops at cycle)
			expect(result.sessions[0].messages.length).toBeGreaterThan(0);
		});

		it('should include parallel tool result siblings in session', () => {
			// Simulates parallel tool calls: assistant sends 4 Task tool_use messages
			// as a linear chain, then tool results come back pointing to their respective
			// tool_use assistant messages. Only the last tool result is in the "main" chain;
			// the others branch off as siblings.
			//
			// Structure:
			//   user-1 -> asst-thinking -> asst-tool-1 -> asst-tool-2 -> asst-tool-3 -> asst-tool-4
			//                                 |               |               |               |
			//                              result-1        result-2        result-3        result-4
			//                                                                                 |
			//                                                                          asst-final -> asst-text
			const messages = new Map<string, StoredMessage>([
				['user-1', createTestMessage({
					uuid: 'user-1',
					sessionId: 'session-1',
					parentUuid: null,
					timestamp: new Date('2026-01-31T00:01:00Z'),
					message: { role: 'user', content: 'Run 4 tasks in parallel' },
				})],
				['asst-thinking', createTestMessage({
					uuid: 'asst-thinking',
					sessionId: 'session-1',
					parentUuid: 'user-1',
					type: 'assistant',
					timestamp: new Date('2026-01-31T00:02:00Z'),
				})],
				// 4 tool_use messages chained linearly
				['asst-tool-1', createTestMessage({
					uuid: 'asst-tool-1',
					sessionId: 'session-1',
					parentUuid: 'asst-thinking',
					type: 'assistant',
					timestamp: new Date('2026-01-31T00:03:00Z'),
				})],
				['asst-tool-2', createTestMessage({
					uuid: 'asst-tool-2',
					sessionId: 'session-1',
					parentUuid: 'asst-tool-1',
					type: 'assistant',
					timestamp: new Date('2026-01-31T00:03:01Z'),
				})],
				['asst-tool-3', createTestMessage({
					uuid: 'asst-tool-3',
					sessionId: 'session-1',
					parentUuid: 'asst-tool-2',
					type: 'assistant',
					timestamp: new Date('2026-01-31T00:03:02Z'),
				})],
				['asst-tool-4', createTestMessage({
					uuid: 'asst-tool-4',
					sessionId: 'session-1',
					parentUuid: 'asst-tool-3',
					type: 'assistant',
					timestamp: new Date('2026-01-31T00:03:03Z'),
				})],
				// Tool results - each points back to its tool_use assistant message
				['result-1', createTestMessage({
					uuid: 'result-1',
					sessionId: 'session-1',
					parentUuid: 'asst-tool-1',
					timestamp: new Date('2026-01-31T00:04:00Z'),
					message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Done 1' }] },
					toolUseResultAgentId: 'agent-1',
				})],
				['result-2', createTestMessage({
					uuid: 'result-2',
					sessionId: 'session-1',
					parentUuid: 'asst-tool-2',
					timestamp: new Date('2026-01-31T00:04:01Z'),
					message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'Done 2' }] },
					toolUseResultAgentId: 'agent-2',
				})],
				['result-3', createTestMessage({
					uuid: 'result-3',
					sessionId: 'session-1',
					parentUuid: 'asst-tool-3',
					timestamp: new Date('2026-01-31T00:04:02Z'),
					message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-3', content: 'Done 3' }] },
					toolUseResultAgentId: 'agent-3',
				})],
				['result-4', createTestMessage({
					uuid: 'result-4',
					sessionId: 'session-1',
					parentUuid: 'asst-tool-4',
					timestamp: new Date('2026-01-31T00:04:03Z'),
					message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-4', content: 'Done 4' }] },
					toolUseResultAgentId: 'agent-4',
				})],
				// Continuation after all tools complete - connected to last result
				['asst-final', createTestMessage({
					uuid: 'asst-final',
					sessionId: 'session-1',
					parentUuid: 'result-4',
					type: 'assistant',
					timestamp: new Date('2026-01-31T00:05:00Z'),
				})],
			]);

			const result = buildSessions(messages, new Map(), new Map());

			expect(result.sessions.length).toBe(1);
			const session = result.sessions[0];

			// The session should include ALL tool results, not just the last one
			const toolResultMessages = session.messages.filter(
				m => m.toolUseResultAgentId !== undefined
			);
			expect(toolResultMessages).toHaveLength(4);
			expect(toolResultMessages.map(m => m.toolUseResultAgentId).sort())
				.toEqual(['agent-1', 'agent-2', 'agent-3', 'agent-4']);

			// All 11 messages should be present (user + thinking + 4 tool_use + 4 results + final)
			expect(session.messages.length).toBe(11);
		});

		it('should parse parallel subagent fixture correctly', () => {
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', 'b3a7bd3c-5a10-4e7b-8ff0-7fc0cd6d1093.jsonl');
			const content = fs.readFileSync(fixturePath, 'utf8');
			const parseResult = parseSessionFileContent(content);

			const buildResult = buildSessions(parseResult.messages, parseResult.summaries, parseResult.chainLinks);

			expect(buildResult.sessions.length).toBe(1);
			const session = buildResult.sessions[0];

			// The fixture has 4 parallel tool calls (subagents a775a67, ae52dab, aa9d784, ac47f8c)
			// Each tool_result user message has a toolUseResultAgentId
			const toolResultMessages = session.messages.filter(
				m => m.toolUseResultAgentId !== undefined
			);
			expect(toolResultMessages).toHaveLength(4);

			const agentIds = toolResultMessages.map(m => m.toolUseResultAgentId).sort();
			expect(agentIds).toEqual(['a775a67', 'aa9d784', 'ac47f8c', 'ae52dab']);
		});
	});

	// #region buildSubagentSession

	describe('buildSubagentSession', () => {
		it('should build subagent session from messages', () => {
			const messages = new Map<string, StoredMessage>([
				['uuid-1', {
					uuid: 'uuid-1',
					sessionId: 'session-1',
					timestamp: new Date('2026-01-31T00:34:50.049Z'),
					parentUuid: null,
					type: 'user',
					message: { role: 'user', content: 'Task for subagent' },
					agentId: 'a139fcf',
				} as StoredMessage],
				['uuid-2', {
					uuid: 'uuid-2',
					sessionId: 'session-1',
					timestamp: new Date('2026-01-31T00:35:00.000Z'),
					parentUuid: 'uuid-1',
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
					agentId: 'a139fcf',
				} as StoredMessage],
			]);

			const subagent = buildSubagentSession('a139fcf', messages, new Map());

			expect(subagent).not.toBeNull();
			expect(subagent!.agentId).toBe('a139fcf');
			expect(subagent!.messages.length).toBe(2);
			expect(subagent!.messages[0].uuid).toBe('uuid-1');
			expect(subagent!.messages[1].uuid).toBe('uuid-2');
			expect(subagent!.timestamp).toEqual(new Date('2026-01-31T00:35:00.000Z'));
		});

		it('should return null for empty messages', () => {
			const subagent = buildSubagentSession('a139fcf', new Map(), new Map());

			expect(subagent).toBeNull();
		});

		it('should use chain links for parent resolution', () => {
			const messages = new Map<string, StoredMessage>([
				['uuid-2', {
					uuid: 'uuid-2',
					sessionId: 'session-1',
					timestamp: new Date('2026-01-31T00:35:00.000Z'),
					parentUuid: 'chain-1', // Points to chain link
					type: 'user',
					message: { role: 'user', content: 'Hello' },
				} as StoredMessage],
			]);

			const chainLinks = new Map([
				['chain-1', { uuid: 'chain-1', parentUuid: null }],
			]);

			const subagent = buildSubagentSession('test-agent', messages, chainLinks);

			expect(subagent).not.toBeNull();
			expect(subagent!.agentId).toBe('test-agent');
			expect(subagent!.messages.length).toBe(1);
		});

		it('should pick the chain with most messages when multiple leaf nodes exist', () => {
			// Two parallel branches: one with 3 messages, one with 1 message
			const messages = new Map<string, StoredMessage>([
				['uuid-1', {
					uuid: 'uuid-1',
					sessionId: 'session-1',
					timestamp: new Date('2026-01-31T00:34:00.000Z'),
					parentUuid: null,
					type: 'user',
					message: { role: 'user', content: 'Start' },
				} as StoredMessage],
				['uuid-2', {
					uuid: 'uuid-2',
					sessionId: 'session-1',
					timestamp: new Date('2026-01-31T00:35:00.000Z'),
					parentUuid: 'uuid-1',
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
				} as StoredMessage],
				['uuid-3', {
					uuid: 'uuid-3',
					sessionId: 'session-1',
					timestamp: new Date('2026-01-31T00:36:00.000Z'),
					parentUuid: 'uuid-2',
					type: 'user',
					message: { role: 'user', content: 'Follow-up' },
				} as StoredMessage],
				// Orphaned branch - parallel tool result that didn't continue
				['uuid-orphan', {
					uuid: 'uuid-orphan',
					sessionId: 'session-1',
					timestamp: new Date('2026-01-31T00:35:30.000Z'),
					parentUuid: 'uuid-1', // Also branches from uuid-1
					type: 'user',
					message: { role: 'user', content: 'Tool result' },
				} as StoredMessage],
			]);

			const subagent = buildSubagentSession('test-agent', messages, new Map());

			expect(subagent).not.toBeNull();
			expect(subagent!.messages.length).toBe(3); // Main chain, not the orphaned one
			expect(subagent!.messages[2].uuid).toBe('uuid-3');
		});
	});

	// #endregion

	// #region extractSessionMetadata

	describe('extractSessionMetadata', () => {
		it('should extract metadata from session with summary', () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"summary","summary":"Test session summary","leafUuid":"uuid-1"}'
			].join('\n');

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.id).toBe('session-1');
			expect(metadata!.label).toBe('Test session summary');
			expect(metadata!.firstMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
		});

		it('should extract label from first user message when no summary', () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"This is my first message"}}';

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('This is my first message');
		});

		it('should truncate long labels', () => {
			const longMessage = 'This is a very long message that should be truncated to 50 characters maximum for display purposes in the UI';
			const content = `{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"${longMessage}"}}`;

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label.length).toBeLessThanOrEqual(50);
			expect(metadata!.label).toBe('This is a very long message that should be trun...');
		});

		it('should skip API error summaries', () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"summary","summary":"API Error: Something went wrong","leafUuid":"uuid-1"}'
			].join('\n');

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('Hello'); // Falls back to user message content
		});

		it('should return null for empty content', () => {
			const metadata = extractSessionMetadata('', 'session-1', new Date());

			expect(metadata).toBeNull();
		});

		it('should handle content with array blocks', () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"Hello from array"}]}}';

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('Hello from array');
		});

		it('should strip system reminders from label', () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"<system-reminder>Some reminder</system-reminder>Actual message"}}';

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('Actual message');
		});

		it('should extract firstMessageTimestamp and lastMessageTimestamp from single message', () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}';

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.firstMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
			expect(metadata!.lastMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
		});

		it('should extract different firstMessageTimestamp and lastMessageTimestamp from multiple messages', () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"assistant","uuid":"uuid-2","sessionId":"session-1","timestamp":"2026-01-31T00:35:00.000Z","parentUuid":"uuid-1","message":{"role":"assistant","content":[]}}',
				'{"type":"user","uuid":"uuid-3","sessionId":"session-1","timestamp":"2026-01-31T00:36:00.000Z","parentUuid":"uuid-2","message":{"role":"user","content":"Follow up"}}',
				'{"type":"assistant","uuid":"uuid-4","sessionId":"session-1","timestamp":"2026-01-31T00:37:30.000Z","parentUuid":"uuid-3","message":{"role":"assistant","content":[]}}'
			].join('\n');

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.firstMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
			expect(metadata!.lastMessageTimestamp).toEqual(new Date('2026-01-31T00:37:30.000Z'));
		});

		it('should return null when only summary exists (no messages)', () => {
			const content = '{"type":"summary","summary":"Just a summary","leafUuid":"uuid-1"}';

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).toBeNull();
		});
	});

	// #endregion

	// #region extractSessionMetadataStreaming

	describe('extractSessionMetadataStreaming', () => {
		let tempDir: string;
		const tempFiles: string[] = [];

		// Helper to create temp files
		const createTempFile = (content: string): string => {
			if (!tempDir) {
				tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-test-'));
			}
			const filePath = path.join(tempDir, `session-${tempFiles.length}.jsonl`);
			fs.writeFileSync(filePath, content, 'utf8');
			tempFiles.push(filePath);
			return filePath;
		};

		afterAll(() => {
			// Cleanup temp directory and all files after all tests complete
			if (tempDir) {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore cleanup errors
				}
			}
		});

		it('should extract metadata from session with summary', async () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"summary","summary":"Test session summary","leafUuid":"uuid-1"}'
			].join('\n');
			const filePath = createTempFile(content);

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.id).toBe('session-1');
			expect(metadata!.label).toBe('Test session summary');
			expect(metadata!.firstMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
		});

		it('should extract label from first user message when no summary', async () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"This is my first message"}}';
			const filePath = createTempFile(content);

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('This is my first message');
		});

		it('should truncate long labels', async () => {
			const longMessage = 'This is a very long message that should be truncated to 50 characters maximum for display purposes in the UI';
			const content = `{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"${longMessage}"}}`;
			const filePath = createTempFile(content);

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label.length).toBeLessThanOrEqual(50);
			expect(metadata!.label).toBe('This is a very long message that should be trun...');
		});

		it('should skip API error summaries', async () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"summary","summary":"API Error: Something went wrong","leafUuid":"uuid-1"}'
			].join('\n');
			const filePath = createTempFile(content);

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('Hello');
		});

		it('should return null for empty content', async () => {
			const filePath = createTempFile('');

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date());

			expect(metadata).toBeNull();
		});

		it('should handle content with array blocks', async () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"Hello from array"}]}}';
			const filePath = createTempFile(content);

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('Hello from array');
		});

		it('should strip system reminders from label', async () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"<system-reminder>Some reminder</system-reminder>Actual message"}}';
			const filePath = createTempFile(content);

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('Actual message');
		});

		it('should extract firstMessageTimestamp and lastMessageTimestamp from single message', async () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}';
			const filePath = createTempFile(content);

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.firstMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
			expect(metadata!.lastMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
		});

		it('should extract different firstMessageTimestamp and lastMessageTimestamp from multiple messages', async () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"assistant","uuid":"uuid-2","sessionId":"session-1","timestamp":"2026-01-31T00:35:00.000Z","parentUuid":"uuid-1","message":{"role":"assistant","content":[]}}',
				'{"type":"user","uuid":"uuid-3","sessionId":"session-1","timestamp":"2026-01-31T00:36:00.000Z","parentUuid":"uuid-2","message":{"role":"user","content":"Follow up"}}',
				'{"type":"assistant","uuid":"uuid-4","sessionId":"session-1","timestamp":"2026-01-31T00:37:30.000Z","parentUuid":"uuid-3","message":{"role":"assistant","content":[]}}'
			].join('\n');
			const filePath = createTempFile(content);

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.firstMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
			expect(metadata!.lastMessageTimestamp).toEqual(new Date('2026-01-31T00:37:30.000Z'));
		});

		it('should read all messages to get lastMessageTimestamp', async () => {
			// Create a file where summary is early but last message timestamp is at the end
			const lines = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"summary","summary":"Test summary","leafUuid":"uuid-1"}',
			];
			// Add more messages - the last one should be captured
			for (let i = 0; i < 10; i++) {
				lines.push(`{"type":"assistant","uuid":"uuid-${i + 2}","sessionId":"session-1","timestamp":"2026-01-31T01:0${i}:00.000Z","parentUuid":"uuid-1","message":{"role":"assistant","content":[]}}`);
			}
			const filePath = createTempFile(lines.join('\n'));

			const metadata = await extractSessionMetadataStreaming(filePath, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.label).toBe('Test summary');
			expect(metadata!.firstMessageTimestamp).toEqual(new Date('2026-01-31T00:34:50.049Z'));
			// Last message is at index 9, so timestamp is 01:09:00
			expect(metadata!.lastMessageTimestamp).toEqual(new Date('2026-01-31T01:09:00.000Z'));
		});

		it('should handle cancellation via AbortSignal', async () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"summary","summary":"Test session summary","leafUuid":"uuid-1"}'
			].join('\n');
			const filePath = createTempFile(content);

			const abortController = new AbortController();
			abortController.abort();

			await expect(
				extractSessionMetadataStreaming(filePath, 'session-1', new Date(), abortController.signal)
			).rejects.toThrow('Operation cancelled');
		});

		it('should produce same results as sync version', async () => {
			const testCases = [
				// Summary with user message
				[
					'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
					'{"type":"summary","summary":"Test summary","leafUuid":"uuid-1"}'
				].join('\n'),
				// No summary, user message only
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Just a message"}}',
				// Summary only
				'{"type":"summary","summary":"Summary only session","leafUuid":"uuid-1"}',
				// Empty
				'',
			];

			for (const content of testCases) {
				const filePath = createTempFile(content);
				const fileMtime = new Date('2026-01-31T00:00:00.000Z');

				const syncResult = extractSessionMetadata(content, 'session-1', fileMtime);
				const streamResult = await extractSessionMetadataStreaming(filePath, 'session-1', fileMtime);

				expect(streamResult).toEqual(syncResult);
			}
		});
	});

	// #endregion

	// #region Metadata extraction consistency with full parsing

	describe('metadata extraction consistency', () => {
		/**
		 * This test ensures that the lightweight metadata extraction produces
		 * the same label and timestamp as the full parsing + session building path.
		 * If this test fails, the two code paths have diverged.
		 */
		it('should produce same label and timestamp as full parsing path', () => {
			const testCases = [
				// With summary
				[
					'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
					'{"type":"summary","summary":"Test summary label","leafUuid":"uuid-1"}'
				].join('\n'),
				// Without summary - label from first user message
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"My first message"}}',
				// With system reminder stripping
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"<system-reminder>context</system-reminder>Actual question"}}',
				// Long label truncation
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"This is a very long message that should be truncated to 50 characters maximum"}}',
				// Array content blocks
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"Array block content"}]}}',
			];

			const fileMtime = new Date('2026-01-31T00:00:00.000Z');

			for (const content of testCases) {
				// Lightweight extraction path
				const metadataResult = extractSessionMetadata(content, 'session-1', fileMtime);

				// Full parsing path
				const parseResult = parseSessionFileContent(content);
				const buildResult = buildSessions(parseResult.messages, parseResult.summaries, parseResult.chainLinks);

				// Both should produce results
				expect(metadataResult).not.toBeNull();
				expect(buildResult.sessions.length).toBe(1);

				const fullSession = buildResult.sessions[0];

				// Label and timestamps should match
				expect(metadataResult!.label).toBe(fullSession.label);
				expect(metadataResult!.firstMessageTimestamp).toEqual(fullSession.firstMessageTimestamp);
				expect(metadataResult!.lastMessageTimestamp).toEqual(fullSession.lastMessageTimestamp);
			}
		});

		it('should skip API error summaries consistently with full parsing', () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"summary","summary":"API error: 401 Unauthorized","leafUuid":"uuid-1"}'
			].join('\n');

			const fileMtime = new Date('2026-01-31T00:00:00.000Z');

			// Lightweight path
			const metadataResult = extractSessionMetadata(content, 'session-1', fileMtime);

			// Full path
			const parseResult = parseSessionFileContent(content);
			const buildResult = buildSessions(parseResult.messages, parseResult.summaries, parseResult.chainLinks);

			// Both should fall back to user message content (not use the API error summary)
			expect(metadataResult!.label).toBe('Hello');
			expect(buildResult.sessions[0].label).toBe('Hello');
		});
	});

	// #endregion
});
