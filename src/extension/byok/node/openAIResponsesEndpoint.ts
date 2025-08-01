/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { ClientHttp2Stream } from 'http2';
import { OpenAI } from 'openai';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, IResponseDelta, isOpenAiFunctionTool, OpenAiResponsesFunctionTool } from '../../../platform/networking/common/fetch';
import { Response } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint, IEndpointBody } from '../../../platform/networking/common/networking';
import { CAPIChatMessage, ChatCompletion, FinishedCompletionReason, TokenLogProb } from '../../../platform/networking/common/openai';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { binaryIndexOf } from '../../../util/vs/base/common/buffer';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { SSEParser } from '../../../util/vs/base/common/sseParser';
import { isDefined } from '../../../util/vs/base/common/types';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { OpenAIEndpoint } from './openAIEndpoint';


export class OpenAIResponsesEndpoint extends OpenAIEndpoint {
	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this._modelInfo, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(OpenAIResponsesEndpoint, newModelInfo, this._apiKey, this._modelUrl);
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		if (!body) {
			return;
		}

		// responses API uses input instead of messages
		if (body.messages) {
			const input: OpenAI.Responses.ResponseInputItem[] = [];
			for (const message of body.messages as CAPIChatMessage[]) {
				switch (message.role) {
					case 'assistant':
						if (message.content) {
							input.push({ role: 'assistant', content: message.content });
						}
						if (message.tool_calls) {
							for (const toolCall of message.tool_calls) {
								input.push({ type: 'function_call', name: toolCall.function.name, arguments: toolCall.function.arguments, call_id: toolCall.id });
							}
						}
						break;
					case 'tool':
						if (message.tool_call_id) {
							const asText = typeof message.content === 'string' ? message.content : message.content.filter(c => c.type === 'text').map(c => c.text).join('');
							const asImages = typeof message.content === 'string' ? [] : message.content.filter(c => c.type === 'image_url').map((c): OpenAI.Responses.ResponseInputImage => ({ type: 'input_image', detail: c.image_url.detail || 'auto', image_url: c.image_url.url }));

							// todod@connor4312: hack while responses API only supports text output from tools
							input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: asText });
							if (asImages.length) {
								input.push({ role: 'user', content: [{ type: 'input_text', text: 'Image associated with the above tool call:' }, ...asImages] });
							}
						}
						break;
					case 'user':
					case 'system':
						input.push({
							role: message.role,
							content: typeof message.content === 'string' ? message.content : message.content.map((c): OpenAI.Responses.ResponseInputContent => {
								if (c.type === 'text') {
									return { type: 'input_text', text: c.text };
								} else {
									return { type: 'input_image', detail: c.image_url.detail || 'auto', image_url: c.image_url.url };
								}
							})
						});
						break;
				}
			}

			body.input = input;
			body.messages = undefined;
		}

		body.n = undefined;
		body.stream_options = undefined;

		if (body?.tools) {
			body.tools = body.tools.map((tool): OpenAiResponsesFunctionTool => isOpenAiFunctionTool(tool) ? ({ ...tool.function, type: 'function' }) : tool);
		}
	}

	public override async processResponseFromChatEndpoint(telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData): Promise<AsyncIterableObject<ChatCompletion>> {
		const body = (await response.body()) as ClientHttp2Stream;
		return new AsyncIterableObject<ChatCompletion>(async feed => {
			const requestId = response.headers.get('X-Request-ID') ?? generateUuid();
			const processor = this.instantiationService.createInstance(OpenAIResponsesProcessor, telemetryData, requestId);
			const parser = new SSEParser((ev) => {
				try {
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
