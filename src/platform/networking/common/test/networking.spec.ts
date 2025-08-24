/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, it } from 'vitest';
import { createCapiRequestBody } from '../networking';

describe('createCapiRequestBody - reasoning properties', () => {
	it('AzureOpenAI reasoning properties', () => {
		const assistantMessage: any = {
			role: Raw.ChatRole.Assistant,
			content: [
				{ type: Raw.ChatCompletionContentPartKind.Opaque, value: { type: 'thinking', thinking: { id: 'thinking-123', text: 'this is a summary' } } }
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

		// Create a callback that sets AzureOpenAI properties
		const azureCallback = (out: any, data: any) => {
			if (data && data.id) {
				out.cot_id = data.id;
				out.cot_summary = data.text;
			}
		};

		const body = createCapiRequestBody(options, 'model-id', azureCallback);
		expect(body.messages).toBeDefined();
		const messages = body.messages as any[];

		expect(messages).toHaveLength(1);
		expect(messages[0].cot_id).toBe('thinking-123');
		expect(messages[0].cot_summary).toBe('this is a summary');
	});

	it('CAPI reasoning properties', () => {
		const assistantMessage: any = {
			role: Raw.ChatRole.Assistant,
			content: [
				{ type: Raw.ChatCompletionContentPartKind.Opaque, value: { type: 'thinking', thinking: { id: 'opaque-456', text: 'some reasoning text' } } }
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

		// Create a callback that sets CAPI properties
		const capiCallback = (out: any, data: any) => {
			if (data && data.id) {
				out.reasoning_opaque = data.id;
				out.reasoning_text = data.text;
			}
		};

		const body = createCapiRequestBody(options, 'model-id', capiCallback);
		expect(body.messages).toBeDefined();
		const messages = body.messages as any[];

		expect(messages).toHaveLength(1);
		expect(messages[0].reasoning_opaque).toBe('opaque-456');
		expect(messages[0].reasoning_text).toBe('some reasoning text');
	});
});
