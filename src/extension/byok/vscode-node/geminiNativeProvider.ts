/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GenerateContentParameters, GoogleGenAI, Tool, Type } from '@google/genai';
import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage } from '../../../platform/networking/common/openai';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { toErrorMessage } from '../../../util/common/errorMessage';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { BYOKAuthType, BYOKKnownModels, byokKnownModelsToAPIInfo, BYOKModelCapabilities, BYOKModelProvider, handleAPIKeyUpdate, LMResponsePart } from '../common/byokProvider';
import { toGeminiFunction as toGeminiFunctionDeclaration, ToolJsonSchema } from '../common/geminiFunctionDeclarationConverter';
import { apiMessageToGeminiMessage, geminiMessagesToRawMessagesForLogging } from '../common/geminiMessageConverter';
import { IBYOKStorageService } from './byokStorageService';
import { promptForAPIKey } from './byokUIService';

export class GeminiNativeBYOKLMProvider implements BYOKModelProvider<LanguageModelChatInformation> {
	public static readonly providerName = 'Gemini';
	public readonly authType: BYOKAuthType = BYOKAuthType.GlobalApiKey;
	private _genAIClient: GoogleGenAI | undefined;
	private _genAIClientApiKey: string | undefined;
	private _apiKey: string | undefined;

	constructor(
		private readonly _knownModels: BYOKKnownModels | undefined,
		private readonly _byokStorageService: IBYOKStorageService,
		@ILogService private readonly _logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger
	) { }

	private async _getOrReadApiKey(): Promise<string | undefined> {
		if (!this._apiKey) {
			this._apiKey = await this._byokStorageService.getAPIKey(GeminiNativeBYOKLMProvider.providerName);
		}
		return this._apiKey;
	}

	private _ensureClient(apiKey: string): GoogleGenAI {
		if (!this._genAIClient || this._genAIClientApiKey !== apiKey) {
			this._genAIClient = new GoogleGenAI({ apiKey });
			this._genAIClientApiKey = apiKey;
		}
		return this._genAIClient;
	}

	private async getAllModels(apiKey: string): Promise<BYOKKnownModels> {
		const client = this._ensureClient(apiKey);
		try {
			const models = await client.models.list();
			const modelList: Record<string, BYOKModelCapabilities> = {};

			for await (const model of models) {
				const modelId = model.name;
				if (!modelId) {
					continue; // Skip models without names
				}

				// Enable only known models.
				if (this._knownModels && this._knownModels[modelId]) {
					modelList[modelId] = this._knownModels[modelId];
				}
			}
			return modelList;
		} catch (error) {
			this._logService.error(error, `Error fetching available ${GeminiNativeBYOKLMProvider.providerName} models`);
			throw new Error(toErrorMessage(error, true));
		}
	}

	async updateAPIKey(): Promise<void> {
		const result = await handleAPIKeyUpdate(GeminiNativeBYOKLMProvider.providerName, this._byokStorageService, promptForAPIKey);
		if (result.cancelled) {
			return;
		}

		this._apiKey = result.apiKey;
		if (this._apiKey) {
			this._ensureClient(this._apiKey);
		} else {
			this._genAIClient = undefined;
			this._genAIClientApiKey = undefined;
		}
	}

	async provideLanguageModelChatInformation(options: { silent: boolean }, token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		if (!this._apiKey) { // If we don't have the API key it might just be in storage, so we try to read it first
			const storedKey = await this._byokStorageService.getAPIKey(GeminiNativeBYOKLMProvider.providerName);
			// Normalize empty strings to undefined - the || undefined ensures that if trim() returns an empty string,
			// we store undefined instead, so subsequent if (this._apiKey) checks treat it as "no key"
			this._apiKey = storedKey?.trim() || undefined;
		}
		try {
			if (this._apiKey) {
				return byokKnownModelsToAPIInfo(GeminiNativeBYOKLMProvider.providerName, await this.getAllModels(this._apiKey));
			} else if (options.silent && !this._apiKey) {
				return [];
			} else { // Not silent, and no api key = good to prompt user for api key
				await this.updateAPIKey();
				if (this._apiKey) {
					return byokKnownModelsToAPIInfo(GeminiNativeBYOKLMProvider.providerName, await this.getAllModels(this._apiKey));
				} else {
					return [];
				}
			}
		} catch {
			return [];
		}
	}

