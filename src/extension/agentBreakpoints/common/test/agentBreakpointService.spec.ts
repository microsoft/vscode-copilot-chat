/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
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
		return false; // All settings default to false
	}
}

describe('AgentBreakpointServiceImpl', () => {
	let service: AgentBreakpointServiceImpl;
	let logService: MockLogService;
	let configService: MockConfigurationService;

	beforeEach(() => {
		logService = new MockLogService();
		configService = new MockConfigurationService();
		service = new AgentBreakpointServiceImpl(logService as unknown as ILogService, configService as unknown as IConfigurationService);
	});

	afterEach(() => {
		service.dispose();
	});

	describe('addBreakpoint', () => {
		it('should add a tool breakpoint', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Tool, { toolName: 'terminal' });
			expect(bp.type).toBe(AgentBreakpointType.Tool);
			expect(bp.toolName).toBe('terminal');
			expect(bp.enabled).toBe(true);
			expect(bp.label).toBe('Break on tool: terminal');
			expect(service.breakpoints).toHaveLength(1);
		});

		it('should add an error breakpoint', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Error);
			expect(bp.type).toBe(AgentBreakpointType.Error);
			expect(bp.label).toBe('Break on tool error');
		});

		it('should add an iteration breakpoint', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Iteration, { iteration: 5 });
			expect(bp.type).toBe(AgentBreakpointType.Iteration);
			expect(bp.iteration).toBe(5);
			expect(bp.label).toBe('Break at iteration 5');
		});

		it('should add a token threshold breakpoint', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.TokenThreshold, { tokenThreshold: 50000 });
			expect(bp.type).toBe(AgentBreakpointType.TokenThreshold);
			expect(bp.tokenThreshold).toBe(50000);
		});

		it('should use custom label when provided', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Tool, {
				toolName: 'edit_file',
				label: 'Pause before edits',
			});
			expect(bp.label).toBe('Pause before edits');
		});

		it('should default to enabled', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Error);
			expect(bp.enabled).toBe(true);
		});

		it('should support creating disabled breakpoints', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Error, { enabled: false });
			expect(bp.enabled).toBe(false);
		});

		it('should fire onDidChangeBreakpoints', () => {
			const listener = vi.fn();
			service.onDidChangeBreakpoints(listener);
			service.addBreakpoint(AgentBreakpointType.Error);
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('should generate unique IDs', () => {
			const bp1 = service.addBreakpoint(AgentBreakpointType.Error);
			const bp2 = service.addBreakpoint(AgentBreakpointType.Error);
			expect(bp1.id).not.toBe(bp2.id);
		});
	});

	describe('removeBreakpoint', () => {
		it('should remove an existing breakpoint', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Error);
			expect(service.removeBreakpoint(bp.id)).toBe(true);
			expect(service.breakpoints).toHaveLength(0);
		});

		it('should return false for non-existent ID', () => {
			expect(service.removeBreakpoint('nonexistent')).toBe(false);
		});

		it('should fire onDidChangeBreakpoints', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Error);
			const listener = vi.fn();
			service.onDidChangeBreakpoints(listener);
			service.removeBreakpoint(bp.id);
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe('removeAllBreakpoints', () => {
		it('should remove all breakpoints', () => {
			service.addBreakpoint(AgentBreakpointType.Error);
			service.addBreakpoint(AgentBreakpointType.Tool, { toolName: 'terminal' });
			service.addBreakpoint(AgentBreakpointType.Iteration, { iteration: 3 });
			service.removeAllBreakpoints();
			expect(service.breakpoints).toHaveLength(0);
		});

		it('should also disable step mode', () => {
			service.setStepMode(true);
			service.removeAllBreakpoints();
			expect(service.isStepMode).toBe(false);
		});

		it('should not fire event if already empty', () => {
			const listener = vi.fn();
			service.onDidChangeBreakpoints(listener);
			service.removeAllBreakpoints();
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('setBreakpointEnabled', () => {
		it('should toggle enabled state', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Error);
			service.setBreakpointEnabled(bp.id, false);
			expect(service.breakpoints[0].enabled).toBe(false);
			service.setBreakpointEnabled(bp.id, true);
			expect(service.breakpoints[0].enabled).toBe(true);
		});

		it('should fire onDidChangeBreakpoints', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.Error);
			const listener = vi.fn();
			service.onDidChangeBreakpoints(listener);
			service.setBreakpointEnabled(bp.id, false);
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe('step mode', () => {
		it('should be off by default', () => {
			expect(service.isStepMode).toBe(false);
		});

		it('should toggle on and off', () => {
			service.setStepMode(true);
			expect(service.isStepMode).toBe(true);
			service.setStepMode(false);
			expect(service.isStepMode).toBe(false);
		});

		it('should fire onDidChangeBreakpoints when toggled', () => {
			const listener = vi.fn();
			service.onDidChangeBreakpoints(listener);
			service.setStepMode(true);
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('should not fire if already in target state', () => {
			service.setStepMode(true);
			const listener = vi.fn();
			service.onDidChangeBreakpoints(listener);
			service.setStepMode(true);
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('token tracking', () => {
		it('should start at zero', () => {
			expect(service.getTokenUsage()).toEqual({ promptTokens: 0, completionTokens: 0 });
		});

		it('should accumulate token usage', () => {
			service.recordTokenUsage(100, 50);
			service.recordTokenUsage(200, 30);
			expect(service.getTokenUsage()).toEqual({ promptTokens: 300, completionTokens: 80 });
		});

		it('should reset on new session', () => {
			service.recordTokenUsage(100, 50);
			service.resetSession();
			expect(service.getTokenUsage()).toEqual({ promptTokens: 0, completionTokens: 0 });
		});

		it('should also reset step mode on new session', () => {
			service.setStepMode(true);
			service.resetSession();
			expect(service.isStepMode).toBe(false);
		});
	});

	describe('event firing', () => {
		it('should fire onDidHitBreakpoint', () => {
			const listener = vi.fn();
			service.onDidHitBreakpoint(listener);
			const bp = service.addBreakpoint(AgentBreakpointType.Error);
			service.fireBreakpointHit({
				breakpoint: bp,
				iteration: 3,
				totalPromptTokens: 1000,
				totalCompletionTokens: 500,
				hadError: true,
				sessionId: 'test-session',
				elapsedMs: 5000,
			});
			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener.mock.calls[0][0].breakpoint.id).toBe(bp.id);
		});

		it('should fire onDidResumeFromBreakpoint', () => {
			const listener = vi.fn();
			service.onDidResumeFromBreakpoint(listener);
			service.fireResumed(BreakpointResumeAction.Continue);
			expect(listener).toHaveBeenCalledWith(BreakpointResumeAction.Continue);
		});
	});

	describe('per-tool-call breakpoints', () => {
		it('should report hasToolCallBreakpoints when BeforeToolCall is set', () => {
			expect(service.hasToolCallBreakpoints()).toBe(false);
			service.addBreakpoint(AgentBreakpointType.BeforeToolCall);
			expect(service.hasToolCallBreakpoints()).toBe(true);
		});

		it('should report hasToolCallBreakpoints when AfterToolCall is set', () => {
			service.addBreakpoint(AgentBreakpointType.AfterToolCall);
			expect(service.hasToolCallBreakpoints()).toBe(true);
		});

		it('should not report hasToolCallBreakpoints for other types', () => {
			service.addBreakpoint(AgentBreakpointType.Tool, { toolName: 'terminal' });
			service.addBreakpoint(AgentBreakpointType.Error);
			expect(service.hasToolCallBreakpoints()).toBe(false);
		});

		it('should not report disabled tool call breakpoints', () => {
			const bp = service.addBreakpoint(AgentBreakpointType.BeforeToolCall);
			service.setBreakpointEnabled(bp.id, false);
			expect(service.hasToolCallBreakpoints()).toBe(false);
		});

		it('should pause on evaluateToolCallBreakpoint for before timing', async () => {
			service.addBreakpoint(AgentBreakpointType.BeforeToolCall);

			const evalPromise = service.evaluateToolCallBreakpoint(
				'before', 'read_file', 'tc-1', '{"path":"test.ts"}', 'session-1'
			);

			// Should be paused — resume it
			service.resumeToolCallBreakpoint(BreakpointResumeAction.Continue);
			const result = await evalPromise;
			expect(result).toBe(BreakpointResumeAction.Continue);
		});

		it('should pause on evaluateToolCallBreakpoint for after timing', async () => {
			service.addBreakpoint(AgentBreakpointType.AfterToolCall);

			const evalPromise = service.evaluateToolCallBreakpoint(
				'after', 'read_file', 'tc-1', '{}', 'session-1', 'file content', false
			);

			service.resumeToolCallBreakpoint(BreakpointResumeAction.Continue);
			const result = await evalPromise;
			expect(result).toBe(BreakpointResumeAction.Continue);
		});

		it('should not pause when no matching timing breakpoint exists', async () => {
			service.addBreakpoint(AgentBreakpointType.BeforeToolCall);

			// 'after' timing should not match BeforeToolCall
			const result = await service.evaluateToolCallBreakpoint(
				'after', 'read_file', 'tc-1', '{}', 'session-1'
			);
			expect(result).toBe(BreakpointResumeAction.Continue);
		});

		it('should fire onDidHitToolCallBreakpoint event', async () => {
			const listener = vi.fn();
			service.onDidHitToolCallBreakpoint(listener);
			service.addBreakpoint(AgentBreakpointType.BeforeToolCall);

			const evalPromise = service.evaluateToolCallBreakpoint(
				'before', 'terminal', 'tc-2', '{"command":"ls"}', 'session-1'
			);

			expect(listener).toHaveBeenCalledTimes(1);
			const ctx = listener.mock.calls[0][0];
			expect(ctx.timing).toBe('before');
			expect(ctx.toolName).toBe('terminal');
			expect(ctx.toolCallId).toBe('tc-2');

			service.resumeToolCallBreakpoint(BreakpointResumeAction.Continue);
			await evalPromise;
		});

		it('should throw CancellationError on Abort', async () => {
			service.addBreakpoint(AgentBreakpointType.BeforeToolCall);

			const evalPromise = service.evaluateToolCallBreakpoint(
				'before', 'terminal', 'tc-1', '{}', 'session-1'
			);

			service.resumeToolCallBreakpoint(BreakpointResumeAction.Abort);
			await expect(evalPromise).rejects.toThrow();
		});

		it('should generate correct labels', () => {
			const bp1 = service.addBreakpoint(AgentBreakpointType.BeforeToolCall);
			expect(bp1.label).toBe('Break before every tool call');
			const bp2 = service.addBreakpoint(AgentBreakpointType.AfterToolCall);
			expect(bp2.label).toBe('Break after every tool call');
		});
	});

});
