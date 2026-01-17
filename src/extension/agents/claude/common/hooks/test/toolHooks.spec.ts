/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	PostToolUseFailureHookInput,
	PostToolUseHookInput,
	PreToolUseHookInput
} from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ILogService } from '../../../../../../platform/log/common/logService';
import {
	PostToolUseFailureLoggingHook,
	PostToolUseLoggingHook,
	PreToolUseLoggingHook
} from '../toolHooks';

// Helper to create base hook input fields
function createBaseHookInput() {
	return {
		session_id: 'test-session',
		transcript_path: '/path/to/transcript',
		cwd: '/current/working/dir'
	};
}

// Helper to create PreToolUseHookInput
function createPreToolUseInput(overrides: Partial<PreToolUseHookInput> = {}): PreToolUseHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'PreToolUse',
		tool_name: 'TestTool',
		tool_input: {},
		...overrides
	} as PreToolUseHookInput;
}

// Helper to create PostToolUseHookInput
function createPostToolUseInput(overrides: Partial<PostToolUseHookInput> = {}): PostToolUseHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'PostToolUse',
		tool_name: 'TestTool',
		tool_input: {},
		tool_response: '',
		tool_use_id: 'test-tool-use-id',
		...overrides
	} as PostToolUseHookInput;
}

// Helper to create PostToolUseFailureHookInput
function createPostToolUseFailureInput(overrides: Partial<PostToolUseFailureHookInput> = {}): PostToolUseFailureHookInput {
	return {
		...createBaseHookInput(),
		hook_event_name: 'PostToolUseFailure',
		tool_name: 'TestTool',
		error: 'Test error',
		is_interrupt: false,
		...overrides
	} as PostToolUseFailureHookInput;
}

