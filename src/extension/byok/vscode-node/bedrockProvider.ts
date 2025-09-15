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
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatMessage2,
	LanguageModelResponsePart2,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage } from '../../../platform/networking/common/openai';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { toErrorMessage } from '../../../util/vs/base/common/errorMessage';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import {
	BYOKAuthType,
	BYOKKnownModels,
	byokKnownModelsToAPIInfo,
	BYOKModelCapabilities,
	BYOKModelProvider
} from '../common/byokProvider';
import {
	apiMessageToBedrockMessage,
	bedrockMessagesToRawMessagesForLogging,
} from './bedrockMessageConverter';

export class BedrockLMProvider implements BYOKModelProvider<LanguageModelChatInformation> {
	public static readonly providerName = 'Bedrock';
	public readonly authType: BYOKAuthType = BYOKAuthType.None;
	private _bedrockClient: BedrockRuntimeClient | undefined;

	constructor(
		private readonly _knownModels: BYOKKnownModels | undefined,
		@ILogService private readonly _logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger
	) { }

	// Filters the byok known models based on what's available in Bedrock
	private async getAllModels(): Promise<BYOKKnownModels> {
		if (!this._bedrockClient) {
			this._bedrockClient = new BedrockRuntimeClient({
				region: 'us-west-2',
				credentials: fromIni({ profile: 'bedrock' }),
			});
		}
		try {
			// For Bedrock, we'll use the known models since we can't easily list all available models
			// In a real implementation, you might want to call ListFoundationModels API
			if (this._knownModels && Object.keys(this._knownModels).length > 0) {
				return this._knownModels;
			}

			// Fallback hardcoded models if no known models available
			const fallbackModels: BYOKKnownModels = {
				'us.anthropic.claude-sonnet-4-20250514-v1:0': {
					name: 'Claude Sonnet 4',
					maxInputTokens: 200000,
					maxOutputTokens: 8192,
					toolCalling: true,
					vision: true,
				} as BYOKModelCapabilities,
				'us.anthropic.claude-3-5-sonnet-20241022-v2:0': {
					name: 'Claude 3.5 Sonnet',
					maxInputTokens: 200000,
					maxOutputTokens: 8192,
					toolCalling: true,
					vision: true,
				} as BYOKModelCapabilities,
				'us.anthropic.claude-3-7-sonnet-20250219-v1:0': {
					name: 'Claude 3.7 Sonnet',
					maxInputTokens: 200000,
					maxOutputTokens: 8192,
					toolCalling: true,
					vision: true,
				} as BYOKModelCapabilities,
				'us.amazon.nova-pro-v1:0': {
					name: 'Amazon Nova Pro',
					maxInputTokens: 300000,
					maxOutputTokens: 5000,
					toolCalling: true,
					vision: true,
				} as BYOKModelCapabilities,
				'us.anthropic.claude-3-haiku-20240307-v1:0': {
					name: 'Claude 3 Haiku',
					maxInputTokens: 200000,
					maxOutputTokens: 4096,
					toolCalling: true,
					vision: false,
				} as BYOKModelCapabilities
			};
			return fallbackModels;
		} catch (error) {
			this._logService.error(error, `Error fetching available ${BedrockLMProvider.providerName} models`);
			throw new Error(error.message ? error.message : error);
		}
	}

	async updateAPIKey(): Promise<void> {
		// Bedrock uses AWS credentials, no API key needed
		// This method is required by the interface but is a no-op for Bedrock
	}

	async provideLanguageModelChatInformation(options: { silent: boolean }, token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		try {
			return byokKnownModelsToAPIInfo(BedrockLMProvider.providerName, await this.getAllModels());
		} catch {
			return [];
		}
	}
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken,
	): Promise<any> {
		if (!this._bedrockClient) {
			return;
		}
		// Convert the messages from the API format into messages that we can use against bedrock
		const { system, messages: convertedMessages } = apiMessageToBedrockMessage(messages as LanguageModelChatMessage[]);

		const requestId = generateUuid();
		const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
			'BedrockBYOK',
			{
				model: model.id,
				modelMaxPromptTokens: model.maxInputTokens,
				urlOrRequestMetadata: 'aws-bedrock',
			},
			{
				model: model.id,
				location: ChatLocation.Other,
				messages: bedrockMessagesToRawMessagesForLogging(convertedMessages, system),
				ourRequestId: requestId,
				tools: options.tools?.map((tool): OpenAiFunctionTool => ({
					type: 'function',
					function: {
						name: tool.name,
						description: tool.description,
						parameters: tool.inputSchema
					}
				})),
			});

		const wrappedProgress = new RecordedProgress(progress);
		const params: ConverseStreamCommandInput = {
			modelId: model.id,
			messages: convertedMessages,
			system,
			inferenceConfig: { maxTokens: model.maxOutputTokens },
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
			const result = await this._makeRequest(progress, params, token);
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
					text: i instanceof LanguageModelTextPart ? i.value : '',
					copilotToolCalls: i instanceof LanguageModelToolCallPart ? [{
						name: i.name,
						arguments: JSON.stringify(i.input),
						id: i.callId
					}] : undefined,
				};
			}));
		} catch (err) {
			this._logService.error(`BYOK Bedrock error: ${toErrorMessage(err, true)}`);
			pendingLoggedChatRequest.resolve({
				type: ChatFetchResponseType.Unknown,
				requestId,
				serverRequestId: requestId,
				reason: err.message
			}, wrappedProgress.items.map((i): IResponseDelta => {
				return {
					text: i instanceof LanguageModelTextPart ? i.value : '',
					copilotToolCalls: i instanceof LanguageModelToolCallPart ? [{
						name: i.name,
						arguments: JSON.stringify(i.input),
						id: i.callId
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

	private async _makeRequest(progress: Progress<LanguageModelResponsePart2>, params: ConverseStreamCommandInput, token: CancellationToken): Promise<{ ttft: number | undefined; usage: APIUsage | undefined }> {
		if (!this._bedrockClient) {
			return { ttft: undefined, usage: undefined };
		}
		const start = Date.now();
		let ttft: number | undefined;
		const response = await this._bedrockClient.send(new ConverseStreamCommand(params));
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
					progress.report(new LanguageModelToolCallPart(pending.id, pending.name, (typeof args === 'object' && args !== null) ? args : {}));
					pendingToolUses.delete(toolStopIndex);
				}
			}

			const delta = event.contentBlockDelta?.delta?.text;
			if (delta) {
				progress.report(new LanguageModelTextPart(delta));
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

		return { ttft, usage };
	}
}

