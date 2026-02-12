/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Test fixtures representing real-world multi-agent session data.
 * Based on atlas1 chatreplay logs (28 prompts: 11 main, 17 subagent).
 */

/**
 * Minimal representation of a chatreplay prompt for testing
 */
export interface TestPromptFixture {
	prompt: string;
	toolCallCount: number;
	/** Optional timestamp for testing parallel execution detection */
	timestamp?: Date;
	/** Optional duration in ms */
	durationMs?: number;
}

/**
 * Atlas1 session: Multi-agent collaboration task
 * - 28 total prompts
 * - 11 main agent prompts
 * - 17 subagent prompts:
 *   - Oracle-subagent: 13 turns (research tasks)
 *   - Sisyphus-subagent: 2 turns (implementation/fixes)
 *   - Code-Review-subagent: 2 turns (code review)
 *
 * Pattern observed:
 * - Turns 0-12: Oracle-subagent (13 consecutive)
 * - Turns 13-16: Main agent
 * - Turn 17: Sisyphus-subagent
 * - Turns 18-19: Main agent
 * - Turn 20: Code-Review-subagent
 * - Turns 21-22: Main agent
 * - Turn 23: Sisyphus-subagent
 * - Turn 24: Main agent
 * - Turn 25: Code-Review-subagent
 * - Turns 26-27: Main agent
 *
 * IMPORTANT: This data is extracted from real atlas1 chatreplay logs.
 * Do NOT modify unless updating from a new source log file.
 */
export const ATLAS1_PROMPTS: TestPromptFixture[] = [
	// Oracle-subagent research phase (turns 0-12) - 13 consecutive
	{ prompt: 'You are Oracle-subagent. Research the collaboration endpoint configuration system...', toolCallCount: 4 },
	{ prompt: 'You are Oracle-subagent. Research the settings UI implementation patterns in depth...', toolCallCount: 2 },
	{ prompt: 'You are Oracle-subagent. Research the collaboration endpoint configuration system...', toolCallCount: 0 },
	{ prompt: 'You are Oracle-subagent. Research the settings UI implementation patterns in depth...', toolCallCount: 1 },
	{ prompt: 'You are Oracle-subagent. Research the collaboration endpoint configuration system...', toolCallCount: 2 },
	{ prompt: 'You are Oracle-subagent. Research the settings UI implementation patterns in depth...', toolCallCount: 2 },
	{ prompt: 'You are Oracle-subagent. Research the collaboration endpoint configuration system...', toolCallCount: 0 },
	{ prompt: 'You are Oracle-subagent. Research the settings UI implementation patterns in depth...', toolCallCount: 0 },
	{ prompt: 'You are Oracle-subagent. Research the collaboration endpoint configuration system...', toolCallCount: 2 },
	{ prompt: 'You are Oracle-subagent. Research the settings UI implementation patterns in depth...', toolCallCount: 2 },
	{ prompt: 'You are Oracle-subagent. Research the collaboration endpoint configuration system...', toolCallCount: 1 },
	{ prompt: 'You are Oracle-subagent. Research the settings UI implementation patterns in depth...', toolCallCount: 0 },
	{ prompt: 'You are Oracle-subagent. Research the collaboration endpoint configuration system...', toolCallCount: 0 },

	// Main agent implementation phase (turns 13-16)
	{ prompt: 'Add option to configure collab/coediting endpoint and UI to pick the endpoint...', toolCallCount: 3 },
	{ prompt: 'Add option to configure collab/coediting endpoint and UI to pick the endpoint...', toolCallCount: 0 },
	{ prompt: 'approve', toolCallCount: 2 },
	{ prompt: 'approve', toolCallCount: 0 },

	// Sisyphus implementation (turn 17)
	{ prompt: 'You are Sisyphus-subagent, the implementer. Your task is to implement Phase 1 of...', toolCallCount: 6 },

	// Main agent (turns 18-19)
	{ prompt: 'approve', toolCallCount: 2 },
	{ prompt: 'approve', toolCallCount: 0 },

	// Code-Review (turn 20)
	{ prompt: 'You are Code-Review-subagent. Review the Phase 1 implementation of the collab en...', toolCallCount: 8 },

	// Main agent (turns 21-22)
	{ prompt: 'approve', toolCallCount: 1 },
	{ prompt: 'approve', toolCallCount: 0 },

	// Sisyphus fix (turn 23)
	{ prompt: 'You are Sisyphus-subagent. Fix the naming inconsistency issues found during code...', toolCallCount: 6 },

	// Main agent (turn 24)
	{ prompt: 'approve', toolCallCount: 1 },

	// Code-Review re-review (turn 25)
	{ prompt: 'You are Code-Review-subagent. Quick re-review of Phase 1 after naming fixes...', toolCallCount: 2 },

	// Main agent (turns 26-27)
	{ prompt: 'approve', toolCallCount: 3 },
	{ prompt: 'approve', toolCallCount: 0 },
];

