/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { ICreateEndpointBodyOptions, IEndpointBody } from '../../../platform/networking/common/networking';
import { ChatCompletion } from '../../../platform/networking/common/openai';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

/**
 * Represents reasoning details from OpenRouter responses.
 * For Gemini models, the `data` field contains the encrypted thought signature.
 */
interface ReasoningDetail {
	type: 'reasoning.summary' | 'reasoning.encrypted' | 'reasoning.text';
	id?: string | null;
	format?: string;
	index?: number;
	summary?: string;
	data?: string; // Base64-encoded for reasoning.encrypted
	text?: string;
	signature?: string;
}

/**
 * Extended model metadata that includes the reasoning cache reference.
 */
interface ModelMetadataWithReasoningCache extends IChatModelInformation {
	reasoningCache?: Map<string, ReasoningDetail[]>;
}

interface ResponseWithGetBody {
	getBody: () => Promise<import('stream').Readable | null>;
}

/**
 * Extended endpoint body that supports OpenRouter-specific reasoning fields.
 */
interface IEndpointBodyWithReasoning extends IEndpointBody {
	messages?: Array<{
		role: string;
		content: unknown;
		tool_calls?: Array<{
			id?: string;
			type?: string;
			function?: { name?: string; arguments?: string };
			[key: string]: unknown;
		}>;
		reasoning_details?: ReasoningDetail[];
		[key: string]: unknown;
	}>;
}

export class OpenRouterLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'OpenRouter';

	/**
	 * Cache to store reasoning details by tool_call_id.
	 * This is used to preserve reasoning across multi-turn conversations for Gemini models.
	 */
	private readonly _reasoningCache = new Map<string, ReasoningDetail[]>();
	private static readonly MAX_CACHE_SIZE = 500;

	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService private readonly _openRouterInstantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			OpenRouterLMProvider.providerName,
			'https://openrouter.ai/api/v1',
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_openRouterInstantiationService,
		);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			const response = await this._fetcherService.fetch('https://openrouter.ai/api/v1/models?supported_parameters=tools', { method: 'GET' });
			const data = await response.json();
			const knownModels: BYOKKnownModels = {};
			for (const model of data.data) {
				knownModels[model.id] = {
					name: model.name,
					toolCalling: model.supported_parameters?.includes('tools') ?? false,
					vision: model.architecture?.input_modalities?.includes('image') ?? false,
					maxInputTokens: model.top_provider?.context_length ? model.top_provider.context_length - 16000 : 8000,
					maxOutputTokens: 16000
				};
			}
			this._knownModels = knownModels;
			return knownModels;
		} catch (error) {
			this._logService.error(error, `Error fetching available OpenRouter models`);
			throw error;
		}
	}

	override async provideLanguageModelChatResponse(model: LanguageModelChatInformation, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		// Use our custom OpenRouterEndpoint instead of the base OpenAIEndpoint
		const openAIChatEndpoint = await this.getOpenRouterEndpoint(model);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const lmWrapper = (this as any)._lmWrapper;
		return lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.requestInitiator, progress, token);
	}

	private async getOpenRouterEndpoint(model: LanguageModelChatInformation): Promise<OpenRouterEndpoint> {
		const modelInfo: ModelMetadataWithReasoningCache = await this.getModelInfo(model.id, this._apiKey);
		const url = modelInfo.supported_endpoints?.includes(ModelSupportedEndpoint.Responses) ?
			`${this._baseUrl}/responses` :
			`${this._baseUrl}/chat/completions`;

		// Manage cache size - clean up older entries when limit exceeded
		if (this._reasoningCache.size > OpenRouterLMProvider.MAX_CACHE_SIZE) {
			const keysToDelete = Array.from(this._reasoningCache.keys()).slice(0, 100);
			keysToDelete.forEach(k => this._reasoningCache.delete(k));
		}

		// Attach reasoning cache to model metadata so the Endpoint can access it
		modelInfo.reasoningCache = this._reasoningCache;

		return this._openRouterInstantiationService.createInstance(OpenRouterEndpoint, modelInfo, this._apiKey ?? '', url);
	}
}

/**
 * Custom endpoint for OpenRouter that handles Gemini's reasoning details requirements.
 *
 * Gemini models via OpenRouter require that reasoning_details be preserved and replayed
 * in subsequent requests when tool calls are involved.
 *
 * According to OpenRouter's documentation:
 * - reasoning_details should be included at the message level (alongside content and tool_calls)
 * - The entire sequence of reasoning blocks must match the original output unmodified
 *
 * This endpoint:
 * 1. Captures reasoning_details from streaming responses and associates them with tool call IDs
 * 2. Injects the captured reasoning_details back into outgoing requests at the message level
 */
