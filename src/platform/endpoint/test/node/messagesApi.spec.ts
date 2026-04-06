/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlockParam, ImageBlockParam, MessageParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources';
import { Raw } from '@vscode/prompt-tsx';
<<<<<<< HEAD
import { expect, suite, test } from 'vitest';
import { rawMessagesToMessagesAPI } from '../../node/messagesApi';
=======
import { beforeEach, describe, expect, suite, test } from 'vitest';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatLocation } from '../../../chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../configuration/test/common/inMemoryConfigurationService';
import { AnthropicMessagesTool, CUSTOM_TOOL_SEARCH_NAME } from '../../../networking/common/anthropic';
import { IChatEndpoint, ICreateEndpointBodyOptions } from '../../../networking/common/networking';
import { IToolDeferralService } from '../../../networking/common/toolDeferralService';
import { createPlatformServices } from '../../../test/node/services';
import { addToolsAndSystemCacheControl, buildToolInputSchema, createMessagesRequestBody, rawMessagesToMessagesAPI } from '../../node/messagesApi';
>>>>>>> b7e094d (Guard reasoning effort parameter against unsupported models (#5010))

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

describe('createMessagesRequestBody reasoning effort', () => {
	let disposables: DisposableStore;
	let instantiationService: IInstantiationService;
	let mockConfig: InMemoryConfigurationService;

	function createMockEndpoint(overrides: Partial<IChatEndpoint> = {}): IChatEndpoint {
		return {
			model: 'claude-sonnet-4.5',
			family: 'claude-sonnet-4.5',
			modelProvider: 'Anthropic',
			maxOutputTokens: 8192,
			modelMaxPromptTokens: 200000,
			supportsToolCalls: true,
			supportsVision: true,
			supportsPrediction: false,
			showInModelPicker: true,
			isFallback: false,
			name: 'test',
			version: '1.0',
			policy: 'enabled',
			urlOrRequestMetadata: 'https://test.com',
			tokenizer: 0,
			isDefault: false,
			processResponseFromChatEndpoint: () => { throw new Error('not implemented'); },
			acceptChatPolicy: () => { throw new Error('not implemented'); },
			makeChatRequest2: () => { throw new Error('not implemented'); },
			createRequestBody: () => { throw new Error('not implemented'); },
			cloneWithTokenOverride: () => { throw new Error('not implemented'); },
			interceptBody: () => { },
			getExtraHeaders: () => ({}),
			...overrides,
		} as IChatEndpoint;
	}

	function createMinimalOptions(overrides: Partial<ICreateEndpointBodyOptions> = {}): ICreateEndpointBodyOptions {
		return {
			debugName: 'test',
			requestId: 'test-request-id',
			finishedCb: undefined,
			messages: [{
				role: Raw.ChatRole.User,
				content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }],
			}],
			postOptions: { max_tokens: 8192 },
			location: ChatLocation.Panel,
			...overrides,
		};
	}

	beforeEach(() => {
		disposables = new DisposableStore();
		const services = disposables.add(createPlatformServices(disposables));
		services.define(IToolDeferralService, {
			_serviceBrand: undefined,
			isNonDeferredTool: () => true,
		});
		const accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		mockConfig = accessor.get(IConfigurationService) as InMemoryConfigurationService;
	});

	test('includes effort in output_config when model supports reasoning effort and thinking is adaptive', () => {
		const endpoint = createMockEndpoint({
			supportsAdaptiveThinking: true,
			supportsReasoningEffort: ['low', 'medium', 'high'],
		});
		const options = createMinimalOptions({
			enableThinking: true,
			reasoningEffort: 'high',
		});

		const body = instantiationService.invokeFunction(createMessagesRequestBody, options, endpoint.model, endpoint);

		expect(body.thinking).toEqual({ type: 'adaptive' });
		expect(body.output_config).toEqual({ effort: 'high' });
	});

	test('omits effort when model does not declare supportsReasoningEffort', () => {
		const endpoint = createMockEndpoint({
			supportsAdaptiveThinking: true,
			// supportsReasoningEffort is undefined
		});
		const options = createMinimalOptions({
			enableThinking: true,
			reasoningEffort: 'high',
		});

		const body = instantiationService.invokeFunction(createMessagesRequestBody, options, endpoint.model, endpoint);

		expect(body.thinking).toEqual({ type: 'adaptive' });
		expect(body.output_config).toBeUndefined();
	});

	test('omits effort when supportsReasoningEffort is an empty array', () => {
		const endpoint = createMockEndpoint({
			supportsAdaptiveThinking: true,
			supportsReasoningEffort: [],
		});
		const options = createMinimalOptions({
			enableThinking: true,
			reasoningEffort: 'medium',
		});

		const body = instantiationService.invokeFunction(createMessagesRequestBody, options, endpoint.model, endpoint);

		expect(body.thinking).toEqual({ type: 'adaptive' });
		expect(body.output_config).toBeUndefined();
	});

	test('omits effort when thinking is not enabled', () => {
		const endpoint = createMockEndpoint({
			supportsAdaptiveThinking: true,
			supportsReasoningEffort: ['low', 'medium', 'high'],
		});
		const options = createMinimalOptions({
			enableThinking: false,
			reasoningEffort: 'high',
		});

		const body = instantiationService.invokeFunction(createMessagesRequestBody, options, endpoint.model, endpoint);

		expect(body.thinking).toBeUndefined();
		expect(body.output_config).toBeUndefined();
	});

	test('omits effort when reasoningEffort is an invalid value', () => {
		const endpoint = createMockEndpoint({
			supportsAdaptiveThinking: true,
			supportsReasoningEffort: ['low', 'medium', 'high'],
		});
		const options = createMinimalOptions({
			enableThinking: true,
			reasoningEffort: 'xhigh' as any,
		});

		const body = instantiationService.invokeFunction(createMessagesRequestBody, options, endpoint.model, endpoint);

		expect(body.thinking).toEqual({ type: 'adaptive' });
		expect(body.output_config).toBeUndefined();
	});

	test('uses budget_tokens thinking when model has maxThinkingBudget but not adaptive', () => {
		const endpoint = createMockEndpoint({
			supportsAdaptiveThinking: false,
			maxThinkingBudget: 32000,
			minThinkingBudget: 1024,
			supportsReasoningEffort: ['low', 'medium', 'high'],
		});
		mockConfig.setConfig(ConfigKey.AnthropicThinkingBudget, 10000);
		const options = createMinimalOptions({
			enableThinking: true,
			reasoningEffort: 'low',
		});

		const body = instantiationService.invokeFunction(createMessagesRequestBody, options, endpoint.model, endpoint);

		expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8191 });
		expect(body.output_config).toEqual({ effort: 'low' });
	});
});
