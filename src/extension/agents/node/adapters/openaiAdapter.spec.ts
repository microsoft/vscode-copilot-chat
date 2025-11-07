/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { describe, expect, it } from 'vitest';
import { OpenAIAdapterFactory } from './openaiAdapter';

describe('OpenAIAdapterFactory', () => {
	it('should create an OpenAI adapter instance', () => {
		const factory = new OpenAIAdapterFactory();
		const adapter = factory.createAdapter();

		// Verify the adapter has the correct name
		expect(adapter.name).toBe('openai');
	});

	it('should parse a basic OpenAI request', () => {
		const factory = new OpenAIAdapterFactory();
		const adapter = factory.createAdapter();

		const requestBody = {
			model: 'gpt-4o',
			messages: [
				{ role: 'user', content: 'Hello' }
			],
			temperature: 0.7
		};

		const parsedRequest = adapter.parseRequest(JSON.stringify(requestBody));

		expect(parsedRequest.model).toBe('gpt-4o');
		expect(parsedRequest.messages).toHaveLength(1);
		expect(parsedRequest.messages[0]).toEqual({ role: 'user', content: 'Hello' });
		expect(parsedRequest.options?.temperature).toBe(0.7);
	});

	it('should parse an OpenAI request with tools', () => {
		const factory = new OpenAIAdapterFactory();
		const adapter = factory.createAdapter();

		const requestBody = {
			model: 'gpt-4o',
			messages: [
				{ role: 'user', content: 'What is the weather?' }
			],
			tools: [
				{
					type: 'function',
					function: {
						name: 'get_weather',
						description: 'Get the current weather',
						parameters: {
							type: 'object',
							properties: {
								location: { type: 'string' }
							}
						}
					}
				}
			]
		};

		const parsedRequest = adapter.parseRequest(JSON.stringify(requestBody));

		expect(parsedRequest.model).toBe('gpt-4o');
		expect(parsedRequest.messages).toHaveLength(1);
		expect(parsedRequest.options?.tools).toBeDefined();
		expect(parsedRequest.options?.tools).toHaveLength(1);
	});

	it('should extract auth key from headers', () => {
		const factory = new OpenAIAdapterFactory();
		const adapter = factory.createAdapter();

		const headers: http.IncomingHttpHeaders = {
			'authorization': 'Bearer test-key-123'
		};

		const authKey = adapter.extractAuthKey(headers);

		expect(authKey).toBe('test-key-123');
	});

	it('should format text stream response', () => {
		const factory = new OpenAIAdapterFactory();
		const adapter = factory.createAdapter();

		const context = {
			requestId: 'test-request-id',
			endpoint: {
				modelId: 'gpt-4o',
				modelMaxPromptTokens: 128000
			}
		};

		const streamData = {
			type: 'text' as const,
			content: 'Hello, world!'
		};

		const events = adapter.formatStreamResponse(streamData, context);

		expect(events).toHaveLength(1);
		expect(events[0].event).toBe('message');
		expect(events[0].data).toContain('Hello, world!');
	});

	it('should format tool call stream response', () => {
		const factory = new OpenAIAdapterFactory();
		const adapter = factory.createAdapter();

		const context = {
			requestId: 'test-request-id',
			endpoint: {
				modelId: 'gpt-4o',
				modelMaxPromptTokens: 128000
			}
		};

		const streamData = {
			type: 'tool_call' as const,
			callId: 'call_123',
			name: 'get_weather',
			input: { location: 'Boston' }
		};

		const events = adapter.formatStreamResponse(streamData, context);

		expect(events).toHaveLength(1);
		expect(events[0].event).toBe('message');
		expect(events[0].data).toContain('get_weather');
		expect(events[0].data).toContain('Boston');
	});

	it('should generate final events with usage', () => {
		const factory = new OpenAIAdapterFactory();
		const adapter = factory.createAdapter();

		const context = {
			requestId: 'test-request-id',
			endpoint: {
				modelId: 'gpt-4o',
				modelMaxPromptTokens: 128000
			}
		};

		const usage = {
			prompt_tokens: 10,
			completion_tokens: 20,
			total_tokens: 30
		};

		const events = adapter.generateFinalEvents(context, usage);

		expect(events).toHaveLength(1);
		expect(events[0].event).toBe('message');
		expect(events[0].data).toContain('"prompt_tokens":10');
		expect(events[0].data).toContain('"completion_tokens":20');
	});
});