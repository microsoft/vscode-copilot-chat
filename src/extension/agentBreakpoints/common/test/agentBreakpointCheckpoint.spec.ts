/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IToolCallRound } from '../../../prompt/common/intents';
import { AgentBreakpointCheckpoint } from '../agentBreakpointCheckpoint';
import { AgentBreakpointServiceImpl } from '../agentBreakpointServiceImpl';
import { AgentBreakpointType, BreakpointResumeAction } from '../agentBreakpointTypes';

class MockLogService implements Partial<ILogService> {
	readonly _serviceBrand = undefined;
	info = vi.fn();
	warn = vi.fn();
	error = vi.fn();
	trace = vi.fn();
	debug = vi.fn();
}

class MockConfigurationService {
	readonly _serviceBrand = undefined;
	getConfig(_key: unknown): unknown {
		return false;
	}
}

function createRound(overrides?: Partial<IToolCallRound>): IToolCallRound {
	return {
		id: 'round-1',
		response: 'test response',
		toolInputRetry: 0,
		toolCalls: [],
		timestamp: Date.now(),
		...overrides,
	};
}

describe('AgentBreakpointCheckpoint', () => {
	let service: AgentBreakpointServiceImpl;
	let logService: MockLogService;
	let checkpoint: AgentBreakpointCheckpoint;

	beforeEach(() => {
		logService = new MockLogService();
		const configService = new MockConfigurationService();
		service = new AgentBreakpointServiceImpl(logService as unknown as ILogService, configService as unknown as IConfigurationService);
		checkpoint = new AgentBreakpointCheckpoint('test-session', service, logService as unknown as ILogService);
	});

	afterEach(() => {
		checkpoint.dispose();
		service.dispose();
	});

	describe('evaluate with no breakpoints', () => {
		it('should return Continue when no breakpoints are set', async () => {
			const result = await checkpoint.evaluate(0, undefined, false);
			expect(result).toBe(BreakpointResumeAction.Continue);
		});

		it('should return Continue when all breakpoints are disabled', async () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Error);
			service.setBreakpointEnabled(bp.id, false);
			const result = await checkpoint.evaluate(0, undefined, true);
			expect(result).toBe(BreakpointResumeAction.Continue);
		});
	});

	describe('tool breakpoint', () => {
		it('should pause when matching tool is called', async () => {
			service.addBreakpoint(AgentBreakpointType.Tool, { toolName: 'terminal' });
			const round = createRound({
				toolCalls: [{ id: 'tc-1', name: 'terminal', arguments: '{}' }],
			});

			// Start evaluation in the background
			const evalPromise = checkpoint.evaluate(1, round, false);

			// Checkpoint should be paused
			expect(checkpoint.isPaused).toBe(true);

			// Resume
			checkpoint.resume(BreakpointResumeAction.Continue);
			const result = await evalPromise;
			expect(result).toBe(BreakpointResumeAction.Continue);
			expect(checkpoint.isPaused).toBe(false);
		});

		it('should not pause for non-matching tool', async () => {
			service.addBreakpoint(AgentBreakpointType.Tool, { toolName: 'terminal' });
			const round = createRound({
				toolCalls: [{ id: 'tc-1', name: 'read_file', arguments: '{}' }],
			});
			const result = await checkpoint.evaluate(1, round, false);
			expect(result).toBe(BreakpointResumeAction.Continue);
		});
	});

	describe('error breakpoint', () => {
		it('should pause when hadError is true', async () => {
			service.addBreakpoint(AgentBreakpointType.Error);
			const round = createRound({ toolInputRetry: 1 });

			const evalPromise = checkpoint.evaluate(1, round, true);
			expect(checkpoint.isPaused).toBe(true);

			checkpoint.resume(BreakpointResumeAction.Continue);
			const result = await evalPromise;
			expect(result).toBe(BreakpointResumeAction.Continue);
		});

		it('should not pause when no error', async () => {
			service.addBreakpoint(AgentBreakpointType.Error);
			const round = createRound();
			const result = await checkpoint.evaluate(1, round, false);
			expect(result).toBe(BreakpointResumeAction.Continue);
		});
	});

	describe('iteration breakpoint', () => {
		it('should pause at the specified iteration', async () => {
			service.addBreakpoint(AgentBreakpointType.Iteration, { iteration: 3 });

			// Iterations 0, 1, 2 should pass
			expect(await checkpoint.evaluate(0, undefined, false)).toBe(BreakpointResumeAction.Continue);
			expect(await checkpoint.evaluate(1, createRound(), false)).toBe(BreakpointResumeAction.Continue);
			expect(await checkpoint.evaluate(2, createRound(), false)).toBe(BreakpointResumeAction.Continue);

			// Iteration 3 should pause
			const evalPromise = checkpoint.evaluate(3, createRound(), false);
			expect(checkpoint.isPaused).toBe(true);
			checkpoint.resume(BreakpointResumeAction.Continue);
			await evalPromise;
		});
	});

	describe('token threshold breakpoint', () => {
		it('should pause when tokens exceed threshold', async () => {
			service.addBreakpoint(AgentBreakpointType.TokenThreshold, { tokenThreshold: 1000 });
			service.recordTokenUsage(800, 300); // total = 1100

			const evalPromise = checkpoint.evaluate(1, createRound(), false);
			expect(checkpoint.isPaused).toBe(true);
			checkpoint.resume(BreakpointResumeAction.Continue);
			await evalPromise;
		});

		it('should not pause when tokens are below threshold', async () => {
			service.addBreakpoint(AgentBreakpointType.TokenThreshold, { tokenThreshold: 1000 });
			service.recordTokenUsage(400, 100); // total = 500

			const result = await checkpoint.evaluate(1, createRound(), false);
			expect(result).toBe(BreakpointResumeAction.Continue);
		});
	});

	describe('step mode', () => {
		it('should pause on every iteration in step mode', async () => {
			service.setStepMode(true);

			const evalPromise = checkpoint.evaluate(0, undefined, false);
			expect(checkpoint.isPaused).toBe(true);
			checkpoint.resume(BreakpointResumeAction.Continue);
			await evalPromise;
		});
	});

	describe('resume actions', () => {
		it('should support Step action (one-shot step)', async () => {
			// Use a tool breakpoint that only fires when the tool is present
			service.addBreakpoint(AgentBreakpointType.Tool, { toolName: 'terminal' });

			const roundWithTerminal = createRound({
				toolCalls: [{ id: 'tc-1', name: 'terminal', arguments: '{}' }],
			});
			const roundWithoutTerminal = createRound({
				toolCalls: [{ id: 'tc-2', name: 'read_file', arguments: '{}' }],
			});

			// Iteration 1 with terminal: should pause (tool breakpoint matches)
			const eval0 = checkpoint.evaluate(1, roundWithTerminal, false);
			checkpoint.resume(BreakpointResumeAction.Step);
			const result0 = await eval0;
			expect(result0).toBe(BreakpointResumeAction.Step);

			// Iteration 2 with read_file: should also pause (one-shot step active)
			const eval1 = checkpoint.evaluate(2, roundWithoutTerminal, false);
			expect(checkpoint.isPaused).toBe(true);
			checkpoint.resume(BreakpointResumeAction.Continue);
			await eval1;

			// Iteration 3 with read_file: should NOT pause (one-shot expired, no matching tool)
			const result2 = await checkpoint.evaluate(3, roundWithoutTerminal, false);
			expect(result2).toBe(BreakpointResumeAction.Continue);
		});

		it('should throw CancellationError on Abort', async () => {
			service.addBreakpoint(AgentBreakpointType.Iteration, { iteration: 0 });
			const evalPromise = checkpoint.evaluate(0, undefined, false);
			checkpoint.resume(BreakpointResumeAction.Abort);

			await expect(evalPromise).rejects.toThrow();
		});
	});

	describe('cancelPending', () => {
		it('should resolve pending promise with Continue', async () => {
			service.addBreakpoint(AgentBreakpointType.Iteration, { iteration: 0 });
			const evalPromise = checkpoint.evaluate(0, undefined, false);
			expect(checkpoint.isPaused).toBe(true);

			checkpoint.cancelPending();
			// The evaluate call should resolve (not hang)
			// Note: cancelPending resolves with Continue, but the CancellationError
			// from Abort won't be thrown since we used cancelPending
			const result = await evalPromise;
			expect(result).toBe(BreakpointResumeAction.Continue);
		});
	});

	describe('event notifications', () => {
		it('should fire onDidHitBreakpoint when a breakpoint matches', async () => {
			const listener = vi.fn();
			service.onDidHitBreakpoint(listener);

			service.addBreakpoint(AgentBreakpointType.Error);
			const evalPromise = checkpoint.evaluate(2, createRound(), true);

			expect(listener).toHaveBeenCalledTimes(1);
			const ctx = listener.mock.calls[0][0];
			expect(ctx.iteration).toBe(2);
			expect(ctx.hadError).toBe(true);
			expect(ctx.sessionId).toBe('test-session');

			checkpoint.resume(BreakpointResumeAction.Continue);
			await evalPromise;
		});

		it('should fire onDidResumeFromBreakpoint on resume', async () => {
			const listener = vi.fn();
			service.onDidResumeFromBreakpoint(listener);

			service.addBreakpoint(AgentBreakpointType.Error);
			const evalPromise = checkpoint.evaluate(0, createRound(), true);
			checkpoint.resume(BreakpointResumeAction.Step);
			await evalPromise;

			expect(listener).toHaveBeenCalledWith(BreakpointResumeAction.Step);
		});
	});

	describe('multiple breakpoints', () => {
		it('should match the first matching breakpoint', async () => {
			service.addBreakpoint(AgentBreakpointType.Error);
			service.addBreakpoint(AgentBreakpointType.Tool, { toolName: 'terminal' });

			const round = createRound({
				toolCalls: [{ id: 'tc-1', name: 'terminal', arguments: '{}' }],
			});

			// Error breakpoint is first in the list, and hadError=true, so it should match first
			const hitListener = vi.fn();
			service.onDidHitBreakpoint(hitListener);

			const evalPromise = checkpoint.evaluate(1, round, true);
			expect(hitListener.mock.calls[0][0].breakpoint.type).toBe(AgentBreakpointType.Error);

			checkpoint.resume(BreakpointResumeAction.Continue);
			await evalPromise;
		});
	});
});
