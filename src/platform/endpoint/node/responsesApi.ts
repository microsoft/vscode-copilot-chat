/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { OpenAI } from 'openai';
import { Response } from '../../../platform/networking/common/fetcherService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { binaryIndexOf } from '../../../util/vs/base/common/buffer';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { SSEParser } from '../../../util/vs/base/common/sseParser';
import { isDefined } from '../../../util/vs/base/common/types';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatLocation } from '../../chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { CUSTOM_TOOL_SEARCH_NAME } from '../../networking/common/anthropic';
import { FinishedCallback, IResponseDelta, OpenAiFunctionTool, OpenAiResponsesFunctionTool, OpenAiToolSearchTool } from '../../networking/common/fetch';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody } from '../../networking/common/networking';
import { ChatCompletion, FinishedCompletionReason, isResponsesApiToolSearchEnabled, modelsWithoutResponsesContextManagement, openAIContextManagementCompactionType, OpenAIContextManagementResponse, rawMessageToCAPI, TokenLogProb } from '../../networking/common/openai';
import { IToolDeferralService } from '../../networking/common/toolDeferralService';
import { sendEngineMessagesTelemetry } from '../../networking/node/chatStream';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { getVerbosityForModelSync } from '../common/chatModelCapabilities';
import { rawPartAsCompactionData } from '../common/compactionDataContainer';
import { rawPartAsPhaseData } from '../common/phaseDataContainer';
import { getStatefulMarkerAndIndex } from '../common/statefulMarkerContainer';
import { rawPartAsThinkingData } from '../common/thinkingDataContainer';

export function createResponsesRequestBody(accessor: ServicesAccessor, options: ICreateEndpointBodyOptions, model: string, endpoint: IChatEndpoint): IEndpointBody {
	const configService = accessor.get(IConfigurationService);
	const expService = accessor.get(IExperimentationService);
	const verbosity = getVerbosityForModelSync(endpoint);
	// compaction supported for all the models but works well for codex models and any future models after 5.3

	// Tool search: when enabled, split tools into non-deferred (always loaded) and deferred (defer_loading: true).
	// Uses OpenAI's client-executed tool search protocol: we add { type: 'tool_search', execution: 'client' }
	// and mark deferred tools with defer_loading. The model emits tool_search_call which we handle via
	// our ToolSearchTool embeddings search, then round-trip as tool_search_output in the next request.
	const toolSearchEnabled = isResponsesApiToolSearchEnabled(endpoint, configService, expService);
	const isAllowedConversationAgent = options.location === ChatLocation.Agent || options.location === ChatLocation.MessagesProxy;
	const isSubagent = options.telemetryProperties?.subType?.startsWith('subagent') ?? false;
	const shouldDeferTools = toolSearchEnabled && isAllowedConversationAgent && !isSubagent;
	const toolDeferralService = shouldDeferTools ? accessor.get(IToolDeferralService) : undefined;

	type ResponsesFunctionTool = OpenAI.Responses.FunctionTool & OpenAiResponsesFunctionTool & { defer_loading?: boolean };
	const functionTools: ResponsesFunctionTool[] = [];
	if (options.requestOptions?.tools) {
		for (const tool of options.requestOptions.tools) {
			if (!tool.function.name || tool.function.name.length === 0) {
				continue;
			}
			const isDeferred = shouldDeferTools && !toolDeferralService!.isNonDeferredTool(tool.function.name);
			functionTools.push({
				...tool.function,
				type: 'function',
				strict: false,
				parameters: (tool.function.parameters || {}) as Record<string, unknown>,
				...(isDeferred ? { defer_loading: true } : {}),
			});
		}
	}

	// Build final tools array
	const finalTools: Array<ResponsesFunctionTool | OpenAiToolSearchTool | ClientToolSearchTool> = [...functionTools];
	const hasDeferredTools = functionTools.some(t => t.defer_loading);
	if (hasDeferredTools) {
		// Client-executed tool search: the model emits tool_search_call, our ToolSearchTool
		// handles the embeddings search, and we return tool_search_output with full definitions.
		finalTools.unshift({
			type: 'tool_search',
			execution: 'client',
			description: 'Search for relevant tools by describing what you need. Returns tool definitions for tools matching your query.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Natural language description of what tool capability you are looking for.',
					},
				},
				required: ['query'],
			},
		} as ClientToolSearchTool);
	}

	// Build tools map for rawMessagesToResponseAPI to convert tool_search round-trips
	const toolsMap = shouldDeferTools && options.requestOptions?.tools
		? new Map(options.requestOptions.tools.map(t => [t.function.name, t]))
		: undefined;

	const body: IEndpointBody = {
		model,
		...rawMessagesToResponseAPI(model, options.messages, !!options.ignoreStatefulMarker, toolsMap),
		stream: true,
		tools: finalTools.length > 0 ? finalTools : undefined,
		// Only a subset of completion post options are supported, and some
		// are renamed. Handle them manually:
		max_output_tokens: options.postOptions.max_tokens,
		tool_choice: typeof options.postOptions.tool_choice === 'object'
			? { type: 'function', name: options.postOptions.tool_choice.function.name }
			: options.postOptions.tool_choice,
		top_logprobs: options.postOptions.logprobs ? 3 : undefined,
		store: false,
		text: verbosity ? { verbosity } : undefined,
	};

	const contextManagementEnabled = configService.getExperimentBasedConfig(ConfigKey.ResponsesApiContextManagementEnabled, expService) && !modelsWithoutResponsesContextManagement.has(endpoint.family);
	if (contextManagementEnabled) {
		const compactThreshold = endpoint.modelMaxPromptTokens > 0
			? Math.floor(endpoint.modelMaxPromptTokens * 0.9)
			: 50000;
		body.context_management = [{
			'type': openAIContextManagementCompactionType,
			// Trigger compaction at 90% of the model max prompt context to keep headroom for active turns.
			'compact_threshold': compactThreshold
		}];
	}

	body.truncation = configService.getConfig(ConfigKey.Advanced.UseResponsesApiTruncation) ?
		'auto' :
		'disabled';
	const summaryConfig = configService.getExperimentBasedConfig(ConfigKey.ResponsesApiReasoningSummary, expService);
	const shouldDisableReasoningSummary = endpoint.family === 'gpt-5.3-codex-spark-preview';
	const effort = options.reasoningEffort || 'medium';
	const summary = summaryConfig === 'off' || shouldDisableReasoningSummary ? undefined : summaryConfig;
	if (effort || summary) {
		body.reasoning = {
			...(effort ? { effort } : {}),
			...(summary ? { summary } : {})
		};
	}

	body.include = ['reasoning.encrypted_content'];

	const promptCacheKeyEnabled = configService.getExperimentBasedConfig(ConfigKey.ResponsesApiPromptCacheKeyEnabled, expService);
	if (promptCacheKeyEnabled && options.conversationId) {
		body.prompt_cache_key = `${options.conversationId}:${endpoint.family}`;
	}

	return body;
}

