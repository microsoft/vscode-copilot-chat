/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { ClientHttp2Stream } from 'http2';
import { OpenAI } from 'openai';
import { Response } from '../../../platform/networking/common/fetcherService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { binaryIndexOf } from '../../../util/vs/base/common/buffer';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { SSEParser } from '../../../util/vs/base/common/sseParser';
import { isDefined } from '../../../util/vs/base/common/types';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { FinishedCallback, IResponseDelta, OpenAiResponsesFunctionTool } from '../../networking/common/fetch';
import { ICreateEndpointBodyOptions, IEndpointBody } from '../../networking/common/networking';
import { ChatCompletion, FinishedCompletionReason, TokenLogProb } from '../../networking/common/openai';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { IChatModelInformation } from '../common/endpointProvider';
import { getStatefulMarkerAndIndex } from '../common/statefulMarkerContainer';
import { rawPartAsThinkingData } from '../common/thinkingDataContainer';

export function createResponsesRequestBody(accessor: ServicesAccessor, options: ICreateEndpointBodyOptions, model: string, modelInfo: IChatModelInformation): IEndpointBody {
	const configService = accessor.get(IConfigurationService);
	const logService = accessor.get(ILogService);
	const body: IEndpointBody = {
		model,
		...rawMessagesToResponseAPI(model, options.messages, !!options.ignoreStatefulMarker),
		stream: true,
		tools: options.requestOptions?.tools?.map((tool): OpenAI.Responses.FunctionTool & OpenAiResponsesFunctionTool => ({
			...tool.function,
			type: 'function',
			strict: false,
			parameters: (tool.function.parameters || {}) as Record<string, unknown>,
		})),
		// Only a subset of completion post options are supported, and some
		// are renamed. Handle them manually:
		top_p: options.postOptions.top_p,
		max_output_tokens: options.postOptions.max_tokens,
		tool_choice: typeof options.postOptions.tool_choice === 'object'
			? { type: 'function', name: options.postOptions.tool_choice.function.name }
			: options.postOptions.tool_choice,
		top_logprobs: options.postOptions.logprobs ? 3 : undefined,
		store: false
	};

	body.truncation = configService.getConfig(ConfigKey.Internal.UseResponsesApiTruncation) ?
		'auto' :
		'disabled';
	const reasoningConfig = configService.getConfig(ConfigKey.Internal.ResponsesApiReasoning);
	if (reasoningConfig === true) {
		body.reasoning = {
			'effort': 'medium',
			'summary': 'detailed'
		};
	} else if (typeof reasoningConfig === 'string') {
		try {
			body.reasoning = JSON.parse(reasoningConfig);
		} catch (e) {
			logService.error(e, 'Failed to parse responses reasoning setting');
		}
	}

	body.include = ['reasoning.encrypted_content'];

	return body;
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
					input.push(...extractThinkingData(message.content));
					input.push({
						role: 'assistant',
						content: message.content.map(rawContentToResponsesOutputContent).filter(isDefined),
						// I don't think this needs to be round-tripped.
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

function extractThinkingData(content: Raw.ChatCompletionContentPart[]): OpenAI.Responses.ResponseReasoningItem[] {
	return coalesce(content.map(part => {
		if (part.type === Raw.ChatCompletionContentPartKind.Opaque) {
			const thinkingData = rawPartAsThinkingData(part);
			if (thinkingData) {
				return {
					type: 'reasoning',
					id: thinkingData.id,
					summary: [],
					encrypted_content: thinkingData.encrypted,
				} satisfies OpenAI.Responses.ResponseReasoningItem;
			}
		}
	}));
}

export async function processResponseFromChatEndpoint(instantiationService: IInstantiationService, telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData): Promise<AsyncIterableObject<ChatCompletion>> {
	const body = (await response.body()) as ClientHttp2Stream;
	return new AsyncIterableObject<ChatCompletion>(async feed => {
		const requestId = response.headers.get('X-Request-ID') ?? generateUuid();
		const processor = instantiationService.createInstance(OpenAIResponsesProcessor, telemetryData, requestId);
		const parser = new SSEParser((ev) => {
			try {
				logService.trace(`SSE: ${ev.data}`);
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

interface CapiResponsesTextDeltaEvent extends Omit<OpenAI.Responses.ResponseTextDeltaEvent, 'logprobs'> {
	logprobs: Array<OpenAI.Responses.ResponseTextDeltaEvent.Logprob> | undefined;
}

class OpenAIResponsesProcessor {
	private textAccumulator: string = '';
	private hasReceivedReasoningSummary = false;

	constructor(
		private readonly telemetryData: TelemetryData,
		private readonly requestId: string,
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
				const capiChunk: CapiResponsesTextDeltaEvent = chunk;
				const haystack = new Lazy(() => new TextEncoder().encode(capiChunk.delta));
				return onProgress({
					text: capiChunk.delta,
					logprobs: capiChunk.logprobs && {
						content: capiChunk.logprobs.map(lp => ({
							...mapLogProp(haystack, lp),
							top_logprobs: lp.top_logprobs?.map(l => mapLogProp(haystack, l)) || []
						}))
					},
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
				} else if (chunk.item.type === 'reasoning') {
					onProgress({
						text: '',
						thinking: chunk.item.encrypted_content ? {
							id: chunk.item.id,
							// CAPI models don't stream the reasoning summary for some reason, byok do, so don't duplicate it
							text: this.hasReceivedReasoningSummary ?
								undefined :
								chunk.item.summary.map(s => s.text),
							encrypted: chunk.item.encrypted_content,
						} : undefined
					});
				}
				return;
			case 'response.reasoning_summary_text.delta':
				this.hasReceivedReasoningSummary = true;
				return onProgress({
					text: '',
					thinking: {
						id: chunk.item_id,
						text: chunk.delta,
					}
				});
			case 'response.reasoning_summary_part.done':
				this.hasReceivedReasoningSummary = true;
				return onProgress({
					text: '',
					thinking: {
						id: chunk.item_id
					}
				});
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