describe('toolHooks', () => {
	let mockLogService: ILogService;

	beforeEach(() => {
		mockLogService = createMockLogService();
	});

	describe('PreToolUseLoggingHook', () => {
		it('logs pre tool use with tool name and tool use ID', async () => {
			const hook = new PreToolUseLoggingHook(mockLogService);
			const input = createPreToolUseInput({
				tool_name: 'Bash',
				tool_input: { command: 'npm install' }
			});

			const result = await hook.hooks[0](input, 'tool-use-id-456', {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PreToolUse Hook: tool=Bash, toolUseID=tool-use-id-456'
			);
		});

		it('handles undefined tool use ID', async () => {
			const hook = new PreToolUseLoggingHook(mockLogService);
			const input = createPreToolUseInput({
				tool_name: 'Read',
				tool_input: { file_path: '/path/to/file.ts' }
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PreToolUse Hook: tool=Read, toolUseID=undefined'
			);
		});

		it('handles various tool names', async () => {
			const hook = new PreToolUseLoggingHook(mockLogService);
			const toolNames = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

			for (let i = 0; i < toolNames.length; i++) {
				vi.clearAllMocks();

				const input = createPreToolUseInput({
					tool_name: toolNames[i],
					tool_input: {}
				});

				const result = await hook.hooks[0](input, `tool-${i}`, {} as never);

				expect(result).toEqual({ continue: true });
				expect(mockLogService.trace).toHaveBeenCalledWith(
					`[ClaudeCodeSession] PreToolUse Hook: tool=${toolNames[i]}, toolUseID=tool-${i}`
				);
			}
		});

		it('does not log tool input (privacy concern)', async () => {
			const hook = new PreToolUseLoggingHook(mockLogService);
			const sensitiveInput = {
				command: 'echo $SECRET_TOKEN',
				file_path: '/home/user/.ssh/id_rsa'
			};
			const input = createPreToolUseInput({
				tool_name: 'Bash',
				tool_input: sensitiveInput
			});

			await hook.hooks[0](input, 'tool-id', {} as never);

			const logCall = (mockLogService.trace as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(logCall).not.toContain('SECRET_TOKEN');
			expect(logCall).not.toContain('id_rsa');
		});

		it('has exactly one hook callback', () => {
			const hook = new PreToolUseLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});
	});

	describe('PostToolUseLoggingHook', () => {
		it('logs post tool use with tool name and tool use ID', async () => {
			const hook = new PostToolUseLoggingHook(mockLogService);
			const input = createPostToolUseInput({
				tool_name: 'Bash',
				tool_input: { command: 'npm install' },
				tool_response: 'Success'
			});

			const result = await hook.hooks[0](input, 'tool-use-id-789', {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PostToolUse Hook: tool=Bash, toolUseID=tool-use-id-789'
			);
		});

		it('handles undefined tool use ID', async () => {
			const hook = new PostToolUseLoggingHook(mockLogService);
			const input = createPostToolUseInput({
				tool_name: 'Glob',
				tool_input: { pattern: '**/*.ts' },
				tool_response: ['file1.ts', 'file2.ts']
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PostToolUse Hook: tool=Glob, toolUseID=undefined'
			);
		});

		it('does not log tool output (privacy concern)', async () => {
			const hook = new PostToolUseLoggingHook(mockLogService);
			const sensitiveResult = 'password=supersecret123';
			const input = createPostToolUseInput({
				tool_name: 'Read',
				tool_input: { file_path: '/config/.env' },
				tool_response: sensitiveResult
			});

			await hook.hooks[0](input, 'tool-id', {} as never);

			const logCall = (mockLogService.trace as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(logCall).not.toContain('supersecret123');
		});

		it('has exactly one hook callback', () => {
			const hook = new PostToolUseLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});
	});

	describe('PostToolUseFailureLoggingHook', () => {
		it('logs failure with tool name, error, and isInterrupt', async () => {
			const hook = new PostToolUseFailureLoggingHook(mockLogService);
			const input = createPostToolUseFailureInput({
				tool_name: 'Bash',
				error: 'Command not found: npm',
				is_interrupt: false
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PostToolUseFailure Hook: tool=Bash, error=Command not found: npm, isInterrupt=false'
			);
		});

		it('logs failure when isInterrupt is true', async () => {
			const hook = new PostToolUseFailureLoggingHook(mockLogService);
			const input = createPostToolUseFailureInput({
				tool_name: 'Task',
				error: 'User cancelled',
				is_interrupt: true
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PostToolUseFailure Hook: tool=Task, error=User cancelled, isInterrupt=true'
			);
		});

		it('handles empty error message', async () => {
			const hook = new PostToolUseFailureLoggingHook(mockLogService);
			const input = createPostToolUseFailureInput({
				tool_name: 'Edit',
				error: '',
				is_interrupt: false
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				'[ClaudeCodeSession] PostToolUseFailure Hook: tool=Edit, error=, isInterrupt=false'
			);
		});

		it('handles long error messages', async () => {
			const hook = new PostToolUseFailureLoggingHook(mockLogService);
			const longError = 'Error: '.repeat(100);
			const input = createPostToolUseFailureInput({
				tool_name: 'Write',
				error: longError,
				is_interrupt: false
			});

			const result = await hook.hooks[0](input, undefined, {} as never);

			expect(result).toEqual({ continue: true });
			expect(mockLogService.trace).toHaveBeenCalledWith(
				`[ClaudeCodeSession] PostToolUseFailure Hook: tool=Write, error=${longError}, isInterrupt=false`
			);
		});

		it('has exactly one hook callback', () => {
			const hook = new PostToolUseFailureLoggingHook(mockLogService);
			expect(hook.hooks.length).toBe(1);
		});
	});

	describe('common behavior', () => {
		it('all hooks always return continue: true', async () => {
			const preHook = new PreToolUseLoggingHook(mockLogService);
			const postHook = new PostToolUseLoggingHook(mockLogService);
			const failureHook = new PostToolUseFailureLoggingHook(mockLogService);

			const preInput = createPreToolUseInput({ tool_name: 'Bash' });
			const postInput = createPostToolUseInput({ tool_name: 'Bash', tool_response: 'ok' });
			const failureInput = createPostToolUseFailureInput({ tool_name: 'Bash', error: 'error' });

			const preResult = await preHook.hooks[0](preInput, 'id', {} as never);
			const postResult = await postHook.hooks[0](postInput, 'id', {} as never);
			const failureResult = await failureHook.hooks[0](failureInput, undefined, {} as never);

			expect(preResult).toEqual({ continue: true });
			expect(postResult).toEqual({ continue: true });
			expect(failureResult).toEqual({ continue: true });
		});

		it('all hooks use trace level logging', async () => {
			const preHook = new PreToolUseLoggingHook(mockLogService);
			const postHook = new PostToolUseLoggingHook(mockLogService);
			const failureHook = new PostToolUseFailureLoggingHook(mockLogService);

			await preHook.hooks[0](createPreToolUseInput({ tool_name: 'Test' }), 'id', {} as never);
			await postHook.hooks[0](createPostToolUseInput({ tool_name: 'Test', tool_response: 'ok' }), 'id', {} as never);
			await failureHook.hooks[0](createPostToolUseFailureInput({ tool_name: 'Test', error: 'err' }), undefined, {} as never);

			expect(mockLogService.trace).toHaveBeenCalledTimes(3);
			expect(mockLogService.debug).not.toHaveBeenCalled();
			expect(mockLogService.info).not.toHaveBeenCalled();
		});

		it('hooks include ClaudeCodeSession prefix in log messages', async () => {
			const preHook = new PreToolUseLoggingHook(mockLogService);
			const postHook = new PostToolUseLoggingHook(mockLogService);
			const failureHook = new PostToolUseFailureLoggingHook(mockLogService);

			await preHook.hooks[0](createPreToolUseInput({ tool_name: 'T' }), 'id', {} as never);
			await postHook.hooks[0](createPostToolUseInput({ tool_name: 'T' }), 'id', {} as never);
			await failureHook.hooks[0](createPostToolUseFailureInput({ tool_name: 'T', error: 'e' }), undefined, {} as never);

			const calls = (mockLogService.trace as ReturnType<typeof vi.fn>).mock.calls;
			expect(calls[0][0]).toContain('[ClaudeCodeSession]');
			expect(calls[1][0]).toContain('[ClaudeCodeSession]');
			expect(calls[2][0]).toContain('[ClaudeCodeSession]');
		});

		it('PreToolUse and PostToolUse hooks accept toolID parameter', () => {
			const preHook = new PreToolUseLoggingHook(mockLogService);
			const postHook = new PostToolUseLoggingHook(mockLogService);

			// The hook callback accepts a second parameter for toolID
			expect(preHook.hooks[0].length).toBeGreaterThanOrEqual(1);
			expect(postHook.hooks[0].length).toBeGreaterThanOrEqual(1);
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
