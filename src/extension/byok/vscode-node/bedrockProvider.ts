/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	ConverseStreamCommandInput,
	ConverseStreamOutput,
	Tool,
	ToolChoice,
	ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import {
	CancellationToken,
	ChatResponseFragment2,
	ChatResponseProviderMetadata,
	Disposable,
	LanguageModelChatMessage,
	LanguageModelChatProvider,
	LanguageModelChatRequestOptions,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	lm,
	Progress,
} from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage, rawMessageToCAPI } from '../../../platform/networking/common/openai';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { toErrorMessage } from '../../../util/vs/base/common/errorMessage';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import {
	BYOKAuthType,
	BYOKKnownModels,
	BYOKModelConfig,
	BYOKModelRegistry,
	chatModelInfoToProviderMetadata,
	isNoAuthConfig,
	resolveModelInfo,
} from '../common/byokProvider';
import {
	apiMessageToBedrockMessage,
	bedrockMessagesToRawMessagesForLogging,
} from './bedrockMessageConverter';

export class BedrockBYOKModelRegistry implements BYOKModelRegistry {
	public readonly authType = BYOKAuthType.None;
	public readonly name = 'Bedrock';
	private _knownModels: BYOKKnownModels | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		this._logService.logger.info('BedrockBYOKModelRegistry: Constructor called');
	}

	updateKnownModelsList(knownModels: BYOKKnownModels | undefined): void {
		this._knownModels = knownModels;
	}

	async getAllModels(): Promise<{ id: string; name: string }[]> {
		this._logService.logger.info('BedrockBYOKModelRegistry: getAllModels called');
		this._logService.logger.info(`BedrockBYOKModelRegistry: _knownModels state: ${this._knownModels ? 'defined' : 'undefined'}`);

		try {
			// If we have known models from local/CDN data, use those
			if (this._knownModels && Object.keys(this._knownModels).length > 0) {
				const models = Object.entries(this._knownModels).map(([id, info]) => ({ id, name: info.name }));
				this._logService.logger.info(`BedrockBYOKModelRegistry: Returning ${models.length} models from known models: ${JSON.stringify(models)}`);
				return models;
			}

			// Fallback hardcoded models if no known models available
			const fallbackModels = [
				{
					id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
					name: 'Claude Sonnet 4 (fallback)'
				},
				{
					id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
					name: 'Claude 3.5 Sonnet (fallback)'
				}
			];
			this._logService.logger.info(`BedrockBYOKModelRegistry: No known models found, returning ${fallbackModels.length} fallback models: ${JSON.stringify(fallbackModels)}`);
			return fallbackModels;
		} catch (error) {
			this._logService.logger.error(`BedrockBYOKModelRegistry: getAllModels error: ${error}`);
			throw error;
		}
	}

	async registerModel(config: BYOKModelConfig): Promise<Disposable> {
		if (!isNoAuthConfig(config)) {
			throw new Error('Incorrect configuration passed to bedrock provider');
		}

		try {
			const modelMetadata = chatModelInfoToProviderMetadata(
				resolveModelInfo(config.modelId, this.name, this._knownModels, config.capabilities),
			);
			const provider = this._instantiationService.createInstance(
				BedrockChatProvider,
				config.modelId,
				modelMetadata,
			);
			const disposable = lm.registerChatModelProvider(
				`${this.name}-${config.modelId}`,
				provider,
				modelMetadata,
			);
			return disposable;
		} catch (e) {
			this._logService.logger.error(`Error registering ${this.name} model ${config.modelId}: ${e}`);
			throw e;
		}
	}
}

export class BedrockChatProvider implements LanguageModelChatProvider {
	private client: BedrockRuntimeClient;
	private modelId: string;

	constructor(
		modelId: string,
		private readonly _modelMetadata: ChatResponseProviderMetadata,
		@ILogService private readonly _logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
	) {
		this._logService.logger.info(`BedrockChatProvider: Constructor called for model ${modelId}`);

		try {
			this.client = new BedrockRuntimeClient({
				region: 'us-west-2',
				credentials: fromIni({ profile: 'bedrock' }),
			});
			this.modelId = modelId;
			this._logService.logger.info(`BedrockChatProvider: Successfully created client for model ${modelId}`);
		} catch (error) {
			this._logService.logger.error(`BedrockChatProvider: Error creating client for model ${modelId}: ${error}`);
			throw error;
		}
	}

