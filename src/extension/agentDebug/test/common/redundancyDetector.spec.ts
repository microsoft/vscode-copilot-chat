/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, expect, suite, test } from 'vitest';
import { AgentDebugEventCategory, IToolCallEvent } from '../../common/agentDebugTypes';
import { IRedundancyPattern, RedundancyDetector } from '../../common/redundancyDetector';

function makeToolCall(toolName: string, argsSummary: string = ''): IToolCallEvent {
	return {
		id: 'test-id',
		timestamp: Date.now(),
		category: AgentDebugEventCategory.ToolCall,
		sessionId: 'test-session',
		summary: `Tool: ${toolName}`,
		details: {},
		toolName,
		argsSummary,
		status: 'success',
	};
}

function findPattern(patterns: IRedundancyPattern[], type: IRedundancyPattern['type']): IRedundancyPattern | undefined {
	return patterns.find(p => p.type === type);
}

suite('RedundancyDetector', () => {
	let detector: RedundancyDetector;

	beforeEach(() => {
		detector = new RedundancyDetector();
	});

	suite('duplicate detection', () => {
		test('first call produces no patterns', () => {
			const patterns = detector.addToolCall(makeToolCall('read_file', '/foo.ts'));
			expect(findPattern(patterns, 'duplicate')).toBeUndefined();
		});

		test('second identical call fires duplicate', () => {
			detector.addToolCall(makeToolCall('read_file', '/foo.ts'));
			const patterns = detector.addToolCall(makeToolCall('read_file', '/foo.ts'));
			expect(findPattern(patterns, 'duplicate')).toBeDefined();
			expect(findPattern(patterns, 'duplicate')!.occurrences).toBe(2);
		});

		test('third identical call does NOT re-fire duplicate', () => {
			detector.addToolCall(makeToolCall('read_file', '/foo.ts'));
			detector.addToolCall(makeToolCall('read_file', '/foo.ts'));
			const patterns = detector.addToolCall(makeToolCall('read_file', '/foo.ts'));
			expect(findPattern(patterns, 'duplicate')).toBeUndefined();
		});

		test('same tool with different args is not a duplicate', () => {
			detector.addToolCall(makeToolCall('read_file', '/foo.ts'));
			const patterns = detector.addToolCall(makeToolCall('read_file', '/bar.ts'));
			expect(findPattern(patterns, 'duplicate')).toBeUndefined();
		});

		test('different tools with same args are not duplicates', () => {
			detector.addToolCall(makeToolCall('read_file', '/foo.ts'));
			const patterns = detector.addToolCall(makeToolCall('write_file', '/foo.ts'));
			expect(findPattern(patterns, 'duplicate')).toBeUndefined();
		});
	});

	suite('excessive retry detection', () => {
		test('two consecutive identical calls do not trigger retry', () => {
			detector.addToolCall(makeToolCall('grep', 'pattern'));
			const patterns = detector.addToolCall(makeToolCall('grep', 'pattern'));
			// duplicate fires, but not excessiveRetry (threshold is 3)
			expect(findPattern(patterns, 'excessiveRetry')).toBeUndefined();
		});

		test('three consecutive identical calls trigger retry', () => {
			detector.addToolCall(makeToolCall('grep', 'pattern'));
			detector.addToolCall(makeToolCall('grep', 'pattern'));
			const patterns = detector.addToolCall(makeToolCall('grep', 'pattern'));
			expect(findPattern(patterns, 'excessiveRetry')).toBeDefined();
			expect(findPattern(patterns, 'excessiveRetry')!.occurrences).toBe(3);
		});

		test('interleaving a different tool resets retry count', () => {
			detector.addToolCall(makeToolCall('grep', 'a'));
			detector.addToolCall(makeToolCall('grep', 'a'));
			detector.addToolCall(makeToolCall('read_file', '/x'));
			// restart — should NOT trigger retry threshold
			detector.addToolCall(makeToolCall('grep', 'a'));
			const patterns = detector.addToolCall(makeToolCall('grep', 'a'));
			expect(findPattern(patterns, 'excessiveRetry')).toBeUndefined();
		});

		test('consecutive calls require same key (tool+args)', () => {
			// changing args changes the key, so consecutive count resets
			detector.addToolCall(makeToolCall('grep', 'a'));
			detector.addToolCall(makeToolCall('grep', 'b'));
			const patterns = detector.addToolCall(makeToolCall('grep', 'c'));
			expect(findPattern(patterns, 'excessiveRetry')).toBeUndefined();
		});
	});

	suite('oscillation detection', () => {
		test('A→B→A→B triggers oscillation', () => {
			detector.addToolCall(makeToolCall('read_file', '1'));
			detector.addToolCall(makeToolCall('grep', '2'));
			detector.addToolCall(makeToolCall('read_file', '3'));
			const patterns = detector.addToolCall(makeToolCall('grep', '4'));
			expect(findPattern(patterns, 'oscillation')).toBeDefined();
			expect(findPattern(patterns, 'oscillation')!.toolName).toContain('read_file');
			expect(findPattern(patterns, 'oscillation')!.toolName).toContain('grep');
		});

		test('fewer than 4 calls does not trigger oscillation', () => {
			detector.addToolCall(makeToolCall('read_file', '1'));
			detector.addToolCall(makeToolCall('grep', '2'));
			const patterns = detector.addToolCall(makeToolCall('read_file', '3'));
			expect(findPattern(patterns, 'oscillation')).toBeUndefined();
		});

		test('same tool repeated does not trigger oscillation', () => {
			detector.addToolCall(makeToolCall('grep', '1'));
			detector.addToolCall(makeToolCall('grep', '2'));
			detector.addToolCall(makeToolCall('grep', '3'));
			const patterns = detector.addToolCall(makeToolCall('grep', '4'));
			expect(findPattern(patterns, 'oscillation')).toBeUndefined();
		});

		test('A→B→C→A does not trigger oscillation', () => {
			detector.addToolCall(makeToolCall('a', ''));
			detector.addToolCall(makeToolCall('b', ''));
			detector.addToolCall(makeToolCall('c', ''));
			const patterns = detector.addToolCall(makeToolCall('a', ''));
			expect(findPattern(patterns, 'oscillation')).toBeUndefined();
		});
	});

	suite('toPartialErrorEvent', () => {
		test('converts pattern to error event shape', () => {
			const pattern: IRedundancyPattern = {
				type: 'duplicate',
				toolName: 'grep',
				occurrences: 2,
				description: '"grep" called 2 times with identical args',
			};
			const event = RedundancyDetector.toPartialErrorEvent(pattern, 'session-1');
			expect(event.category).toBe(AgentDebugEventCategory.Error);
			expect(event.sessionId).toBe('session-1');
			expect(event.errorType).toBe('redundancy');
			expect(event.toolName).toBe('grep');
			expect(event.summary).toContain('Redundancy');
		});
	});

	suite('combined patterns', () => {
		test('duplicate and retry can fire together on same call', () => {
			// Call 1 & 2: sets up duplicate + starts consecutive count
			detector.addToolCall(makeToolCall('run', 'x'));
			detector.addToolCall(makeToolCall('run', 'x'));
			// Call 3: hits retry threshold (3 consecutive)
			const patterns = detector.addToolCall(makeToolCall('run', 'x'));
			// duplicate only fires at crossing (call 2), but retry fires here
			expect(findPattern(patterns, 'excessiveRetry')).toBeDefined();
			// duplicate should NOT re-fire (already fired on call 2)
			expect(findPattern(patterns, 'duplicate')).toBeUndefined();
		});

		test('recent tools buffer is bounded', () => {
			// Push more than 8 calls — buffer should not grow unbounded
			for (let i = 0; i < 20; i++) {
				detector.addToolCall(makeToolCall(`tool_${i}`, ''));
			}
			// Oscillation should only look at last 8 entries
			detector.addToolCall(makeToolCall('a', ''));
			detector.addToolCall(makeToolCall('b', ''));
			detector.addToolCall(makeToolCall('a', ''));
			const patterns = detector.addToolCall(makeToolCall('b', ''));
			expect(findPattern(patterns, 'oscillation')).toBeDefined();
		});
	});
});
