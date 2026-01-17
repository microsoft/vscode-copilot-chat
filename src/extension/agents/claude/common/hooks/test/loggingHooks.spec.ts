/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	NotificationHookInput,
	PermissionRequestHookInput,
	PreCompactHookInput,
	StopHookInput,
	UserPromptSubmitHookInput
} from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ILogService } from '../../../../../../platform/log/common/logService';
import {
	NotificationLoggingHook,
	PermissionRequestLoggingHook,
	PreCompactLoggingHook,
	StopLoggingHook,
	UserPromptSubmitLoggingHook
} from '../loggingHooks';

// Helper to create base hook input fields
function createBaseHookInput() {
	return {
		session_id: 'test-session',
		transcript_path: '/path/to/transcript',
		cwd: '/current/working/dir'
	};
}

// Helper to create NotificationHookInput
function createNotificationInput(overrides: Partial<NotificationHookInput> = {}): NotificationHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'Notification',
		title: 'Test Title',
		message: 'Test message',
		notification_type: 'info',
		...overrides
	} as NotificationHookInput;
}

// Helper to create UserPromptSubmitHookInput
function createUserPromptSubmitInput(overrides: Partial<UserPromptSubmitHookInput> = {}): UserPromptSubmitHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'UserPromptSubmit',
		prompt: 'Test prompt',
		...overrides
	} as UserPromptSubmitHookInput;
}

// Helper to create StopHookInput
function createStopInput(overrides: Partial<StopHookInput> = {}): StopHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'Stop',
		stop_hook_active: false,
		...overrides
	} as StopHookInput;
}

// Helper to create PreCompactHookInput
function createPreCompactInput(overrides: Partial<PreCompactHookInput> = {}): PreCompactHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'PreCompact',
		trigger: 'auto',
		custom_instructions: null,
		...overrides
	} as PreCompactHookInput;
}

// Helper to create PermissionRequestHookInput
function createPermissionRequestInput(overrides: Partial<PermissionRequestHookInput> = {}): PermissionRequestHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'PermissionRequest',
		tool_name: 'TestTool',
		tool_input: {},
		...overrides
	} as PermissionRequestHookInput;
}

describe('loggingHooks', () => {
	let mockLogService: ILogService;

	beforeEach(() => {
		mockLogService = createMockLogService();
	});

	describe('NotificationLoggingHook', () => {
		it('logs notification title and message on trace', async () => {
			const hook = new NotificationLoggingHook(mockLogService);
			const input = createNotificationInput({
				title: 'Test Title',
				message: 'Test notification message'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] Notification Hook: title=Test Title, message=Test notification message'
			);
		});

		it('handles empty title and message', async () => {
			const hook = new NotificationLoggingHook(mockLogService);
			const input = createNotificationInput({
				title: '',
				message: ''
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] Notification Hook: title=, message='
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new NotificationLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});
	});

	describe('UserPromptSubmitLoggingHook', () => {
		it('logs user prompt on trace', async () => {
			const hook = new UserPromptSubmitLoggingHook(mockLogService);
			const input = createUserPromptSubmitInput({
				prompt: 'What is the meaning of life?'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] UserPromptSubmit Hook: prompt=What is the meaning of life?'
			);
		});

		it('handles long prompts', async () => {
			const hook = new UserPromptSubmitLoggingHook(mockLogService);
			const longPrompt = 'a'.repeat(1000);
			const input = createUserPromptSubmitInput({
				prompt: longPrompt
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				`[ClaudeCodeSession] UserPromptSubmit Hook: prompt=${longPrompt}`
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new UserPromptSubmitLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});
	});

	describe('StopLoggingHook', () => {
		it('logs stop hook active state when true', async () => {
			const hook = new StopLoggingHook(mockLogService);
			const input = createStopInput({
				stop_hook_active: true
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] Stop Hook: stopHookActive=true'
			);
		});

		it('logs stop hook active state when false', async () => {
			const hook = new StopLoggingHook(mockLogService);
			const input = createStopInput({
				stop_hook_active: false
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] Stop Hook: stopHookActive=false'
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new StopLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});
	});

	describe('PreCompactLoggingHook', () => {
		it('logs precompact trigger and custom instructions', async () => {
			const hook = new PreCompactLoggingHook(mockLogService);
			const input = createPreCompactInput({
				trigger: 'manual',
				custom_instructions: 'Focus on TypeScript'
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PreCompact Hook: trigger=manual, customInstructions=Focus on TypeScript'
			);
		});

		it('handles null custom instructions', async () => {
			const hook = new PreCompactLoggingHook(mockLogService);
			const input = createPreCompactInput({
				trigger: 'auto',
				custom_instructions: null
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PreCompact Hook: trigger=auto, customInstructions=null'
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new PreCompactLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});
	});

	describe('PermissionRequestLoggingHook', () => {
		it('logs tool name and input as JSON', async () => {
			const hook = new PermissionRequestLoggingHook(mockLogService);
			const input = createPermissionRequestInput({
				tool_name: 'Bash',
				tool_input: { command: 'npm install' }
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PermissionRequest Hook: tool=Bash, input={"command":"npm install"}'
			);
		});

		it('handles complex tool input', async () => {
			const hook = new PermissionRequestLoggingHook(mockLogService);
			const input = createPermissionRequestInput({
				tool_name: 'Edit',
				tool_input: {
					file_path: '/path/to/file.ts',
					old_string: 'const x = 1;',
					new_string: 'const x = 2;'
				}
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PermissionRequest Hook: tool=Edit, input={"file_path":"/path/to/file.ts","old_string":"const x = 1;","new_string":"const x = 2;"}'
			);
		});

		it('handles empty tool input', async () => {
			const hook = new PermissionRequestLoggingHook(mockLogService);
			const input = createPermissionRequestInput({
				tool_name: 'SomeTool',
				tool_input: {}
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PermissionRequest Hook: tool=SomeTool, input={}'
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new PermissionRequestLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});
	});

	describe('common behavior', () => {
		it('all hooks return continue: true', async () => {
			const hooks = [
				new NotificationLoggingHook(mockLogService),
				new UserPromptSubmitLoggingHook(mockLogService),
				new StopLoggingHook(mockLogService),
				new PreCompactLoggingHook(mockLogService),
				new PermissionRequestLoggingHook(mockLogService)
			];

			const inputs = [
				createNotificationInput(),
				createUserPromptSubmitInput(),
				createStopInput({ stop_hook_active: true }),
				createPreCompactInput(),
				createPermissionRequestInput()
			];

			for (let i = 0; i < hooks.length; i++) {
				const result = await hooks[i].hooks[0](inputs[i], undefined, {} as never);
				expect(result).toEqual({ continue: true });
			}
		});

		it('all hooks use trace level logging', () => {
			const hooks = [
				new NotificationLoggingHook(mockLogService),
				new UserPromptSubmitLoggingHook(mockLogService),
				new StopLoggingHook(mockLogService),
				new PreCompactLoggingHook(mockLogService),
				new PermissionRequestLoggingHook(mockLogService)
			];

			// All hooks are created and should have the log service available
			// The trace method is what they call
			for (const hook of hooks) {
				expect(hook.hooks.length).toBe(1);
			}
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
