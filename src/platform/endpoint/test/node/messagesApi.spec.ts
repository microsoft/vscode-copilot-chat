/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlockParam, ImageBlockParam, MessageParam, TextBlockParam, ToolReferenceBlockParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources';
import { Raw } from '@vscode/prompt-tsx';
import { expect, suite, test } from 'vitest';
import { AnthropicMessagesTool, CUSTOM_TOOL_SEARCH_NAME } from '../../../networking/common/anthropic';
import { addToolsAndSystemCacheControl, rawMessagesToMessagesAPI } from '../../node/messagesApi';

function assertContentArray(content: MessageParam['content']): ContentBlockParam[] {
	expect(Array.isArray(content)).toBe(true);
	return content as ContentBlockParam[];
}

function findBlock<T extends ContentBlockParam>(blocks: ContentBlockParam[], type: T['type']): T | undefined {
	return blocks.find(b => b.type === type) as T | undefined;
}

function findToolResult(messages: MessageParam[]): ToolResultBlockParam | undefined {
	for (const msg of messages.filter(m => m.role === 'user')) {
		const content = msg.content;
		if (Array.isArray(content)) {
			const result = content.find((c): c is ToolResultBlockParam => c.type === 'tool_result');
			if (result) {
				return result;
			}
		}
	}
	return undefined;
}

