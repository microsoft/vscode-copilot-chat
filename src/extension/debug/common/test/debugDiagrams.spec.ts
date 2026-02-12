/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { generateControlFlowDiagram, generateSequenceDiagram, turnsOverlap } from '../debugDiagrams';
import { DebugItemStatus, DebugSession, DebugTurn } from '../debugTypes';

describe('debugDiagrams', () => {
	describe('generateControlFlowDiagram', () => {
		it('should generate valid mermaid flowchart', () => {
			const session = createMockSessionWithSubagents();
			const diagram = generateControlFlowDiagram(session);

			// Function returns raw mermaid syntax (no code fences)
			expect(diagram).toContain('flowchart TD');
			expect(diagram).toContain('classDef');
		});

		it('should include subagent class definition', () => {
			const session = createMockSessionWithSubagents();
			const diagram = generateControlFlowDiagram(session);

			expect(diagram).toContain('classDef subagent');
		});

		it('should style subagent turns with subagent class', () => {
			const session = createMockSessionWithSubagents();
			const diagram = generateControlFlowDiagram(session);

			// Should contain subagent styling
			expect(diagram).toContain(':::subagent');
		});

		it('should group consecutive subagent turns when many turns present', () => {
			// Create session with 20+ turns including consecutive subagent turns
			const session = createMockSessionWithManySubagents();
			const diagram = generateControlFlowDiagram(session);

			// When grouping kicks in (>15 turns), should show grouped subagent node
			expect(diagram).toContain('Oracle');
			expect(diagram).toContain('turns');
			expect(diagram).toContain('tools');
		});

		it('should handle session with no subagents', () => {
			const session = createMockSessionNoSubagents();
			const diagram = generateControlFlowDiagram(session);

			expect(diagram).toContain('flowchart TD');
			// No subagent styling when no subagent turns
			expect(diagram).not.toContain(':::subagent');
		});
	});

	describe('generateSequenceDiagram', () => {
		it('should generate valid mermaid sequence diagram', () => {
			const session = createMockSessionWithSubagents();
			const diagram = generateSequenceDiagram(session);

			// Function returns raw mermaid syntax (no code fences)
			expect(diagram).toContain('sequenceDiagram');
			expect(diagram).toContain('participant');
		});

		it('should include SubAgents participant when subagents present', () => {
			const session = createMockSessionWithSubagents();
			const diagram = generateSequenceDiagram(session);

			expect(diagram).toContain('participant S as SubAgents');
		});

		it('should NOT include SubAgents participant when no subagents', () => {
			const session = createMockSessionNoSubagents();
			const diagram = generateSequenceDiagram(session);

			expect(diagram).not.toContain('participant S as SubAgents');
		});

		it('should show runSubagent invocation for subagent turns', () => {
			const session = createMockSessionWithSubagents();
			const diagram = generateSequenceDiagram(session);

			expect(diagram).toContain('runSubagent');
		});

		it('should show subagent completion with turn and tool counts', () => {
			const session = createMockSessionWithSubagents();
			const diagram = generateSequenceDiagram(session);

			// Should show completion message with counts
			expect(diagram).toMatch(/completed.*turns.*tools/);
		});

		it('should group consecutive subagent turns in visualization', () => {
			const session = createMockSessionWithManySubagents();
			const diagram = generateSequenceDiagram(session);

			// Should invoke subagent once for grouped turns
			const runSubagentMatches = diagram.match(/runSubagent/g);
			expect(runSubagentMatches).toBeTruthy();
			// Not every subagent turn should have its own runSubagent call (they're grouped)
			expect(runSubagentMatches!.length).toBeLessThan(13); // 13 Oracle turns should be grouped
		});
	});

	describe('turnsOverlap', () => {
		it('should detect overlapping turns', () => {
			const turnA: DebugTurn = createMockTurn(0, 'Turn A', new Date('2024-01-01T10:00:00Z'), 5000);
			const turnB: DebugTurn = createMockTurn(1, 'Turn B', new Date('2024-01-01T10:00:03Z'), 5000); // Starts during A

			expect(turnsOverlap(turnA, turnB)).toBe(true);
		});

		it('should detect non-overlapping turns', () => {
			const turnA: DebugTurn = createMockTurn(0, 'Turn A', new Date('2024-01-01T10:00:00Z'), 2000);
			const turnB: DebugTurn = createMockTurn(1, 'Turn B', new Date('2024-01-01T10:00:10Z'), 2000); // Starts way after A ends

			expect(turnsOverlap(turnA, turnB)).toBe(false);
		});

		it('should return false when timestamps missing', () => {
			const turnA: DebugTurn = createMockTurn(0, 'Turn A');
			const turnB: DebugTurn = createMockTurn(1, 'Turn B');

			expect(turnsOverlap(turnA, turnB)).toBe(false);
		});

		it('should handle edge case where turns touch exactly', () => {
			const turnA: DebugTurn = createMockTurn(0, 'Turn A', new Date('2024-01-01T10:00:00Z'), 5000);
			const turnB: DebugTurn = createMockTurn(1, 'Turn B', new Date('2024-01-01T10:00:05Z'), 5000); // Starts exactly when A ends

			// Touching at edge counts as overlap (aStart <= bEnd && bStart <= aEnd)
			expect(turnsOverlap(turnA, turnB)).toBe(true);
		});
	});

	describe('parallel execution visualization', () => {
		it('should add parallel indicator to grouped subagents with overlapping timestamps', () => {
			const session = createMockSessionWithParallelSubagents();
			const diagram = generateControlFlowDiagram(session);

			// Should show parallel indicator in mermaid
			expect(diagram).toContain('⚡'); // Parallel indicator
		});

		it('should use parallel styling class for parallel groups', () => {
			const session = createMockSessionWithParallelSubagents();
			const diagram = generateControlFlowDiagram(session);

			// Should contain parallel styling
			expect(diagram).toContain(':::parallel');
		});

		it('should show fork/join for multiple runSubagent tool calls in one turn', () => {
			const session = createMockSessionWithParallelSubagentCalls();
			const diagram = generateControlFlowDiagram(session);

			// Should show fork node for parallel execution
			expect(diagram).toContain('⚡ Parallel SubAgents');
			// Should show join node
			expect(diagram).toContain('Join');
			// Should have parallel styling
			expect(diagram).toContain(':::parallel');
		});

		it('should show subagent branches from fork node', () => {
			const session = createMockSessionWithParallelSubagentCalls();
			const diagram = generateControlFlowDiagram(session);

			// Should connect fork to each subagent
			expect(diagram).toContain('Fork');
			// Should have runSubagent tool calls as branches
			expect(diagram).toContain('runSubagent');
		});
	});
});

