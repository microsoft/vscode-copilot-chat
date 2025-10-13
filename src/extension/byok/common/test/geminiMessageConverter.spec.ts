/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { LanguageModelChatMessage } from 'vscode';
import { LanguageModelChatMessageRole, LanguageModelTextPart, LanguageModelToolResultPart, LanguageModelTextPart as LMText } from '../../../../vscodeTypes';
import { apiMessageToGeminiMessage } from '../geminiMessageConverter';

describe('GeminiMessageConverter', () => {
	it('should convert basic user and assistant messages', () => {
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.User,
				content: [new LanguageModelTextPart('Hello, how are you?')],
				name: undefined
			},
			{
				role: LanguageModelChatMessageRole.Assistant,
				content: [new LanguageModelTextPart('I am doing well, thank you!')],
				name: undefined
			}
		];

		const result = apiMessageToGeminiMessage(messages);

		expect(result.contents).toHaveLength(2);
		expect(result.contents[0].role).toBe('user');
		expect(result.contents[0].parts).toBeDefined();
		expect(result.contents[0].parts![0].text).toBe('Hello, how are you?');
		expect(result.contents[1].role).toBe('model');
		expect(result.contents[1].parts).toBeDefined();
		expect(result.contents[1].parts![0].text).toBe('I am doing well, thank you!');
	});

	it('should handle system messages as system instruction', () => {
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.System,
				content: [new LanguageModelTextPart('You are a helpful assistant.')],
				name: undefined
			},
			{
				role: LanguageModelChatMessageRole.User,
				content: [new LanguageModelTextPart('Hello!')],
				name: undefined
			}
		];

		const result = apiMessageToGeminiMessage(messages);

		expect(result.systemInstruction).toBeDefined();
		expect(result.systemInstruction!.parts).toBeDefined();
		expect(result.systemInstruction!.parts![0].text).toBe('You are a helpful assistant.');
		expect(result.contents).toHaveLength(1);
		expect(result.contents[0].role).toBe('user');
	});

	it('should filter out empty text parts', () => {
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.User,
				content: [
					new LanguageModelTextPart(''),
					new LanguageModelTextPart('  '),
					new LanguageModelTextPart('Hello!')
				],
				name: undefined
			}
		];

		const result = apiMessageToGeminiMessage(messages);

		expect(result.contents[0].parts).toBeDefined();
		expect(result.contents[0].parts!).toHaveLength(2); // Empty string filtered out, whitespace kept
		expect(result.contents[0].parts![0].text).toBe('  ');
		expect(result.contents[0].parts![1].text).toBe('Hello!');
	});

	it('should extract functionResponse parts from model message into subsequent user message and prune empty model', () => {
		// Simulate a model message that (incorrectly) contains only a tool result part
		const toolResult = new LanguageModelToolResultPart('myTool_12345', [new LanguageModelTextPart('{"foo":"bar"}')]);
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.Assistant,
				content: [toolResult],
				name: undefined
			}
		];

		const { contents } = apiMessageToGeminiMessage(messages);

		// The original (empty) model message should be pruned; we expect a single user message with functionResponse
		expect(contents).toHaveLength(1);
		expect(contents[0].role).toBe('user');
		expect(contents[0].parts![0]).toHaveProperty('functionResponse');
		const fr: any = contents[0].parts![0];
		expect(fr.functionResponse.name).toBe('myTool'); // extracted from callId prefix
		expect(fr.functionResponse.response).toEqual({ foo: 'bar' });
	});

	it('should be idempotent when called multiple times (no duplication)', () => {
		const toolResult = new LanguageModelToolResultPart('doThing_12345', [new LMText('{"value":42}')]);
		const messages: LanguageModelChatMessage[] = [
			{ role: LanguageModelChatMessageRole.Assistant, content: [new LMText('Result:'), toolResult], name: undefined }
		];
		const first = apiMessageToGeminiMessage(messages);
		const second = apiMessageToGeminiMessage(messages); // Re-run with same original messages

		// Both runs should yield identical normalized structure (model text + user tool response) without growth
		expect(first.contents.length).toBe(2);
		expect(second.contents.length).toBe(2);
		expect(first.contents[0].role).toBe('model');
		expect(first.contents[1].role).toBe('user');
		expect(second.contents[0].role).toBe('model');
		expect(second.contents[1].role).toBe('user');
	});
});