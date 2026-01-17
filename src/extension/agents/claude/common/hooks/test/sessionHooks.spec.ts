/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionEndHookInput, SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ILogService } from '../../../../../../platform/log/common/logService';
import { SessionEndLoggingHook, SessionStartLoggingHook } from '../sessionHooks';

// Helper to create base hook input fields
function createBaseHookInput() {
	return {
		session_id: 'test-session',
		transcript_path: '/path/to/transcript',
		cwd: '/current/working/dir'
	};
}

// Helper to create SessionStartHookInput
function createSessionStartInput(overrides: Partial<SessionStartHookInput> = {}): SessionStartHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'SessionStart',
		source: 'startup',
		...overrides
	} as SessionStartHookInput;
}

// Helper to create SessionEndHookInput
function createSessionEndInput(overrides: Partial<SessionEndHookInput> = {}): SessionEndHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'SessionEnd',
		reason: 'other',
		...overrides
	} as SessionEndHookInput;
}

describe('sessionHooks', () => {
	let mockLogService: ILogService;

	beforeEach(() => {
		mockLogService = createMockLogService();
	});

	describe('SessionStartLoggingHook', () => {
		it('logs session start with source and session id', async () => {
			const hook = new SessionStartLoggingHook(mockLogService);
			const input = createSessionStartInput({
				session_id: 'session-123',
				source: 'startup'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] SessionStart Hook: source=startup, sessionId=session-123'
			);
		});

		it('handles different source values', async () => {
			const hook = new SessionStartLoggingHook(mockLogService);
			const input = createSessionStartInput({
				session_id: 'session-456',
				source: 'resume'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] SessionStart Hook: source=resume, sessionId=session-456'
			);
		});

		it('handles UUID-style session ids', async () => {
			const hook = new SessionStartLoggingHook(mockLogService);
			const sessionId = '550e8400-e29b-41d4-a716-446655440000';
			const input = createSessionStartInput({
				session_id: sessionId,
				source: 'startup'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				`[ClaudeCodeSession] SessionStart Hook: source=startup, sessionId=${sessionId}`
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new SessionStartLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});

		it('implements HookCallbackMatcher interface', () => {
			const hook = new SessionStartLoggingHook(mockLogService);
			expect(hook.hooks).toBeDefined();
			expect(Array.isArray(hook.hooks)).toBe(true);
		});
	});

	describe('SessionEndLoggingHook', () => {
		it('logs session end with reason and session id', async () => {
			const hook = new SessionEndLoggingHook(mockLogService);
			const input = createSessionEndInput({
				session_id: 'session-789',
				reason: 'other'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] SessionEnd Hook: reason=other, sessionId=session-789'
			);
		});

		it('logs session end with clear reason', async () => {
			const hook = new SessionEndLoggingHook(mockLogService);
			const input = createSessionEndInput({
				session_id: 'session-error-01',
				reason: 'clear'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] SessionEnd Hook: reason=clear, sessionId=session-error-01'
			);
		});

		it('logs session end with logout reason', async () => {
			const hook = new SessionEndLoggingHook(mockLogService);
			const input = createSessionEndInput({
				session_id: 'session-cancel-01',
				reason: 'logout'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] SessionEnd Hook: reason=logout, sessionId=session-cancel-01'
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new SessionEndLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});

		it('implements HookCallbackMatcher interface', () => {
			const hook = new SessionEndLoggingHook(mockLogService);
			expect(hook.hooks).toBeDefined();
			expect(Array.isArray(hook.hooks)).toBe(true);
		});
	});

	describe('common behavior', () => {
		it('both hooks always return continue: true', async () => {
			const startHook = new SessionStartLoggingHook(mockLogService);
			const endHook = new SessionEndLoggingHook(mockLogService);

			const startInput = createSessionStartInput();
			const endInput = createSessionEndInput();

			const startResult = await startHook.hooks[0](startInput, undefined, {} as never);
			const endResult = await endHook.hooks[0](endInput, undefined, {} as never);

			expect(startResult).toEqual({ continue: true });
			expect(endResult).toEqual({ continue: true });
		});

		it('both hooks use trace level logging', async () => {
			const startHook = new SessionStartLoggingHook(mockLogService);
			const endHook = new SessionEndLoggingHook(mockLogService);

			const startInput = createSessionStartInput();
			const endInput = createSessionEndInput();

			await startHook.hooks[0](startInput, undefined, {} as never);
			await endHook.hooks[0](endInput, undefined, {} as never);

			expect(mockLogService.trace).toHaveBeenCalledTimes(2);
			expect(mockLogService.debug).not.toHaveBeenCalled();
			expect(mockLogService.info).not.toHaveBeenCalled();
		});

		it('hooks include ClaudeCodeSession prefix in log messages', async () => {
			const startHook = new SessionStartLoggingHook(mockLogService);
			const endHook = new SessionEndLoggingHook(mockLogService);

			await startHook.hooks[0](createSessionStartInput(), undefined, {} as never);
			await endHook.hooks[0](createSessionEndInput(), undefined, {} as never);

			const calls = (mockLogService.trace as ReturnType<typeof vi.fn>).mock.calls;
			expect(calls[0][0]).toContain('[ClaudeCodeSession]');
			expect(calls[1][0]).toContain('[ClaudeCodeSession]');
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