// Helper: Session with a mix of main and subagent turns
function createMockSessionWithSubagents(): DebugSession {
	return createMockSession([
		{ prompt: 'You are Oracle-subagent. Research task 1', toolCalls: [{ name: 'read_file' }] },
		{ prompt: 'You are Oracle-subagent. Research task 2', toolCalls: [{ name: 'grep_search' }] },
		{ prompt: 'Main agent: implement feature', toolCalls: [{ name: 'create_file' }] },
		{ prompt: 'You are Sisyphus-subagent. Fix bugs', toolCalls: [{ name: 'replace_string_in_file' }] },
	]);
}

// Helper: Session with many consecutive subagent turns (to test grouping)
function createMockSessionWithManySubagents(): DebugSession {
	const turns: Array<{ prompt: string; toolCalls: Array<{ name: string }> }> = [];

	// 13 consecutive Oracle-subagent turns
	for (let i = 0; i < 13; i++) {
		turns.push({
			prompt: `You are Oracle-subagent. Research task ${i + 1}`,
			toolCalls: [{ name: 'read_file' }, { name: 'grep_search' }],
		});
	}

	// Some main agent turns
	turns.push({ prompt: 'Main agent: implement feature', toolCalls: [{ name: 'create_file' }] });
	turns.push({ prompt: 'approve', toolCalls: [] });

	// Sisyphus subagent
	turns.push({ prompt: 'You are Sisyphus-subagent. Fix bugs', toolCalls: [{ name: 'replace_string_in_file' }] });

	// More main agent
	turns.push({ prompt: 'approve', toolCalls: [] });

	// Code-Review subagent
	turns.push({ prompt: 'You are Code-Review-subagent. Review PR', toolCalls: [{ name: 'read_file' }] });

	return createMockSession(turns);
}

// Helper: Session with no subagents
function createMockSessionNoSubagents(): DebugSession {
	return createMockSession([
		{ prompt: 'Implement the feature', toolCalls: [{ name: 'create_file' }] },
		{ prompt: 'approve', toolCalls: [] },
		{ prompt: 'Fix the bug', toolCalls: [{ name: 'replace_string_in_file' }] },
	]);
}

