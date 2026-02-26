/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import * as vscode from 'vscode';
import { FetchStreamRecorder } from '../../../platform/chat/common/chatMLFetcher';
import { toErrorMessage } from '../../../util/common/errorMessage';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatFetchResponseType, ChatLocation, ChatResponse } from '../../chat/common/commonTypes';
import { ILogService } from '../../log/common/logService';
import { ContextManagementResponse } from '../../networking/common/anthropic';
import { FinishedCallback, OpenAiFunctionTool, OptionalChatRequestParams } from '../../networking/common/fetch';
import { Response } from '../../networking/common/fetcherService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../networking/common/networking';
import { ChatCompletion } from '../../networking/common/openai';
import { CopilotChatAttr, GenAiAttr, GenAiMetrics, GenAiOperationName, StdAttr } from '../../otel/common/index';
import { IOTelService, SpanKind, SpanStatusCode } from '../../otel/common/otelService';
import { retrieveCapturingTokenByCorrelation, storeCapturingTokenForCorrelation } from '../../requestLogger/node/requestLogger';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { EndpointEditToolName, isEndpointEditToolName } from '../common/endpointProvider';
import { CustomDataPartMimeTypes } from '../common/endpointTypes';
import { decodeStatefulMarker, encodeStatefulMarker, rawPartAsStatefulMarker } from '../common/statefulMarkerContainer';
import { rawPartAsThinkingData } from '../common/thinkingDataContainer';
import { ExtensionContributedChatTokenizer } from './extChatTokenizer';

enum ChatImageMimeType {
	PNG = 'image/png',
	JPEG = 'image/jpeg',
	GIF = 'image/gif',
	WEBP = 'image/webp',
	BMP = 'image/bmp',
}

export class ExtensionContributedChatEndpoint implements IChatEndpoint {
	private readonly _maxTokens: number;
	public readonly isDefault: boolean = false;
	public readonly isFallback: boolean = false;
	public readonly isPremium: boolean = false;
	public readonly multiplier: number = 0;
	public readonly isExtensionContributed = true;
	public readonly supportedEditTools?: readonly EndpointEditToolName[] | undefined;

	constructor(
		private readonly languageModel: vscode.LanguageModelChat,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IOTelService private readonly _otelService: IOTelService,
	) {
		// Initialize with the model's max tokens
		this._maxTokens = languageModel.maxInputTokens;
		this.supportedEditTools = languageModel.capabilities.editToolsHint?.filter(isEndpointEditToolName);
	}

	get modelProvider(): string {
		return this.languageModel.vendor;
	}

	get modelMaxPromptTokens(): number {
		return this._maxTokens;
	}

	get maxOutputTokens(): number {
		// The VS Code API doesn't expose max output tokens, use a reasonable default
		return 8192;
	}

	get urlOrRequestMetadata(): string {
		// Not used for extension contributed endpoints
		return '';
	}

	get model(): string {
		return this.languageModel.id;
	}

	get name(): string {
		return this.languageModel.name;
	}

	get version(): string {
		return this.languageModel.version;
	}

	get family(): string {
		return this.languageModel.family;
	}

	get tokenizer(): TokenizerType {
		// Most language models use the O200K tokenizer, if they don't they should specify in their metadata
		return TokenizerType.O200K;
	}

	get showInModelPicker(): boolean {
		// TODO @lramos15 - Need some API exposed for this, registration seems to have it
		return true;
	}

	get supportsToolCalls(): boolean {
		return this.languageModel.capabilities?.supportsToolCalling ?? false;
	}

	get supportsVision(): boolean {
		return this.languageModel?.capabilities?.supportsImageToText ?? false;
	}

	get supportsPrediction(): boolean {
		return false;
	}

	get policy(): 'enabled' | { terms: string } {
		return 'enabled';
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
		throw new Error('processResponseFromChatEndpoint not supported for extension contributed endpoints');
	}

	async acceptChatPolicy(): Promise<boolean> {
		return true;
	}

	public acquireTokenizer(): ITokenizer {
		// Use the extension-contributed tokenizer that leverages the VS Code language model API
		return new ExtensionContributedChatTokenizer(this.languageModel);
	}

