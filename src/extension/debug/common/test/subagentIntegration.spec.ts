/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { generateControlFlowDiagram, generateSequenceDiagram } from '../debugDiagrams';
import { formatSessionSummary, getSubagentName, isSubagentTurn } from '../debugFormatters';
import { DebugItemStatus, DebugSession } from '../debugTypes';
import {
	ATLAS1_EXPECTED,
	ATLAS1_PROMPTS,
	INTERLEAVED_SUBAGENTS_PROMPTS,
	SIMPLE_NO_SUBAGENTS_PROMPTS,
	TestPromptFixture
} from './fixtures/subagentTestData';

describe('subagent integration tests', () => {
	describe('atlas1 session analysis', () => {
		it('should correctly count main vs subagent turns', () => {
			const mainCount = ATLAS1_PROMPTS.filter(p => !isSubagentTurn(p.prompt)).length;
			const subagentCount = ATLAS1_PROMPTS.filter(p => isSubagentTurn(p.prompt)).length;

			expect(mainCount).toBe(ATLAS1_EXPECTED.mainAgentTurns);
			expect(subagentCount).toBe(ATLAS1_EXPECTED.subagentTurns);
			expect(mainCount + subagentCount).toBe(ATLAS1_EXPECTED.totalPrompts);
		});

		it('should correctly identify subagent distribution', () => {
			const distribution = new Map<string, number>();

			for (const p of ATLAS1_PROMPTS) {
				if (isSubagentTurn(p.prompt)) {
					const name = getSubagentName(p.prompt);
					distribution.set(name, (distribution.get(name) || 0) + 1);
				}
			}

			expect(distribution.get('Oracle')).toBe(ATLAS1_EXPECTED.subagentDistribution.Oracle);
			expect(distribution.get('Sisyphus')).toBe(ATLAS1_EXPECTED.subagentDistribution.Sisyphus);
			expect(distribution.get('Code')).toBe(ATLAS1_EXPECTED.subagentDistribution.Code);
		});

		it('should identify consecutive Oracle-subagent group', () => {
			let consecutiveCount = 0;
			let startIndex = -1;
			let endIndex = -1;

			for (let i = 0; i < ATLAS1_PROMPTS.length; i++) {
				const isOracle = isSubagentTurn(ATLAS1_PROMPTS[i].prompt) &&
					getSubagentName(ATLAS1_PROMPTS[i].prompt) === 'Oracle';

				if (isOracle) {
					if (startIndex === -1) {
						startIndex = i;
					}
					consecutiveCount++;
					endIndex = i;
				} else if (startIndex !== -1) {
					// First non-Oracle after Oracle sequence
					break;
				}
			}

			expect(consecutiveCount).toBe(ATLAS1_EXPECTED.consecutiveOracleGroupSize);
			expect(startIndex).toBe(ATLAS1_EXPECTED.consecutiveOracleGroupStartIndex);
			expect(endIndex).toBe(ATLAS1_EXPECTED.consecutiveOracleGroupEndIndex);
		});

		it('should generate session summary with correct breakdown', () => {
			const session = createSessionFromFixture(ATLAS1_PROMPTS);
			const summary = formatSessionSummary(session);

			expect(summary).toContain('Total Turns | 28');
			expect(summary).toContain('→ Main Agent Turns | 11');
			expect(summary).toContain('→ SubAgent Turns | 17');
		});

		it('should generate control flow diagram with subagent grouping', () => {
			const session = createSessionFromFixture(ATLAS1_PROMPTS);
			const diagram = generateControlFlowDiagram(session);

			// Should have subagent styling
			expect(diagram).toContain('classDef subagent');
			// With 28 turns, grouping should kick in (>15 threshold)
			expect(diagram).toContain('Oracle');
			// Should show grouped turns and tools
			expect(diagram).toMatch(/Oracle.*turns.*tools/);
		});

		it('should generate sequence diagram with subagent invocations', () => {
			const session = createSessionFromFixture(ATLAS1_PROMPTS);
			const diagram = generateSequenceDiagram(session);

			// Should have SubAgents participant
			expect(diagram).toContain('participant S as SubAgents');
			// Should show subagent invocations
			expect(diagram).toContain('runSubagent');
			expect(diagram).toContain('invoke Oracle');
			// Should show completion with grouped counts
			expect(diagram).toMatch(/Oracle completed.*turns.*tools/);
		});
	});

	describe('simple session (no subagents)', () => {
		it('should not show subagent breakdown', () => {
			const session = createSessionFromFixture(SIMPLE_NO_SUBAGENTS_PROMPTS);
			const summary = formatSessionSummary(session);

			expect(summary).toContain('Total Turns | 4');
			expect(summary).not.toContain('→ Main Agent Turns');
			expect(summary).not.toContain('→ SubAgent Turns');
		});

		it('should not include SubAgents participant in sequence diagram', () => {
			const session = createSessionFromFixture(SIMPLE_NO_SUBAGENTS_PROMPTS);
			const diagram = generateSequenceDiagram(session);

			expect(diagram).not.toContain('participant S as SubAgents');
			expect(diagram).not.toContain('runSubagent');
		});
	});

	describe('interleaved subagents session', () => {
		it('should correctly count turns', () => {
			const mainCount = INTERLEAVED_SUBAGENTS_PROMPTS.filter(p => !isSubagentTurn(p.prompt)).length;
			const subagentCount = INTERLEAVED_SUBAGENTS_PROMPTS.filter(p => isSubagentTurn(p.prompt)).length;

			expect(mainCount).toBe(4); // Start, Continue, approve, Finalize
			expect(subagentCount).toBe(3); // Oracle x2, Sisyphus x1
		});

		it('should not group non-consecutive subagent turns', () => {
			const session = createSessionFromFixture(INTERLEAVED_SUBAGENTS_PROMPTS);
			const diagram = generateSequenceDiagram(session);

			// Should have multiple separate runSubagent invocations (not grouped)
			const runSubagentMatches = diagram.match(/runSubagent/g);
			expect(runSubagentMatches).toBeTruthy();
			// 3 subagent turns that are interleaved should have 3 invocations
			expect(runSubagentMatches!.length).toBe(3);
		});
	});
});

/**
 * Helper to create a mock DebugSession from test fixtures
 */
function createSessionFromFixture(prompts: TestPromptFixture[]): DebugSession {
	const allToolCalls: DebugSession['toolCalls'] = [];

	const turns = prompts.map((p, i) => {
		const turnToolCalls = Array.from({ length: p.toolCallCount }, (_, j) => ({
			id: `tc-${i}-${j}`,
			name: `tool_${j}`,
			args: {},
			status: DebugItemStatus.Success,
			turnId: `turn-${i}`,
		}));
		allToolCalls.push(...turnToolCalls);

		return {
			id: `turn-${i}`,
			prompt: p.prompt,
			response: undefined,
			toolCalls: turnToolCalls,
			requests: [],
			status: DebugItemStatus.Success,
			index: i,
		};
	});

	return {
		sessionId: 'test-session',
		source: 'chatreplay',
		turns,
		toolCalls: allToolCalls,
		requests: [],
		subAgents: [],
		metrics: {
			totalTurns: turns.length,
			totalToolCalls: allToolCalls.length,
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
