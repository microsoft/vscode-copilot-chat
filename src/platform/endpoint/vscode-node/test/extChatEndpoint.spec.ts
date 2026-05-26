/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelChat, LanguageModelChatResponse } from 'vscode';
import { LanguageModelDataPart, LanguageModelTextPart } from '../../../../vscodeTypes';
import { ChatFetchResponseType, ChatLocation } from '../../../chat/common/commonTypes';
import { CustomDataPartMimeTypes } from '../../common/endpointTypes';
import { ExtensionContributedChatEndpoint } from '../extChatEndpoint';

function createMockStream(chunks: unknown[]): LanguageModelChatResponse {
	return {
		stream: (async function* () {
			for (const chunk of chunks) {
				yield chunk;
			}
		})(),
		text: (async function* () {
			for (const chunk of chunks) {
				if (chunk instanceof LanguageModelTextPart) {
					yield chunk.value;
				}
			}
		})(),
	} as LanguageModelChatResponse;
}

function createMockLanguageModel(streamChunks: unknown[]): LanguageModelChat {
	return {
		id: 'test-model',
		name: 'Test Model',
		vendor: 'test',
		family: 'test-family',
		version: '1.0',
		maxInputTokens: 128000,
		capabilities: {},
		sendRequest: vi.fn().mockResolvedValue(createMockStream(streamChunks)),
		countTokens: vi.fn().mockResolvedValue(10),
	} as unknown as LanguageModelChat;
}

function createEndpoint(streamChunks: unknown[]): ExtensionContributedChatEndpoint {
	const languageModel = createMockLanguageModel(streamChunks);
	const mockInstantiationService = {} as any;
	const mockOTelService = {
		getActiveTraceContext: vi.fn().mockReturnValue(undefined),
	} as any;
	return new ExtensionContributedChatEndpoint(languageModel, mockInstantiationService, mockOTelService);
}

describe('ExtensionContributedChatEndpoint usage reporting', () => {
	it('should extract usage from Usage DataPart', async () => {
		const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } };
		const endpoint = createEndpoint([
			new LanguageModelTextPart('Hello'),
			new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usage)), CustomDataPartMimeTypes.Usage),
		]);

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [],
			finishedCb: undefined,
			location: ChatLocation.Panel,
		}, { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type === ChatFetchResponseType.Success) {
			expect(result.usage?.prompt_tokens).toBe(100);
			expect(result.usage?.completion_tokens).toBe(50);
			expect(result.usage?.total_tokens).toBe(150);
			expect(result.usage?.prompt_tokens_details?.cached_tokens).toBe(20);
		}
	});

	it('should fall back to zero usage when no Usage DataPart is present', async () => {
		const endpoint = createEndpoint([
			new LanguageModelTextPart('Hello'),
		]);

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [],
			finishedCb: undefined,
			location: ChatLocation.Panel,
		}, { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type === ChatFetchResponseType.Success) {
			expect(result.usage?.prompt_tokens).toBe(0);
			expect(result.usage?.completion_tokens).toBe(0);
		}
	});

	it('should fall back to zero usage when Usage DataPart contains malformed data', async () => {
		const endpoint = createEndpoint([
			new LanguageModelTextPart('Hello'),
			new LanguageModelDataPart(new TextEncoder().encode('not-valid-json'), CustomDataPartMimeTypes.Usage),
		]);

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [],
			finishedCb: undefined,
			location: ChatLocation.Panel,
		}, { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type === ChatFetchResponseType.Success) {
			expect(result.usage?.prompt_tokens).toBe(0);
			expect(result.usage?.completion_tokens).toBe(0);
		}
	});

	it('should reject usage with invalid field types', async () => {
		const invalidUsage = { prompt_tokens: '100', completion_tokens: 50, total_tokens: 150 };
		const endpoint = createEndpoint([
			new LanguageModelTextPart('Hello'),
			new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(invalidUsage)), CustomDataPartMimeTypes.Usage),
		]);

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [],
			finishedCb: undefined,
			location: ChatLocation.Panel,
		}, { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type === ChatFetchResponseType.Success) {
			expect(result.usage?.prompt_tokens).toBe(0);
			expect(result.usage?.completion_tokens).toBe(0);
		}
	});

	it('should extract usage when Usage DataPart arrives before text', async () => {
		const usage = { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 };
		const endpoint = createEndpoint([
			new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usage)), CustomDataPartMimeTypes.Usage),
			new LanguageModelTextPart('Hello'),
		]);

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [],
			finishedCb: undefined,
			location: ChatLocation.Panel,
		}, { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type === ChatFetchResponseType.Success) {
			expect(result.usage?.prompt_tokens).toBe(200);
			expect(result.usage?.completion_tokens).toBe(80);
			expect(result.usage?.total_tokens).toBe(280);
		}
	});

	it('should report usage when finishedCb is provided', async () => {
		const usage = { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 };
		const finishedCb = vi.fn();
		const endpoint = createEndpoint([
			new LanguageModelTextPart('Hello'),
			new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usage)), CustomDataPartMimeTypes.Usage),
		]);

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [],
			finishedCb,
			location: ChatLocation.Panel,
		}, { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type === ChatFetchResponseType.Success) {
			expect(result.usage?.prompt_tokens).toBe(50);
			expect(result.usage?.completion_tokens).toBe(25);
		}
	});
});