/**
 * Expected metrics for atlas1 session
 */
export const ATLAS1_EXPECTED = {
	totalPrompts: 28,
	mainAgentTurns: 11,
	subagentTurns: 17,
	subagentDistribution: {
		'Oracle': 13,
		'Sisyphus': 2,
		'Code': 2,
	},
	consecutiveOracleGroupSize: 13,
	consecutiveOracleGroupStartIndex: 0,
	consecutiveOracleGroupEndIndex: 12,
};

/**
 * Simple session with no subagents for baseline testing
 */
export const SIMPLE_NO_SUBAGENTS_PROMPTS: TestPromptFixture[] = [
	{ prompt: 'Implement the new feature', toolCallCount: 5 },
	{ prompt: 'Fix the bug in the code', toolCallCount: 3 },
	{ prompt: 'approve', toolCallCount: 0 },
	{ prompt: 'Add unit tests', toolCallCount: 4 },
];

/**
 * Session with interleaved subagent turns (no long consecutive runs)
 */
export const INTERLEAVED_SUBAGENTS_PROMPTS: TestPromptFixture[] = [
	{ prompt: 'Start the task', toolCallCount: 1 },
	{ prompt: 'You are Oracle-subagent. Research task A', toolCallCount: 2 },
	{ prompt: 'Continue implementation', toolCallCount: 3 },
	{ prompt: 'You are Sisyphus-subagent. Fix issue X', toolCallCount: 1 },
	{ prompt: 'approve', toolCallCount: 0 },
	{ prompt: 'You are Oracle-subagent. Research task B', toolCallCount: 2 },
	{ prompt: 'Finalize', toolCallCount: 1 },
];

/**
 * Session with PARALLEL subagent execution (based on atlas1 timestamps)
 * Turns 0-3 have overlapping timestamps indicating parallel execution.
 *
 * Timeline:
 * - Turn 0: 00:00.000 - 00:06.000 (6s)
 * - Turn 1: 00:05.000 - 00:09.000 (4s) - overlaps with 0
 * - Turn 2: 00:06.000 - 00:12.000 (6s) - overlaps with 1
 * - Turn 3: 00:10.000 - 00:14.000 (4s) - overlaps with 2
 * - Turn 4: 00:15.000 - 00:20.000 (5s) - sequential (main agent)
 */
export const PARALLEL_SUBAGENTS_PROMPTS: TestPromptFixture[] = [
	// Parallel Oracle subagents (overlapping timestamps)
	{
		prompt: 'You are Oracle-subagent. Research endpoint configuration',
		toolCallCount: 4,
		timestamp: new Date('2026-02-12T15:27:44.000Z'),
		durationMs: 6000
	},
	{
		prompt: 'You are Oracle-subagent. Research settings UI patterns',
		toolCallCount: 2,
		timestamp: new Date('2026-02-12T15:27:49.000Z'), // Overlaps with turn 0
		durationMs: 4000
	},
	{
		prompt: 'You are Oracle-subagent. Research integration details',
		toolCallCount: 3,
		timestamp: new Date('2026-02-12T15:27:50.000Z'), // Overlaps with turn 1
		durationMs: 6000
	},
	{
		prompt: 'You are Oracle-subagent. Research validation patterns',
		toolCallCount: 1,
		timestamp: new Date('2026-02-12T15:27:54.000Z'), // Overlaps with turn 2
		durationMs: 4000
	},
	// Main agent (sequential, no overlap)
	{
		prompt: 'Implement the feature based on research',
		toolCallCount: 5,
		timestamp: new Date('2026-02-12T15:28:00.000Z'), // No overlap
		durationMs: 5000
	},
];

/**
 * Expected metrics for parallel execution session
 */
export const PARALLEL_EXPECTED = {
	totalPrompts: 5,
	mainAgentTurns: 1,
	subagentTurns: 4,
	hasParallelExecution: true,
	parallelOracleCount: 4,
};
