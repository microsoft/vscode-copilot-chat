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
	LinkedListParseResult,
	parseSessionFileContent,
} from '../claudeSessionParser';
import { ChainNode, isUserRequest, SummaryEntry } from '../claudeSessionSchema';

// #region Test Helpers

/**
 * Build a LinkedListParseResult from raw entry objects.
 * Convenience helper for unit tests that need to construct chain nodes directly.
 */
function buildParseResult(
	entries: Record<string, unknown>[],
	summaries?: Map<string, SummaryEntry>
): LinkedListParseResult {
	const nodes = new Map<string, ChainNode>();
	for (let i = 0; i < entries.length; i++) {
		const raw = entries[i];
		if (typeof raw.uuid === 'string') {
			const logicalParentUuid = typeof raw.logicalParentUuid === 'string' ? raw.logicalParentUuid : null;
			const parentUuid = typeof raw.parentUuid === 'string' ? raw.parentUuid : null;
			nodes.set(raw.uuid, {
				uuid: raw.uuid,
				parentUuid: logicalParentUuid ?? parentUuid,
				raw,
				lineNumber: i + 1,
			});
		}
	}
	return {
		nodes,
		summaries: summaries ?? new Map(),
		errors: [],
		stats: {
			totalLines: entries.length,
			chainNodes: nodes.size,
			summaries: summaries?.size ?? 0,
			queueOperations: 0,
			errors: 0,
			skippedEmpty: 0,
		},
	};
}

/** Minimal user message entry for tests */
function userEntry(uuid: string, parentUuid: string | null, content: string | unknown[] = 'Test', overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 'user',
		uuid,
		parentUuid,
		sessionId: 'session-1',
		timestamp: '2026-01-31T00:34:50.049Z',
		message: { role: 'user', content },
		...overrides,
	};
}

/** Minimal assistant message entry for tests */
function assistantEntry(uuid: string, parentUuid: string | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 'assistant',
		uuid,
		parentUuid,
		sessionId: 'session-1',
		timestamp: '2026-01-31T00:35:00.000Z',
		message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }], stop_reason: 'end_turn', stop_sequence: null },
		...overrides,
	};
}

// #endregion

