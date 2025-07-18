/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import { CancellationToken, ChatResponseFragment2, ChatResponseProviderMetadata, Disposable, LanguageModelChatMessage, LanguageModelChatProvider, LanguageModelChatRequestOptions, LanguageModelTextPart, LanguageModelToolCallPart, lm, Progress } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage, rawMessageToCAPI } from '../../../platform/networking/common/openai';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { toErrorMessage } from '../../../util/vs/base/common/errorMessage';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels, BYOKModelConfig, BYOKModelRegistry, chatModelInfoToProviderMetadata, isGlobalKeyConfig, resolveModelInfo } from '../common/byokProvider';
import { anthropicMessagesToRawMessagesForLogging, apiMessageToAnthropicMessage } from './anthropicMessageConverter';

export class AnthropicBYOKModelRegistry implements BYOKModelRegistry {
	public readonly authType = BYOKAuthType.GlobalApiKey;
	public readonly name = 'Anthropic';
	private _knownModels: BYOKKnownModels | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) { }

	async getAllModels(apiKey: string): Promise<{ id: string; name: string }[]> {
		try {
			const client = new Anthropic({ apiKey });
			const response = await client.models.list();
			const modelList: { id: string; name: string }[] = [];
			for (const model of response.data) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList.push({ id: model.id, name: this._knownModels[model.id].name });
				}
			}
			return modelList;
		} catch (error) {
			this._logService.logger.error(error, `Error fetching available ${this.name} models`);
			throw new Error(error.message ? error.message : error);
		}
	}

	updateKnownModelsList(knownModels: BYOKKnownModels | undefined): void {
		if (knownModels) {
			knownModels['claude-opus-4-20250514'] = {
				'name': 'Claude Opus 4',
				'toolCalling': true,
				'vision': false,
				'maxInputTokens': 64000,
				'maxOutputTokens': 8192
			};
		}
		this._knownModels = knownModels;
	}

	async registerModel(config: BYOKModelConfig): Promise<Disposable> {
		if (!isGlobalKeyConfig(config)) {
			throw new Error('Incorrect configuration passed to anthropic provider');
		}
		try {
			const modelMetadata = chatModelInfoToProviderMetadata(resolveModelInfo(config.modelId, this.name, this._knownModels, config.capabilities));
			const provider = this._instantiationService.createInstance(AnthropicChatProvider, config.apiKey, config.modelId, modelMetadata);

			const disposable = lm.registerChatModelProvider(
				`${this.name}-${config.modelId}`,
				provider,
				modelMetadata
			);
			return disposable;
		} catch (e) {
			this._logService.logger.error(`Error registering ${this.name} model ${config.modelId}`);
			throw e;
		}
	}
}

export class AnthropicChatProvider implements LanguageModelChatProvider {
	private client: Anthropic;
	private modelId: string;

	constructor(
		apiKey: string,
		modelId: string,
		private readonly _modelMetadata: ChatResponseProviderMetadata,
		@ILogService private readonly _logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@IThinkingDataService private readonly _thinkingDataService: IThinkingDataService
	) {
		this.client = new Anthropic({
			apiKey
		});
		this.modelId = modelId;
	}

