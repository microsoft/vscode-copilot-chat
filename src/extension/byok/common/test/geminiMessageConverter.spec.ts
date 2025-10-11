/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { LanguageModelChatMessage } from 'vscode';
import { LanguageModelChatMessageRole, LanguageModelTextPart } from '../../../../vscodeTypes';
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
});