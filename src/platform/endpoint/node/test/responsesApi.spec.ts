/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { OpenAI } from 'openai';
import { describe, expect, it } from 'vitest';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatLocation } from '../../../chat/common/commonTypes';
import { ILogService } from '../../../log/common/logService';
import { OpenAiFunctionTool } from '../../../networking/common/fetch';
import { IChatEndpoint } from '../../../networking/common/networking';
import { TelemetryData } from '../../../telemetry/common/telemetryData';
import { SpyingTelemetryService } from '../../../telemetry/node/spyingTelemetryService';
import { createFakeStreamResponse } from '../../../test/node/fetcher';
import { createPlatformServices } from '../../../test/node/services';
import { createResponsesRequestBody, processResponseFromChatEndpoint, responseApiInputToRawMessagesForLogging } from '../responsesApi';

const gpt54ResponsesEndpoint: IChatEndpoint = {
	acquireTokenizer() { throw new Error('Not implemented.'); },
	cloneWithTokenOverride() { throw new Error('Not implemented.'); },
	createRequestBody() { throw new Error('Not implemented.'); },
	family: 'gpt-5.4',
	getExtraHeaders() { return {}; },
	isFallback: false,
	makeChatRequest() { throw new Error('Not implemented.'); },
	makeChatRequest2() { throw new Error('Not implemented.'); },
	maxOutputTokens: 4096,
	model: 'gpt-5.4',
	modelMaxPromptTokens: 128000,
	modelProvider: 'OpenAI',
	name: 'gpt-5.4',
	processResponseFromChatEndpoint() { throw new Error('Not implemented.'); },
	showInModelPicker: true,
	supportsPrediction: false,
	supportsToolCalls: true,
	supportsVision: false,
	tokenizer: 0 as IChatEndpoint['tokenizer'],
	urlOrRequestMetadata: 'https://example.invalid/responses',
	version: 'test',
};

function createTool(name: string): OpenAiFunctionTool {
	return {
		type: 'function',
		function: {
			name,
			description: `${name} tool`,
			parameters: {
				type: 'object',
				properties: {},
				required: [],
			},
		},
	};
}

describe('createResponsesRequestBody', () => {
	it('adds hosted tool search and defers non-core tools for gpt-5.4', () => {
		const services = createPlatformServices();
		const accessor = services.createTestingAccessor();

		const body = accessor.get(IInstantiationService).invokeFunction(servicesAccessor => createResponsesRequestBody(servicesAccessor, {
			messages: [],
			location: ChatLocation.Agent,
			postOptions: {},
			requestOptions: {
				tools: [createTool('read_file'), createTool('custom_tool')],
			},
		}, 'gpt-5.4', gpt54ResponsesEndpoint));

		expect(body.tools).toEqual([
			{
				type: 'function',
				name: 'read_file',
				description: 'read_file tool',
				strict: false,
				parameters: { type: 'object', properties: {}, required: [] },
			},
			{
				type: 'function',
				name: 'custom_tool',
				description: 'custom_tool tool',
				strict: false,
				parameters: { type: 'object', properties: {}, required: [] },
				defer_loading: true,
			},
			{ type: 'tool_search' },
		]);

		accessor.dispose();
		services.dispose();
	});

	it('keeps the required tool loaded immediately', () => {
		const services = createPlatformServices();
		const accessor = services.createTestingAccessor();

		const body = accessor.get(IInstantiationService).invokeFunction(servicesAccessor => createResponsesRequestBody(servicesAccessor, {
			messages: [],
			location: ChatLocation.Agent,
			postOptions: {
				tool_choice: {
					type: 'function',
					function: { name: 'custom_tool' },
				},
			},
			requestOptions: {
				tools: [createTool('custom_tool')],
			},
		}, 'gpt-5.4', gpt54ResponsesEndpoint));

		expect(body.tools).toEqual([
			{
				type: 'function',
				name: 'custom_tool',
				description: 'custom_tool tool',
				strict: false,
				parameters: { type: 'object', properties: {}, required: [] },
			},
		]);

		accessor.dispose();
		services.dispose();
	});
});

