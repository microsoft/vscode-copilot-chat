/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { Source } from '../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType, ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { EndpointEditToolName } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, ICopilotToolCall, IResponseDelta, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { ChatCompletion, rawMessageToCAPI } from '../../../platform/networking/common/openai';
import { ITelemetryService, TelemetryProperties } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { generateUuid } from '../../../util/vs/base/common/uuid';

/**
 * Feima Endpoint for integrating Qwen3 Coder LLM (OpenAI-compatible API)
 */
export class FeimaEndpoint implements IChatEndpoint {
	// Model configuration
	readonly model = 'qwen3-coder-plus';
	readonly name = 'Qwen3 Coder';
	readonly version = '1.0';
	readonly family = 'qwen3';
	readonly tokenizer: TokenizerType = TokenizerType.CL100K;
	readonly modelMaxPromptTokens = 120000; // Leave some buffer from 128k
	readonly maxOutputTokens = 8192;

	// Model capabilities
	readonly supportsToolCalls = true; // Qwen3 supports tool calling
	readonly supportsVision = false;
	readonly supportsPrediction = false;
	readonly supportsThinkingContentInHistory = false;
	readonly supportedEditTools: readonly EndpointEditToolName[] = [];

	// Model metadata
	readonly showInModelPicker = true;
	readonly isDefault = false;
	readonly isFallback = false;
	readonly isPremium = false;
	readonly multiplier = undefined;
	readonly restrictedToSkus = undefined;
	readonly customModel = undefined;
	readonly isExtensionContributed = true;
	readonly degradationReason = undefined;

	// Policy
	readonly policy: 'enabled' = 'enabled';

	constructor(
		private readonly apiKey: string,
		private readonly baseUrl: string,
		private readonly tokenizerProvider: ITokenizerProvider,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@ILogService private readonly logService: ILogService,
	) {
		this.logService.info(`[FeimaEndpoint] Initialized with baseUrl: ${baseUrl}`);
	}

	get apiType(): string {
		return 'openai-compatible';
	}

	get urlOrRequestMetadata(): string {
		return `${this.baseUrl}/chat/completions`;
	}

	getExtraHeaders(): Record<string, string> {
		return {
			'Authorization': `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		};
	}

	acquireTokenizer(): ITokenizer {
		return this.tokenizerProvider.acquireTokenizer(this);
	}

	async acceptChatPolicy(): Promise<boolean> {
		// No policy acceptance needed for custom endpoint
		return true;
	}

	createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		const request: IEndpointBody = {
			messages: rawMessageToCAPI(options.messages),
			model: this.model,
			stream: false, // Disable streaming for simplicity
			max_tokens: this.maxOutputTokens,
		};

		if (options.postOptions) {
			Object.assign(request, options.postOptions);
		}

		// Log the request body to debug tool calling
		this.logService.debug(`[FeimaEndpoint] Request body: ${JSON.stringify(request, null, 2)}`);

		return request;
	}

	async makeChatRequest(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		source?: Source,
		requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
	): Promise<ChatResponse> {
		return this.makeChatRequest2({
			debugName,
			messages,
			finishedCb,
			location,
			source,
			requestOptions,
			userInitiatedRequest,
			telemetryProperties,
		}, token);
	}

	async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		const requestId = generateUuid();

		try {
			const body = this.createRequestBody({
				...options,
				requestId,
				postOptions: options.requestOptions ?? {},
			});

			this.logService.debug(`[FeimaEndpoint] Making request to ${this.urlOrRequestMetadata} with ${options.messages.length} messages`);

			// Create AbortController to convert VS Code CancellationToken to AbortSignal
			const abortController = new AbortController();
			const abortListener = token.onCancellationRequested(() => {
				abortController.abort();
			});

			try {
				// Make the HTTP request
				const response = await this.fetcherService.fetch(this.urlOrRequestMetadata, {
					method: 'POST',
					headers: this.getExtraHeaders(),
					body: JSON.stringify(body),
					signal: abortController.signal,
				});

				if (!response.ok) {
					const errorText = await response.text();
					this.logService.error(`[FeimaEndpoint] Request failed: ${response.status} ${errorText}`);
					return {
						type: ChatFetchResponseType.Failed,
						reason: `Qwen3 API error: ${response.status} ${errorText}`,
						requestId,
						serverRequestId: undefined,
					};
				}

				// Get response text
				const responseText = await response.text();
				const jsonResponse = JSON.parse(responseText);

				// Log the full response for debugging
				this.logService.debug(`[FeimaEndpoint] Response: ${JSON.stringify(jsonResponse, null, 2)}`);

				// Extract the assistant message (OpenAI format)
				const choice = jsonResponse?.choices?.[0];
				const message = choice?.message;
				const assistantMessage = message?.content || '';
				const toolCalls = message?.tool_calls;

				// Prepare the response delta
				const delta: IResponseDelta = { text: assistantMessage };

				// Convert OpenAI tool_calls format to Copilot's copilotToolCalls format
				if (toolCalls && Array.isArray(toolCalls)) {
					delta.copilotToolCalls = toolCalls.map((tc: { id: string; function?: { name?: string; arguments?: string } }): ICopilotToolCall => ({
						id: tc.id,
						name: tc.function?.name || '',
						arguments: tc.function?.arguments || '{}',
					}));
					this.logService.debug(`[FeimaEndpoint] Converted ${toolCalls.length} tool calls to copilotToolCalls format`);
				}

				// Call the finish callback with the complete delta
				if (options.finishedCb) {
					await options.finishedCb(assistantMessage, 0, delta);
				}

				return {
					type: ChatFetchResponseType.Success,
					requestId,
					serverRequestId: jsonResponse.id,
					value: assistantMessage,
					usage: jsonResponse.usage,
					resolvedModel: jsonResponse.model || this.model,
				};
			} finally {
				abortListener.dispose();
			}
		} catch (error) {
			this.logService.error(error instanceof Error ? error : new Error(String(error)), '[FeimaEndpoint] Request error');
			return {
				type: ChatFetchResponseType.Failed,
				reason: `Qwen3 API error: ${error instanceof Error ? error.message : String(error)}`,
				requestId,
				serverRequestId: undefined,
			};
		}
	}

	async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken
	): Promise<AsyncIterableObject<ChatCompletion>> {
		// Not used in our simplified implementation
		// This method is part of IChatEndpoint interface but we handle responses directly in makeChatRequest2
		logService.warn('[FeimaEndpoint] processResponseFromChatEndpoint called but not implemented');
		throw new Error('processResponseFromChatEndpoint not implemented for FeimaEndpoint');
	}

	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		// Create a shallow copy with overridden token limit
		return Object.create(this, {
			modelMaxPromptTokens: { value: modelMaxPromptTokens, writable: false, enumerable: true }
		});
	}
}
