/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import { CancellationToken, ChatResponseFragment2, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatRequestHandleOptions, LanguageModelTextPart, LanguageModelToolCallPart, Progress } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage, rawMessageToCAPI } from '../../../platform/networking/common/openai';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { toErrorMessage } from '../../../util/vs/base/common/errorMessage';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { BYOKAuthType, BYOKKnownModels, byokKnownModelsToAPIInfo, BYOKModelCapabilities, BYOKModelProvider } from '../common/byokProvider';
import { anthropicMessagesToRawMessagesForLogging, apiMessageToAnthropicMessage } from './anthropicMessageConverter';
import { IBYOKStorageService } from './byokStorageService';
import { promptForAPIKey } from './byokUIService';

export class AnthropicLMProvider implements BYOKModelProvider<LanguageModelChatInformation> {
	public static readonly providerName = 'Anthropic';
	public readonly authType: BYOKAuthType = BYOKAuthType.GlobalApiKey;
	private _anthropicAPIClient: Anthropic | undefined;
	private _apiKey: string | undefined;
	constructor(
		private readonly _knownModels: BYOKKnownModels | undefined,
		private readonly _byokStorageService: IBYOKStorageService,
		@ILogService private readonly _logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger
	) { }

	// Filters the byok known models based on what the anthropic API knows as well
	private async getAllModels(apiKey: string): Promise<BYOKKnownModels> {
		if (!this._anthropicAPIClient) {
			this._anthropicAPIClient = new Anthropic({ apiKey });
		}
		try {
			const response = await this._anthropicAPIClient.models.list();
			const modelList: Record<string, BYOKModelCapabilities> = {};
			for (const model of response.data) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList[model.id] = this._knownModels[model.id];
				}
			}
			return modelList;
		} catch (error) {
			this._logService.error(error, `Error fetching available ${AnthropicLMProvider.providerName} models`);
			throw new Error(error.message ? error.message : error);
		}
	}

	async updateAPIKey(): Promise<void> {
		this._apiKey = await promptForAPIKey(AnthropicLMProvider.providerName, await this._byokStorageService.getAPIKey(AnthropicLMProvider.providerName) !== undefined);
		if (this._apiKey) {
			this._byokStorageService.storeAPIKey(AnthropicLMProvider.providerName, this._apiKey, BYOKAuthType.GlobalApiKey);
		}
	}

	async prepareLanguageModelChat(options: { silent: boolean }, token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		if (!this._apiKey) { // If we don't have the API key it might just be in storage, so we try to read it first
			this._apiKey = await this._byokStorageService.getAPIKey(AnthropicLMProvider.providerName);
		}
		try {
			if (this._apiKey) {
				return byokKnownModelsToAPIInfo(AnthropicLMProvider.providerName, await this.getAllModels(this._apiKey));
			} else if (options.silent && !this._apiKey) {
				return [];
			} else { // Not silent, and no api key = good to prompt user for api key
				await this.updateAPIKey();
				if (this._apiKey) {
					return byokKnownModelsToAPIInfo(AnthropicLMProvider.providerName, await this.getAllModels(this._apiKey));
				} else {
					return [];
				}
			}
		} catch {
			return [];
		}
	}

	async provideLanguageModelChatResponse(model: LanguageModelChatInformation, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: LanguageModelChatRequestHandleOptions, progress: Progress<ChatResponseFragment2>, token: CancellationToken): Promise<any> {
		if (!this._anthropicAPIClient) {
			return;
		}
		// Convert the messages from the API format into messages that we can use against anthropic
		const { system, messages: convertedMessages } = apiMessageToAnthropicMessage(messages as LanguageModelChatMessage[]);

		const requestId = generateUuid();
		const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
			'AnthropicBYOK',
			{
				model: model.id,
				modelMaxPromptTokens: model.maxInputTokens,
				urlOrRequestMetadata: this._anthropicAPIClient.baseURL,
			},
			{
				model: model.id,
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
			model: model.id,
			messages: convertedMessages,
			max_tokens: model.maxOutputTokens,
			stream: true,
			system: [system],
			tools: tools.length > 0 ? tools : undefined,
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
			this._logService.error(`BYOK Anthropic error: ${toErrorMessage(err, true)}`);
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

	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		// Simple estimation - actual token count would require Claude's tokenizer
		return Math.ceil(text.toString().length / 4);
	}

	private async _makeRequest(progress: Progress<ChatResponseFragment2>, params: Anthropic.MessageCreateParamsStreaming, token: CancellationToken): Promise<{ ttft: number | undefined; usage: APIUsage | undefined }> {
		if (!this._anthropicAPIClient) {
			return { ttft: undefined, usage: undefined };
		}
		const start = Date.now();
		let ttft: number | undefined;
		const stream = await this._anthropicAPIClient.messages.create(params);

		let pendingToolCall: {
			toolId?: string;
			name?: string;
			jsonInput?: string;
		} | undefined;
		let usage: APIUsage | undefined;

		let hasText = false;
		let firstTool = true;
		for await (const chunk of stream) {
			if (token.isCancellationRequested) {
				break;
			}

			if (ttft === undefined) {
				ttft = Date.now() - start;
			}
			this._logService.trace(`chunk: ${JSON.stringify(chunk)}`);

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