	async provideLanguageModelResponse(
		messages: LanguageModelChatMessage[],
		options: LanguageModelChatRequestOptions,
		extensionId: string,
		progress: Progress<ChatResponseFragment2>,
		token: CancellationToken,
	): Promise<void> {
		const { system, messages: convertedMessages } = apiMessageToBedrockMessage(messages);

		const requestId = generateUuid();
		const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
			'BedrockBYOK',
			{
				model: this.modelId,
				modelMaxPromptTokens: this._modelMetadata.maxInputTokens,
				urlOrRequestMetadata: 'aws-bedrock',
			},
			{
				model: this.modelId,
				location: ChatLocation.Other,
				messages: rawMessageToCAPI(bedrockMessagesToRawMessagesForLogging(convertedMessages, system)),
				ourRequestId: requestId,
				postOptions: {
					tools: options.tools?.map((tool): OpenAiFunctionTool => ({
						type: 'function',
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.inputSchema,
						},
					})),
				},
			},
		);

		const wrappedProgress = new RecordedProgress(progress);
		const params: ConverseStreamCommandInput = {
			modelId: this.modelId,
			messages: convertedMessages,
			system,
			inferenceConfig: { maxTokens: this._modelMetadata.maxOutputTokens },
		};

		const tools: Tool[] = (options.tools ?? []).map(tool => ({
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: {
					json: tool.inputSchema ?? { type: 'object' }
				}
			}
		} as Tool));
		if (tools.length > 0) {
			const toolConfig: ToolConfiguration = { tools };
			const toolChoiceOptions = (options as any).toolChoice;
			if (toolChoiceOptions) {
				let toolChoice: ToolChoice | undefined;
				if (toolChoiceOptions === 'auto') {
					toolChoice = { auto: {} };
				} else if (typeof toolChoiceOptions === 'object' && 'name' in toolChoiceOptions) {
					toolChoice = { tool: { name: toolChoiceOptions.name } };
				}
				if (toolChoice) {
					(toolConfig as any).toolChoice = toolChoice;
				}
			}
			params.toolConfig = toolConfig;
		}

		try {
			const start = Date.now();
			const response = await this.client.send(new ConverseStreamCommand(params));
			let ttft: number | undefined;
			let usage: APIUsage | undefined;
			const pendingToolUses = new Map<number, { id: string; name: string; input: string }>();

			for await (const event of (response.stream as AsyncIterable<ConverseStreamOutput>) ?? []) {
				if (token.isCancellationRequested) {
					break;
				}
				if (ttft === undefined) {
					ttft = Date.now() - start;
				}

				const startTool = event.contentBlockStart?.start?.toolUse;
				if (startTool && event.contentBlockStart?.contentBlockIndex !== undefined) {
					pendingToolUses.set(event.contentBlockStart.contentBlockIndex, {
						id: startTool.toolUseId || '',
						name: startTool.name || '',
						input: '',
					});
				}

				const toolDelta = event.contentBlockDelta?.delta?.toolUse?.input;
				if (toolDelta !== undefined && event.contentBlockDelta?.contentBlockIndex !== undefined) {
					const idx = event.contentBlockDelta.contentBlockIndex;
					const pending = pendingToolUses.get(idx);
					if (pending) {
						pending.input += typeof toolDelta === 'string' ? toolDelta : JSON.stringify(toolDelta);
					}
				}

				const toolStopIndex = event.contentBlockStop?.contentBlockIndex;
				if (toolStopIndex !== undefined) {
					const pending = pendingToolUses.get(toolStopIndex);
					if (pending) {
						let args: unknown;
						try {
							args = JSON.parse(pending.input || '{}');
						} catch {
							args = pending.input;
						}
						wrappedProgress.report({ index: 0, part: new LanguageModelToolCallPart(pending.id, pending.name, (typeof args === 'object' && args !== null) ? args : {}) });
						pendingToolUses.delete(toolStopIndex);
					}
				}

				const delta = event.contentBlockDelta?.delta?.text;
				if (delta) {
					wrappedProgress.report({ index: 0, part: new LanguageModelTextPart(delta) });
				}

				const meta = event.metadata?.usage;
				if (meta) {
					usage = {
						prompt_tokens: meta.inputTokens || 0,
						completion_tokens: meta.outputTokens || 0,
						total_tokens: (meta.inputTokens || 0) + (meta.outputTokens || 0),
						prompt_tokens_details: { cached_tokens: 0 },
					};
				}
			}

			if (ttft !== undefined) {
				pendingLoggedChatRequest.markTimeToFirstToken(ttft);
			}
			pendingLoggedChatRequest.resolve(
				{
					type: ChatFetchResponseType.Success,
					requestId,
					serverRequestId: requestId,
					usage,
					value: ['value'],
				},
				wrappedProgress.items.map((i): IResponseDelta => ({
					text: i.part instanceof LanguageModelTextPart ? i.part.value : '',
					copilotToolCalls: i.part instanceof LanguageModelToolCallPart
						? [{ name: i.part.name, arguments: JSON.stringify(i.part.input), id: i.part.callId }]
						: undefined,
				})),
			);
		} catch (err) {
			this._logService.logger.error(`BYOK bedrock error: ${toErrorMessage(err, true)}`);
			pendingLoggedChatRequest.resolve(
				{
					type: ChatFetchResponseType.Unknown,
					requestId,
					serverRequestId: requestId,
					reason: err.message,
				},
				wrappedProgress.items.map((i): IResponseDelta => ({
					text: i.part instanceof LanguageModelTextPart ? i.part.value : '',
					copilotToolCalls: i.part instanceof LanguageModelToolCallPart
						? [{ name: i.part.name, arguments: JSON.stringify(i.part.input), id: i.part.callId }]
						: undefined,
				})),
			);
			throw err;
		}
	}

	async provideTokenCount(text: string | LanguageModelChatMessage): Promise<number> {
		return Math.ceil(text.toString().length / 4);
	}
}