	async makeChatRequest(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		source?: { extensionId?: string | undefined },
		requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		userInitiatedRequest?: boolean,
		telemetryProperties?: Record<string, string>,
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

	async makeChatRequest2({
		debugName,
		messages,
		requestOptions,
		finishedCb,
		location,
		source,
	}: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		const vscodeMessages = convertToApiChatMessage(messages);
		const ourRequestId = generateUuid();

		// Determine provider name from the language model vendor/family
		const providerName = this.languageModel.vendor ?? 'extension';

		// OTel inference span for this BYOK/extension-contributed LLM call
		const otelSpan = this._otelService.startSpan(`chat ${this.languageModel.id}`, {
			kind: SpanKind.CLIENT,
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
				[GenAiAttr.PROVIDER_NAME]: providerName,
				[GenAiAttr.REQUEST_MODEL]: this.languageModel.id,
				[GenAiAttr.CONVERSATION_ID]: ourRequestId,
				[CopilotChatAttr.ENDPOINT_TYPE]: 'extension_contributed',
				[CopilotChatAttr.MAX_PROMPT_TOKENS]: this.modelMaxPromptTokens,
			},
		});
		// Capture input messages when content capture is enabled
		if (this._otelService.config.captureContent) {
			try {
				const inputSummary = messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '[complex]' }));
				otelSpan.setAttribute(GenAiAttr.INPUT_MESSAGES, JSON.stringify(inputSummary));
			} catch { /* swallow */ }
		}
		const otelStartTime = Date.now();

		const vscodeOptions: vscode.LanguageModelChatRequestOptions = {
			tools: ((requestOptions?.tools ?? []) as OpenAiFunctionTool[]).map(tool => ({
				name: tool.function.name,
				description: tool.function.description,
				inputSchema: tool.function.parameters,
			})),
			// Pass correlation ID and OTel trace context through modelOptions for cross-IPC restoration.
			modelOptions: {
				_capturingTokenCorrelationId: ourRequestId,
				_otelTraceContext: this._otelService.getActiveTraceContext(),
			}
		};

		// Store current CapturingToken for retrieval by BYOK providers after IPC crossing
		//
		// Note: We intentionally don't log chat requests here for external models (BYOK).
		// BYOK providers (Anthropic, Gemini, CopilotLanguageModelWrapper) handle their own
		// logging with correct token usage. Logging here would create duplicates with
		// incorrect (0) token counts since we don't have access to actual usage stats.
		storeCapturingTokenForCorrelation(ourRequestId);

		const streamRecorder = new FetchStreamRecorder(finishedCb);

		try {
			const response = await this.languageModel.sendRequest(vscodeMessages, vscodeOptions, token);
			let text = '';
			let numToolsCalled = 0;
			const requestId = ourRequestId;

			// consume stream
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					text += chunk.value;
					// Call finishedCb with the current chunk of text
					if (streamRecorder.callback) {
						await streamRecorder.callback(text, 0, { text: chunk.value });
					}
				} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
					// Call finishedCb with updated tool calls
					if (streamRecorder.callback) {
						const functionCalls = [chunk].map(tool => ({
							name: tool.name ?? '',
							arguments: JSON.stringify(tool.input) ?? '',
							id: tool.callId
						}));
						numToolsCalled++;
						await streamRecorder.callback(text, 0, { text: '', copilotToolCalls: functionCalls });
					}
				} else if (chunk instanceof vscode.LanguageModelDataPart) {
					if (chunk.mimeType === CustomDataPartMimeTypes.StatefulMarker) {
						const decoded = decodeStatefulMarker(chunk.data);
						await streamRecorder.callback?.(text, 0, { text: '', statefulMarker: decoded.marker });
					} else if (chunk.mimeType === CustomDataPartMimeTypes.ContextManagement) {
						const contextManagement = JSON.parse(new TextDecoder().decode(chunk.data)) as ContextManagementResponse;
						await streamRecorder.callback?.(text, 0, { text: '', contextManagement });
					}
				} else if (chunk instanceof vscode.LanguageModelThinkingPart) {
					// Call finishedCb with the current chunk of thinking text with a specific thinking field
					if (streamRecorder.callback) {
						await streamRecorder.callback(text, 0, {
							text: '',  // Use empty text to avoid creating markdown part
							thinking: {
								text: chunk.value,
								id: chunk.id || '',
								metadata: chunk.metadata
							}
						});
					}
				}
			}

			if (text || numToolsCalled > 0) {
				otelSpan.setAttributes({
					[GenAiAttr.RESPONSE_MODEL]: this.languageModel.id,
					[GenAiAttr.RESPONSE_ID]: requestId,
					[GenAiAttr.RESPONSE_FINISH_REASONS]: ['stop'],
					[CopilotChatAttr.TIME_TO_FIRST_TOKEN]: Date.now() - otelStartTime,
				});
				otelSpan.setStatus(SpanStatusCode.OK);
				// Capture response content when content capture is enabled
				if (this._otelService.config.captureContent && text) {
					try {
						otelSpan.setAttribute(GenAiAttr.OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: text }] }]));
					} catch { /* swallow */ }
				}
				const response: ChatResponse = {
					type: ChatFetchResponseType.Success,
					requestId,
					serverRequestId: requestId,
					usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
					value: text,
					resolvedModel: this.languageModel.id
				};
				return response;
			} else {
				const result: ChatResponse = {
					type: ChatFetchResponseType.Unknown,
					reason: 'No response from language model',
					requestId: requestId,
					serverRequestId: undefined
				};
				return result;
			}
		} catch (e) {
			otelSpan.setStatus(SpanStatusCode.ERROR, toErrorMessage(e, true));
			otelSpan.setAttribute(StdAttr.ERROR_TYPE, e instanceof Error ? e.constructor.name : 'Error');
			otelSpan.recordException(e);
			const result: ChatResponse = {
				type: ChatFetchResponseType.Failed,
				reason: toErrorMessage(e, true),
				requestId: generateUuid(),
				serverRequestId: undefined
			};
			return result;
		} finally {
			// Record OTel metrics for this BYOK LLM call
			const durationSec = (Date.now() - otelStartTime) / 1000;
			const metrics = new GenAiMetrics(this._otelService);
			metrics.recordOperationDuration(durationSec, {
				operationName: GenAiOperationName.CHAT,
				providerName,
				requestModel: this.languageModel.id,
				responseModel: this.languageModel.id,
			});
			otelSpan.end();

			// Clean up correlation map entry to prevent memory leak.
			// If the request reached a BYOK provider, they already retrieved and removed this.
			// If not (e.g., request failed early or model isn't BYOK), we need to clean it up here.
			retrieveCapturingTokenByCorrelation(ourRequestId);
		}
	}

	createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		throw new Error('unreachable'); // this endpoint does not call into fetchers
	}

	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, {
			...this.languageModel,
			maxInputTokens: modelMaxPromptTokens
		});
	}
}