describe('claudeSessionParser', () => {
	// ========================================================================
	// parseSessionFileContent (Layer 2)
	// ========================================================================

	describe('parseSessionFileContent', () => {
		it('should parse empty content', () => {
			const result = parseSessionFileContent('');

			expect(result.nodes.size).toBe(0);
			expect(result.summaries.size).toBe(0);
			expect(result.errors.length).toBe(0);
			expect(result.stats.totalLines).toBe(1);
			expect(result.stats.skippedEmpty).toBe(1);
		});

		it('should parse queue operation (no uuid, skipped)', () => {
			const content = '{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-31T00:34:50.025Z","sessionId":"6762c0b9-ee55-42cc-8998-180da7f37462"}';
			const result = parseSessionFileContent(content);

			expect(result.nodes.size).toBe(0);
			expect(result.stats.queueOperations).toBe(1);
			expect(result.errors.length).toBe(0);
		});

		it('should parse user message as chain node', () => {
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

			expect(result.nodes.size).toBe(1);
			expect(result.stats.chainNodes).toBe(1);
			expect(result.errors.length).toBe(0);

			const node = result.nodes.get('8d4dcda5-3984-42c4-9b9e-d57f64a924dc');
			expect(node).toBeDefined();
			expect(node?.raw.type).toBe('user');
			expect(node?.parentUuid).toBeNull();
		});

		it('should parse assistant message as chain node', () => {
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

			expect(result.nodes.size).toBe(1);
			expect(result.stats.chainNodes).toBe(1);
			expect(result.errors.length).toBe(0);
		});

		it('should parse assistant message with cache_creation: null in usage', () => {
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

			expect(result.nodes.size).toBe(1);
			expect(result.stats.chainNodes).toBe(1);
			expect(result.errors.length).toBe(0);
		});

		it('should parse compact boundary using logicalParentUuid', () => {
			const content = JSON.stringify({
				type: 'system',
				subtype: 'compact_boundary',
				uuid: 'compact-uuid',
				parentUuid: null,
				logicalParentUuid: 'pre-compact-uuid',
				isSidechain: false,
				content: 'Conversation compacted',
				timestamp: '2026-02-09T06:49:50.112Z',
			});

			const result = parseSessionFileContent(content);

			expect(result.stats.chainNodes).toBe(1);
			expect(result.errors.length).toBe(0);
			const node = result.nodes.get('compact-uuid');
			expect(node).toBeDefined();
			// logicalParentUuid takes precedence over parentUuid
			expect(node?.parentUuid).toBe('pre-compact-uuid');
		});

		it('should keep isCompactSummary user messages as chain nodes (not excluded)', () => {
			const lines = [
				JSON.stringify({
					parentUuid: null,
					type: 'user',
					message: { role: 'user', content: 'Hello' },
					uuid: 'uuid-1',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:01:00.000Z',
				}),
				JSON.stringify({
					parentUuid: 'uuid-1',
					type: 'user',
					message: { role: 'user', content: 'This is a compaction summary of the conversation...' },
					uuid: 'uuid-summary',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:02:00.000Z',
					isCompactSummary: true,
				}),
				JSON.stringify({
					parentUuid: 'uuid-summary',
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'After compaction' }], stop_reason: 'end_turn', stop_sequence: null },
					uuid: 'uuid-2',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:03:00.000Z',
				}),
			];

			const result = parseSessionFileContent(lines.join('\n'));

			// All 3 entries are chain nodes (isCompactSummary is just a flag for layer 3)
			expect(result.nodes.size).toBe(3);
			expect(result.nodes.has('uuid-summary')).toBe(true);
		});

		it('should parse microcompact boundary using parentUuid when no logicalParentUuid', () => {
			const content = JSON.stringify({
				type: 'system',
				subtype: 'microcompact_boundary',
				uuid: 'micro-uuid',
				parentUuid: 'parent-uuid',
				isSidechain: false,
				content: 'Context microcompacted',
				timestamp: '2026-02-09T20:29:41.238Z',
			});

			const result = parseSessionFileContent(content);

			expect(result.stats.chainNodes).toBe(1);
			expect(result.errors.length).toBe(0);
			expect(result.nodes.get('micro-uuid')?.parentUuid).toBe('parent-uuid');
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

			expect(result.nodes.size).toBe(2);
			expect(result.stats.chainNodes).toBe(2);
			expect(result.stats.queueOperations).toBe(1);
			expect(result.errors.length).toBe(0);
		});

		it('should handle invalid JSON gracefully', () => {
			const content = 'not valid json\n{"valid":"json"}';
			const result = parseSessionFileContent(content, 'test-file.jsonl');

			expect(result.stats.errors).toBeGreaterThanOrEqual(1);
			expect(result.errors.length).toBeGreaterThanOrEqual(1);
			expect(result.errors[0].message).toContain('test-file.jsonl:1');
		});

		it('should skip empty lines', () => {
			const content = '\n\n{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-31T00:34:50.025Z","sessionId":"6762c0b9-ee55-42cc-8998-180da7f37462"}\n\n';
			const result = parseSessionFileContent(content);

			expect(result.stats.skippedEmpty).toBe(4);
			expect(result.stats.queueOperations).toBe(1);
			expect(result.errors.length).toBe(0);
		});

		it('should parse progress entries as chain nodes', () => {
			const content = JSON.stringify({
				uuid: 'progress-uuid',
				parentUuid: 'msg-uuid',
				type: 'progress',
				data: { type: 'agent_progress' },
			});

			const result = parseSessionFileContent(content);

			expect(result.nodes.size).toBe(1);
			expect(result.nodes.get('progress-uuid')?.parentUuid).toBe('msg-uuid');
		});
	});

	// ========================================================================
	// isUserRequest
	// ========================================================================

	describe('isUserRequest', () => {
		it('should return true for string content', () => {
			expect(isUserRequest('Hello world')).toBe(true);
		});

		it('should return true for array with text block', () => {
			expect(isUserRequest([{ type: 'text', text: 'Hello' }])).toBe(true);
		});

		it('should return false for array with only tool_result blocks', () => {
			expect(isUserRequest([
				{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
				{ type: 'tool_result', tool_use_id: 'tool-2', content: 'result' },
			])).toBe(false);
		});

		it('should return true for mixed array with tool_result and text', () => {
			expect(isUserRequest([
				{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
				{ type: 'text', text: 'Follow-up question' },
			])).toBe(true);
		});

		it('should return false for empty array', () => {
			expect(isUserRequest([])).toBe(false);
		});
	});

	// ========================================================================
	// buildSessions (Layer 3)
	// ========================================================================

	describe('buildSessions', () => {
		it('should build session from single message', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].id).toBe('session-1');
			expect(result.sessions[0].messages.length).toBe(1);
		});

		it('should build session with message chain', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, 'Hello', { timestamp: '2026-01-31T00:01:00Z' }),
				assistantEntry('msg-2', 'msg-1', { timestamp: '2026-01-31T00:02:00Z' }),
				userEntry('msg-3', 'msg-2', 'Follow up', { timestamp: '2026-01-31T00:03:00Z' }),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBe(3);
			expect(result.sessions[0].messages[0].uuid).toBe('msg-1');
			expect(result.sessions[0].messages[1].uuid).toBe('msg-2');
			expect(result.sessions[0].messages[2].uuid).toBe('msg-3');
		});

		it('should use summary for session label', () => {
			const summaries = new Map<string, SummaryEntry>([
				['msg-1', { type: 'summary', summary: 'Testing dark mode', leafUuid: 'msg-1' }],
			]);
			const parseResult = buildParseResult(
				[userEntry('msg-1', null)],
				summaries
			);

			const result = buildSessions(parseResult);

			expect(result.sessions[0].label).toBe('Testing dark mode');
		});

		it('should extract label from first user message if no summary', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, 'Help me fix this bug'),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions[0].label).toBe('Help me fix this bug');
		});

		it('should strip system reminders from label', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, '<system-reminder>Some context</system-reminder>\nActual question here'),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions[0].label).toBe('Actual question here');
		});

		it('should truncate long labels', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, 'A'.repeat(100)),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions[0].label.length).toBe(50);
			expect(result.sessions[0].label.endsWith('...')).toBe(true);
		});

		it('should deduplicate sessions by ID', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null),
				userEntry('msg-2a', 'msg-1'),
				userEntry('msg-2b', 'msg-1'),
				userEntry('msg-3', 'msg-2a'),
			]);

			const result = buildSessions(parseResult);

			// Should only have one session (the one with more messages)
			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBe(3); // msg-1 -> msg-2a -> msg-3
		});

		it('should walk through non-visible entries to reach parent messages', () => {
			// Chain: msg-1 -> compact-boundary -> msg-3
			// compact-boundary is not a visible message but is in the linked list
			const parseResult = buildParseResult([
				userEntry('msg-1', null),
				{ type: 'system', subtype: 'compact_boundary', uuid: 'compact-1', parentUuid: null, logicalParentUuid: 'msg-1', isSidechain: false },
				userEntry('msg-3', 'compact-1'),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBe(2);
			expect(result.sessions[0].messages[0].uuid).toBe('msg-1');
			expect(result.sessions[0].messages[1].uuid).toBe('msg-3');
		});

		it('should filter out isCompactSummary entries from visible messages', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, 'Hello', { timestamp: '2026-01-31T00:01:00Z' }),
				{ type: 'system', subtype: 'compact_boundary', uuid: 'compact-1', parentUuid: null, logicalParentUuid: 'msg-1' },
				userEntry('uuid-summary', 'compact-1', 'Summary of conversation...', {
					timestamp: '2026-01-31T00:02:00Z',
					isCompactSummary: true,
				}),
				assistantEntry('msg-2', 'uuid-summary', { timestamp: '2026-01-31T00:03:00Z' }),
				userEntry('msg-3', 'msg-2', 'After compaction', { timestamp: '2026-01-31T00:04:00Z' }),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions.length).toBe(1);
			// uuid-summary should be filtered from visible messages
			const uuids = result.sessions[0].messages.map(m => m.uuid);
			expect(uuids).not.toContain('uuid-summary');
			expect(uuids).toContain('msg-1');
			expect(uuids).toContain('msg-2');
			expect(uuids).toContain('msg-3');
		});

		it('should include system entries with content as visible system messages', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, 'Hello', { timestamp: '2026-01-31T00:01:00Z' }),
				assistantEntry('msg-2', 'msg-1', { timestamp: '2026-01-31T00:02:00Z' }),
				{
					type: 'system',
					subtype: 'compact_boundary',
					uuid: 'compact-1',
					parentUuid: null,
					logicalParentUuid: 'msg-2',
					sessionId: 'session-1',
					content: 'Conversation compacted',
					timestamp: '2026-01-31T00:03:00Z',
				},
				userEntry('msg-3', 'compact-1', 'After compaction', { timestamp: '2026-01-31T00:04:00Z' }),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBe(4);

			const systemMsg = result.sessions[0].messages[2];
			expect(systemMsg.type).toBe('system');
			expect(systemMsg.uuid).toBe('compact-1');
			expect(systemMsg.message.role).toBe('system');
			expect(systemMsg.message.content).toBe('Conversation compacted');
		});

		it('should not show system entries without content', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, 'Hello', { timestamp: '2026-01-31T00:01:00Z' }),
				{ type: 'system', subtype: 'stop_hook_summary', uuid: 'hook-1', parentUuid: 'msg-1', sessionId: 'session-1', timestamp: '2026-01-31T00:02:00Z' },
				assistantEntry('msg-2', 'hook-1', { timestamp: '2026-01-31T00:03:00Z' }),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions.length).toBe(1);
			// stop_hook_summary has no content field → invisible
			const uuids = result.sessions[0].messages.map(m => m.uuid);
			expect(uuids).not.toContain('hook-1');
			expect(uuids).toContain('msg-1');
			expect(uuids).toContain('msg-2');
		});

		it('should handle progress entries as leaves without breaking session building', () => {
			// Reproduces the "Shrek session" bug: progress entries at the end of a chain
			// become additional leaves, but deduplication keeps the longest visible chain.
			const parseResult = buildParseResult([
				userEntry('msg-1', null, 'Hello', { timestamp: '2026-01-31T00:01:00Z' }),
				assistantEntry('msg-2', 'msg-1', { timestamp: '2026-01-31T00:02:00Z' }),
				userEntry('msg-3', 'msg-2', 'Follow up', { timestamp: '2026-01-31T00:03:00Z' }),
				{ uuid: 'progress-1', parentUuid: 'msg-3', type: 'progress', data: { type: 'agent_progress' } },
				{ uuid: 'stop-hook-1', parentUuid: 'progress-1', type: 'system', subtype: 'stop_hook_summary' },
			]);

			const result = buildSessions(parseResult);

			// progress/stop_hook leaves produce sessions with the same messages as msg-3's chain,
			// so deduplication keeps one session with all 3 visible messages
			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBe(3);
			expect(result.sessions[0].messages[2].uuid).toBe('msg-3');
		});

		it('should handle cycle detection', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', 'msg-2'),
				userEntry('msg-2', 'msg-1'),
				userEntry('msg-3', 'msg-2'),
			]);

			const result = buildSessions(parseResult);

			// Should not hang, should produce some output
			expect(result.sessions.length).toBe(1);
			expect(result.sessions[0].messages.length).toBeGreaterThan(0);
		});

		it('should set lastRequestStarted to last genuine user request', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, 'Hello', { timestamp: '2026-01-31T00:01:00Z' }),
				assistantEntry('msg-2', 'msg-1', { timestamp: '2026-01-31T00:02:00Z' }),
				userEntry('msg-3', 'msg-2', [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }], { timestamp: '2026-01-31T00:03:00Z' }),
				assistantEntry('msg-4', 'msg-3', { timestamp: '2026-01-31T00:04:00Z' }),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions[0].lastRequestStarted).toBe(new Date('2026-01-31T00:01:00Z').getTime());
		});

		it('should set lastRequestStarted to undefined when all user messages are tool results', () => {
			const parseResult = buildParseResult([
				userEntry('msg-1', null, [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }], { timestamp: '2026-01-31T00:01:00Z' }),
				assistantEntry('msg-2', 'msg-1', { timestamp: '2026-01-31T00:02:00Z' }),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions[0].lastRequestStarted).toBeUndefined();
		});

		it('should include parallel tool result siblings in session', () => {
			const parseResult = buildParseResult([
				userEntry('user-1', null, 'Run 4 tasks in parallel', { timestamp: '2026-01-31T00:01:00Z' }),
				assistantEntry('asst-thinking', 'user-1', { timestamp: '2026-01-31T00:02:00Z' }),
				assistantEntry('asst-tool-1', 'asst-thinking', { timestamp: '2026-01-31T00:03:00Z' }),
				assistantEntry('asst-tool-2', 'asst-tool-1', { timestamp: '2026-01-31T00:03:01Z' }),
				assistantEntry('asst-tool-3', 'asst-tool-2', { timestamp: '2026-01-31T00:03:02Z' }),
				assistantEntry('asst-tool-4', 'asst-tool-3', { timestamp: '2026-01-31T00:03:03Z' }),
				userEntry('result-1', 'asst-tool-1', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Done 1' }], {
					timestamp: '2026-01-31T00:04:00Z',
					toolUseResult: { agentId: 'agent-1' },
				}),
				userEntry('result-2', 'asst-tool-2', [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'Done 2' }], {
					timestamp: '2026-01-31T00:04:01Z',
					toolUseResult: { agentId: 'agent-2' },
				}),
				userEntry('result-3', 'asst-tool-3', [{ type: 'tool_result', tool_use_id: 'tool-3', content: 'Done 3' }], {
					timestamp: '2026-01-31T00:04:02Z',
					toolUseResult: { agentId: 'agent-3' },
				}),
				userEntry('result-4', 'asst-tool-4', [{ type: 'tool_result', tool_use_id: 'tool-4', content: 'Done 4' }], {
					timestamp: '2026-01-31T00:04:03Z',
					toolUseResult: { agentId: 'agent-4' },
				}),
				assistantEntry('asst-final', 'result-4', { timestamp: '2026-01-31T00:05:00Z' }),
			]);

			const result = buildSessions(parseResult);

			expect(result.sessions.length).toBe(1);
			const session = result.sessions[0];

			const toolResultMessages = session.messages.filter(m => m.toolUseResultAgentId !== undefined);
			expect(toolResultMessages).toHaveLength(4);
			expect(toolResultMessages.map(m => m.toolUseResultAgentId).sort())
				.toEqual(['agent-1', 'agent-2', 'agent-3', 'agent-4']);

			expect(session.messages.length).toBe(11);
		});

		it('should parse parallel subagent fixture correctly', () => {
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', 'b3a7bd3c-5a10-4e7b-8ff0-7fc0cd6d1093.jsonl');
			const content = fs.readFileSync(fixturePath, 'utf8');
			const parseResult = parseSessionFileContent(content);

			const buildResult = buildSessions(parseResult);

			expect(buildResult.sessions.length).toBe(1);
			const session = buildResult.sessions[0];

			const toolResultMessages = session.messages.filter(m => m.toolUseResultAgentId !== undefined);
			expect(toolResultMessages).toHaveLength(4);

			const agentIds = toolResultMessages.map(m => m.toolUseResultAgentId).sort();
			expect(agentIds).toEqual(['a775a67', 'aa9d784', 'ac47f8c', 'ae52dab']);
		});

		it('should stitch messages across compact boundary from JSONL', () => {
			const lines = [
				JSON.stringify({
					parentUuid: null,
					type: 'user',
					message: { role: 'user', content: 'First message' },
					uuid: 'uuid-1',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:01:00.000Z',
				}),
				JSON.stringify({
					parentUuid: 'uuid-1',
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Response 1' }], stop_reason: 'end_turn', stop_sequence: null },
					uuid: 'uuid-2',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:02:00.000Z',
				}),
				JSON.stringify({
					parentUuid: 'uuid-2',
					type: 'user',
					message: { role: 'user', content: 'Second message' },
					uuid: 'uuid-3',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:03:00.000Z',
				}),
				JSON.stringify({
					type: 'system',
					subtype: 'compact_boundary',
					uuid: 'compact-1',
					parentUuid: null,
					logicalParentUuid: 'uuid-3',
					isSidechain: false,
					sessionId: 'session-1',
					content: 'Conversation compacted',
					timestamp: '2026-01-31T00:04:00.000Z',
				}),
				JSON.stringify({
					parentUuid: 'compact-1',
					type: 'user',
					message: { role: 'user', content: 'Summary of prior conversation...' },
					uuid: 'uuid-summary',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:04:01.000Z',
					isCompactSummary: true,
				}),
				JSON.stringify({
					parentUuid: 'uuid-summary',
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing after compaction' }], stop_reason: 'end_turn', stop_sequence: null },
					uuid: 'uuid-4',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:05:00.000Z',
				}),
				JSON.stringify({
					parentUuid: 'uuid-4',
					type: 'user',
					message: { role: 'user', content: 'After compaction' },
					uuid: 'uuid-5',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:06:00.000Z',
				}),
			];

			const parseResult = parseSessionFileContent(lines.join('\n'));

			expect(parseResult.errors.length).toBe(0);
			// All 7 entries (including compact boundary and summary) are chain nodes
			expect(parseResult.nodes.size).toBe(7);

			const buildResult = buildSessions(parseResult);

			expect(buildResult.sessions.length).toBe(1);
			const session = buildResult.sessions[0];
			// 6 visible messages (uuid-1, uuid-2, uuid-3, compact-1 system, uuid-4, uuid-5)
			// isCompactSummary is invisible, compact boundary is visible as a system message
			expect(session.messages.length).toBe(6);
			expect(session.messages[0].uuid).toBe('uuid-1');
			expect(session.messages[3].type).toBe('system');
			expect(session.messages[3].uuid).toBe('compact-1');
			expect(session.messages[5].uuid).toBe('uuid-5');
		});
	});

	// #region buildSubagentSession

	describe('buildSubagentSession', () => {
		it('should build subagent session from parsed content', () => {
			const lines = [
				JSON.stringify({
					parentUuid: null,
					type: 'user',
					message: { role: 'user', content: 'Task for subagent' },
					uuid: 'uuid-1',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:34:50.049Z',
					agentId: 'a139fcf',
				}),
				JSON.stringify({
					parentUuid: 'uuid-1',
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', stop_sequence: null },
					uuid: 'uuid-2',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:35:00.000Z',
					agentId: 'a139fcf',
				}),
			];

			const parseResult = parseSessionFileContent(lines.join('\n'));
			const subagent = buildSubagentSession('a139fcf', parseResult);

			expect(subagent).not.toBeNull();
			expect(subagent!.agentId).toBe('a139fcf');
			expect(subagent!.messages.length).toBe(2);
			expect(subagent!.messages[0].uuid).toBe('uuid-1');
			expect(subagent!.messages[1].uuid).toBe('uuid-2');
			expect(subagent!.timestamp).toEqual(new Date('2026-01-31T00:35:00.000Z'));
		});

		it('should return null for empty content', () => {
			const parseResult = parseSessionFileContent('');
			const subagent = buildSubagentSession('a139fcf', parseResult);

			expect(subagent).toBeNull();
		});

		it('should walk through chain link entries', () => {
			const lines = [
				JSON.stringify({
					uuid: 'chain-1',
					parentUuid: null,
					type: 'progress',
				}),
				JSON.stringify({
					parentUuid: 'chain-1',
					type: 'user',
					message: { role: 'user', content: 'Hello' },
					uuid: 'uuid-2',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:35:00.000Z',
				}),
			];

			const parseResult = parseSessionFileContent(lines.join('\n'));
			const subagent = buildSubagentSession('test-agent', parseResult);

			expect(subagent).not.toBeNull();
			expect(subagent!.messages.length).toBe(1);
		});

		it('should pick the chain with most visible messages when multiple leaves exist', () => {
			const lines = [
				JSON.stringify({
					parentUuid: null,
					type: 'user',
					message: { role: 'user', content: 'Start' },
					uuid: 'uuid-1',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:34:00.000Z',
				}),
				JSON.stringify({
					parentUuid: 'uuid-1',
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }], stop_reason: 'end_turn', stop_sequence: null },
					uuid: 'uuid-2',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:35:00.000Z',
				}),
				JSON.stringify({
					parentUuid: 'uuid-2',
					type: 'user',
					message: { role: 'user', content: 'Follow-up' },
					uuid: 'uuid-3',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:36:00.000Z',
				}),
				// Orphaned branch
				JSON.stringify({
					parentUuid: 'uuid-1',
					type: 'user',
					message: { role: 'user', content: 'Tool result' },
					uuid: 'uuid-orphan',
					sessionId: 'session-1',
					timestamp: '2026-01-31T00:35:30.000Z',
				}),
			];

			const parseResult = parseSessionFileContent(lines.join('\n'));
			const subagent = buildSubagentSession('test-agent', parseResult);

			expect(subagent).not.toBeNull();
			expect(subagent!.messages.length).toBe(3);
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
			expect(metadata!.created).toBe(new Date('2026-01-31T00:34:50.049Z').getTime());
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
			expect(metadata!.label).toBe('Hello');
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

		it('should extract created and lastRequestEnded from single message', () => {
			const content = '{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}';

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.created).toBe(new Date('2026-01-31T00:34:50.049Z').getTime());
			expect(metadata!.lastRequestEnded).toBe(new Date('2026-01-31T00:34:50.049Z').getTime());
		});

		it('should extract different created and lastRequestEnded from multiple messages', () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"assistant","uuid":"uuid-2","sessionId":"session-1","timestamp":"2026-01-31T00:35:00.000Z","parentUuid":"uuid-1","message":{"role":"assistant","content":[]}}',
				'{"type":"user","uuid":"uuid-3","sessionId":"session-1","timestamp":"2026-01-31T00:36:00.000Z","parentUuid":"uuid-2","message":{"role":"user","content":"Follow up"}}',
				'{"type":"assistant","uuid":"uuid-4","sessionId":"session-1","timestamp":"2026-01-31T00:37:30.000Z","parentUuid":"uuid-3","message":{"role":"assistant","content":[]}}'
			].join('\n');

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.created).toBe(new Date('2026-01-31T00:34:50.049Z').getTime());
			expect(metadata!.lastRequestEnded).toBe(new Date('2026-01-31T00:37:30.000Z').getTime());
		});

		it('should return null when only summary exists (no messages)', () => {
			const content = '{"type":"summary","summary":"Just a summary","leafUuid":"uuid-1"}';

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).toBeNull();
		});

		it('should set lastRequestStarted for genuine user request', () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"assistant","uuid":"uuid-2","sessionId":"session-1","timestamp":"2026-01-31T00:35:00.000Z","parentUuid":"uuid-1","message":{"role":"assistant","content":[]}}',
				'{"type":"user","uuid":"uuid-3","sessionId":"session-1","timestamp":"2026-01-31T00:36:00.000Z","parentUuid":"uuid-2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]}}',
				'{"type":"assistant","uuid":"uuid-4","sessionId":"session-1","timestamp":"2026-01-31T00:37:30.000Z","parentUuid":"uuid-3","message":{"role":"assistant","content":[]}}'
			].join('\n');

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.lastRequestStarted).toBe(new Date('2026-01-31T00:34:50.049Z').getTime());
		});

		it('should set lastRequestStarted to undefined when all user messages are tool results', () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]}}',
				'{"type":"assistant","uuid":"uuid-2","sessionId":"session-1","timestamp":"2026-01-31T00:35:00.000Z","parentUuid":"uuid-1","message":{"role":"assistant","content":[]}}'
			].join('\n');

			const metadata = extractSessionMetadata(content, 'session-1', new Date('2026-01-31T00:00:00.000Z'));

			expect(metadata).not.toBeNull();
			expect(metadata!.lastRequestStarted).toBeUndefined();
		});
	});

	// #endregion

	// #region extractSessionMetadataStreaming

	describe('extractSessionMetadataStreaming', () => {
		let tempDir: string;
		const tempFiles: string[] = [];

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
		});

		it('should produce same results as sync version', async () => {
			const testCases = [
				[
					'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
					'{"type":"summary","summary":"Test summary","leafUuid":"uuid-1"}'
				].join('\n'),
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Just a message"}}',
				'{"type":"summary","summary":"Summary only session","leafUuid":"uuid-1"}',
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

		it('should handle cancellation via AbortSignal', async () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
			].join('\n');
			const filePath = createTempFile(content);

			const abortController = new AbortController();
			abortController.abort();

			await expect(
				extractSessionMetadataStreaming(filePath, 'session-1', new Date(), abortController.signal)
			).rejects.toThrow('Operation cancelled');
		});
	});

	// #endregion

	// #region Metadata extraction consistency

	describe('metadata extraction consistency', () => {
		it('should produce same label and timestamp as full parsing path', () => {
			const testCases = [
				[
					'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
					'{"type":"summary","summary":"Test summary label","leafUuid":"uuid-1"}'
				].join('\n'),
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"My first message"}}',
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"<system-reminder>context</system-reminder>Actual question"}}',
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"This is a very long message that should be truncated to 50 characters maximum"}}',
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"Array block content"}]}}',
				[
					'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
					'{"type":"assistant","uuid":"uuid-2","sessionId":"session-1","timestamp":"2026-01-31T00:35:00.000Z","parentUuid":"uuid-1","message":{"role":"assistant","content":[]}}',
					'{"type":"user","uuid":"uuid-3","sessionId":"session-1","timestamp":"2026-01-31T00:36:00.000Z","parentUuid":"uuid-2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]}}',
					'{"type":"assistant","uuid":"uuid-4","sessionId":"session-1","timestamp":"2026-01-31T00:37:00.000Z","parentUuid":"uuid-3","message":{"role":"assistant","content":[]}}',
					'{"type":"summary","summary":"Tool result session","leafUuid":"uuid-4"}'
				].join('\n'),
			];

			const fileMtime = new Date('2026-01-31T00:00:00.000Z');

			for (const content of testCases) {
				const metadataResult = extractSessionMetadata(content, 'session-1', fileMtime);

				const parseResult = parseSessionFileContent(content);
				const buildResult = buildSessions(parseResult);

				expect(metadataResult).not.toBeNull();
				expect(buildResult.sessions.length).toBe(1);

				const fullSession = buildResult.sessions[0];

				expect(metadataResult!.label).toBe(fullSession.label);
				expect(metadataResult!.created).toEqual(fullSession.created);
				expect(metadataResult!.lastRequestStarted).toEqual(fullSession.lastRequestStarted);
				expect(metadataResult!.lastRequestEnded).toEqual(fullSession.lastRequestEnded);
			}
		});

		it('should skip API error summaries consistently with full parsing', () => {
			const content = [
				'{"type":"user","uuid":"uuid-1","sessionId":"session-1","timestamp":"2026-01-31T00:34:50.049Z","parentUuid":null,"message":{"role":"user","content":"Hello"}}',
				'{"type":"summary","summary":"API error: 401 Unauthorized","leafUuid":"uuid-1"}'
			].join('\n');

			const fileMtime = new Date('2026-01-31T00:00:00.000Z');

			const metadataResult = extractSessionMetadata(content, 'session-1', fileMtime);

			const parseResult = parseSessionFileContent(content);
			const buildResult = buildSessions(parseResult);

			expect(metadataResult!.label).toBe('Hello');
			expect(buildResult.sessions[0].label).toBe('Hello');
		});
	});

	// #endregion
});
