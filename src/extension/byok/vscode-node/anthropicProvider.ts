/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelDataPart, LanguageModelResponsePart2, LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { CustomDataPartMimeTypes } from '../../../platform/endpoint/common/endpointTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { ContextManagementResponse, getContextManagementFromConfig, isAnthropicContextEditingEnabled, isAnthropicToolSearchEnabled, nonDeferredToolNames, TOOL_SEARCH_TOOL_NAME, TOOL_SEARCH_TOOL_TYPE, ToolSearchToolResult, ToolSearchToolSearchResult } from '../../../platform/networking/common/anthropic';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage } from '../../../platform/networking/common/openai';
import { IRequestLogger, retrieveCapturingTokenByCorrelation, runWithCapturingToken } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { toErrorMessage } from '../../../util/common/errorMessage';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { anthropicMessagesToRawMessagesForLogging, apiMessageToAnthropicMessage } from '../common/anthropicMessageConverter';
import { BYOKKnownModels, byokKnownModelsToAPIInfo, BYOKModelCapabilities, LMResponsePart } from '../common/byokProvider';
import { AbstractLanguageModelChatProvider, ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

export class AnthropicLMProvider extends AbstractLanguageModelChatProvider {

	public static readonly providerName = 'Anthropic';

	constructor(
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@ILogService logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService
	) {
		super(AnthropicLMProvider.providerName.toLowerCase(), AnthropicLMProvider.providerName, knownModels, byokStorageService, logService);

	}

	private _getThinkingBudget(modelId: string, maxOutputTokens: number): number | undefined {
		const configuredBudget = this._configurationService.getExperimentBasedConfig(ConfigKey.AnthropicThinkingBudget, this._experimentationService);
		if (!configuredBudget || configuredBudget === 0) {
			return undefined;
		}

		const modelCapabilities = this._knownModels?.[modelId];
		const modelSupportsThinking = modelCapabilities?.thinking ?? false;
		if (!modelSupportsThinking) {
			return undefined;
		}
		const normalizedBudget = configuredBudget < 1024 ? 1024 : configuredBudget;
		return Math.min(32000, maxOutputTokens - 1, normalizedBudget);
	}

	// Filters the byok known models based on what the anthropic API knows as well
	protected async getAllModels(silent: boolean, apiKey: string | undefined): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		if (!apiKey && silent) {
			return [];
		}

		try {
			const response = await new Anthropic({ apiKey }).models.list();
			const modelList: Record<string, BYOKModelCapabilities> = {};
			for (const model of response.data) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList[model.id] = this._knownModels[model.id];
				} else {
					// Mix in generic capabilities for models we don't know
					modelList[model.id] = {
						maxInputTokens: 100000,
						maxOutputTokens: 16000,
						name: model.display_name,
						toolCalling: true,
						vision: false,
						thinking: false
					};
				}
			}
			return byokKnownModelsToAPIInfo(this._name, modelList);
		} catch (error) {
			this._logService.error(error, `Error fetching available ${AnthropicLMProvider.providerName} models`);
			throw new Error(error.message ? error.message : error);
		}
	}

	async provideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		// Restore CapturingToken context if correlation ID was passed through modelOptions.
		// This handles the case where AsyncLocalStorage context was lost crossing VS Code IPC.
		const correlationId = (options as { modelOptions?: { _capturingTokenCorrelationId?: string } }).modelOptions?._capturingTokenCorrelationId;
		const capturingToken = correlationId ? retrieveCapturingTokenByCorrelation(correlationId) : undefined;

		const doRequest = async () => {
			const issuedTime = Date.now();
			const apiKey = model.configuration?.apiKey;
			if (!apiKey) {
				throw new Error('API key not found for the model');
			}

			const anthropicClient = new Anthropic({ apiKey });

			// Convert the messages from the API format into messages that we can use against anthropic
			const { system, messages: convertedMessages } = apiMessageToAnthropicMessage(messages as LanguageModelChatMessage[]);

			const requestId = generateUuid();
			const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
				'AnthropicBYOK',
				{
					model: model.id,
					modelMaxPromptTokens: model.maxInputTokens,
					urlOrRequestMetadata: anthropicClient.baseURL,
				},
				{
					model: model.id,
					messages: anthropicMessagesToRawMessagesForLogging(convertedMessages, system),
					ourRequestId: requestId,
					location: ChatLocation.Other,
					body: {
						tools: options.tools?.map((tool): OpenAiFunctionTool => ({
							type: 'function',
							function: {
								name: tool.name,
								description: tool.description,
								parameters: tool.inputSchema
							}
						}))
					},
				});

			let hasMemoryTool = false;

			const toolSearchEnabled = isAnthropicToolSearchEnabled(model.id, this._configurationService, this._experimentationService);

			// Build tools array, handling both standard tools and native Anthropic tools
			const tools: Anthropic.Beta.BetaToolUnion[] = [];

			// Add tool search tool if enabled (must be first in the array)
			if (toolSearchEnabled) {
				tools.push({
					name: TOOL_SEARCH_TOOL_NAME,
					type: TOOL_SEARCH_TOOL_TYPE,
					defer_loading: false
				} as Anthropic.Beta.BetaToolUnion);
			}

			for (const tool of (options.tools ?? [])) {
				// Handle native Anthropic memory tool
				if (tool.name === 'memory') {
					hasMemoryTool = true;
					tools.push({
						name: 'memory',
						type: 'memory_20250818'
					} as Anthropic.Beta.BetaMemoryTool20250818);
					continue;
				}

				// Mark tools for deferred loading when tool search is enabled, except for frequently used tools
				const shouldDefer = toolSearchEnabled ? !nonDeferredToolNames.has(tool.name) : undefined;

				if (!tool.inputSchema) {
					tools.push({
						name: tool.name,
						description: tool.description,
						input_schema: {
							type: 'object',
							properties: {},
							required: []
						},
						...(shouldDefer ? { defer_loading: shouldDefer } : {})
					});
					continue;
				}

				tools.push({
					name: tool.name,
					description: tool.description,
					input_schema: {
						type: 'object',
						properties: (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
						required: (tool.inputSchema as { required?: string[] }).required ?? [],
						$schema: (tool.inputSchema as { $schema?: unknown }).$schema
					},
					...(shouldDefer ? { defer_loading: shouldDefer } : {})
				});
			}

			// Check if web search is enabled and append web_search tool if not already present.
			// We need to do this because there is no local web_search tool definition we can replace.
			const webSearchEnabled = this._configurationService.getExperimentBasedConfig(ConfigKey.AnthropicWebSearchToolEnabled, this._experimentationService);
			if (webSearchEnabled && !tools.some(tool => 'name' in tool && tool.name === 'web_search')) {
				const maxUses = this._configurationService.getConfig(ConfigKey.AnthropicWebSearchMaxUses);
				const allowedDomains = this._configurationService.getConfig(ConfigKey.AnthropicWebSearchAllowedDomains);
				const blockedDomains = this._configurationService.getConfig(ConfigKey.AnthropicWebSearchBlockedDomains);
				const userLocation = this._configurationService.getConfig(ConfigKey.AnthropicWebSearchUserLocation);
				const shouldDeferWebSearch = toolSearchEnabled ? !nonDeferredToolNames.has('web_search') : undefined;

				const webSearchTool: Anthropic.Beta.BetaWebSearchTool20250305 = {
					name: 'web_search',
					type: 'web_search_20250305',
					max_uses: maxUses,
					...(shouldDeferWebSearch ? { defer_loading: shouldDeferWebSearch } : {})
				};

				// Add domain filtering if configured
				// Cannot use both allowed and blocked domains simultaneously
				if (allowedDomains && allowedDomains.length > 0) {
					webSearchTool.allowed_domains = allowedDomains;
				} else if (blockedDomains && blockedDomains.length > 0) {
					webSearchTool.blocked_domains = blockedDomains;
				}

				// Add user location if configured
				// Note: All fields are optional according to Anthropic docs
				if (userLocation && (userLocation.city || userLocation.region || userLocation.country || userLocation.timezone)) {
					webSearchTool.user_location = {
						type: 'approximate',
						...userLocation
					};
				}

				tools.push(webSearchTool);
			}

			const thinkingBudget = this._getThinkingBudget(model.id, model.maxOutputTokens);

			// Check if model supports adaptive thinking
			const modelCapabilities = this._knownModels?.[model.id];
			const supportsAdaptiveThinking = modelCapabilities?.adaptiveThinking ?? false;

			// Build context management configuration
			const thinkingEnabled = supportsAdaptiveThinking || (thinkingBudget ?? 0) > 0;
			const contextManagement = isAnthropicContextEditingEnabled(model.id, this._configurationService, this._experimentationService) ? getContextManagementFromConfig(
				this._configurationService,
				thinkingEnabled
			) : undefined;

			// Build betas array for beta API features (adaptive thinking doesn't need interleaved-thinking beta)
			const betas: string[] = [];
			if (thinkingBudget && !supportsAdaptiveThinking) {
				betas.push('interleaved-thinking-2025-05-14');
			}
			if (hasMemoryTool || contextManagement) {
				betas.push('context-management-2025-06-27');
			}
			if (toolSearchEnabled) {
				betas.push('advanced-tool-use-2025-11-20');
			}

			const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
				model: model.id,
				messages: convertedMessages,
				max_tokens: model.maxOutputTokens,
				stream: true,
				system: [system],
				tools: tools.length > 0 ? tools : undefined,
				thinking: supportsAdaptiveThinking
					? { type: 'adaptive' as any }
					: thinkingBudget ? { type: 'enabled' as const, budget_tokens: thinkingBudget } : undefined,
				context_management: contextManagement as Anthropic.Beta.Messages.BetaContextManagementConfig | undefined,
			};

			const wrappedProgress = new RecordedProgress(progress);

			try {
				const result = await this._makeRequest(anthropicClient, wrappedProgress, params, betas, token, issuedTime);
				if (result.ttft) {
					pendingLoggedChatRequest.markTimeToFirstToken(result.ttft);
				}
				const responseDeltas: IResponseDelta[] = wrappedProgress.items.map((i): IResponseDelta => {
					if (i instanceof LanguageModelTextPart) {
						return { text: i.value };
					} else if (i instanceof LanguageModelToolCallPart) {
						return {
							text: '',
							copilotToolCalls: [{
								name: i.name,
								arguments: JSON.stringify(i.input),
								id: i.callId
							}]
						};
					} else if (i instanceof LanguageModelToolResultPart) {
						// Handle tool results - extract text from content
						const resultText = i.content.map(c => c instanceof LanguageModelTextPart ? c.value : '').join('');
						return {
							text: `[Tool Result ${i.callId}]: ${resultText}`
						};
					} else {
						return { text: '' };
					}
				});
				// TODO: @bhavyaus - Add telemetry tracking for context editing (contextEditingApplied, contextEditingClearedTokens, contextEditingEditCount) like messagesApi.ts does
				if (result.contextManagement) {
					responseDeltas.push({
						text: '',
						contextManagement: result.contextManagement
					});
				}
				pendingLoggedChatRequest.resolve({
					type: ChatFetchResponseType.Success,
					requestId,
					serverRequestId: requestId,
					usage: result.usage,
					value: ['value'],
					resolvedModel: model.id
				}, responseDeltas);

				// Send success telemetry matching response.success format
				/* __GDPR__
					"response.success" : {
						"owner": "lramos15",
						"comment": "Report quality details for a successful BYOK Anthropic response.",
						"source": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Source of the initial request" },
						"model": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model selection for the response" },
						"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the current turn request" },
						"totalTokenMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum total token window", "isMeasurement": true },
						"tokenCountMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum generated tokens", "isMeasurement": true },
						"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens, server side counted", "isMeasurement": true },
						"promptCacheTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens hitting cache as reported by server", "isMeasurement": true },
						"tokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of generated tokens", "isMeasurement": true },
						"completionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the output", "isMeasurement": true },
						"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
						"timeToFirstTokenEmitted": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token emitted (visible text)", "isMeasurement": true },
						"timeToComplete": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to complete the request", "isMeasurement": true },
						"issuedTime": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Timestamp when the request was issued", "isMeasurement": true },
						"isBYOK": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for a BYOK model", "isMeasurement": true }
					}
				*/
				this._telemetryService.sendTelemetryEvent('response.success', { github: true, microsoft: true }, {
					source: 'byok.anthropic',
					model: model.id,
					requestId,
				}, {
					totalTokenMax: model.maxInputTokens ?? -1,
					tokenCountMax: model.maxOutputTokens ?? -1,
					promptTokenCount: result.usage?.prompt_tokens,
					promptCacheTokenCount: result.usage?.prompt_tokens_details?.cached_tokens,
					tokenCount: result.usage?.total_tokens,
					completionTokens: result.usage?.completion_tokens,
					timeToFirstToken: result.ttft,
					timeToFirstTokenEmitted: result.ttfte,
					timeToComplete: Date.now() - issuedTime,
					issuedTime,
					isBYOK: 1,
				});
			} catch (err) {
				this._logService.error(`BYOK Anthropic error: ${toErrorMessage(err, true)}`);
				pendingLoggedChatRequest.resolve({
					type: ChatFetchResponseType.Unknown,
					requestId,
					serverRequestId: requestId,
					reason: err.message
				}, wrappedProgress.items.map((i): IResponseDelta => {
					if (i instanceof LanguageModelTextPart) {
						return { text: i.value };
					} else if (i instanceof LanguageModelToolCallPart) {
						return {
							text: '',
							copilotToolCalls: [{
								name: i.name,
								arguments: JSON.stringify(i.input),
								id: i.callId
							}]
						};
					} else if (i instanceof LanguageModelToolResultPart) {
						// Handle tool results - extract text from content
						const resultText = i.content.map(c => c instanceof LanguageModelTextPart ? c.value : '').join('');
						return {
							text: `[Tool Result ${i.callId}]: ${resultText}`
						};
					} else {
						return { text: '' };
					}
				}));
				throw err;
			}
		};

		// Execute with restored CapturingToken context if available
		if (capturingToken) {
			return runWithCapturingToken(capturingToken, doRequest);
		}
		return doRequest();
	}

	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		// Simple estimation - actual token count would require Claude's tokenizer
		return Math.ceil(text.toString().length / 4);
	}

	private async _makeRequest(anthropicClient: Anthropic, progress: RecordedProgress<LMResponsePart>, params: Anthropic.Beta.Messages.MessageCreateParamsStreaming, betas: string[], token: CancellationToken, issuedTime: number): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined; contextManagement: ContextManagementResponse | undefined }> {
		const start = Date.now();
		let ttft: number | undefined;
		let ttfte: number | undefined;

		const stream = await anthropicClient.beta.messages.create({
			...params,
			...(betas.length > 0 && { betas })
		});

		let pendingToolCall: {
			toolId?: string;
			name?: string;
			jsonInput?: string;
		} | undefined;
		let pendingThinking: {
			thinking?: string;
			signature?: string;
		} | undefined;
		let pendingRedactedThinking: {
			data: string;
		} | undefined;
		let pendingServerToolCall: {
			toolId?: string;
			name?: string;
			jsonInput?: string;
			type?: string;
		} | undefined;
		let usage: APIUsage | undefined;
		let contextManagementResponse: ContextManagementResponse | undefined;

		let hasText = false;
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
					pendingToolCall = {
						toolId: chunk.content_block.id,
						name: chunk.content_block.name,
						jsonInput: ''
					};
				} else if ('content_block' in chunk && chunk.content_block.type === 'server_tool_use') {
					// Handle server-side tool use (e.g., web_search)
					pendingServerToolCall = {
						toolId: chunk.content_block.id,
						name: chunk.content_block.name,
						jsonInput: '',
						type: chunk.content_block.name
					};
					progress.report(new LanguageModelTextPart('\n'));

				} else if ('content_block' in chunk && chunk.content_block.type === 'thinking') {
					pendingThinking = {
						thinking: '',
						signature: ''
					};
				} else if ('content_block' in chunk && chunk.content_block.type === 'redacted_thinking') {
					const redactedBlock = chunk.content_block as Anthropic.Messages.RedactedThinkingBlock;
					pendingRedactedThinking = {
						data: redactedBlock.data
					};
				} else if ('content_block' in chunk && chunk.content_block.type === 'web_search_tool_result') {
					if (!pendingServerToolCall || !pendingServerToolCall.toolId) {
						continue;
					}

					const resultBlock = chunk.content_block as Anthropic.Messages.WebSearchToolResultBlock;
					// Handle potential error in web search
					if (!Array.isArray(resultBlock.content)) {
						this._logService.error(`Web search error: ${(resultBlock.content as Anthropic.Messages.WebSearchToolResultError).error_code}`);
						continue;
					}

					const results = resultBlock.content.map((result: Anthropic.Messages.WebSearchResultBlock) => ({
						type: 'web_search_result',
						url: result.url,
						title: result.title,
						page_age: result.page_age,
						encrypted_content: result.encrypted_content
					}));

					// Format according to Anthropic's web_search_tool_result specification
					const toolResult = {
						type: 'web_search_tool_result',
						tool_use_id: pendingServerToolCall.toolId,
						content: results
					};

					const searchResults = JSON.stringify(toolResult, null, 2);

					// TODO: @bhavyaus - instead of just pushing text, create a specialized WebSearchResult part
					progress.report(new LanguageModelToolResultPart(
						pendingServerToolCall.toolId!,
						[new LanguageModelTextPart(searchResults)]
					));
					pendingServerToolCall = undefined;
				} else if ('content_block' in chunk && chunk.content_block.type === 'tool_search_tool_result') {
					const toolSearchResult = chunk.content_block as unknown as ToolSearchToolResult;
					if (toolSearchResult.content.type === 'tool_search_tool_search_result') {
						const searchResult = toolSearchResult.content as ToolSearchToolSearchResult;
						const toolNames = searchResult.tool_references.map(ref => ref.tool_name);

						this._logService.trace(`Tool search discovered ${toolNames.length} tools: ${toolNames.join(', ')}`);

						let query: string | undefined;
						if (pendingServerToolCall) {
							try {
								const parsed = JSON.parse(pendingServerToolCall.jsonInput || '{}');
								query = parsed.query;
							} catch {
								// Ignore parse errors
							}
						}

						progress.report(new LanguageModelToolResultPart(
							toolSearchResult.tool_use_id,
							[new LanguageModelTextPart(JSON.stringify({ query, discovered_tools: toolNames }))]
						));
						pendingServerToolCall = undefined;
					} else if (toolSearchResult.content.type === 'tool_search_tool_result_error') {
						this._logService.warn(`Tool search error: ${toolSearchResult.content.error_code}`);
						pendingServerToolCall = undefined;
					}
				}
				continue;
			}

			if (chunk.type === 'content_block_delta') {
				if (chunk.delta.type === 'text_delta') {
					progress.report(new LanguageModelTextPart(chunk.delta.text || ''));
					if (!hasText && chunk.delta.text?.length > 0) {
						ttfte = Date.now() - issuedTime;
					}
					hasText ||= chunk.delta.text?.length > 0;
				} else if (chunk.delta.type === 'citations_delta') {
					if ('citation' in chunk.delta) {
						// TODO: @bhavyaus - instead of just pushing text, create a specialized Citation part
						const citation = chunk.delta.citation as Anthropic.Messages.CitationsWebSearchResultLocation;
						if (citation.type === 'web_search_result_location') {
							// Format citation according to Anthropic specification
							const citationData = {
								type: 'web_search_result_location',
								url: citation.url,
								title: citation.title,
								encrypted_index: citation.encrypted_index,
								cited_text: citation.cited_text
							};

							// Format citation as readable blockquote with source link
							const referenceText = `\n> "${citation.cited_text}" — [${vscode.l10n.t('Source')}](${citation.url})\n\n`;

							// Report formatted reference text to user
							progress.report(new LanguageModelTextPart(referenceText));

							// Store the citation data in the correct format for multi-turn conversations
							progress.report(new LanguageModelToolResultPart(
								'citation',
								[new LanguageModelTextPart(JSON.stringify(citationData, null, 2))]
							));
						}
					}
				} else if (chunk.delta.type === 'thinking_delta') {
					if (pendingThinking) {
						pendingThinking.thinking = (pendingThinking.thinking || '') + (chunk.delta.thinking || '');
						progress.report(new LanguageModelThinkingPart(chunk.delta.thinking || ''));
					}
				} else if (chunk.delta.type === 'signature_delta') {
					// Accumulate signature
					if (pendingThinking) {
						pendingThinking.signature = (pendingThinking.signature || '') + (chunk.delta.signature || '');
					}
				} else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
					pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + (chunk.delta.partial_json || '');

					try {
						// Try to parse the accumulated JSON to see if it's complete
						const parsedJson = JSON.parse(pendingToolCall.jsonInput);
						progress.report(new LanguageModelToolCallPart(
							pendingToolCall.toolId!,
							pendingToolCall.name!,
							parsedJson
						));
						pendingToolCall = undefined;
					} catch {
						// JSON is not complete yet, continue accumulating
						continue;
					}
				} else if (chunk.delta.type === 'input_json_delta' && pendingServerToolCall) {
					pendingServerToolCall.jsonInput = (pendingServerToolCall.jsonInput || '') + (chunk.delta.partial_json || '');
				}
			}

			if (chunk.type === 'content_block_stop') {
				if (pendingToolCall) {
					try {
						const parsedJson = JSON.parse(pendingToolCall.jsonInput || '{}');
						progress.report(
							new LanguageModelToolCallPart(
								pendingToolCall.toolId!,
								pendingToolCall.name!,
								parsedJson
							)
						);
					} catch (e) {
						console.error('Failed to parse tool call JSON:', e);
					}
					pendingToolCall = undefined;
				} else if (pendingThinking) {
					if (pendingThinking.signature) {
						const finalThinkingPart = new LanguageModelThinkingPart('');
						finalThinkingPart.metadata = {
							signature: pendingThinking.signature,
							_completeThinking: pendingThinking.thinking
						};
						progress.report(finalThinkingPart);
					}
					pendingThinking = undefined;
				} else if (pendingRedactedThinking) {
					pendingRedactedThinking = undefined;
				}
			}

			if (chunk.type === 'message_start') {
				// TODO final output tokens: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":46}}
				usage = {
					completion_tokens: -1,
					prompt_tokens: chunk.message.usage.input_tokens + (chunk.message.usage.cache_creation_input_tokens ?? 0) + (chunk.message.usage.cache_read_input_tokens ?? 0),
					total_tokens: -1,
					// Cast needed: Anthropic returns cache_creation_input_tokens which APIUsage.prompt_tokens_details doesn't define
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
				// Handle context management response
				if ('context_management' in chunk && chunk.context_management) {
					contextManagementResponse = chunk.context_management as ContextManagementResponse;
					const totalClearedTokens = contextManagementResponse.applied_edits.reduce(
						(sum, edit) => sum + (edit.cleared_input_tokens || 0),
						0
					);
					this._logService.info(`BYOK Anthropic context editing applied: cleared ${totalClearedTokens} tokens across ${contextManagementResponse.applied_edits.length} edits`);
					// Emit context management via LanguageModelDataPart so it flows through to toolCallingLoop
					progress.report(new LanguageModelDataPart(
						new TextEncoder().encode(JSON.stringify(contextManagementResponse)),
						CustomDataPartMimeTypes.ContextManagement
					));
				}
			}
		}

		return { ttft, ttfte, usage, contextManagement: contextManagementResponse };
	}
}