class OpenRouterEndpoint extends OpenAIEndpoint {

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		const body = super.createRequestBody(options) as IEndpointBodyWithReasoning;
		const cache = (this.modelMetadata as ModelMetadataWithReasoningCache).reasoningCache;

		if (cache && body.messages) {
			for (const message of body.messages) {
				// Only process assistant messages that have tool_calls
				if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
					// Find if any of these tool calls have cached reasoning
					let reasoningDetails: ReasoningDetail[] | undefined;

					for (const toolCall of message.tool_calls) {
						if (toolCall.id && cache.has(toolCall.id)) {
							reasoningDetails = cache.get(toolCall.id);
							break; // All tool calls in one turn share the same reasoning
						}
					}

					if (reasoningDetails && reasoningDetails.length > 0) {
						// Inject reasoning_details at the message level
						// OpenRouter expects this alongside content and tool_calls
						message.reasoning_details = reasoningDetails;
					}
				}
			}
		}
		return body;
	}

	public override async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken | undefined
	): Promise<AsyncIterableObject<ChatCompletion>> {

		const cache = (this.modelMetadata as ModelMetadataWithReasoningCache).reasoningCache;

		if (cache) {
			// Fork the response stream to capture reasoning details in parallel
			const responseWithGetBody = response as unknown as ResponseWithGetBody;
			const originalGetBody = responseWithGetBody.getBody;
			let sideStream: import('stream').Readable | undefined;

			responseWithGetBody.getBody = async () => {
				const stream = await originalGetBody.call(response);
				if (stream && stream instanceof Readable) {
					const { PassThrough } = await import('stream');
					const s1 = new PassThrough();
					const s2 = new PassThrough();
					stream.pipe(s1);
					stream.pipe(s2);
					sideStream = s2;
					return s1;
				}
				return stream;
			};

			const result = await super.processResponseFromChatEndpoint(telemetryService, logService, response, expectedNumChoices, finishCallback, telemetryData, cancellationToken);

			if (sideStream) {
				// Process the side stream to capture reasoning details (don't await)
				this.processSideChannel(sideStream, cache, logService).catch(err => {
					logService.error(err, 'OpenRouter reasoning capture failed');
				});
			}

			return result;
		}

		return super.processResponseFromChatEndpoint(telemetryService, logService, response, expectedNumChoices, finishCallback, telemetryData, cancellationToken);
	}

	/**
	 * Processes the response stream to capture reasoning_details and associate them with tool call IDs.
	 */
	private async processSideChannel(stream: import('stream').Readable, cache: Map<string, ReasoningDetail[]>, logService: ILogService) {
		let buffer = '';
		const toolCallIds = new Set<string>();
		let reasoningDetails: ReasoningDetail[] = [];

		try {
			for await (const chunk of stream) {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() || ''; // Keep incomplete line in buffer

				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
						try {
							const jsonStr = trimmed.slice(6);
							const data = JSON.parse(jsonStr);

							// Capture reasoning_details from the response
							// OpenRouter sends these at the top level of the SSE data
							if (data.reasoning_details && Array.isArray(data.reasoning_details)) {
								reasoningDetails = data.reasoning_details;
							}

							// Also check for reasoning_details in choices (some models send it there)
							if (data.choices) {
								for (const choice of data.choices) {
									if (choice.delta?.reasoning_details && Array.isArray(choice.delta.reasoning_details)) {
										reasoningDetails = choice.delta.reasoning_details;
									}
									if (choice.message?.reasoning_details && Array.isArray(choice.message.reasoning_details)) {
										reasoningDetails = choice.message.reasoning_details;
									}

									// Capture tool call IDs (streaming format)
									if (choice.delta?.tool_calls) {
										for (const toolCall of choice.delta.tool_calls) {
											if (toolCall.id) {
												toolCallIds.add(toolCall.id);
											}
										}
									}

									// Capture tool call IDs (non-streaming format)
									if (choice.message?.tool_calls) {
										for (const toolCall of choice.message.tool_calls) {
											if (toolCall.id) {
												toolCallIds.add(toolCall.id);
											}
										}
									}
								}
							}
						} catch {
							// Ignore partial JSON parse errors
						}
					}
				}
			}

			// Associate the captured reasoning with all tool calls in this turn
			if (reasoningDetails.length > 0 && toolCallIds.size > 0) {
				for (const id of toolCallIds) {
					cache.set(id, reasoningDetails);
				}
				logService.trace(`OpenRouter: Cached reasoning details for ${toolCallIds.size} tool calls`);
			}

		} catch (e) {
			logService.error(e, 'OpenRouter side channel error');
		}
	}
}