suite('rawMessagesToMessagesAPI', function () {

	test('places cache_control on tool_result block, not inside content', function () {
		const messages: Raw.ChatMessage[] = [
			{
				role: Raw.ChatRole.User,
				content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Read my file' }],
			},
			{
				role: Raw.ChatRole.Assistant,
				content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'I will read the file.' }],
				toolCalls: [{
					id: 'toolu_test123',
					type: 'function',
					function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' },
				}],
			},
			{
				role: Raw.ChatRole.Tool,
				toolCallId: 'toolu_test123',
				content: [
					{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello world' },
					{ type: Raw.ChatCompletionContentPartKind.CacheBreakpoint, cacheType: 'ephemeral' },
				],
			},
		];

		const result = rawMessagesToMessagesAPI(messages);

		const toolResult = findToolResult(result.messages);
		expect(toolResult).toBeDefined();

		// cache_control should be on the tool_result block itself
		expect(toolResult!.cache_control).toEqual({ type: 'ephemeral' });

		// cache_control should NOT be on inner content blocks
		if (Array.isArray(toolResult!.content)) {
			for (const inner of toolResult!.content) {
				expect(('cache_control' in inner) ? inner.cache_control : undefined).toBeUndefined();
			}
		}
	});

	test('tool_result without cache_control has no cache_control property', function () {
		const messages: Raw.ChatMessage[] = [
			{
				role: Raw.ChatRole.Tool,
				toolCallId: 'toolu_no_cache',
				content: [
					{ type: Raw.ChatCompletionContentPartKind.Text, text: 'result text' },
				],
			},
		];

		const result = rawMessagesToMessagesAPI(messages);

		const toolResult = findToolResult(result.messages);
		expect(toolResult).toBeDefined();
		expect(toolResult!.cache_control).toBeUndefined();
	});

	test('converts base64 data URL image to Anthropic base64 image source', function () {
		const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
		const messages: Raw.ChatMessage[] = [
			{
				role: Raw.ChatRole.User,
				content: [{
					type: Raw.ChatCompletionContentPartKind.Image,
					imageUrl: { url: `data:image/png;base64,${base64Data}` },
				}],
			},
		];

		const result = rawMessagesToMessagesAPI(messages);
		const content = assertContentArray(result.messages[0].content);
		const imageBlock = findBlock<ImageBlockParam>(content, 'image');
		expect(imageBlock).toBeDefined();
		expect(imageBlock!.source).toEqual({
			type: 'base64',
			media_type: 'image/png',
			data: base64Data,
		});
	});

	test('converts https URL image to Anthropic url image source', function () {
		const imageUrl = 'https://example.com/image.png';
		const messages: Raw.ChatMessage[] = [
			{
				role: Raw.ChatRole.User,
				content: [{
					type: Raw.ChatCompletionContentPartKind.Image,
					imageUrl: { url: imageUrl },
				}],
			},
		];

		const result = rawMessagesToMessagesAPI(messages);
		const content = assertContentArray(result.messages[0].content);
		const imageBlock = findBlock<ImageBlockParam>(content, 'image');
		expect(imageBlock).toBeDefined();
		expect(imageBlock!.source).toEqual({
			type: 'url',
			url: imageUrl,
		});
	});

	test('drops image with unsupported URL scheme', function () {
		const messages: Raw.ChatMessage[] = [
			{
				role: Raw.ChatRole.User,
				content: [
					{ type: Raw.ChatCompletionContentPartKind.Text, text: 'look at this' },
					{
						type: Raw.ChatCompletionContentPartKind.Image,
						imageUrl: { url: 'http://insecure.example.com/image.png' },
					},
				],
			},
		];

		const result = rawMessagesToMessagesAPI(messages);
		const content = assertContentArray(result.messages[0].content);
		expect(findBlock<ImageBlockParam>(content, 'image')).toBeUndefined();
		expect(findBlock(content, 'text')).toBeDefined();
	});

	suite('custom tool search tool_reference conversion', function () {

		function makeToolSearchMessages(toolNames: string[]): Raw.ChatMessage[] {
			return [
				{
					role: Raw.ChatRole.User,
					content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'find github tools' }],
				},
				{
					role: Raw.ChatRole.Assistant,
					content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Searching for tools.' }],
					toolCalls: [{
						id: 'toolu_search1',
						type: 'function',
						function: { name: CUSTOM_TOOL_SEARCH_NAME, arguments: '{"query":"github"}' },
					}],
				},
				{
					role: Raw.ChatRole.Tool,
					toolCallId: 'toolu_search1',
					content: [
						{ type: Raw.ChatCompletionContentPartKind.Text, text: JSON.stringify(toolNames) },
					],
				},
			];
		}

		test('converts tool search results into tool_reference blocks', function () {
			const messages = makeToolSearchMessages(['mcp__github__list_issues', 'mcp__github__create_pull_request']);

			const result = rawMessagesToMessagesAPI(messages);

			const toolResult = findToolResult(result.messages);
			expect(toolResult).toBeDefined();
			const content = toolResult!.content as ToolReferenceBlockParam[];
			expect(content).toHaveLength(2);
			expect(content[0]).toEqual({ type: 'tool_reference', tool_name: 'mcp__github__list_issues' });
			expect(content[1]).toEqual({ type: 'tool_reference', tool_name: 'mcp__github__create_pull_request' });
		});

		test('filters tool_reference blocks against validToolNames', function () {
			const messages = makeToolSearchMessages(['mcp__github__list_issues', 'mcp__github__unknown_tool', 'read_file']);
			const validToolNames = new Set(['mcp__github__list_issues', 'read_file', 'edit_file']);

			const result = rawMessagesToMessagesAPI(messages, validToolNames);

			const toolResult = findToolResult(result.messages);
			expect(toolResult).toBeDefined();
			const content = toolResult!.content as ToolReferenceBlockParam[];
			expect(content).toHaveLength(2);
			expect(content.map(c => c.tool_name)).toEqual(['mcp__github__list_issues', 'read_file']);
		});

		test('filters out all tool names when none are valid', function () {
			const messages = makeToolSearchMessages(['unknown_tool_a', 'unknown_tool_b']);
			const validToolNames = new Set(['read_file']);

			const result = rawMessagesToMessagesAPI(messages, validToolNames);

			const toolResult = findToolResult(result.messages);
			expect(toolResult).toBeDefined();
			// No valid tool references, content should be undefined (empty filtered)
			expect(toolResult!.content).toBeUndefined();
		});

		test('passes all tool names through when validToolNames is undefined', function () {
			const messages = makeToolSearchMessages(['any_tool', 'another_tool']);

			const result = rawMessagesToMessagesAPI(messages);

			const toolResult = findToolResult(result.messages);
			expect(toolResult).toBeDefined();
			const content = toolResult!.content as ToolReferenceBlockParam[];
			expect(content).toHaveLength(2);
			expect(content.map(c => c.tool_name)).toEqual(['any_tool', 'another_tool']);
		});

		test('returns undefined for non-JSON tool search results', function () {
			const messages: Raw.ChatMessage[] = [
				{
					role: Raw.ChatRole.Assistant,
					content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: '' }],
					toolCalls: [{
						id: 'toolu_bad',
						type: 'function',
						function: { name: CUSTOM_TOOL_SEARCH_NAME, arguments: '{"query":"test"}' },
					}],
				},
				{
					role: Raw.ChatRole.Tool,
					toolCallId: 'toolu_bad',
					content: [
						{ type: Raw.ChatCompletionContentPartKind.Text, text: 'not valid json' },
					],
				},
			];

			const result = rawMessagesToMessagesAPI(messages);

			// Falls back to normal text content since JSON parse fails
			const toolResult = findToolResult(result.messages);
			expect(toolResult).toBeDefined();
			const content = toolResult!.content as ContentBlockParam[];
			expect(content).toHaveLength(1);
			expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'not valid json' }));
		});

		test('does not convert tool results for non-tool-search tools', function () {
			const messages: Raw.ChatMessage[] = [
				{
					role: Raw.ChatRole.Assistant,
					content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: '' }],
					toolCalls: [{
						id: 'toolu_read',
						type: 'function',
						function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' },
					}],
				},
				{
					role: Raw.ChatRole.Tool,
					toolCallId: 'toolu_read',
					content: [
						{ type: Raw.ChatCompletionContentPartKind.Text, text: '["mcp__github__list_issues"]' },
					],
				},
			];

			const result = rawMessagesToMessagesAPI(messages);

			const toolResult = findToolResult(result.messages);
			expect(toolResult).toBeDefined();
			// Should be normal text, not tool_reference blocks
			const content = toolResult!.content as ContentBlockParam[];
			expect(content).toHaveLength(1);
			expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: '["mcp__github__list_issues"]' }));
		});
	});

	test('cache_control-only tool content does not produce empty inner content', function () {
		const messages: Raw.ChatMessage[] = [
			{
				role: Raw.ChatRole.Tool,
				toolCallId: 'toolu_cache_only',
				content: [
					{ type: Raw.ChatCompletionContentPartKind.CacheBreakpoint, cacheType: 'ephemeral' },
				],
			},
		];

		const result = rawMessagesToMessagesAPI(messages);

		const toolResult = findToolResult(result.messages);
		expect(toolResult).toBeDefined();
		expect(toolResult!.cache_control).toEqual({ type: 'ephemeral' });
		// The dummy whitespace-only text block should be filtered out
		expect(toolResult!.content).toBeUndefined();
	});
});

