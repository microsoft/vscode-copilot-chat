/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { URI } from '../../../../../util/vs/base/common/uri';
import { ClaudeToolNames } from '../claudeTools';
import { createFormattedToolInvocation } from '../toolInvocationFormatter';

function createToolUseBlock(name: string, input: object): Anthropic.ToolUseBlock {
	return {
		type: 'tool_use',
		id: 'test-tool-id-123',
		name,
		input
	};
}

describe('createFormattedToolInvocation', () => {
	describe('Bash tool', () => {
		it('formats bash invocation with command', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Bash, { command: 'npm install' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolName).toBe(ClaudeToolNames.Bash);
			expect(result!.toolCallId).toBe('test-tool-id-123');
			expect(result!.isConfirmed).toBe(true);
			expect(result!.invocationMessage).toBe('');
			expect(result!.toolSpecificData).toEqual({
				commandLine: { original: 'npm install' },
				language: 'bash'
			});
		});

		it('handles missing command input', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Bash, {});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolSpecificData).toEqual({
				commandLine: { original: undefined },
				language: 'bash'
			});
		});
	});

	describe('Read tool', () => {
		it('formats read invocation with file path', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Read, { file_path: '/path/to/file.ts' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolName).toBe(ClaudeToolNames.Read);
			expect(result!.isConfirmed).toBe(true);
			expect(result!.invocationMessage).toBeDefined();
			const message = result!.invocationMessage as { value: string };
			expect(message.value).toContain(URI.file('/path/to/file.ts').toString());
		});

		it('handles missing file path', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Read, {});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			const message = result!.invocationMessage as { value: string };
			expect(message.value).toContain('Read');
		});
	});

	describe('Glob tool', () => {
		it('formats glob invocation with pattern', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Glob, { pattern: '**/*.ts' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolName).toBe(ClaudeToolNames.Glob);
			const message = result!.invocationMessage as { value: string };
			expect(message.value).toContain('**/*.ts');
		});

		it('handles missing pattern', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Glob, {});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			const message = result!.invocationMessage as { value: string };
			expect(message.value).toBeDefined();
		});
	});

	describe('Grep tool', () => {
		it('formats grep invocation with pattern', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Grep, { pattern: 'function\\s+\\w+' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolName).toBe(ClaudeToolNames.Grep);
			const message = result!.invocationMessage as { value: string };
			expect(message.value).toContain('function\\s+\\w+');
		});

		it('handles missing pattern', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Grep, {});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
		});
	});

	describe('LS tool', () => {
		it('formats ls invocation with path', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.LS, { path: '/project/src' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolName).toBe(ClaudeToolNames.LS);
			const message = result!.invocationMessage as { value: string };
			expect(message.value).toContain(URI.file('/project/src').toString());
		});

		it('handles missing path', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.LS, {});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
		});
	});

	describe('Edit tools', () => {
		it('returns undefined for Edit tool (diff shown separately)', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Edit, { file_path: '/path/to/file.ts' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeUndefined();
		});

		it('returns undefined for MultiEdit tool (diff shown separately)', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.MultiEdit, { file_path: '/path/to/file.ts' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeUndefined();
		});

		it('returns undefined for Write tool (diff shown separately)', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Write, { file_path: '/path/to/file.ts' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeUndefined();
		});
	});

	describe('ExitPlanMode tool', () => {
		it('formats exit plan mode with plan', () => {
			const plan = '1. First step\n2. Second step\n3. Third step';
			const toolUse = createToolUseBlock(ClaudeToolNames.ExitPlanMode, { plan });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolName).toBe(ClaudeToolNames.ExitPlanMode);
			expect(result!.invocationMessage).toBe(`Here is Claude's plan:\n\n${plan}`);
		});

		it('handles missing plan', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.ExitPlanMode, {});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.invocationMessage).toBe('Here is Claude\'s plan:\n\n');
		});
	});

	describe('Task tool', () => {
		it('formats task invocation with description', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Task, {
				description: 'Analyze codebase structure',
				subagent_type: 'analyzer',
				prompt: 'Please analyze the structure'
			});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolName).toBe(ClaudeToolNames.Task);
			const message = result!.invocationMessage as { value: string };
			expect(message.value).toContain('Analyze codebase structure');
		});

		it('handles missing description', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.Task, {});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
		});
	});

	describe('TodoWrite tool', () => {
		it('returns undefined (suppressed - too common)', () => {
			const toolUse = createToolUseBlock(ClaudeToolNames.TodoWrite, {
				todos: [{ content: 'Task 1', status: 'pending', activeForm: 'active' }]
			});

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeUndefined();
		});
	});

	describe('Unknown tool', () => {
		it('formats unknown tool with generic message', () => {
			const toolUse = createToolUseBlock('UnknownTool', { someInput: 'value' });

			const result = createFormattedToolInvocation(toolUse);

			expect(result).toBeDefined();
			expect(result!.toolName).toBe('UnknownTool');
			expect(result!.invocationMessage).toContain('UnknownTool');
		});
	});

	describe('common properties', () => {
		it('sets isConfirmed to true for all non-suppressed tools', () => {
			const tools = [
				ClaudeToolNames.Bash,
				ClaudeToolNames.Read,
				ClaudeToolNames.Glob,
				ClaudeToolNames.Grep,
				ClaudeToolNames.LS,
				ClaudeToolNames.ExitPlanMode,
				ClaudeToolNames.Task
			];

			for (const tool of tools) {
				const toolUse = createToolUseBlock(tool, {});
				const result = createFormattedToolInvocation(toolUse);
				expect(result?.isConfirmed).toBe(true);
			}
		});

		it('uses tool call id from tool use block', () => {
			const toolUse: Anthropic.ToolUseBlock = {
				type: 'tool_use',
				id: 'unique-call-id-456',
				name: ClaudeToolNames.Bash,
				input: { command: 'ls' }
			};

			const result = createFormattedToolInvocation(toolUse);

			expect(result!.toolCallId).toBe('unique-call-id-456');
		});
	});
});