type ResponseOutputMessageWithPhase = OpenAI.Responses.ResponseOutputMessage & {
	phase?: string;
};

interface ResponseOutputItemWithPhase {
	phase?: string;
}

// ── Responses API tool search types ──────────────────────────────────\n// These match the shapes from https://developers.openai.com/api/docs/guides/tools-tool-search

/** Client-executed tool_search tool definition for the Responses API */
interface ClientToolSearchTool {
	type: 'tool_search';
	execution: 'client';
	description: string;
	parameters: Record<string, unknown>;
}

interface ResponsesToolSearchCall {
	type: 'tool_search_call';
	id: string;
	execution: 'server' | 'client';
	call_id: string | null;
	status: string;
	arguments?: Record<string, unknown>;
}

interface ResponsesToolSearchOutput {
	type: 'tool_search_output';
	id: string;
	execution: 'server' | 'client';
	call_id: string | null;
	status: string;
	tools?: unknown[];
}

function rawMessagesToResponseAPI(modelId: string, messages: readonly Raw.ChatMessage[], ignoreStatefulMarker: boolean, toolsMap?: Map<string, OpenAiFunctionTool>): { input: OpenAI.Responses.ResponseInputItem[]; previous_response_id?: string } {
	const latestCompactionMessageIndex = getLatestCompactionMessageIndex(messages);
	if (latestCompactionMessageIndex !== undefined) {
		messages = messages.slice(latestCompactionMessageIndex);
	}

	const statefulMarkerAndIndex = !ignoreStatefulMarker && getStatefulMarkerAndIndex(modelId, messages);
	let previousResponseId: string | undefined;
	if (latestCompactionMessageIndex === undefined && statefulMarkerAndIndex) {
		previousResponseId = statefulMarkerAndIndex.statefulMarker;
		messages = messages.slice(statefulMarkerAndIndex.index + 1);
	}

	// Track which call_ids are tool_search_calls (from client-executed tool search)
	const toolSearchCallIds = new Set<string>();

	const input: OpenAI.Responses.ResponseInputItem[] = [];
	for (const message of messages) {
		switch (message.role) {
			case Raw.ChatRole.Assistant:
				if (message.content.length) {
					input.push(...extractCompactionData(message.content));
					input.push(...extractThinkingData(message.content));
					const asstContent = message.content.map(rawContentToResponsesOutputContent).filter(isDefined);
					if (asstContent.length) {
						const assistantMessage: ResponseOutputMessageWithPhase = {
							role: 'assistant',
							content: asstContent,
							// I don't think this needs to be round-tripped.
							id: 'msg_123',
							status: 'completed',
							type: 'message',
							phase: extractPhaseData(message.content),
						};
						input.push(assistantMessage);
					}
				}
				if (message.toolCalls) {
					for (const toolCall of message.toolCalls) {
						if (toolsMap && toolCall.function.name === CUSTOM_TOOL_SEARCH_NAME) {
							// Client-executed tool search: emit as tool_search_call instead of function_call
							toolSearchCallIds.add(toolCall.id);
							let parsedArgs: Record<string, unknown> = {};
							try { parsedArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch { }
							input.push({
								type: 'tool_search_call',
								execution: 'client',
								call_id: toolCall.id,
								status: 'completed',
								arguments: parsedArgs,
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
							} as any);
						} else {
							input.push({ type: 'function_call', name: toolCall.function.name, arguments: toolCall.function.arguments, call_id: toolCall.id });
						}
					}
				}
				break;
			case Raw.ChatRole.Tool:
				if (message.toolCallId) {
					if (toolsMap && toolSearchCallIds.has(message.toolCallId)) {
						// Client-executed tool search result: convert tool names to tool_search_output with full definitions
						const resultText = message.content
							.filter(c => c.type === Raw.ChatCompletionContentPartKind.Text)
							.map(c => c.text)
							.join('');
						const loadedTools = buildToolSearchOutputTools(resultText, toolsMap);
						input.push({
							type: 'tool_search_output',
							execution: 'client',
							call_id: message.toolCallId,
							status: 'completed',
							tools: loadedTools,
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
						} as any);
					} else {
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

/**
 * Converts a JSON array of tool names (from ToolSearchTool) into full tool definitions
 * for the tool_search_output. Falls back to an empty array on parse failure.
 */
function buildToolSearchOutputTools(resultText: string, toolsMap: Map<string, OpenAiFunctionTool>): unknown[] {
	let toolNames: unknown;
	try { toolNames = JSON.parse(resultText); } catch { return []; }
	if (!Array.isArray(toolNames)) { return []; }

	return toolNames
		.filter((name): name is string => typeof name === 'string' && toolsMap.has(name))
		.map(name => {
			const tool = toolsMap.get(name)!;
			return {
				type: 'function',
				name: tool.function.name,
				description: tool.function.description || '',
				defer_loading: true,
				parameters: tool.function.parameters || { type: 'object', properties: {} },
			};
		});
}

function getLatestCompactionMessageIndex(messages: readonly Raw.ChatMessage[]): number | undefined {
	for (let idx = messages.length - 1; idx >= 0; idx--) {
		const message = messages[idx];
		for (const part of message.content) {
			if (part.type === Raw.ChatCompletionContentPartKind.Opaque && rawPartAsCompactionData(part)) {
				return idx;
			}
		}
	}

	return undefined;
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
			if (part.text.trim()) {
				return { type: 'output_text', text: part.text, annotations: [] };
			}
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

function extractPhaseData(content: Raw.ChatCompletionContentPart[]): string | undefined {
	for (const part of content) {
		if (part.type === Raw.ChatCompletionContentPartKind.Opaque) {
			const phase = rawPartAsPhaseData(part);
			if (phase) {
				return phase;
			}
		}
	}
	return undefined;
}

/**
 * Extracts compaction data from opaque content parts and converts them to
 * Responses API input items for round-tripping.
 */
function extractCompactionData(content: Raw.ChatCompletionContentPart[]): OpenAI.Responses.ResponseInputItem[] {
	return coalesce(content.map(part => {
		if (part.type === Raw.ChatCompletionContentPartKind.Opaque) {
			const compaction = rawPartAsCompactionData(part);
			if (compaction) {
				return {
					type: openAIContextManagementCompactionType,
					id: compaction.id,
					encrypted_content: compaction.encrypted_content,
				} as unknown as OpenAI.Responses.ResponseInputItem;
			}
		}
	}));
}

/**
 * This is an approximate responses input -> raw messages helper, should be used for logging only
 */
export function responseApiInputToRawMessagesForLogging(body: OpenAI.Responses.ResponseCreateParams): Raw.ChatMessage[] {
	const messages: Raw.ChatMessage[] = [];
	const pendingFunctionCalls: Raw.ChatMessageToolCall[] = [];

	const flushPendingFunctionCalls = () => {
		if (pendingFunctionCalls.length > 0) {
			messages.push({
				role: Raw.ChatRole.Assistant,
				content: [],
				toolCalls: pendingFunctionCalls.splice(0)
			});
		}
	};

	// Add system instructions if provided
	if (body.instructions) {
		messages.push({
			role: Raw.ChatRole.System,
			content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: body.instructions }]
		});
	}

	// Convert input to array format if it's a string
	const inputItems = typeof body.input === 'string' ? [{ role: 'user' as const, content: body.input, type: 'message' as const }] : (body.input ?? []);

	for (const item of inputItems) {
		// Handle message items with roles
		if ('role' in item) {
			switch (item.role) {
				case 'user':
					flushPendingFunctionCalls();
					messages.push({
						role: Raw.ChatRole.User,
						content: ensureContentArray(item.content).map(responseContentToRawContent).filter(isDefined)
					});
					break;
				case 'system':
				case 'developer':
					flushPendingFunctionCalls();
					messages.push({
						role: Raw.ChatRole.System,
						content: ensureContentArray(item.content).map(responseContentToRawContent).filter(isDefined)
					});
					break;
				case 'assistant':
					flushPendingFunctionCalls();
					if (isResponseOutputMessage(item)) {
						messages.push({
							role: Raw.ChatRole.Assistant,
							content: item.content.map(responseOutputToRawContent).filter(isDefined)
						});
					} else if (isResponseInputItemMessage(item)) {
						messages.push({
							role: Raw.ChatRole.Assistant,
							content: ensureContentArray(item.content).map(responseContentToRawContent).filter(isDefined)
						});
					}
					break;
			}
		} else if ('type' in item) {
			// Handle other item types without roles
			switch (item.type) {
				case 'function_call':
					// Collect function calls to be grouped with the next assistant message
					pendingFunctionCalls.push({
						id: item.call_id,
						type: 'function',
						function: {
							name: item.name,
							arguments: item.arguments
						}
					});
					break;
				case 'function_call_output': {
					flushPendingFunctionCalls();
					const content = responseFunctionOutputToRawContents(item.output);
					messages.push({
						role: Raw.ChatRole.Tool,
						content,
						toolCallId: item.call_id
					});
					break;
				}
				case 'reasoning':
					// We can't perfectly reconstruct the original thinking data
					// but we can add a placeholder for logging
					flushPendingFunctionCalls();
					messages.push({
						role: Raw.ChatRole.Assistant,
						content: [{
							type: Raw.ChatCompletionContentPartKind.Text,
							text: `Reasoning summary: ${item.summary.map(s => s.text).join('\n\n')}`
						}]
					});
					break;
			}
		}
	}

	// Flush any remaining function calls at the end
	if (pendingFunctionCalls.length > 0) {
		messages.push({
			role: Raw.ChatRole.Assistant,
			content: [],
			toolCalls: pendingFunctionCalls.splice(0)
		});
	}

	return messages;
}

function isResponseOutputMessage(item: OpenAI.Responses.ResponseInputItem): item is OpenAI.Responses.ResponseOutputMessage {
	return 'role' in item && item.role === 'assistant' && 'type' in item && item.type === 'message' && 'content' in item && Array.isArray(item.content);
}

function isResponseInputItemMessage(item: OpenAI.Responses.ResponseInputItem): item is OpenAI.Responses.ResponseInputItem.Message {
	return 'role' in item && item.role === 'assistant' && (!('type' in item) || item.type !== 'message');
}

function ensureContentArray(content: string | OpenAI.Responses.ResponseInputMessageContentList): OpenAI.Responses.ResponseInputMessageContentList {
	if (typeof content === 'string') {
		return [{ type: 'input_text', text: content }];
	}
	return content;
}

function responseContentToRawContent(part: OpenAI.Responses.ResponseInputContent | OpenAI.Responses.ResponseFunctionCallOutputItem): Raw.ChatCompletionContentPart | undefined {
	switch (part.type) {
		case 'input_text':
			return { type: Raw.ChatCompletionContentPartKind.Text, text: part.text };
		case 'input_image':
			return {
				type: Raw.ChatCompletionContentPartKind.Image,
				imageUrl: {
					url: part.image_url || '',
					detail: part.detail === 'auto' ?
						undefined :
						(part.detail ?? undefined)
				}
			};
		case 'input_file':
			// This is a rough approximation for logging
			return {
				type: Raw.ChatCompletionContentPartKind.Opaque,
				value: `[File Input - Filename: ${part.filename || 'unknown'}]`
			};
	}
}

function responseOutputToRawContent(part: OpenAI.Responses.ResponseOutputText | OpenAI.Responses.ResponseOutputRefusal): Raw.ChatCompletionContentPart | undefined {
	switch (part.type) {
		case 'output_text':
			return { type: Raw.ChatCompletionContentPartKind.Text, text: part.text };
		case 'refusal':
			return { type: Raw.ChatCompletionContentPartKind.Text, text: `[Refusal: ${part.refusal}]` };
	}
}

function responseFunctionOutputToRawContents(output: string | OpenAI.Responses.ResponseFunctionCallOutputItemList): Raw.ChatCompletionContentPart[] {
	if (typeof output === 'string') {
		return [{ type: Raw.ChatCompletionContentPartKind.Text, text: output }];
	}
	return coalesce(output.map(responseContentToRawContent));
}

export async function processResponseFromChatEndpoint(instantiationService: IInstantiationService, telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData): Promise<AsyncIterableObject<ChatCompletion>> {
	return new AsyncIterableObject<ChatCompletion>(async feed => {
		const requestId = response.headers.get('X-Request-ID') ?? generateUuid();
		const ghRequestId = response.headers.get('x-github-request-id') ?? '';
		const processor = instantiationService.createInstance(OpenAIResponsesProcessor, telemetryData, requestId, ghRequestId);
		const parser = new SSEParser((ev) => {
			try {
				logService.trace(`SSE: ${ev.data}`);
				const completion = processor.push({ type: ev.type, ...JSON.parse(ev.data) }, finishCallback);
				if (completion) {
					sendCompletionOutputTelemetry(telemetryService, logService, completion, telemetryData);
					feed.emitOne(completion);
				}
			} catch (e) {
				feed.reject(e);
			}
		});

		for await (const chunk of response.body) {
			parser.feed(chunk);
		}
	}, async () => {
		await response.body.destroy();
	});
}

export function sendCompletionOutputTelemetry(telemetryService: ITelemetryService, logService: ILogService, completion: ChatCompletion, telemetryData: TelemetryData): void {
	const telemetryMessage = rawMessageToCAPI(completion.message);
	let telemetryDataWithUsage = telemetryData;
	if (completion.usage) {
		telemetryDataWithUsage = telemetryData.extendedBy({}, {
			promptTokens: completion.usage.prompt_tokens,
			completionTokens: completion.usage.completion_tokens,
			totalTokens: completion.usage.total_tokens,
		});
	}
	sendEngineMessagesTelemetry(telemetryService, [telemetryMessage], telemetryDataWithUsage, true, logService);
}

interface CapiResponsesTextDeltaEvent extends Omit<OpenAI.Responses.ResponseTextDeltaEvent, 'logprobs'> {
	logprobs: Array<OpenAI.Responses.ResponseTextDeltaEvent.Logprob> | undefined;
}

export class OpenAIResponsesProcessor {
	private textAccumulator: string = '';
	private hasReceivedReasoningSummary = false;
	/** Maps output_index to { name, callId, arguments } for streaming tool call updates */
	private readonly toolCallInfo = new Map<number, { name: string; callId: string; arguments: string }>();

	constructor(
		private readonly telemetryData: TelemetryData,
		private readonly requestId: string,
		private readonly ghRequestId: string,
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
					this.toolCallInfo.set(chunk.output_index, { name: chunk.item.name, callId: chunk.item.call_id, arguments: '' });
					onProgress({
						text: '',
						beginToolCalls: [{ name: chunk.item.name, id: chunk.item.call_id }]
					});
				} else if (chunk.item.type.toString() === 'tool_search_call') {
					const tsItem = chunk.item as unknown as ResponsesToolSearchCall;
					if (tsItem.execution === 'client' && tsItem.call_id) {
						// Client-executed tool search: treat as a regular tool call so our ToolSearchTool handles it.
						// Use CUSTOM_TOOL_SEARCH_NAME ('tool_search') as the name so VS Code invokes ToolSearchTool.
						this.toolCallInfo.set(chunk.output_index, { name: CUSTOM_TOOL_SEARCH_NAME, callId: tsItem.call_id, arguments: '' });
						onProgress({
							text: '',
							beginToolCalls: [{ name: CUSTOM_TOOL_SEARCH_NAME, id: tsItem.call_id }]
						});
					} else {
						// Server-hosted tool search: just log it
						onProgress({
							text: '',
							serverToolCalls: [{ isServer: true, name: 'tool_search', id: tsItem.id ?? '' }]
						});
					}
				}
				return;
			case 'response.function_call_arguments.delta': {
				const info = this.toolCallInfo.get(chunk.output_index);
				if (info) {
					info.arguments += chunk.delta;
					onProgress({
						text: '',
						copilotToolCallStreamUpdates: [{
							id: info.callId,
							name: info.name,
							arguments: info.arguments,
						}],
					});
				}
				return;
			}
			case 'response.output_item.done':
				if (chunk.item.type.toString() === openAIContextManagementCompactionType) {
					const compactionItem = chunk.item as unknown as OpenAIContextManagementResponse;
					return onProgress({
						text: '',
						contextManagement: {
							type: openAIContextManagementCompactionType,
							id: compactionItem.id,
							encrypted_content: compactionItem.encrypted_content,
						}
					});
				}
				if (chunk.item.type === 'function_call') {
					this.toolCallInfo.delete(chunk.output_index);
					onProgress({
						text: '',
						copilotToolCalls: [{
							id: chunk.item.call_id,
							name: chunk.item.name,
							arguments: chunk.item.arguments,
						}],
						phase: (chunk.item as ResponseOutputItemWithPhase).phase
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
				} else if (chunk.item.type === 'message') {
					onProgress({
						text: '',
						phase: (chunk.item as ResponseOutputItemWithPhase).phase
					});
				} else if (chunk.item.type.toString() === 'tool_search_call') {
					const tsCall = chunk.item as unknown as ResponsesToolSearchCall;
					if (tsCall.execution === 'client' && tsCall.call_id) {
						// Client-executed tool search completed: emit as a completed copilotToolCall
						// so VS Code invokes ToolSearchTool and returns results.
						this.toolCallInfo.delete(chunk.output_index);
						onProgress({
							text: '',
							copilotToolCalls: [{
								id: tsCall.call_id,
								name: CUSTOM_TOOL_SEARCH_NAME,
								arguments: JSON.stringify(tsCall.arguments ?? {}),
							}],
						});
					} else {
						// Server-mode: just log it
						onProgress({
							text: '',
							serverToolCalls: [{
								isServer: true,
								name: 'tool_search',
								id: tsCall.id ?? '',
								args: tsCall.arguments,
							}]
						});
					}
				} else if (chunk.item.type.toString() === 'tool_search_output') {
					// Tool search output — the model loaded deferred tools
					const tsOutput = chunk.item as unknown as ResponsesToolSearchOutput;
					onProgress({
						text: '',
						serverToolCalls: [{
							isServer: true,
							name: 'tool_search_output',
							id: tsOutput.id ?? '',
							result: { tools: tsOutput.tools },
						}]
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
					model: chunk.response.model,
					tokens: [],
					telemetryData: this.telemetryData,
					requestId: { headerRequestId: this.requestId, gitHubRequestId: this.ghRequestId, completionId: chunk.response.id, created: chunk.response.created_at, deploymentId: '', serverExperiments: '' },
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
