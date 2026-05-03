/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatFetchResponseType, ChatLocation } from '../../../chat/common/commonTypes';
import { IOTelService } from '../../../otel/common/otelService';
import { ExtensionContributedChatEndpoint } from '../extChatEndpoint';

vi.mock('../../../requestLogger/node/requestLogger', () => ({
	storeCapturingTokenForCorrelation: vi.fn(),
	retrieveCapturingTokenByCorrelation: vi.fn(),
}));

class MockLanguageModelChat implements Partial<vscode.LanguageModelChat> {
	public readonly id = 'test.model';
	public readonly name = 'Test Model';
	public readonly version = '1.0.0';
	public readonly family = 'test';
	public readonly vendor = 'test-vendor';
	public readonly maxInputTokens = 8192;
	public readonly capabilities = {
		supportsToolCalling: false,
		supportsImageToText: false,
	};

	constructor(private readonly parts: readonly vscode.LanguageModelResponsePart[]) {
	}

	sendRequest(): Thenable<vscode.LanguageModelChatResponse> {
		const parts = this.parts;
		return Promise.resolve({
			stream: (async function* () {
				for (const part of parts) {
					yield part;
				}
			})(),
			text: (async function* () {
				for (const part of parts) {
					if (part instanceof vscode.LanguageModelTextPart) {
						yield part.value;
					}
				}
			})(),
		} as unknown as vscode.LanguageModelChatResponse);
	}

	countTokens(_input: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2, _token?: vscode.CancellationToken): Thenable<number> {
		return Promise.resolve(0);
	}
}

function createEndpoint(parts: readonly vscode.LanguageModelResponsePart[]): ExtensionContributedChatEndpoint {
	const languageModel = new MockLanguageModelChat(parts);
	const instantiationService = {} as unknown as IInstantiationService;
	const otelService = {
		getActiveTraceContext: () => undefined,
	} as unknown as IOTelService;

	return new ExtensionContributedChatEndpoint(languageModel as unknown as vscode.LanguageModelChat, instantiationService, otelService);
}

function createUserMessage(text: string): Raw.ChatMessage {
	return {
		role: Raw.ChatRole.User,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
}

describe('ExtensionContributedChatEndpoint', () => {
	it('parses usage data by shape even when mime type is provider-specific', async () => {
		const usagePart = new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify({
				prompt_tokens: 11,
				completion_tokens: 7,
				total_tokens: 18,
				prompt_tokens_details: { cached_tokens: 4 },
				completion_tokens_details: {
					reasoning_tokens: 2,
					accepted_prediction_tokens: 3,
					rejected_prediction_tokens: 1,
				},
			})),
			'application/vnd.provider.usage+json'
		);

		const endpoint = createEndpoint([
			new vscode.LanguageModelTextPart('hello'),
			usagePart,
		]);

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [createUserMessage('hi')],
			requestOptions: undefined,
			finishedCb: undefined,
			location: ChatLocation.Panel,
			source: undefined,
		}, new vscode.CancellationTokenSource().token);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type !== ChatFetchResponseType.Success) {
			return;
		}

		expect(result.usage?.prompt_tokens).toBe(11);
		expect(result.usage?.completion_tokens).toBe(7);
		expect(result.usage?.total_tokens).toBe(18);
		expect(result.usage?.prompt_tokens_details?.cached_tokens).toBe(4);
		expect(result.usage?.completion_tokens_details?.reasoning_tokens).toBe(2);
		expect(result.usage?.completion_tokens_details?.accepted_prediction_tokens).toBe(3);
		expect(result.usage?.completion_tokens_details?.rejected_prediction_tokens).toBe(1);
	});

	it('falls back to default usage when data chunks are not usage-shaped', async () => {
		const nonUsagePart = new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify({ context: { id: 'abc' } })),
			'application/json'
		);

		const endpoint = createEndpoint([
			new vscode.LanguageModelTextPart('hello'),
			nonUsagePart,
		]);

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [createUserMessage('hi')],
			requestOptions: undefined,
			finishedCb: undefined,
			location: ChatLocation.Panel,
			source: undefined,
		}, new vscode.CancellationTokenSource().token);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type !== ChatFetchResponseType.Success) {
			return;
		}

		expect(result.usage?.prompt_tokens).toBe(0);
		expect(result.usage?.completion_tokens).toBe(0);
		expect(result.usage?.total_tokens).toBe(0);
		expect(result.usage?.prompt_tokens_details?.cached_tokens).toBe(0);
		expect(result.usage?.completion_tokens_details).toBeUndefined();
	});
});
