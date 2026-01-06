/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContentBlockParam, ImageBlockParam, MessageParam, RedactedThinkingBlockParam, TextBlockParam, ThinkingBlockParam } from '@anthropic-ai/sdk/resources';
import { Raw } from '@vscode/prompt-tsx';
import { ClientHttp2Stream } from 'http2';
import { Response } from '../../../platform/networking/common/fetcherService';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { SSEParser } from '../../../util/vs/base/common/sseParser';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { AnthropicMessagesTool, FinishedCallback, IResponseDelta } from '../../networking/common/fetch';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody } from '../../networking/common/networking';
import { ChatCompletion, FinishedCompletionReason } from '../../networking/common/openai';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';

interface AnthropicStreamEvent {
	type: string;
	message?: {
		id: string;
		type: string;
		role: string;
		content: ContentBlockParam[];
		model: string;
		stop_reason: string | null;
		stop_sequence: string | null;
		usage: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
	index?: number;
	content_block?: ContentBlockParam | ThinkingBlockParam | RedactedThinkingBlockParam;
	delta?: {
		type: string;
		text?: string;
		partial_json?: string;
		thinking?: string;
		signature?: string;
		stop_reason?: string;
		stop_sequence?: string;
	};
	usage?: {
		output_tokens: number;
		input_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}

export function createMessagesRequestBody(accessor: ServicesAccessor, options: ICreateEndpointBodyOptions, model: string, endpoint: IChatEndpoint): IEndpointBody {
	const anthropicTools = options.requestOptions?.tools
		?.filter(tool => tool.function.name && tool.function.name.length > 0)
		.map((tool): AnthropicMessagesTool => ({
			name: tool.function.name,
			description: tool.function.description || '',
			input_schema: {
				type: 'object',
				properties: (tool.function.parameters as { properties?: Record<string, unknown> })?.properties ?? {},
				required: (tool.function.parameters as { required?: string[] })?.required ?? [],
			},
		}));

	const configurationService = accessor.get(IConfigurationService);
	const experimentationService = accessor.get(IExperimentationService);
	const configuredBudget = configurationService.getExperimentBasedConfig(ConfigKey.AnthropicThinkingBudget, experimentationService);
	const maxTokens = options.postOptions.max_tokens ?? 1024;
	const normalizedBudget = (configuredBudget && configuredBudget > 0)
		? (configuredBudget < 1024 ? 1024 : configuredBudget)
		: undefined;
	const thinkingBudget = normalizedBudget
		? Math.min(32000, maxTokens - 1, normalizedBudget)
		: undefined;

	return {
		model,
		...rawMessagesToMessagesAPI(options.messages),
		stream: true,
		tools: anthropicTools,
		top_p: options.postOptions.top_p,
		max_tokens: options.postOptions.max_tokens,
		thinking: thinkingBudget ? {
			type: 'enabled',
			budget_tokens: thinkingBudget,
		} : undefined,
	};
}

function rawMessagesToMessagesAPI(messages: readonly Raw.ChatMessage[]): { messages: MessageParam[]; system?: TextBlockParam[] } {
	const unmergedMessages: MessageParam[] = [];
	const systemBlocks: TextBlockParam[] = [];

	for (const message of messages) {
		switch (message.role) {
			case Raw.ChatRole.System: {
				systemBlocks.push(...rawContentToAnthropicContent(message.content).filter((c): c is TextBlockParam => c.type === 'text'));
				break;
			}
			case Raw.ChatRole.User: {
				const content = rawContentToAnthropicContent(message.content);
				if (content.length > 0) {
					unmergedMessages.push({
						role: 'user',
						content,
					});
				}
				break;
			}
			case Raw.ChatRole.Assistant: {
				const content = rawContentToAnthropicContent(message.content);
				if (message.toolCalls) {
					for (const toolCall of message.toolCalls) {
						let parsedInput: Record<string, unknown> = {};
						try {
							parsedInput = JSON.parse(toolCall.function.arguments);
						} catch {
							// Keep empty object if parse fails
						}
						content.push({
							type: 'tool_use',
							id: toolCall.id,
							name: toolCall.function.name,
							input: parsedInput,
						});
					}
				}

				if (content.length > 0) {
					unmergedMessages.push({
						role: 'assistant',
						content,
					});
				}
				break;
			}
			case Raw.ChatRole.Tool: {
				if (message.toolCallId) {
					const toolContent = rawContentToAnthropicContent(message.content);
					const validContent = toolContent.filter((c): c is TextBlockParam | ImageBlockParam =>
						c.type === 'text' || c.type === 'image'
					);
					unmergedMessages.push({
						role: 'user',
						content: [{
							type: 'tool_result',
							tool_use_id: message.toolCallId,
							content: validContent.length > 0 ? validContent : undefined,
						}],
					});
				}
				break;
			}
		}
	}

	const mergedMessages: MessageParam[] = [];
	for (const message of unmergedMessages) {
		const lastMessage = mergedMessages[mergedMessages.length - 1];
		if (lastMessage && lastMessage.role === message.role) {
			const prevContent = Array.isArray(lastMessage.content) ? lastMessage.content : [{ type: 'text' as const, text: lastMessage.content }];
			const newContent = Array.isArray(message.content) ? message.content : [{ type: 'text' as const, text: message.content }];
			lastMessage.content = [...prevContent, ...newContent];
		} else {
			mergedMessages.push(message);
		}
	}

	return {
		messages: mergedMessages,
		...(systemBlocks.length ? { system: systemBlocks } : {}),
	};
}

function rawContentToAnthropicContent(content: readonly Raw.ChatCompletionContentPart[]): ContentBlockParam[] {
	const convertedContent: ContentBlockParam[] = [];

	for (const part of content) {
		switch (part.type) {
			case Raw.ChatCompletionContentPartKind.Text:
				if (part.text.trim()) {
					convertedContent.push({ type: 'text', text: part.text });
				}
				break;
			case Raw.ChatCompletionContentPartKind.Image: {
				const url = part.imageUrl.url;
				// Parse data URL: data:image/png;base64,<data>
				const match = url.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/);
				if (match) {
					convertedContent.push({
						type: 'image',
						source: {
							type: 'base64',
							media_type: match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
							data: match[2],
						}
					});
				}
				break;
			}
			case Raw.ChatCompletionContentPartKind.CacheBreakpoint: {
				const previousBlock = convertedContent.at(-1);
				if (previousBlock && contentBlockSupportsCacheControl(previousBlock)) {
					previousBlock.cache_control = { type: 'ephemeral' };
				} else {
					// Empty string is invalid
					convertedContent.push({
						type: 'text',
						text: ' ',
						cache_control: { type: 'ephemeral' }
					});
				}
				break;
			}
			case Raw.ChatCompletionContentPartKind.Opaque: {
				if (part.value && typeof part.value === 'object' && 'type' in part.value) {
					const opaqueValue = part.value as { type: string; thinking?: { id: string; text?: string; encrypted?: string } };
					if (opaqueValue.type === 'thinking' && opaqueValue.thinking) {
						if (opaqueValue.thinking.encrypted) {
							convertedContent.push({
								type: 'redacted_thinking',
								data: opaqueValue.thinking.encrypted,
							});
						} else if (opaqueValue.thinking.text) {
							convertedContent.push({
								type: 'thinking',
								thinking: opaqueValue.thinking.text,
								signature: '',
							});
						}
					}
				}
				break;
			}
		}
	}

	return convertedContent;
}

function contentBlockSupportsCacheControl(block: ContentBlockParam): block is Exclude<ContentBlockParam, ThinkingBlockParam | RedactedThinkingBlockParam> {
	return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

export async function processResponseFromMessagesEndpoint(
	instantiationService: IInstantiationService,
	telemetryService: ITelemetryService,
	logService: ILogService,
	response: Response,
	expectedNumChoices: number,
	finishCallback: FinishedCallback,
	telemetryData: TelemetryData
): Promise<AsyncIterableObject<ChatCompletion>> {
	const body = (await response.body()) as ClientHttp2Stream;
	return new AsyncIterableObject<ChatCompletion>(async feed => {
		const requestId = response.headers.get('X-Request-ID') ?? generateUuid();
		const ghRequestId = response.headers.get('x-github-request-id') ?? '';
		const processor = instantiationService.createInstance(AnthropicMessagesProcessor, telemetryData, requestId, ghRequestId);
		const parser = new SSEParser((ev) => {
			try {
				const trimmed = ev.data?.trim();
				if (!trimmed || trimmed === '[DONE]') {
					return;
				}

				logService.trace(`SSE: ${trimmed}`);
				const parsed = JSON.parse(trimmed) as Partial<AnthropicStreamEvent>;
				const type = parsed.type ?? ev.type;
				if (!type) {
					return;
				}
				const completion = processor.push({ ...parsed, type } as AnthropicStreamEvent, finishCallback);
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

export class AnthropicMessagesProcessor {
	private textAccumulator: string = '';
	private toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();
	private thinkingAccumulator: Map<number, { thinking: string; signature: string }> = new Map();
	private completedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
	private messageId: string = '';
	private model: string = '';
	private inputTokens: number = 0;
	private outputTokens: number = 0;
	private cachedTokens: number = 0;

	constructor(
		private readonly telemetryData: TelemetryData,
		private readonly requestId: string,
		private readonly ghRequestId: string,
	) { }

	public push(chunk: AnthropicStreamEvent, _onProgress: FinishedCallback): ChatCompletion | undefined {
		const onProgress = (delta: IResponseDelta): undefined => {
			this.textAccumulator += delta.text;
			_onProgress(this.textAccumulator, 0, delta);
		};

		switch (chunk.type) {
			case 'message_start':
				if (chunk.message) {
					this.messageId = chunk.message.id;
					this.model = chunk.message.model;
					this.inputTokens = chunk.message.usage.input_tokens;
					this.outputTokens = chunk.message.usage.output_tokens;
					if (chunk.message.usage.cache_read_input_tokens) {
						this.cachedTokens = chunk.message.usage.cache_read_input_tokens;
					}
				}
				return;
			case 'content_block_start':
				if (chunk.content_block?.type === 'tool_use' && chunk.index !== undefined) {
					this.toolCallAccumulator.set(chunk.index, {
						id: chunk.content_block.id || generateUuid(),
						name: chunk.content_block.name || '',
						arguments: '',
					});
					onProgress({
						text: '',
						beginToolCalls: [{ name: chunk.content_block.name || '' }]
					});
				} else if (chunk.content_block?.type === 'thinking' && chunk.index !== undefined) {
					this.thinkingAccumulator.set(chunk.index, {
						thinking: '',
						signature: '',
					});
				}
				return;
			case 'content_block_delta':
				if (chunk.delta) {
					if (chunk.delta.type === 'text_delta' && chunk.delta.text) {
						return onProgress({ text: chunk.delta.text });
					} else if (chunk.delta.type === 'thinking_delta' && chunk.delta.thinking && chunk.index !== undefined) {
						const thinking = this.thinkingAccumulator.get(chunk.index);
						if (thinking) {
							thinking.thinking += chunk.delta.thinking;
						}
						return onProgress({
							text: '',
							thinking: {
								id: `thinking_${chunk.index}`,
								text: chunk.delta.thinking,
							}
						});
					} else if (chunk.delta.type === 'signature_delta' && chunk.delta.signature && chunk.index !== undefined) {
						const thinking = this.thinkingAccumulator.get(chunk.index);
						if (thinking) {
							thinking.signature += chunk.delta.signature;
						}
						// Don't report signature deltas to the user
					} else if (chunk.delta.type === 'input_json_delta' && chunk.delta.partial_json && chunk.index !== undefined) {
						const toolCall = this.toolCallAccumulator.get(chunk.index);
						if (toolCall) {
							toolCall.arguments += chunk.delta.partial_json;
						}
					}
				}
				return;
			case 'content_block_stop':
				if (chunk.index !== undefined) {
					const toolCall = this.toolCallAccumulator.get(chunk.index);
					if (toolCall) {
						this.completedToolCalls.push(toolCall);
						onProgress({
							text: '',
							copilotToolCalls: [{
								id: toolCall.id,
								name: toolCall.name,
								arguments: toolCall.arguments,
							}],
						});
						this.toolCallAccumulator.delete(chunk.index);
					}
					const thinking = this.thinkingAccumulator.get(chunk.index);
					if (thinking && thinking.signature) {
						onProgress({
							text: '',
							thinking: {
								id: `thinking_${chunk.index}`,
								encrypted: thinking.signature,
							}
						});
						this.thinkingAccumulator.delete(chunk.index);
					}
				}
				return;
			case 'message_delta':
				if (chunk.usage) {
					this.outputTokens = chunk.usage.output_tokens;
				}
				return;
			case 'message_stop':
				return {
					blockFinished: true,
					choiceIndex: 0,
					model: this.model,
					tokens: [],
					telemetryData: this.telemetryData,
					requestId: {
						headerRequestId: this.requestId,
						gitHubRequestId: this.ghRequestId,
						completionId: this.messageId,
						created: Date.now(),
						deploymentId: '',
						serverExperiments: ''
					},
					usage: {
						prompt_tokens: this.inputTokens,
						completion_tokens: this.outputTokens,
						total_tokens: this.inputTokens + this.outputTokens,
						prompt_tokens_details: {
							cached_tokens: this.cachedTokens,
						},
						completion_tokens_details: {
							reasoning_tokens: 0,
							accepted_prediction_tokens: 0,
							rejected_prediction_tokens: 0,
						},
					},
					finishReason: FinishedCompletionReason.Stop,
					message: {
						role: Raw.ChatRole.Assistant,
						content: this.textAccumulator ? [{
							type: Raw.ChatCompletionContentPartKind.Text,
							text: this.textAccumulator
						}] : [],
						...(this.completedToolCalls.length > 0 ? {
							toolCalls: this.completedToolCalls.map(tc => ({
								id: tc.id,
								type: 'function' as const,
								function: {
									name: tc.name,
									arguments: tc.arguments
								}
							}))
						} : {})
					}
				};
			case 'error': {
				const errorMessage = (chunk as unknown as { error?: { message?: string } }).error?.message || 'Unknown error';
				return onProgress({
					text: '',
					copilotErrors: [{
						agent: 'anthropic',
						code: 'unknown',
						message: errorMessage,
						type: 'error',
						identifier: undefined
					}]
				});
			}
		}
	}
}


