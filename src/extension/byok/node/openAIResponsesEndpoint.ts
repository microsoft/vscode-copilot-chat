/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { ClientHttp2Stream } from 'http2';
import type { OpenAI } from 'openai';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { getStatefulMarkerAndIndex } from '../../../platform/endpoint/common/statefulMarkerContainer';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, IResponseDelta, OpenAiResponsesFunctionTool } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { ChatCompletion, FinishedCompletionReason, TokenLogProb } from '../../../platform/networking/common/openai';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { binaryIndexOf } from '../../../util/vs/base/common/buffer';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { SSEParser } from '../../../util/vs/base/common/sseParser';
import { isDefined } from '../../../util/vs/base/common/types';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from './openAIEndpoint';


export class OpenAIResponsesEndpoint extends OpenAIEndpoint {
	constructor(
		modelInfo: IChatModelInformation,
		apiKey: string,
		modelUrl: string,
		@IFetcherService fetcherService: IFetcherService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThinkingDataService thinkingDataService: IThinkingDataService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService
	) {
		super(
			modelInfo,
			apiKey,
			modelUrl,
			fetcherService,
			domainService,
			capiClientService,
			envService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			thinkingDataService
		);
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this._modelInfo, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(OpenAIResponsesEndpoint, newModelInfo, this._apiKey, this._modelUrl);
	}

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		return {
			model: this.model,
			...rawMessagesToResponseAPI(this.model, options.messages, !!options.ignoreStatefulMarker),
			reasoning: this._modelInfo.capabilities.supports.thinking ? { summary: 'concise' } : undefined,
			stream: true,
			tools: options.requestOptions?.tools?.map((tool): OpenAI.Responses.FunctionTool & OpenAiResponsesFunctionTool => ({
				...tool.function,
				type: 'function',
				strict: false,
				parameters: (tool.function.parameters || {}) as Record<string, unknown>,
			})),
			// Only a subset of completion post options are supported, and some
			// are renamed. Handle them manually:
			temperature: options.postOptions.temperature,
			top_p: options.postOptions.top_p,
			max_output_tokens: options.postOptions.max_tokens,
			tool_choice: typeof options.postOptions.tool_choice === 'object'
				? { type: 'function', name: options.postOptions.tool_choice.function.name }
				: options.postOptions.tool_choice,
			// top_logprobs is documented but not in the API types yet
			//@ts-expect-error
			top_logprobs: options.postOptions.logprobs ? 3 : undefined,
		} satisfies OpenAI.Responses.ResponseCreateParamsStreaming;
	}

	public override async processResponseFromChatEndpoint(telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData): Promise<AsyncIterableObject<ChatCompletion>> {
		const body = (await response.body()) as ClientHttp2Stream;
		return new AsyncIterableObject<ChatCompletion>(async feed => {
			const requestId = response.headers.get('X-Request-ID') ?? generateUuid();
			const processor = this.instantiationService.createInstance(OpenAIResponsesProcessor, telemetryData, requestId);
			const parser = new SSEParser((ev) => {
				try {
					this.logService.trace(`SSE: ${ev.data}`);
					const completion = processor.push({ type: ev.type, ...JSON.parse(ev.data) }, finishCallback);
					if (completion) {
						feed.emitOne(completion);
					}
				} catch (e) {
					feed.reject(e);
				}
			});

			for await (const chunk of body) {
				parser.feed(chunk);
			}
		}, () => {
			body.destroy();
		});
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		if (!body) {
			return;
		}

		body.n = undefined;
		body.stream_options = undefined;
		body.truncation = this.configurationService.getConfig(ConfigKey.Internal.UseResponsesApiTruncation) ?
			'auto' :
			'disabled';
	}

	public override async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		const response = await super.makeChatRequest2(options, token);
		if (response.type === ChatFetchResponseType.InvalidStatefulMarker) {
			return super.makeChatRequest2({ ...options, ignoreStatefulMarker: true }, token);
		}

		return response;
	}
}