	async provideLanguageModelChatResponse(model: LanguageModelChatInformation, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		const apiKey = await this._getOrReadApiKey();
		if (!apiKey) {
			this._logService.error(`BYOK: No API key configured for provider ${GeminiNativeBYOKLMProvider.providerName}`);
			throw new Error(`BYOK: No API key configured for provider ${GeminiNativeBYOKLMProvider.providerName}. Use the Copilot "Manage BYOK" command to add one.`);
		}
		this._ensureClient(apiKey);

		// Convert the messages from the API format into messages that we can use against Gemini
		const { contents, systemInstruction } = apiMessageToGeminiMessage(messages as LanguageModelChatMessage[]);

		const requestId = generateUuid();
		const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
			'GeminiNativeBYOK',
			{
				model: model.id,
				modelMaxPromptTokens: model.maxInputTokens,
				urlOrRequestMetadata: 'https://generativelanguage.googleapis.com',
			},
			{
				model: model.id,
				messages: geminiMessagesToRawMessagesForLogging(contents, systemInstruction),
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
				}
			});

		// Convert VS Code tools to Gemini function declarations
		const tools: Tool[] = (options.tools ?? []).length > 0 ? [{
			functionDeclarations: (options.tools ?? []).map(tool => {
				if (!tool.inputSchema) {
					return {
						name: tool.name,
						description: tool.description,
						parameters: {
							type: Type.OBJECT,
							properties: {},
							required: []
						}
					};
				}

				// Transform the input schema to match Gemini's expectations
				const finalTool = toGeminiFunctionDeclaration(tool.name, tool.description, tool.inputSchema as ToolJsonSchema);
				finalTool.description = tool.description || finalTool.description;
				return finalTool;
			})
		}] : [];

		// Bridge VS Code cancellation token to Gemini abortSignal for early network termination
		const abortController = new AbortController();
		const cancelSub = token.onCancellationRequested(() => {
			abortController.abort();
			this._logService.trace('Gemini request aborted via VS Code cancellation token');
		});

		const params: GenerateContentParameters = {
			model: model.id,
			contents: contents,
			config: {
				systemInstruction: systemInstruction,
				tools: tools.length > 0 ? tools : undefined,
				maxOutputTokens: model.maxOutputTokens,
				thinkingConfig: {
					includeThoughts: true,
				},
				abortSignal: abortController.signal
			}
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
				resolvedModel: model.id,
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
			this._logService.error(`BYOK GeminiNative error: ${toErrorMessage(err, true)}`);
			pendingLoggedChatRequest.resolve({
				type: token.isCancellationRequested ? ChatFetchResponseType.Canceled : ChatFetchResponseType.Unknown,
				requestId,
				serverRequestId: requestId,
				reason: token.isCancellationRequested ? 'cancelled' : toErrorMessage(err)
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
		} finally {
			cancelSub.dispose();
		}
	}

	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		// Simple estimation for approximate token count - actual token count would require Gemini's tokenizer
		return Math.ceil(text.toString().length / 4);
	}

	private async _makeRequest(progress: Progress<LMResponsePart>, params: GenerateContentParameters, token: CancellationToken): Promise<{ ttft: number | undefined; usage: APIUsage | undefined }> {
		if (!this._genAIClient) {
			throw new Error('Gemini client is not initialized');
		}

		const start = Date.now();
		let ttft: number | undefined;

		try {
			const stream = await this._genAIClient.models.generateContentStream(params);

			let usage: APIUsage | undefined;
			let pendingThinkingSignature: string | undefined;

			for await (const chunk of stream) {
				if (token.isCancellationRequested) {
					break;
				}

				if (ttft === undefined) {
					ttft = Date.now() - start;
				}

				this._logService.trace(`Gemini chunk: ${JSON.stringify(chunk)}`);

				// Process the streaming response chunks
				if (chunk.candidates && chunk.candidates.length > 0) {
					// choose the primary candidate
					const candidate = chunk.candidates[0];

					if (candidate.content && candidate.content.parts) {
						for (const part of candidate.content.parts) {
							// First, capture thought signature from this part (if present)
							if ('thoughtSignature' in part && part.thoughtSignature) {
								pendingThinkingSignature = part.thoughtSignature as string;
							}
							// Now handle the actual content parts
							if ('thought' in part && part.thought === true && part.text) {
								// Handle thinking/reasoning content from Gemini API
								progress.report(new LanguageModelThinkingPart(part.text));
							} else if (part.text) {
								progress.report(new LanguageModelTextPart(part.text));
							} else if (part.functionCall && part.functionCall.name) {
								// Gemini 3 includes thought signatures for function calling
								// If we have a pending signature, emit it as a thinking part with metadata.signature
								if (pendingThinkingSignature) {
									const thinkingPart = new LanguageModelThinkingPart('', undefined, { signature: pendingThinkingSignature });
									progress.report(thinkingPart);
									pendingThinkingSignature = undefined;
								}

								progress.report(new LanguageModelToolCallPart(
									generateUuid(),
									part.functionCall.name,
									part.functionCall.args || {}
								));
							}
						}
					}
				}

				// Extract usage information if available in the chunk
				if (chunk.usageMetadata) {
					const promptTokens = chunk.usageMetadata.promptTokenCount || -1;
					const completionTokens = chunk.usageMetadata.candidatesTokenCount || -1;

					usage = {
						// Use -1 as a sentinel value to indicate that the token count is unavailable
						completion_tokens: completionTokens,
						prompt_tokens: promptTokens,
						total_tokens: chunk.usageMetadata.totalTokenCount ||
							(promptTokens !== -1 && completionTokens !== -1 ? promptTokens + completionTokens : -1),
						prompt_tokens_details: {
							cached_tokens: chunk.usageMetadata.cachedContentTokenCount || 0,
						}
					};
				}
			}

			return { ttft, usage };
		} catch (error) {
			if ((error as any)?.name === 'AbortError' || token.isCancellationRequested) {
				this._logService.trace('Gemini streaming aborted');
				return { ttft, usage: undefined };
			}
			this._logService.error(`Gemini streaming error: ${toErrorMessage(error, true)}`);
			throw error;
		}
	}
}