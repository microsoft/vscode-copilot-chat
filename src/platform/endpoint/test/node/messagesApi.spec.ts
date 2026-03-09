/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlockParam, ImageBlockParam, MessageParam, ToolReferenceBlockParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources';
import { Raw } from '@vscode/prompt-tsx';
import { expect, suite, test } from 'vitest';
import { CUSTOM_TOOL_SEARCH_NAME } from '../../../networking/common/anthropic';
import { rawMessagesToMessagesAPI } from '../../node/messagesApi';

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