class OpenAIResponsesProcessor {
	private textAccumulator: string = '';

	constructor(
		private readonly telemetryData: TelemetryData,
		private readonly requestId: string,
		@IThinkingDataService private readonly thinkingDataService: IThinkingDataService,
	) { }

	public push(chunk: OpenAI.Responses.ResponseStreamEvent, _onProgress: FinishedCallback): ChatCompletion | undefined {
		const onProgress = (delta: IResponseDelta): undefined => {
			this.textAccumulator += delta.text;
			_onProgress(this.textAccumulator, 0, delta);
		};

		switch (chunk.type) {
			case 'error':
				return onProgress({ text: '', copilotErrors: [{ agent: 'openai', code: chunk.code || 'unknown', message: chunk.message, type: 'error', identifier: chunk.param || undefined }] });
			case 'response.output_text.delta': {
				const haystack = new Lazy(() => new TextEncoder().encode(chunk.delta));
				return onProgress({
					text: chunk.delta,
					logprobs: { content: chunk.logprobs.map(lp => ({ ...mapLogProp(haystack, lp), top_logprobs: lp.top_logprobs?.map(l => mapLogProp(haystack, l)) || [] })) },
				});
			}
			case 'response.output_item.added':
				if (chunk.item.type === 'function_call') {
					onProgress({
						text: '',
						beginToolCalls: [{ name: chunk.item.name }]
					});
				}
				return;
			case 'response.output_item.done':
				if (chunk.item.type === 'function_call') {
					onProgress({
						text: '',
						copilotToolCalls: [{
							id: chunk.item.call_id,
							name: chunk.item.name,
							arguments: chunk.item.arguments,
						}],
					});
				}
				return;
			case 'response.reasoning_summary_text.delta':
				return onProgress({ text: '', thinking: { id: chunk.item_id, text: chunk.delta } });
			case 'response.reasoning_summary_part.done':
				this.thinkingDataService.set('0', {
					id: chunk.item_id,
					text: chunk.part.text,
				});
				return onProgress({ text: '', thinking: { id: chunk.item_id, text: '' } });
			case 'response.completed':
				onProgress({ text: '', statefulMarker: chunk.response.id });
				return {
					blockFinished: true,
					choiceIndex: 0,
					tokens: [],
					telemetryData: this.telemetryData,
					requestId: { headerRequestId: this.requestId, completionId: chunk.response.id, created: chunk.response.created_at, deploymentId: '', serverExperiments: '' },
					usage: {
						prompt_tokens: chunk.response.usage?.input_tokens ?? 0,
						completion_tokens: chunk.response.usage?.output_tokens ?? 0,
						total_tokens: chunk.response.usage?.total_tokens ?? 0,
						prompt_tokens_details: {
							cached_tokens: chunk.response.usage?.input_tokens_details.cached_tokens ?? 0,
						},
						completion_tokens_details: {
							reasoning_tokens: chunk.response.usage?.output_tokens_details.reasoning_tokens ?? 0,
							accepted_prediction_tokens: 0,
							rejected_prediction_tokens: 0,
						},
					},
					finishReason: FinishedCompletionReason.Stop,
					message: {
						role: Raw.ChatRole.Assistant,
						content: chunk.response.output.map((item): Raw.ChatCompletionContentPart | undefined => {
							if (item.type === 'message') {
								return { type: Raw.ChatCompletionContentPartKind.Text, text: item.content.map(c => c.type === 'output_text' ? c.text : c.refusal).join('') };
							} else if (item.type === 'image_generation_call' && item.result) {
								return { type: Raw.ChatCompletionContentPartKind.Image, imageUrl: { url: item.result } };
							}
						}).filter(isDefined),
					}
				};
		}
	}
}

function mapLogProp(text: Lazy<Uint8Array>, lp: OpenAI.Responses.ResponseTextDeltaEvent.Logprob.TopLogprob): TokenLogProb {
	let bytes: number[] = [];
	if (lp.token) {
		const needle = new TextEncoder().encode(lp.token);
		const haystack = text.value;
		const idx = binaryIndexOf(haystack, needle);
		if (idx !== -1) {
			bytes = [idx, idx + needle.length];
		}
	}

	return {
		token: lp.token!,
		bytes,
		logprob: lp.logprob!,
	};
}

