/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionMetricsService } from './executionMetricsService';

describe('ExecutionMetricsService', () => {
	let service: ExecutionMetricsService;
	const sessionId = 'test-session-123';

	beforeEach(() => {
		service = new ExecutionMetricsService();
	});

	it('should start and end a session', () => {
		service.startSession(sessionId);
		const metrics = service.getMetrics(sessionId);

		expect(metrics).toBeDefined();
		expect(metrics?.sessionId).toBe(sessionId);
		expect(metrics?.totalToolCalls).toBe(0);
	});

	it('should track tool calls', () => {
		service.startSession(sessionId);

		const callId1 = service.recordToolCallStart(sessionId, 'readFile');
		service.recordToolCallEnd(sessionId, callId1, 'success', 100);

		const metrics = service.getMetrics(sessionId);
		expect(metrics?.totalToolCalls).toBe(1);
		expect(metrics?.successfulToolCalls).toBe(1);
		expect(metrics?.failedToolCalls).toBe(0);
	});

	it('should track failed tool calls', () => {
		service.startSession(sessionId);

		const callId = service.recordToolCallStart(sessionId, 'editFile');
		service.recordToolCallEnd(sessionId, callId, 'error', 0, 'File not found');

		const metrics = service.getMetrics(sessionId);
		expect(metrics?.totalToolCalls).toBe(1);
		expect(metrics?.successfulToolCalls).toBe(0);
		expect(metrics?.failedToolCalls).toBe(1);
	});

	it('should calculate token usage', () => {
		service.startSession(sessionId);

		const callId1 = service.recordToolCallStart(sessionId, 'readFile');
		service.recordToolCallEnd(sessionId, callId1, 'success', 500);

		const callId2 = service.recordToolCallStart(sessionId, 'findFiles');
		service.recordToolCallEnd(sessionId, callId2, 'success', 300);

		const metrics = service.getMetrics(sessionId);
		expect(metrics?.estimatedTokensUsed).toBe(800);
	});

	it('should estimate cost from tokens', () => {
		service.startSession(sessionId);

		const callId = service.recordToolCallStart(sessionId, 'codebase');
		service.recordToolCallEnd(sessionId, callId, 'success', 1_000_000);

		const finalMetrics = service.endSession(sessionId);
		// With default pricing of $0.02 per 1M tokens, 1M tokens = $0.02
		expect(finalMetrics?.estimatedApiCostUSD).toBeCloseTo(0.02, 3);
	});

	it('should calculate duration', () => {
		service.startSession(sessionId);

		const callId = service.recordToolCallStart(sessionId, 'search');
		// Simulate some time passing
		service.recordToolCallEnd(sessionId, callId, 'success', 100);

		const finalMetrics = service.endSession(sessionId);
		expect(finalMetrics?.totalDuration).toBeGreaterThanOrEqual(0);
		expect(finalMetrics?.startTime).toBeLessThanOrEqual(finalMetrics?.endTime!);
	});

	it('should clean up session on end', () => {
		service.startSession(sessionId);
		service.endSession(sessionId);

		const metrics = service.getMetrics(sessionId);
		expect(metrics).toBeUndefined();
	});

	it('should handle multiple sessions', () => {
		const sessionId2 = 'test-session-456';

		service.startSession(sessionId);
		service.startSession(sessionId2);

		const callId1 = service.recordToolCallStart(sessionId, 'readFile');
		service.recordToolCallEnd(sessionId, callId1, 'success', 100);

		const callId2 = service.recordToolCallStart(sessionId2, 'editFile');
		service.recordToolCallEnd(sessionId2, callId2, 'success', 200);

		const metrics1 = service.getMetrics(sessionId);
		const metrics2 = service.getMetrics(sessionId2);

		expect(metrics1?.totalToolCalls).toBe(1);
		expect(metrics2?.totalToolCalls).toBe(1);
	});

	it('should estimate cost correctly', () => {
		const cost1 = service.estimateCost(1_000_000);
		expect(cost1).toBeCloseTo(0.02, 3); // $0.02 for 1M tokens

		const cost2 = service.estimateCost(500_000);
		expect(cost2).toBeCloseTo(0.01, 3); // $0.01 for 500K tokens
	});
});
