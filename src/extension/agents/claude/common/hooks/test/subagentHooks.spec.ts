/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubagentStartHookInput, SubagentStopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ILogService } from '../../../../../../platform/log/common/logService';
import { SubagentStartLoggingHook, SubagentStopLoggingHook } from '../subagentHooks';

// Helper to create base hook input fields
function createBaseHookInput() {
	return {
		session_id: 'test-session',
		transcript_path: '/path/to/transcript',
		cwd: '/current/working/dir'
	};
}

// Helper to create SubagentStartHookInput
function createSubagentStartInput(overrides: Partial<SubagentStartHookInput> = {}): SubagentStartHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'SubagentStart',
		agent_id: 'agent-default',
		agent_type: 'default',
		...overrides
	} as SubagentStartHookInput;
}

// Helper to create SubagentStopHookInput
function createSubagentStopInput(overrides: Partial<SubagentStopHookInput> = {}): SubagentStopHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'SubagentStop',
		stop_hook_active: false,
		agent_id: 'agent-default',
		agent_transcript_path: '/path/to/agent/transcript',
		...overrides
	} as SubagentStopHookInput;
}

describe('subagentHooks', () => {
	let mockLogService: ILogService;

	beforeEach(() => {
		mockLogService = createMockLogService();
	});

	describe('SubagentStartLoggingHook', () => {
		it('logs subagent start with agent id and type', async () => {
			const hook = new SubagentStartLoggingHook(mockLogService);
			const input = createSubagentStartInput({
				agent_id: 'agent-001',
				agent_type: 'explorer'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] SubagentStart Hook: agentId=agent-001, agentType=explorer'
			);
		});

		it('handles different agent types', async () => {
			const hook = new SubagentStartLoggingHook(mockLogService);
			const agentTypes = ['planner', 'coder', 'researcher', 'validator'];

			for (const agentType of agentTypes) {
				vi.clearAllMocks();

				const input = createSubagentStartInput({
					agent_id: `agent-${agentType}`,
					agent_type: agentType
				});

				const result = await hook.hooks[0](input, undefined, {} as never);

				expect(result).toEqual({ continue: true });
				expect(mockLogService.trace).toHaveBeenCalledWith(
					`[ClaudeCodeSession] SubagentStart Hook: agentId=agent-${agentType}, agentType=${agentType}`
				);
			}
		});

		it('handles UUID-style agent ids', async () => {
			const hook = new SubagentStartLoggingHook(mockLogService);
			const agentId = '550e8400-e29b-41d4-a716-446655440000';
			const input = createSubagentStartInput({
				agent_id: agentId,
				agent_type: 'general'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				`[ClaudeCodeSession] SubagentStart Hook: agentId=${agentId}, agentType=general`
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new SubagentStartLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});

		it('implements HookCallbackMatcher interface', () => {
			const hook = new SubagentStartLoggingHook(mockLogService);
			expect(hook.hooks).toBeDefined();
			expect(Array.isArray(hook.hooks)).toBe(true);
		});
	});

	describe('SubagentStopLoggingHook', () => {
		it('logs subagent stop with stop hook active true', async () => {
			const hook = new SubagentStopLoggingHook(mockLogService);
			const input = createSubagentStopInput({
				stop_hook_active: true
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] SubagentStop Hook: stopHookActive=true'
			);
		});

		it('logs subagent stop with stop hook active false', async () => {
			const hook = new SubagentStopLoggingHook(mockLogService);
			const input = createSubagentStopInput({
				stop_hook_active: false
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] SubagentStop Hook: stopHookActive=false'
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new SubagentStopLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});

		it('implements HookCallbackMatcher interface', () => {
			const hook = new SubagentStopLoggingHook(mockLogService);
			expect(hook.hooks).toBeDefined();
			expect(Array.isArray(hook.hooks)).toBe(true);
		});
	});

	describe('common behavior', () => {
		it('both hooks always return continue: true', async () => {
			const startHook = new SubagentStartLoggingHook(mockLogService);
			const stopHook = new SubagentStopLoggingHook(mockLogService);

			const startInput = createSubagentStartInput();
			const stopInput = createSubagentStopInput({ stop_hook_active: true });

			const startResult = await startHook.hooks[0](startInput, undefined, {} as never);
			const stopResult = await stopHook.hooks[0](stopInput, undefined, {} as never);

			expect(startResult).toEqual({ continue: true });
			expect(stopResult).toEqual({ continue: true });
		});

		it('both hooks use trace level logging', async () => {
			const startHook = new SubagentStartLoggingHook(mockLogService);
			const stopHook = new SubagentStopLoggingHook(mockLogService);

			const startInput = createSubagentStartInput();
			const stopInput = createSubagentStopInput();

			await startHook.hooks[0](startInput, undefined, {} as never);
			await stopHook.hooks[0](stopInput, undefined, {} as never);

			expect(mockLogService.trace).toHaveBeenCalledTimes(2);
			expect(mockLogService.debug).not.toHaveBeenCalled();
			expect(mockLogService.info).not.toHaveBeenCalled();
		});

		it('hooks include ClaudeCodeSession prefix in log messages', async () => {
			const startHook = new SubagentStartLoggingHook(mockLogService);
			const stopHook = new SubagentStopLoggingHook(mockLogService);

			await startHook.hooks[0](createSubagentStartInput(), undefined, {} as never);
			await stopHook.hooks[0](createSubagentStopInput({ stop_hook_active: true }), undefined, {} as never);

			const calls = (mockLogService.trace as ReturnType<typeof vi.fn>).mock.calls;
			expect(calls[0][0]).toContain('[ClaudeCodeSession]');
			expect(calls[1][0]).toContain('[ClaudeCodeSession]');
		});

		it('hooks can be instantiated multiple times independently', () => {
			const hook1 = new SubagentStartLoggingHook(mockLogService);
			const hook2 = new SubagentStartLoggingHook(mockLogService);

			expect(hook1).not.toBe(hook2);
			expect(hook1.hooks).not.toBe(hook2.hooks);
		});
	});
});

function createMockLogService(): ILogService {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		critical: vi.fn(),
		getLevel: vi.fn(),
		setLevel: vi.fn(),
		flush: vi.fn()
	} as unknown as ILogService;
}
