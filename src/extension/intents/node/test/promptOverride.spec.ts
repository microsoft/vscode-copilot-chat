/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LanguageModelToolInformation } from 'vscode';
import { TestLogService } from '../../../../platform/testing/common/testLogService';

const mockReadFile = vi.fn();

vi.mock('fs', () => ({
	promises: {
		readFile: (...args: unknown[]) => mockReadFile(...args),
	}
}));

import { applyPromptOverrides } from '../promptOverride';

function makeMessages(...specs: Array<{ role: Raw.ChatRole; content: string }>): Raw.ChatMessage[] {
	return specs.map(s => ({
		role: s.role,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: s.content }],
	})) as Raw.ChatMessage[];
}

function makeTools(...names: string[]): LanguageModelToolInformation[] {
	return names.map(name => ({
		name,
		description: `Default description for ${name}`,
		inputSchema: undefined,
		tags: [],
		source: undefined,
	})) as LanguageModelToolInformation[];
}

describe('applyPromptOverrides', () => {
	let logService: TestLogService;

	beforeEach(() => {
		logService = new TestLogService();
		mockReadFile.mockReset();
	});

	test('returns unchanged and logs warning when file is not found', async () => {
		mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));
		const warnSpy = vi.spyOn(logService, 'warn');

		const messages = makeMessages({ role: Raw.ChatRole.System, content: 'original' });
		const tools = makeTools('tool_a');

		const result = await applyPromptOverrides('/nonexistent.yaml', messages, tools, logService);

		expect(result.messages).toEqual(messages);
		expect(result.tools).toEqual(tools);
		expect(warnSpy).toHaveBeenCalledOnce();
	});

	test('returns unchanged and logs warning on invalid YAML', async () => {
		mockReadFile.mockResolvedValue('{{{{not valid yaml');
		const warnSpy = vi.spyOn(logService, 'warn');

		const messages = makeMessages({ role: Raw.ChatRole.System, content: 'original' });
		const result = await applyPromptOverrides('/bad.yaml', messages, makeTools(), logService);

		expect(result.messages).toEqual(messages);
		expect(warnSpy).toHaveBeenCalledOnce();
	});

	test('replaces all system messages with systemPrompt override', async () => {
		mockReadFile.mockResolvedValue('systemPrompt: "Custom system prompt"');

		const messages = makeMessages(
			{ role: Raw.ChatRole.System, content: 'System 1' },
			{ role: Raw.ChatRole.System, content: 'System 2' },
			{ role: Raw.ChatRole.User, content: 'Hello' },
			{ role: Raw.ChatRole.Assistant, content: 'Hi' },
		);

		const result = await applyPromptOverrides('/override.yaml', messages, makeTools(), logService);

		expect(result.messages).toHaveLength(3);
		expect(result.messages[0]).toEqual({
			role: Raw.ChatRole.System,
			content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Custom system prompt' }],
		});
		expect(result.messages[1]).toEqual({
			role: Raw.ChatRole.User,
			content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }],
		});
		expect(result.messages[2]).toEqual({
			role: Raw.ChatRole.Assistant,
			content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hi' }],
		});
	});

	test('overrides matching tool descriptions', async () => {
		mockReadFile.mockResolvedValue([
			'toolDescriptions:',
			'  tool_a:',
			'    description: "Overridden A"',
		].join('\n'));

		const tools = makeTools('tool_a', 'tool_b');

		const result = await applyPromptOverrides('/override.yaml', makeMessages(), tools, logService);

		expect(result.tools[0].description).toBe('Overridden A');
		expect(result.tools[1].description).toBe('Default description for tool_b');
	});

	test('applies both system prompt and tool description overrides', async () => {
		mockReadFile.mockResolvedValue([
			'systemPrompt: "New system"',
			'toolDescriptions:',
			'  tool_x:',
			'    description: "New tool_x desc"',
		].join('\n'));

		const messages = makeMessages(
			{ role: Raw.ChatRole.System, content: 'Old system' },
			{ role: Raw.ChatRole.User, content: 'Hello' },
		);
		const tools = makeTools('tool_x');

		const result = await applyPromptOverrides('/override.yaml', messages, tools, logService);

		expect(result.messages[0]).toEqual({
			role: Raw.ChatRole.System,
			content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'New system' }],
		});
		expect(result.messages[1]).toEqual({
			role: Raw.ChatRole.User,
			content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }],
		});
		expect(result.tools[0].description).toBe('New tool_x desc');
	});

	test('returns unchanged for empty YAML file', async () => {
		mockReadFile.mockResolvedValue('');

		const messages = makeMessages({ role: Raw.ChatRole.System, content: 'original' });
		const tools = makeTools('tool_a');

		const result = await applyPromptOverrides('/empty.yaml', messages, tools, logService);

		expect(result.messages).toEqual(messages);
		expect(result.tools).toEqual(tools);
	});

	test('silently ignores tool names not found in available tools', async () => {
		mockReadFile.mockResolvedValue([
			'toolDescriptions:',
			'  nonexistent_tool:',
			'    description: "Does not matter"',
		].join('\n'));

		const tools = makeTools('tool_a');

		const result = await applyPromptOverrides('/override.yaml', makeMessages(), tools, logService);

		expect(result.tools[0].description).toBe('Default description for tool_a');
	});
});