function rawContentToResponsesContent(part: Raw.ChatCompletionContentPart): OpenAI.Responses.ResponseInputContent | undefined {
	switch (part.type) {
		case Raw.ChatCompletionContentPartKind.Text:
			return { type: 'input_text', text: part.text };
		case Raw.ChatCompletionContentPartKind.Image:
			return { type: 'input_image', detail: part.imageUrl.detail || 'auto', image_url: part.imageUrl.url };
		case Raw.ChatCompletionContentPartKind.Opaque: {
			const maybeCast = part.value as OpenAI.Responses.ResponseInputContent;
			if (maybeCast.type === 'input_text' || maybeCast.type === 'input_image' || maybeCast.type === 'input_file') {
				return maybeCast;
			}
		}
	}
}

function rawContentToResponsesOutputContent(part: Raw.ChatCompletionContentPart): OpenAI.Responses.ResponseOutputText | OpenAI.Responses.ResponseOutputRefusal | undefined {
	switch (part.type) {
		case Raw.ChatCompletionContentPartKind.Text:
			return { type: 'output_text', text: part.text, annotations: [] };
	}
}

function rawMessagesToResponseAPI(modelId: string, messages: readonly Raw.ChatMessage[], ignoreStatefulMarker: boolean): { input: OpenAI.Responses.ResponseInputItem[]; previous_response_id?: string } {
	const statefulMarkerAndIndex = !ignoreStatefulMarker && getStatefulMarkerAndIndex(modelId, messages);
	let previousResponseId: string | undefined;
	if (statefulMarkerAndIndex) {
		previousResponseId = statefulMarkerAndIndex.statefulMarker;
		messages = messages.slice(statefulMarkerAndIndex.index + 1);
	}

	const input: OpenAI.Responses.ResponseInputItem[] = [];
	for (const message of messages) {
		switch (message.role) {
			case Raw.ChatRole.Assistant:
				if (message.content.length) {
					input.push({
						role: 'assistant',
						content: message.content.map(rawContentToResponsesOutputContent).filter(isDefined),
						// I don't know what this does. These seem optional but are required in the types
						id: 'msg_123',
						status: 'completed',
						type: 'message',
					} satisfies OpenAI.Responses.ResponseOutputMessage);
				}
				if (message.toolCalls) {
					for (const toolCall of message.toolCalls) {
						input.push({ type: 'function_call', name: toolCall.function.name, arguments: toolCall.function.arguments, call_id: toolCall.id });
					}
				}
				break;
			case Raw.ChatRole.Tool:
				if (message.toolCallId) {
					const asText = message.content
						.filter(c => c.type === Raw.ChatCompletionContentPartKind.Text)
						.map(c => c.text)
						.join('');
					const asImages = message.content
						.filter(c => c.type === Raw.ChatCompletionContentPartKind.Image)
						.map((c): OpenAI.Responses.ResponseInputImage => ({
							type: 'input_image',
							detail: c.imageUrl.detail || 'auto',
							image_url: c.imageUrl.url,
						}));

					// todod@connor4312: hack while responses API only supports text output from tools
					input.push({ type: 'function_call_output', call_id: message.toolCallId, output: asText });
					if (asImages.length) {
						input.push({ role: 'user', content: [{ type: 'input_text', text: 'Image associated with the above tool call:' }, ...asImages] });
					}
				}
				break;
			case Raw.ChatRole.User:
				input.push({ role: 'user', content: message.content.map(rawContentToResponsesContent).filter(isDefined) });
				break;
			case Raw.ChatRole.System:
				input.push({ role: 'system', content: message.content.map(rawContentToResponsesContent).filter(isDefined) });
				break;
		}
	}

	return { input, previous_response_id: previousResponseId };
}