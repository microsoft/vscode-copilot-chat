/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { expect, suite, test } from 'vitest';
import { rawMessagesToMessagesAPI } from '../../node/messagesApi';

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

		// The user text and tool_result get merged into one user message
		// Find the user message that contains the tool_result
		const userMessages = result.messages.filter(m => m.role === 'user');
		expect(userMessages.length).toBeGreaterThan(0);

		let toolResult: any;
		for (const msg of userMessages) {
			const content = msg.content;
			if (Array.isArray(content)) {
				toolResult = (content as any[]).find((c: any) => c.type === 'tool_result');
				if (toolResult) {
					break;
				}
			}
		}
		expect(toolResult).toBeDefined();

		// cache_control should be on the tool_result block itself
		expect(toolResult.cache_control).toEqual({ type: 'ephemeral' });

		// cache_control should NOT be on inner content blocks
		for (const inner of toolResult.content ?? []) {
			expect(inner.cache_control).toBeUndefined();
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

		const userMessage = result.messages[0];
		const content = userMessage.content as any[];
		const toolResult = content.find((c: any) => c.type === 'tool_result');
		expect(toolResult).toBeDefined();
		expect(toolResult.cache_control).toBeUndefined();
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

		const userMessage = result.messages[0];
		const content = userMessage.content as any[];
		const toolResult = content.find((c: any) => c.type === 'tool_result');
		expect(toolResult).toBeDefined();
		expect(toolResult.cache_control).toEqual({ type: 'ephemeral' });
		// The dummy whitespace-only text block should be filtered out
		expect(toolResult.content).toBeUndefined();
	});
});