export function convertToApiChatMessage(messages: Raw.ChatMessage[]): Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2> {
	const apiMessages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2> = [];
	for (const message of messages) {
		const apiContent: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart2 | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart | vscode.LanguageModelThinkingPart> = [];
		// Easier to work with arrays everywhere, rather than string in some cases. So convert to a single text content part
		for (const contentPart of message.content) {
			if (contentPart.type === Raw.ChatCompletionContentPartKind.Text) {
				apiContent.push(new vscode.LanguageModelTextPart(contentPart.text));
			} else if (contentPart.type === Raw.ChatCompletionContentPartKind.Image) {
				// Handle base64 encoded images
				if (contentPart.imageUrl.url.startsWith('data:')) {
					const dataUrlRegex = /^data:([^;]+);base64,(.*)$/;
					const match = contentPart.imageUrl.url.match(dataUrlRegex);

					if (match) {
						const [, mimeType, base64Data] = match;
						apiContent.push(new vscode.LanguageModelDataPart(Buffer.from(base64Data, 'base64'), mimeType as ChatImageMimeType));
					}
				} else {
					// Not a base64 image
					continue;
				}
			} else if (contentPart.type === Raw.ChatCompletionContentPartKind.CacheBreakpoint) {
				apiContent.push(new vscode.LanguageModelDataPart(new TextEncoder().encode('ephemeral'), CustomDataPartMimeTypes.CacheControl));
			} else if (contentPart.type === Raw.ChatCompletionContentPartKind.Opaque) {
				const statefulMarker = rawPartAsStatefulMarker(contentPart);
				if (statefulMarker) {
					apiContent.push(new vscode.LanguageModelDataPart(encodeStatefulMarker(statefulMarker.modelId, statefulMarker.marker), CustomDataPartMimeTypes.StatefulMarker));
				}
				const thinkingData = rawPartAsThinkingData(contentPart);
				if (thinkingData) {
					apiContent.push(new vscode.LanguageModelThinkingPart(thinkingData.text, thinkingData.id, thinkingData.metadata));
				}
			}
		}

		if (message.role === Raw.ChatRole.System || message.role === Raw.ChatRole.User) {
			apiMessages.push({
				role: message.role === Raw.ChatRole.System ? vscode.LanguageModelChatMessageRole.System : vscode.LanguageModelChatMessageRole.User,
				name: message.name,
				content: apiContent
			});
		} else if (message.role === Raw.ChatRole.Assistant) {
			if (message.toolCalls) {
				for (const toolCall of message.toolCalls) {
					apiContent.push(new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, JSON.parse(toolCall.function.arguments)));
				}
			}
			apiMessages.push({
				role: vscode.LanguageModelChatMessageRole.Assistant,
				name: message.name,
				content: apiContent
			});
		} else if (message.role === Raw.ChatRole.Tool) {
			const toolResultPart: vscode.LanguageModelToolResultPart2 = new vscode.LanguageModelToolResultPart2(
				message.toolCallId ?? '',
				apiContent
			);
			apiMessages.push({
				role: vscode.LanguageModelChatMessageRole.User,
				name: '',
				content: [toolResultPart]
			});
		}
	}
	return apiMessages;
}