describe('responseApiInputToRawMessagesForLogging', () => {

	it('converts simple string input to user message', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			input: 'Hello, world!'
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		expect(result).toHaveLength(1);
		expect(result[0].role).toBe(Raw.ChatRole.User);
		expect(result[0].content).toEqual([
			{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello, world!' }
		]);
	});

	it('includes system instructions when provided', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			input: 'Hello',
			instructions: 'You are a helpful assistant'
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		expect(result).toHaveLength(2);
		expect(result[0].role).toBe(Raw.ChatRole.System);
		expect(result[0].content).toEqual([
			{ type: Raw.ChatCompletionContentPartKind.Text, text: 'You are a helpful assistant' }
		]);
		expect(result[1].role).toBe(Raw.ChatRole.User);
	});

	it('converts user message with input_text content', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			input: [
				{
					role: 'user',
					content: [{ type: 'input_text', text: 'What is the weather?' }]
				}
			]
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		expect(result).toHaveLength(1);
		expect(result[0].role).toBe(Raw.ChatRole.User);
		expect(result[0].content).toEqual([
			{ type: Raw.ChatCompletionContentPartKind.Text, text: 'What is the weather?' }
		]);
	});

	it('converts system/developer messages to system role', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			input: [
				{
					role: 'developer',
					content: 'Be concise'
				}
			]
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		expect(result).toHaveLength(1);
		expect(result[0].role).toBe(Raw.ChatRole.System);
	});

	it('converts function_call items to assistant tool calls', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			input: [
				{
					type: 'function_call',
					call_id: 'call_123',
					name: 'get_weather',
					arguments: '{"location": "Seattle"}'
				}
			]
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		expect(result).toHaveLength(1);
		expect(result[0].role).toBe(Raw.ChatRole.Assistant);
		const assistantMsg = result[0] as Raw.AssistantChatMessage;
		expect(assistantMsg.toolCalls).toHaveLength(1);
		expect(assistantMsg.toolCalls![0]).toEqual({
			id: 'call_123',
			type: 'function',
			function: {
				name: 'get_weather',
				arguments: '{"location": "Seattle"}'
			}
		});
	});

	it('converts function_call_output items to tool messages', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			input: [
				{
					type: 'function_call_output',
					call_id: 'call_123',
					output: 'Sunny, 72°F'
				}
			]
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		expect(result).toHaveLength(1);
		expect(result[0].role).toBe(Raw.ChatRole.Tool);
		const toolMsg = result[0] as Raw.ToolChatMessage;
		expect(toolMsg.toolCallId).toBe('call_123');
		expect(toolMsg.content).toEqual([
			{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Sunny, 72°F' }
		]);
	});

	it('handles mixed conversation with multiple message types', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			instructions: 'You are a weather assistant',
			input: [
				{
					role: 'user',
					content: 'What is the weather in Seattle?'
				},
				{
					type: 'function_call',
					call_id: 'call_456',
					name: 'get_weather',
					arguments: '{"location": "Seattle"}'
				},
				{
					type: 'function_call_output',
					call_id: 'call_456',
					output: 'Rainy, 55°F'
				},
				{
					role: 'user',
					content: 'Thanks!'
				}
			]
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		expect(result).toHaveLength(5);
		expect(result[0].role).toBe(Raw.ChatRole.System); // instructions
		expect(result[1].role).toBe(Raw.ChatRole.User); // first user message
		expect(result[2].role).toBe(Raw.ChatRole.Assistant); // function call
		expect((result[2] as Raw.AssistantChatMessage).toolCalls).toHaveLength(1);
		expect(result[3].role).toBe(Raw.ChatRole.Tool); // function output
		expect(result[4].role).toBe(Raw.ChatRole.User); // thanks message
	});

	it('returns empty array for undefined input', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			input: undefined as any
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		expect(result).toHaveLength(0);
	});

	it('groups consecutive function calls into single assistant message', () => {
		const body: OpenAI.Responses.ResponseCreateParams = {
			model: 'gpt-5-mini',
			input: [
				{
					type: 'function_call',
					call_id: 'call_1',
					name: 'tool_a',
					arguments: '{}'
				},
				{
					type: 'function_call',
					call_id: 'call_2',
					name: 'tool_b',
					arguments: '{}'
				}
			]
		};

		const result = responseApiInputToRawMessagesForLogging(body);

		// Two consecutive function calls should be grouped into one assistant message
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe(Raw.ChatRole.Assistant);
		expect((result[0] as Raw.AssistantChatMessage).toolCalls).toHaveLength(2);
	});
});

describe('processResponseFromChatEndpoint telemetry', () => {
	it('emits engine.messages for Responses API assistant output', async () => {
		const services = createPlatformServices();
		const accessor = services.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		const logService = accessor.get(ILogService);
		const telemetryService = new SpyingTelemetryService();

		const completedEvent = {
			type: 'response.completed',
			response: {
				id: 'resp_123',
				model: 'gpt-5-mini',
				created_at: 123,
				usage: {
					input_tokens: 11,
					output_tokens: 7,
					total_tokens: 18,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
				output: [
					{
						type: 'message',
						content: [{ type: 'output_text', text: 'final assistant reply' }],
					}
				],
			}
		};

		const response = createFakeStreamResponse(`data: ${JSON.stringify(completedEvent)}\n\n`);
		const telemetryData = TelemetryData.createAndMarkAsIssued({ modelCallId: 'model-call-1' }, {});

		const stream = await processResponseFromChatEndpoint(
			instantiationService,
			telemetryService,
			logService,
			response,
			1,
			async () => undefined,
			telemetryData
		);

		for await (const _ of stream) {
			// consume all completions to flush telemetry side effects
		}

		const events = telemetryService.getEvents().telemetryServiceEvents.filter(e => e.eventName === 'engine.messages');
		expect(events.length).toBeGreaterThan(0);

		const outputEvent = events[events.length - 1];
		const messagesJson = JSON.parse(String((outputEvent.properties as Record<string, string>)?.messagesJson));
		expect(messagesJson).toHaveLength(1);
		expect(messagesJson[0].role).toBe('assistant');
		expect(messagesJson[0].content).toBe('final assistant reply');

		accessor.dispose();
		services.dispose();
	});
});
