/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, it, vi } from 'vitest';
import { createCapiRequestBody } from '../networking';
import * as openai from '../openai';

describe('createCapiRequestBody - reasoning properties', () => {
	it('AzureOpenAI reasoning properties', () => {
		const spy = vi.spyOn(openai, 'rawMessageToCAPI').mockImplementation((_message: any) => {
			return { role: 'assistant', content: 'assistant content' } as any;
		});

		const assistantMessage: any = {
			role: Raw.ChatRole.Assistant,
			content: [
				{ type: 2, value: { type: 'thinking', thinking: { id: 'thinking-123', text: 'this is a summary' } } }
			]
		};

		const options: any = {
			debugName: 'test',
			messages: [assistantMessage],
			requestId: 'req-1',
			postOptions: undefined,
			finishedCb: undefined,
			location: undefined,
			reasoningPropertyType: 'AzureOpenAI'
		};

		const body = createCapiRequestBody(options, 'model-id');
		expect(body.messages).toBeDefined();
		const messages = body.messages as any[];

		expect(messages).toHaveLength(1);
		expect(messages[0].cot_id).toBe('thinking-123');
		expect(messages[0].cot_summary).toBe('this is a summary');

		spy.mockRestore();
	});

	it('CAPI reasoning properties', () => {
		const spy = vi.spyOn(openai, 'rawMessageToCAPI').mockImplementation(() => {
			return { role: 'assistant', content: 'assistant content' } as any;
		});

		const assistantMessage: any = {
			role: Raw.ChatRole.Assistant,
			content: [
				{ type: 2, value: { type: 'thinking', thinking: { id: 'opaque-456', text: 'some reasoning text' } } }
			]
		};

		const options: any = {
			debugName: 'test',
			messages: [assistantMessage],
			requestId: 'req-2',
			postOptions: undefined,
			finishedCb: undefined,
			location: undefined,
			reasoningPropertyType: 'CAPI'
		};

		const body = createCapiRequestBody(options, 'model-id');
		expect(body.messages).toBeDefined();
		const messages = body.messages as any[];

		expect(messages).toHaveLength(1);
		expect(messages[0].reasoning_opaque).toBe('opaque-456');
		expect(messages[0].reasoning_text).toBe('some reasoning text');

		spy.mockRestore();
	});
});