suite('addToolsAndSystemCacheControl', function () {

	function makeTool(name: string, deferred = false): AnthropicMessagesTool {
		return {
			name,
			description: `${name} tool`,
			input_schema: { type: 'object', properties: {}, required: [] },
			...(deferred ? { defer_loading: true } : {}),
		};
	}

	function makeSystemBlock(text: string, cached = false): TextBlockParam {
		return {
			type: 'text',
			text,
			...(cached ? { cache_control: { type: 'ephemeral' as const } } : {}),
		};
	}

	function makeMessages(...msgs: MessageParam[]): MessageParam[] {
		return msgs;
	}

	function countCacheControl(tools: AnthropicMessagesTool[], system: TextBlockParam[] | undefined, messages: MessageParam[]): number {
		let count = 0;
		for (const tool of tools) {
			if (tool.cache_control) {
				count++;
			}
		}
		if (system) {
			for (const block of system) {
				if (block.cache_control) {
					count++;
				}
			}
		}
		for (const msg of messages) {
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (typeof block === 'object' && 'cache_control' in block && block.cache_control) {
						count++;
					}
				}
			}
		}
		return count;
	}

	test('adds cache_control to last non-deferred tool and last system block', function () {
		const tools = [makeTool('read_file'), makeTool('edit_file')];
		const system: TextBlockParam[] = [makeSystemBlock('You are a helpful assistant.')];
		const messagesResult = { messages: makeMessages(), system };

		addToolsAndSystemCacheControl(tools, messagesResult);

		expect(tools[0].cache_control).toBeUndefined();
		expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
		expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
	});

	test('skips deferred tools and marks last non-deferred tool', function () {
		const tools = [makeTool('read_file'), makeTool('edit_file'), makeTool('deferred_a', true), makeTool('deferred_b', true)];
		const system: TextBlockParam[] = [makeSystemBlock('System prompt')];
		const messagesResult = { messages: makeMessages(), system };

		addToolsAndSystemCacheControl(tools, messagesResult);

		expect(tools[0].cache_control).toBeUndefined();
		expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
		expect(tools[2].cache_control).toBeUndefined();
		expect(tools[3].cache_control).toBeUndefined();
	});

	test('does nothing when all tools are deferred and system already has cache_control', function () {
		const tools = [makeTool('deferred_a', true)];
		const system: TextBlockParam[] = [makeSystemBlock('System prompt', true)];
		const messagesResult = { messages: makeMessages(), system };

		addToolsAndSystemCacheControl(tools, messagesResult);

		expect(tools[0].cache_control).toBeUndefined();
		expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
	});

	test('does nothing when no tools and no system', function () {
		const tools: AnthropicMessagesTool[] = [];
		const messagesResult = { messages: makeMessages() };

		addToolsAndSystemCacheControl(tools, messagesResult);

		expect(tools).toHaveLength(0);
	});

	test('evicts message-level cache_control to stay within limit of 4', function () {
		const tools = [makeTool('read_file')];
		const system: TextBlockParam[] = [makeSystemBlock('System prompt')];
		const msg1Content: ContentBlockParam[] = [
			{ type: 'text', text: 'msg1', cache_control: { type: 'ephemeral' } },
		];
		const msg2Content: ContentBlockParam[] = [
			{ type: 'text', text: 'msg2', cache_control: { type: 'ephemeral' } },
		];
		const msg3Content: ContentBlockParam[] = [
			{ type: 'text', text: 'msg3', cache_control: { type: 'ephemeral' } },
		];
		const messages = makeMessages(
			{ role: 'user', content: msg1Content },
			{ role: 'assistant', content: msg2Content },
			{ role: 'user', content: msg3Content },
		);
		const messagesResult = { messages, system };

		// 3 existing in messages + 2 new (tool + system) = 5, need to evict 1
		addToolsAndSystemCacheControl(tools, messagesResult);

		// Total should not exceed 4
		expect(countCacheControl(tools, system, messages)).toBeLessThanOrEqual(4);
		// Tool and system should have cache_control
		expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
		expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
		// Earliest message cache_control should be evicted
		expect(msg1Content[0]).not.toHaveProperty('cache_control');
	});

	test('skips adding breakpoints when capacity cannot be freed', function () {
		// All 4 breakpoints on system blocks — no message-level entries to evict
		const tools = [makeTool('read_file')];
		const system: TextBlockParam[] = [
			makeSystemBlock('block1', true),
			makeSystemBlock('block2', true),
			makeSystemBlock('block3', true),
			makeSystemBlock('block4', true),
		];
		const messagesResult = { messages: makeMessages(), system };

		addToolsAndSystemCacheControl(tools, messagesResult);

		// Cannot add tool cache_control since all 4 slots are taken by system and
		// there are no message-level entries to evict
		expect(tools[0].cache_control).toBeUndefined();
		expect(countCacheControl(tools, system, messagesResult.messages)).toBeLessThanOrEqual(4);
	});

	test('prioritizes tool breakpoint over system when only one slot can be freed', function () {
		const tools = [makeTool('read_file')];
		const system: TextBlockParam[] = [makeSystemBlock('System prompt')];
		// 3 existing message breakpoints + 2 new = 5, can only evict 1 → 1 slot available
		const messages = makeMessages(
			{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] as ContentBlockParam[] },
			{ role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] as ContentBlockParam[] },
			{ role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }] as ContentBlockParam[] },
		);

		// system counts as existing=0, messages=3, new slots=2, need to evict 1
		// But wait: 3+2=5, max 4, toRemove=1, slotsAvailable=2-1=1
		// So only tool gets cache_control (prioritized), system does not
		const messagesResult = { messages, system };
		addToolsAndSystemCacheControl(tools, messagesResult);

		expect(countCacheControl(tools, system, messages)).toBeLessThanOrEqual(4);
		expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
	});

	test('handles only tools, no system blocks', function () {
		const tools = [makeTool('read_file'), makeTool('edit_file')];
		const messagesResult = { messages: makeMessages() };

		addToolsAndSystemCacheControl(tools, messagesResult);

		expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
		expect(tools[0].cache_control).toBeUndefined();
	});

	test('handles only system, no tools', function () {
		const tools: AnthropicMessagesTool[] = [];
		const system: TextBlockParam[] = [makeSystemBlock('System prompt')];
		const messagesResult = { messages: makeMessages(), system };

		addToolsAndSystemCacheControl(tools, messagesResult);

		expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
	});
});