	async provideLanguageModelResponse(
		messages: LanguageModelChatMessage[],
		options: LanguageModelChatRequestOptions,
		extensionId: string,
		progress: Progress<ChatResponseFragment2>,
		token: CancellationToken
	): Promise<void> {
		// Convert the messages from the API format into messages that we can use against anthropic
		const { system, messages: convertedMessages } = apiMessageToAnthropicMessage(messages, this._thinkingDataService);

		const requestId = generateUuid();
		const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
			'AnthropicBYOK',
			{
				model: this.modelId,
				modelMaxPromptTokens: this._modelMetadata.maxInputTokens,
				urlOrRequestMetadata: this.client.baseURL,
			},
			{
				model: this.modelId,
				location: ChatLocation.Other,
				messages: rawMessageToCAPI(anthropicMessagesToRawMessagesForLogging(convertedMessages, system)),
				ourRequestId: requestId,
				postOptions: {
					tools: options.tools?.map((tool): OpenAiFunctionTool => ({
						type: 'function',
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.inputSchema
						}
					}))
				}
			});

		const tools: Anthropic.Messages.Tool[] = (options.tools ?? []).map(tool => {
			if (!tool.inputSchema) {
				return {
					name: tool.name,
					description: tool.description,
					input_schema: {
						type: 'object',
						properties: {},
						required: []
					}
				};
			}

			return {
				name: tool.name,
				description: tool.description,
				input_schema: {
					type: 'object',
					properties: (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
					required: (tool.inputSchema as { required?: string[] }).required ?? []
				}
			};
		});

		const params: Anthropic.MessageCreateParamsStreaming = {
			model: this.modelId,
			messages: convertedMessages,
			max_tokens: this._modelMetadata.maxOutputTokens,
			stream: true,
			system: [system],
			tools: tools.length > 0 ? tools : undefined,
			thinking: {
				"type": "enabled",
				"budget_tokens": 6000
			},
		};

		const wrappedProgress = new RecordedProgress(progress);

		try {
			const result = await this._makeRequest(wrappedProgress, params, token);
			if (result.ttft) {
				pendingLoggedChatRequest.markTimeToFirstToken(result.ttft);
			}
			pendingLoggedChatRequest.resolve({
				type: ChatFetchResponseType.Success,
				requestId,
				serverRequestId: requestId,
				usage: result.usage,
				value: ['value'],
			}, wrappedProgress.items.map((i): IResponseDelta => {
				return {
					text: i.part instanceof LanguageModelTextPart ? i.part.value : '',
					copilotToolCalls: i.part instanceof LanguageModelToolCallPart ? [{
						name: i.part.name,
						arguments: JSON.stringify(i.part.input),
						id: i.part.callId
					}] : undefined,
				};
			}));
		} catch (err) {
			this._logService.logger.error(`BYOK Anthropic error: ${toErrorMessage(err, true)}`);
			pendingLoggedChatRequest.resolve({
				type: ChatFetchResponseType.Unknown,
				requestId,
				serverRequestId: requestId,
				reason: err.message
			}, wrappedProgress.items.map((i): IResponseDelta => {
				return {
					text: i.part instanceof LanguageModelTextPart ? i.part.value : '',
					copilotToolCalls: i.part instanceof LanguageModelToolCallPart ? [{
						name: i.part.name,
						arguments: JSON.stringify(i.part.input),
						id: i.part.callId
					}] : undefined,
				};
			}));
			throw err;
		}
	}

	async provideTokenCount(text: string | LanguageModelChatMessage): Promise<number> {
		// Simple estimation - actual token count would require Claude's tokenizer
		return Math.ceil(text.toString().length / 4);
	}

	private async _makeRequest(progress: Progress<ChatResponseFragment2>, params: Anthropic.MessageCreateParamsStreaming, token: CancellationToken): Promise<{ ttft: number | undefined; usage: APIUsage | undefined }> {
		const start = Date.now();
		let ttft: number | undefined;
		const stream = await this.client.messages.create(params);

		let pendingToolCall: {
			toolId?: string;
			name?: string;
			jsonInput?: string;
		} | undefined;
		let usage: APIUsage | undefined;

		let hasText = false;
		let firstTool = true;
		let thinkingBlock = '';
		let signature = '';
		for await (const chunk of stream) {
			if (token.isCancellationRequested) {
				break;
			}

			if (ttft === undefined) {
				ttft = Date.now() - start;
			}
			this._logService.logger.trace(`chunk: ${JSON.stringify(chunk)}`);

			if (chunk.type === 'content_block_start') {
				if ('content_block' in chunk && chunk.content_block.type === 'tool_use') {
					if (hasText && firstTool) {
						// Flush the linkifier stream otherwise it pauses before the tool call if the last word ends with a punctuation mark.
						progress.report({ index: 0, part: new LanguageModelTextPart(' ') });
					}
					pendingToolCall = {
						toolId: chunk.content_block.id,
						name: chunk.content_block.name,
						jsonInput: ''
					};
					firstTool = false;

					// now we have tool id, let's capature this thinking block
					this._thinkingDataService.update({
						message: {
							cot_summary: thinkingBlock,
							cot_id: signature
						},
						index: 0
					}, pendingToolCall.toolId!);
				}
				if ('content_block' in chunk && chunk.content_block.type === 'thinking') {
					console.log(`Thinking block received: ${JSON.stringify(chunk)}`);
					thinkingBlock += chunk.content_block.thinking;
				}
				continue;
			}

			if (chunk.type === 'content_block_delta') {
				if (chunk.delta.type === 'text_delta') {
					progress.report({
						index: 0,
						part: new LanguageModelTextPart(chunk.delta.text || ''),
					});
					hasText ||= chunk.delta.text?.length > 0;
				} else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
					pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + (chunk.delta.partial_json || '');

					try {
						// Try to parse the accumulated JSON to see if it's complete
						const parsedJson = JSON.parse(pendingToolCall.jsonInput);
						progress.report({
							index: 0,
							part: new LanguageModelToolCallPart(
								pendingToolCall.toolId!,
								pendingToolCall.name!,
								parsedJson
							)
						});
						pendingToolCall = undefined;
					} catch {
						// JSON is not complete yet, continue accumulating
						continue;
					}
				} else if (chunk.delta.type === 'thinking_delta') {
					console.log(`Thinking delta received: ${JSON.stringify(chunk.delta)}`);
					thinkingBlock += chunk.delta.thinking;
				} else if (chunk.delta.type === 'signature_delta') {
					signature += chunk.delta.signature || '';
				}
			}

			if (chunk.type === 'content_block_stop' && pendingToolCall) {
				try {
					const parsedJson = JSON.parse(pendingToolCall.jsonInput || '{}');
					progress.report({
						index: 0,
						part: new LanguageModelToolCallPart(
							pendingToolCall.toolId!,
							pendingToolCall.name!,
							parsedJson
						)
					});
				} catch (e) {
					console.error('Failed to parse tool call JSON:', e);
				}
				pendingToolCall = undefined;
			}

			if (chunk.type === 'message_start') {
				// TODO final output tokens: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":46}}
				usage = {
					completion_tokens: -1,
					prompt_tokens: chunk.message.usage.input_tokens + (chunk.message.usage.cache_creation_input_tokens ?? 0) + (chunk.message.usage.cache_read_input_tokens ?? 0),
					total_tokens: -1,
					prompt_tokens_details: {
						cached_tokens: chunk.message.usage.cache_read_input_tokens ?? 0,
						cache_creation_input_tokens: chunk.message.usage.cache_creation_input_tokens
					} as any
				};
			} else if (usage && chunk.type === 'message_delta') {
				if (chunk.usage.output_tokens) {
					usage.completion_tokens = chunk.usage.output_tokens;
					usage.total_tokens = usage.prompt_tokens + chunk.usage.output_tokens;
				}
			}
		}

		return { ttft, usage };
	}
}