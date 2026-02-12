/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { formatSessionSummary, getSubagentName, isSubagentTurn } from '../debugFormatters';
import { DebugItemStatus, DebugSession } from '../debugTypes';

describe('debugFormatters', () => {
	describe('isSubagentTurn', () => {
		it('should detect Oracle-subagent prompts', () => {
			const prompt = 'You are Oracle-subagent. Research the collaboration endpoint...';
			expect(isSubagentTurn(prompt)).toBe(true);
		});

		it('should detect Sisyphus-subagent prompts', () => {
			const prompt = 'You are Sisyphus-subagent. Fix the naming inconsistencies...';
			expect(isSubagentTurn(prompt)).toBe(true);
		});

		it('should detect Code-Review-subagent prompts', () => {
			const prompt = 'You are Code-Review-subagent. Quick re-review of Phase 1...';
			expect(isSubagentTurn(prompt)).toBe(true);
		});

		it('should detect generic X-subagent pattern', () => {
			const prompt = 'You are Custom-subagent. Do something special...';
			expect(isSubagentTurn(prompt)).toBe(true);
		});

		it('should detect prompts containing -subagent keyword', () => {
			const prompt = 'Continue the Oracle-subagent task from earlier...';
			expect(isSubagentTurn(prompt)).toBe(true);
		});

		it('should NOT detect main agent prompts', () => {
			const prompt = 'Add option to configure collab/coediting endpoint and UI...';
			expect(isSubagentTurn(prompt)).toBe(false);
		});

		it('should NOT detect approve commands', () => {
			const prompt = 'approve';
			expect(isSubagentTurn(prompt)).toBe(false);
		});

		it('should NOT detect prompts mentioning subagent in discussion', () => {
			// This prompt discusses subagents but is not itself a subagent prompt
			const prompt = 'Can you tell me how many subagent turns there were?';
			expect(isSubagentTurn(prompt)).toBe(false);
		});

		// Real-world patterns from atlas1 logs
		it('should detect Sisyphus-subagent with comma pattern (atlas1)', () => {
			// Real pattern: "You are Sisyphus-subagent, the implementer. Your task..."
			const prompt = 'You are Sisyphus-subagent, the implementer. Your task is to implement Phase 1 of...';
			expect(isSubagentTurn(prompt)).toBe(true);
		});

		it('should detect Code-Review-subagent with hyphenated name (atlas1)', () => {
			// Real pattern: "You are Code-Review-subagent. Review the Phase 1..."
			const prompt = 'You are Code-Review-subagent. Review the Phase 1 implementation of the collab en...';
			expect(isSubagentTurn(prompt)).toBe(true);
		});
	});

	describe('getSubagentName', () => {
		it('should extract Oracle from Oracle-subagent prompt', () => {
			const prompt = 'You are Oracle-subagent. Research the collaboration endpoint...';
			expect(getSubagentName(prompt)).toBe('Oracle');
		});

		it('should extract Sisyphus from Sisyphus-subagent prompt', () => {
			const prompt = 'You are Sisyphus-subagent. Fix the naming inconsistencies...';
			expect(getSubagentName(prompt)).toBe('Sisyphus');
		});

		it('should extract Code from Code-Review-subagent prompt', () => {
			// Note: The regex captures up to the first hyphen in the suffix
			const prompt = 'You are Code-Review-subagent. Quick re-review...';
			expect(getSubagentName(prompt)).toBe('Code');
		});

		it('should extract name from prompts mentioning -subagent', () => {
			const prompt = 'Continue the Custom-subagent task from earlier...';
			expect(getSubagentName(prompt)).toBe('Custom');
		});

		it('should return subagent as fallback', () => {
			// A prompt that somehow passes isSubagentTurn but has no clear name
			const prompt = 'This mentions subagent but has no clear pattern';
			// This would not actually match isSubagentTurn, but testing fallback
			expect(getSubagentName(prompt)).toBe('subagent');
		});
	});

	describe('formatSessionSummary', () => {
		it('should show subagent turn breakdown when subagents present', () => {
			const session = createMockSession([
				{ prompt: 'You are Oracle-subagent. Task 1', toolCalls: [] },
				{ prompt: 'You are Oracle-subagent. Task 2', toolCalls: [] },
				{ prompt: 'Main agent task', toolCalls: [] },
				{ prompt: 'You are Sisyphus-subagent. Fix', toolCalls: [] },
			]);

			const output = formatSessionSummary(session);

			expect(output).toContain('Total Turns | 4');
			expect(output).toContain('→ Main Agent Turns | 1');
			expect(output).toContain('→ SubAgent Turns | 3');
		});

		it('should NOT show breakdown when no subagents', () => {
			const session = createMockSession([
				{ prompt: 'Main agent task 1', toolCalls: [] },
				{ prompt: 'Main agent task 2', toolCalls: [] },
			]);

			const output = formatSessionSummary(session);

			expect(output).toContain('Total Turns | 2');
			expect(output).not.toContain('→ Main Agent Turns');
			expect(output).not.toContain('→ SubAgent Turns');
		});
	});
});

// Helper to create a mock session with specified turns
function createMockSession(turns: Array<{ prompt: string; toolCalls: Array<{ name: string; status?: string }> }>): DebugSession {
	return {
		sessionId: 'test-session-id',
		source: 'live',
		turns: turns.map((t, i) => ({
			id: `turn-${i}`,
			prompt: t.prompt,
			response: undefined,
			toolCalls: t.toolCalls.map((tc, j) => ({
				id: `tc-${i}-${j}`,
				name: tc.name,
				args: {},
				status: (tc.status || 'success') as DebugItemStatus,
				turnId: `turn-${i}`,
			})),
			requests: [],
			status: DebugItemStatus.Success,
			index: i,
		})),
		toolCalls: [],
		requests: [],
		subAgents: [],
		metrics: {
			totalTurns: turns.length,
			totalToolCalls: turns.reduce((sum, t) => sum + t.toolCalls.length, 0),
			totalRequests: 0,
			totalSubAgents: 0,
			maxSubAgentDepth: 0,
			failedToolCalls: 0,
			failedRequests: 0,
			toolCallsByName: new Map(),
			errorTypes: new Map(),
		},
	};
}