// Core helper to create mock session
function createMockSession(turns: Array<{ prompt: string; toolCalls: Array<{ name: string }>; timestamp?: Date; durationMs?: number }>): DebugSession {
	const allToolCalls: DebugSession['toolCalls'] = [];

	const mappedTurns = turns.map((t, i) => {
		const turnToolCalls = t.toolCalls.map((tc, j) => ({
			id: `tc-${i}-${j}`,
			name: tc.name,
			args: {},
			status: DebugItemStatus.Success,
			turnId: `turn-${i}`,
		}));
		allToolCalls.push(...turnToolCalls);

		return {
			id: `turn-${i}`,
			prompt: t.prompt,
			response: undefined,
			toolCalls: turnToolCalls,
			requests: [],
			status: DebugItemStatus.Success,
			index: i,
			timestamp: t.timestamp,
			durationMs: t.durationMs,
		};
	});

	return {
		sessionId: 'test-session-id',
		source: 'live',
		turns: mappedTurns,
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

// Helper to create a mock turn for turnsOverlap tests
function createMockTurn(index: number, prompt: string, timestamp?: Date, durationMs?: number): DebugTurn {
	return {
		id: `turn-${index}`,
		prompt,
		response: undefined,
		toolCalls: [],
		requests: [],
		status: DebugItemStatus.Success,
		index,
		timestamp,
		durationMs,
	};
}

// Helper: Session with parallel subagent execution (overlapping timestamps)
function createMockSessionWithParallelSubagents(): DebugSession {
	const baseTime = new Date('2024-01-01T10:00:00Z');

	// Create 20+ turns to trigger grouping (>15 turns threshold)
	const turns: Array<{ prompt: string; toolCalls: Array<{ name: string }>; timestamp?: Date; durationMs?: number }> = [];

	// Main agent turn
	turns.push({ prompt: 'Plan the task', toolCalls: [{ name: 'read_file' }] });

	// Parallel Oracle subagents (overlapping timestamps)
	for (let i = 0; i < 13; i++) {
		turns.push({
			prompt: `You are Oracle-subagent. Research task ${i + 1}`,
			toolCalls: [{ name: 'read_file' }, { name: 'grep_search' }],
			// Create overlapping timestamps (each starts before previous ends)
			timestamp: new Date(baseTime.getTime() + (i * 2000)), // Start 2s apart
			durationMs: 5000, // Each runs for 5s, so they overlap
		});
	}

	// Main agent turn
	turns.push({ prompt: 'Implement based on research', toolCalls: [{ name: 'create_file' }] });

	// More turns to ensure we're above threshold
	turns.push({ prompt: 'approve', toolCalls: [] });
	turns.push({ prompt: 'final review', toolCalls: [{ name: 'read_file' }] });
	turns.push({ prompt: 'approve', toolCalls: [] });

	return createMockSession(turns);
}

// Helper: Session with multiple runSubagent tool calls in a single turn (parallel invocation)
function createMockSessionWithParallelSubagentCalls(): DebugSession {
	// A turn with multiple runSubagent calls - these are invoked in parallel
	const turns = [
		{
			prompt: 'Implement the feature', toolCalls: [
				{ name: 'read_file' },
				{ name: 'runSubagent', args: { description: 'Research docs' } },
				{ name: 'runSubagent', args: { description: 'Check tests' } },
				{ name: 'runSubagent', args: { description: 'Review patterns' } },
			]
		},
		{ prompt: 'approve', toolCalls: [] },
	];

	const allToolCalls: DebugSession['toolCalls'] = [];

	const mappedTurns = turns.map((t, i) => {
		const turnToolCalls = t.toolCalls.map((tc, j) => ({
			id: `tc-${i}-${j}`,
			name: tc.name,
			args: (tc as { name: string; args?: Record<string, string> }).args || {},
			status: DebugItemStatus.Success,
			turnId: `turn-${i}`,
		}));
		allToolCalls.push(...turnToolCalls);

		return {
			id: `turn-${i}`,
			prompt: t.prompt,
			response: undefined,
			toolCalls: turnToolCalls,
			requests: [],
			status: DebugItemStatus.Success,
			index: i,
			timestamp: undefined,
			durationMs: undefined,
		};
	});

	return {
		sessionId: 'test-session-id',
		source: 'live',
		turns: mappedTurns,
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
