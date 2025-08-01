/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { FetchStreamRecorder, IChatMLFetcher, IntentParams, Source } from '../../../platform/chat/common/chatMLFetcher';
import { IChatQuotaService } from '../../../platform/chat/common/chatQuotaService';
import { ChatFetchError, ChatFetchResponseType, ChatFetchRetriableError, ChatLocation, ChatResponse, ChatResponses } from '../../../platform/chat/common/commonTypes';
import { IConversationOptions } from '../../../platform/chat/common/conversationOptions';
import { getTextPart, toTextParts } from '../../../platform/chat/common/globalStringUtils';
import { IInteractionService } from '../../../platform/chat/common/interactionService';
import { ConfigKey, HARD_TOOL_LIMIT, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { ChatCompletion, FilterReason, FinishedCompletionReason, rawMessageToCAPI } from '../../../platform/networking/common/openai';
import { ChatFailKind, ChatParams, ChatRequestCanceled, ChatRequestFailed, ChatResults, fetchAndStreamChat, FetchResponseKind } from '../../../platform/openai/node/fetch';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryProperties } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { calculateLineRepetitionStats, isRepetitive } from '../../../util/common/anomalyDetection';
import * as errorsUtil from '../../../util/common/errors';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter } from '../../../util/vs/base/common/event';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { OpenAIEndpoint } from '../../byok/node/openAIEndpoint';
import { EXTENSION_ID } from '../../common/constants';

export interface IMadeChatRequestEvent {
	readonly messages: Raw.ChatMessage[];
	readonly model: string;
	readonly source?: Source;
	readonly tokenCount?: number;
}

export abstract class AbstractChatMLFetcher implements IChatMLFetcher {

	declare _serviceBrand: undefined;

	constructor(
		protected readonly options: IConversationOptions,
	) { }

	protected preparePostOptions(requestOptions: OptionalChatRequestParams): OptionalChatRequestParams {
		return {
			temperature: this.options.temperature,
			top_p: this.options.topP,
			// we disallow `stream=false` because we don't support non-streamed response
			...requestOptions,
			stream: true
		};
	}

	protected readonly _onDidMakeChatMLRequest = new Emitter<IMadeChatRequestEvent>();
	readonly onDidMakeChatMLRequest = this._onDidMakeChatMLRequest.event;

	public async fetchOne(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		endpoint: IChatEndpoint,
		source: Source,
		requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
		intentParams?: IntentParams,
	): Promise<ChatResponse> {
		const resp = await this.fetchMany(
			debugName,
			messages,
			finishedCb,
			token,
			location,
			endpoint,
			source,
			{ ...requestOptions, n: 1 },
			userInitiatedRequest,
			telemetryProperties,
			intentParams
		);
		if (resp.type === ChatFetchResponseType.Success) {
			return { ...resp, value: resp.value[0] };
		}
		return resp;
	}

	/**
	 * Note: the returned array of strings may be less than `n` (e.g., in case there were errors during streaming)
	 */
	public abstract fetchMany(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		chatEndpointInfo: IChatEndpoint,
		source?: Source,
		requestOptions?: OptionalChatRequestParams,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
		intentParams?: IntentParams,
		isFilterRetry?: boolean
	): Promise<ChatResponses>;
}

export class ChatMLFetcherImpl extends AbstractChatMLFetcher {

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@ILogService private readonly _logService: ILogService,
		@IEnvService private readonly _envService: IEnvService,
		@IDomainService private readonly _domainService: IDomainService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IInteractionService private readonly _interactionService: IInteractionService,
		@IChatQuotaService private readonly _chatQuotaService: IChatQuotaService,
		@IConversationOptions options: IConversationOptions,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) {
		super(options);
	}

	/**
	 * Note: the returned array of strings may be less than `n` (e.g., in case there were errors during streaming)
	 */
	public async fetchMany(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		chatEndpoint: IChatEndpoint,
		source?: Source,
		requestOptions?: OptionalChatRequestParams,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
		intentParams?: IntentParams,
		isFilterRetry?: boolean
	): Promise<ChatResponses> {
		if (!telemetryProperties) {
			telemetryProperties = {};
		}

		if (!telemetryProperties.messageSource) {
			telemetryProperties.messageSource = debugName;
		}

		// TODO @lramos15 telemetry should not drive request ids
		const ourRequestId = telemetryProperties.requestId ?? telemetryProperties.messageId ?? generateUuid();

		const maxResponseTokens = chatEndpoint.maxOutputTokens;
		if (!requestOptions?.prediction) {
			requestOptions = { max_tokens: maxResponseTokens, ...requestOptions };
		}
		// Avoid sending a prediction with no content as this will yield a 400 Bad Request
		if (!requestOptions.prediction?.content) {
			delete requestOptions['prediction'];
		}

		const postOptions = this.preparePostOptions(requestOptions);
		const model_name = chatEndpoint.model;

		const chatParams: ChatParams = {
			messages: rawMessageToCAPI(messages),
			model: model_name,
			ourRequestId,
			location,
			postOptions,
			secretKey: requestOptions.secretKey
		};

		const baseTelemetry = TelemetryData.createAndMarkAsIssued({
			...telemetryProperties,
			baseModel: chatEndpoint.model,
			uiKind: ChatLocation.toString(location)
		});

		const pendingLoggedChatRequest = this._requestLogger.logChatRequest(debugName, chatEndpoint, chatParams);
		let tokenCount = -1;
		try {
			let response: ChatResults | ChatRequestFailed | ChatRequestCanceled;
			const streamRecorder = new FetchStreamRecorder(finishedCb);
			const payloadValidationResult = isValidChatPayload(chatParams);
			if (!payloadValidationResult.isValid) {
				response = {
					type: FetchResponseKind.Failed,
					modelRequestId: undefined,
					failKind: ChatFailKind.ValidationFailed,
					reason: payloadValidationResult.reason,
				};
			} else {
				response = await fetchAndStreamChat(
					this._logService,
					this._telemetryService,
					this._fetcherService,
					this._envService,
					this._chatQuotaService,
					this._domainService,
					this._capiClientService,
					this._authenticationService,
					this._interactionService,
					chatEndpoint,
					chatParams,
					baseTelemetry,
					streamRecorder.callback,
					userInitiatedRequest,
					token,
					telemetryProperties
				);
				tokenCount = await chatEndpoint.acquireTokenizer().countMessagesTokens(messages);
				const extensionId = source?.extensionId ?? EXTENSION_ID;
				this._onDidMakeChatMLRequest.fire({
					messages,
					model: chatEndpoint.model,
					source: { extensionId },
					tokenCount
				});
			}
			const timeToFirstToken = Date.now() - baseTelemetry.issuedTime;
			pendingLoggedChatRequest?.markTimeToFirstToken(timeToFirstToken);
			switch (response.type) {
				case FetchResponseKind.Success: {
					const result = await this.processSuccessfulResponse(response, messages, chatParams.ourRequestId, maxResponseTokens, tokenCount, timeToFirstToken, baseTelemetry, chatEndpoint, userInitiatedRequest);

					// Handle FilteredRetry case with augmented messages
					if (result.type === ChatFetchResponseType.FilteredRetry) {

						if (isFilterRetry !== true) {
							streamRecorder.callback("", 0, { text: "", retryReason: result.category });

							const filteredContent = result.value[0];
							if (filteredContent) {
								const retryMessage = (result.category === FilterReason.Copyright) ?
									`The previous response (copied below) was filtered due to being too similar to existing public code. Please suggest something similar in function that does not match public code. Here's the previous response: ${filteredContent}\n\n` :
									`The previous response (copied below) was filtered due to triggering our content safety filters, which looks for hateful, self-harm, sexual, or violent content. Please suggest something similar in content that does not trigger these filters. Here's the previous response: ${filteredContent}\n\n`;
								const augmentedMessages: Raw.ChatMessage[] = [
									...messages,
									{
										role: Raw.ChatRole.User,
										content: toTextParts(retryMessage)
									}
								];

								// Retry with augmented messages
								const retryResult = await this.fetchMany(
									'retry-' + debugName,
									augmentedMessages,
									finishedCb,
									token,
									location,
									chatEndpoint,
									source,
									requestOptions,
									false, // do not mark the retry as user initiated
									{ ...telemetryProperties, retryAfterFilterCategory: result.category ?? 'uncategorized' },
									intentParams,
									true,
								);

								pendingLoggedChatRequest?.resolve(retryResult, streamRecorder.deltas);
								if (retryResult.type === ChatFetchResponseType.Success) {
									return retryResult;
								}
							}
						}

						return {
							type: ChatFetchResponseType.Filtered,
							category: result.category,
							reason: 'Response got filtered.',
							requestId: result.requestId,
							serverRequestId: result.serverRequestId
						};
					}

					pendingLoggedChatRequest?.resolve(result, streamRecorder.deltas);
					return result;
				}
				case FetchResponseKind.Canceled:
					this._sendCancellationTelemetry({
						source: telemetryProperties.messageSource ?? 'unknown',
						requestId: chatParams.ourRequestId,
						model: chatEndpoint.model,
						...(telemetryProperties.retryAfterFilterCategory ? { retryAfterFilterCategory: telemetryProperties.retryAfterFilterCategory } : {}),
					}, {
						totalTokenMax: chatEndpoint.modelMaxPromptTokens ?? -1,
						promptTokenCount: tokenCount,
						tokenCountMax: maxResponseTokens,
						timeToFirstToken,
						timeToCancelled: baseTelemetry ? Date.now() - baseTelemetry.issuedTime : -1,
						isVisionRequest: this.filterImageMessages(messages) ? 1 : -1,
						isBYOK: chatEndpoint instanceof OpenAIEndpoint ? 1 : -1
					});
					pendingLoggedChatRequest?.resolveWithCancelation();
					return this.processCanceledResponse(response, chatParams.ourRequestId);
				case FetchResponseKind.Failed: {
					const processed = this.processFailedResponse(response, chatParams.ourRequestId);
					this._sendResponseErrorTelemetry(processed, telemetryProperties, chatParams, chatEndpoint, tokenCount, maxResponseTokens, timeToFirstToken, this.filterImageMessages(messages));
					pendingLoggedChatRequest?.resolve(processed);
					return processed;
				}
			}
		} catch (err: unknown) {
			const timeToError = Date.now() - baseTelemetry.issuedTime;
			const processed = this.processError(err, chatParams.ourRequestId);
			if (processed.type === ChatFetchResponseType.Canceled) {
				this._sendCancellationTelemetry({
					source: telemetryProperties.messageSource ?? 'unknown',
					requestId: chatParams.ourRequestId,
					model: chatEndpoint.model,
				}, {
					totalTokenMax: chatEndpoint.modelMaxPromptTokens ?? -1,
					promptTokenCount: tokenCount,
					tokenCountMax: maxResponseTokens,
					timeToFirstToken: undefined,
					timeToCancelled: timeToError,
					isVisionRequest: this.filterImageMessages(messages) ? 1 : -1,
					isBYOK: chatEndpoint instanceof OpenAIEndpoint ? 1 : -1
				});
			} else {
				this._sendResponseErrorTelemetry(processed, telemetryProperties, chatParams, chatEndpoint, tokenCount, maxResponseTokens, timeToError, this.filterImageMessages(messages));
			}
			pendingLoggedChatRequest?.resolve(processed);
			return processed;
		}
	}

	private _sendCancellationTelemetry(
		{
			source,
			requestId,
			model,
		}: {
			source: string;
			requestId: string;
			model: string;
		},
		{
			totalTokenMax,
			promptTokenCount,
			tokenCountMax,
			timeToFirstToken,
			timeToCancelled,
			isVisionRequest,
			isBYOK
		}: {
			totalTokenMax: number;
			promptTokenCount: number;
			tokenCountMax: number;
			timeToFirstToken: number | undefined;
			timeToCancelled: number;
			isVisionRequest: number;
			isBYOK: number;
		}
	) {
		/* __GDPR__
			"response.cancelled" : {
				"owner": "digitarald",
				"comment": "Report canceled service responses for quality.",
				"model": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model selection for the response" },
				"source": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Source for why the request was made" },
				"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the request" },
				"totalTokenMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum total token window", "isMeasurement": true },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens", "isMeasurement": true },
				"tokenCountMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum generated tokens", "isMeasurement": true },
				"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
				"timeToCancelled": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
				"isVisionRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the request was for a vision model", "isMeasurement": true },
				"isBYOK": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for a BYOK model", "isMeasurement": true },
				"retryAfterFilterCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response was filtered and this is a retry attempt, this contains the original filtered content category." }
			}
		*/
		this._telemetryService.sendTelemetryEvent('response.cancelled', { github: true, microsoft: true }, {
			source,
			requestId,
			model,
		}, {
			totalTokenMax,
			promptTokenCount,
			tokenCountMax,
			timeToFirstToken,
			timeToCancelled,
			isVisionRequest,
			isBYOK
		});
	}

	private _sendResponseErrorTelemetry(
		processed: ChatFetchError,
		telemetryProperties: TelemetryProperties | undefined,
		chatParams: ChatParams,
		chatEndpointInfo: IChatEndpoint,
		tokenCount: number,
		maxResponseTokens: number,
		timeToFirstToken: number,
		isVisionRequest: boolean,
	) {
		/* __GDPR__
			"response.error" : {
				"owner": "digitarald",
				"comment": "Report quality issue for when a service response failed.",
				"type": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Type of issue" },
				"reason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason of issue" },
				"model": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model selection for the response" },
				"source": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Source for why the request was made" },
				"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the request" },
				"totalTokenMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum total token window", "isMeasurement": true },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens", "isMeasurement": true },
				"tokenCountMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum generated tokens", "isMeasurement": true },
				"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
				"isVisionRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the request was for a vision model", "isMeasurement": true },
				"isBYOK": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for a BYOK model", "isMeasurement": true },
				"retryAfterFilterCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response was filtered and this is a retry attempt, this contains the original filtered content category." }
			}
		*/
		this._telemetryService.sendTelemetryEvent('response.error', { github: true, microsoft: true }, {
			type: processed.type,
			reason: processed.reason,
			source: telemetryProperties?.messageSource ?? 'unknown',
			requestId: chatParams.ourRequestId,
			model: chatEndpointInfo.model,
			...(telemetryProperties?.retryAfterFilterCategory ? { retryAfterFilterCategory: telemetryProperties.retryAfterFilterCategory } : {})
		}, {
			totalTokenMax: chatEndpointInfo.modelMaxPromptTokens ?? -1,
			promptTokenCount: tokenCount,
			tokenCountMax: maxResponseTokens,
			timeToFirstToken,
			isVisionRequest: isVisionRequest ? 1 : -1,
			isBYOK: chatEndpointInfo instanceof OpenAIEndpoint ? 1 : -1
		});
	}

	private async processSuccessfulResponse(
		response: ChatResults,
		messages: Raw.ChatMessage[],
		requestId: string,
		maxResponseTokens: number,
		promptTokenCount: number,
		timeToFirstToken: number,
		baseTelemetry?: TelemetryData,
		chatEndpointInfo?: IChatEndpoint,
		userInitiatedRequest?: boolean
	): Promise<ChatResponses | ChatFetchRetriableError<string[]>> {

		const completions: ChatCompletion[] = [];

		for await (const chatCompletion of response.chatCompletions) {
			/* __GDPR__
				"response.success" : {
					"owner": "digitarald",
					"comment": "Report quality details for a successful service response.",
					"reason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason for why a response finished" },
					"filterReason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason for why a response was filtered" },
					"source": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Source of the initial request" },
					"initiatorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was initiated by a user or an agent" },
					"model": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model selection for the response" },
					"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the current turn request" },
					"totalTokenMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum total token window", "isMeasurement": true },
					"clientPromptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens, locally counted", "isMeasurement": true },
					"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens, server side counted", "isMeasurement": true },
					"promptCacheTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens hitting cache as reported by server", "isMeasurement": true },
					"tokenCountMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum generated tokens", "isMeasurement": true },
					"tokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of generated tokens", "isMeasurement": true },
					"acceptedPredictionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prediction that appeared in the completion", "isMeasurement": true },
					"rejectedPredictionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prediction that appeared in the completion", "isMeasurement": true },
					"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
					"timeToComplete": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to complete the request", "isMeasurement": true },
					"isVisionRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the request was for a vision model", "isMeasurement": true },
					"isBYOK": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for a BYOK model", "isMeasurement": true },
					"retryAfterFilterCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response was filtered and this is a retry attempt, this contains the original filtered content category." }
				}
			*/
			this._telemetryService.sendTelemetryEvent('response.success', { github: true, microsoft: true }, {
				reason: chatCompletion.finishReason,
				filterReason: chatCompletion.filterReason,
				source: baseTelemetry?.properties.messageSource ?? 'unknown',
				initiatorType: userInitiatedRequest ? 'user' : 'agent',
				model: chatEndpointInfo?.model,
				requestId,
				...(baseTelemetry?.properties.retryAfterFilterCategory ? { retryAfterFilterCategory: baseTelemetry.properties.retryAfterFilterCategory } : {}),
			}, {
				totalTokenMax: chatEndpointInfo?.modelMaxPromptTokens ?? -1,
				tokenCountMax: maxResponseTokens,
				promptTokenCount: chatCompletion.usage?.prompt_tokens,
				promptCacheTokenCount: chatCompletion.usage?.prompt_tokens_details?.cached_tokens,
				clientPromptTokenCount: promptTokenCount,
				tokenCount: chatCompletion.usage?.total_tokens,
				acceptedPredictionTokens: chatCompletion.usage?.completion_tokens_details?.accepted_prediction_tokens,
				rejectedPredictionTokens: chatCompletion.usage?.completion_tokens_details?.rejected_prediction_tokens,
				timeToFirstToken,
				timeToComplete: baseTelemetry ? Date.now() - baseTelemetry.issuedTime : -1,
				isVisionRequest: this.filterImageMessages(messages) ? 1 : -1,
				isBYOK: chatEndpointInfo instanceof OpenAIEndpoint ? 1 : -1
			});
			if (!this.isRepetitive(chatCompletion, baseTelemetry?.properties)) {
				completions.push(chatCompletion);
			}
		}
		const successFinishReasons = new Set([FinishedCompletionReason.Stop, FinishedCompletionReason.ClientTrimmed, FinishedCompletionReason.FunctionCall, FinishedCompletionReason.ToolCalls]);
		const successfulCompletions = completions.filter(c => successFinishReasons.has(c.finishReason));
		if (successfulCompletions.length >= 1) {
			return {
				type: ChatFetchResponseType.Success,
				usage: successfulCompletions.length === 1 ? successfulCompletions[0].usage : undefined,
				value: successfulCompletions.map(c => getTextPart(c.message.content)),
				requestId,
				serverRequestId: successfulCompletions[0].requestId.headerRequestId,
			};
		}

		const result = completions.at(0);

		const isRetryAfterFilteredResponseEnabled = this.configurationService.getExperimentBasedConfig(ConfigKey.EnableRetryAfterFilteredResponse, this.experimentationService);

		switch (result?.finishReason) {
			case FinishedCompletionReason.ContentFilter:
				if (isRetryAfterFilteredResponseEnabled) {
					return {
						type: ChatFetchResponseType.FilteredRetry,
						category: result.filterReason ?? FilterReason.Copyright,
						reason: 'Response got filtered.',
						value: completions.map(c => getTextPart(c.message.content)),
						requestId: requestId,
						serverRequestId: result.requestId.headerRequestId,
					};
				} else {
					return {
						type: ChatFetchResponseType.Filtered,
						category: result.filterReason ?? FilterReason.Copyright,
						reason: 'Response got filtered.',
						requestId: requestId,
						serverRequestId: result.requestId.headerRequestId
					};
				}
			case FinishedCompletionReason.Length:
				return {
					type: ChatFetchResponseType.Length,
					reason: 'Response too long.',
					requestId: requestId,
					serverRequestId: result.requestId.headerRequestId,
					truncatedValue: getTextPart(result.message.content)
				};
			case FinishedCompletionReason.ServerError:
				return {
					type: ChatFetchResponseType.Failed,
					reason: 'Server error. Stream terminated',
					requestId: requestId,
					serverRequestId: result.requestId.headerRequestId,
					streamError: result.error
				};
		}
		return {
			type: ChatFetchResponseType.Unknown,
			reason: 'Response contained no choices.',
			requestId: requestId,
			serverRequestId: result?.requestId.headerRequestId,
		};
	}

	private filterImageMessages(messages: Raw.ChatMessage[]): boolean {
		return messages?.some(m => Array.isArray(m.content) ? m.content.some(c => 'imageUrl' in c) : false);
	}

	private isRepetitive(chatCompletion: ChatCompletion, telemetryProperties?: TelemetryProperties) {
		const lineRepetitionStats = calculateLineRepetitionStats(getTextPart(chatCompletion.message.content));
		const hasRepetition = isRepetitive(chatCompletion.tokens);
		if (hasRepetition) {
			const telemetryData = TelemetryData.createAndMarkAsIssued();
			telemetryData.extendWithRequestId(chatCompletion.requestId);
			const extended = telemetryData.extendedBy(telemetryProperties);
			this._telemetryService.sendEnhancedGHTelemetryEvent('conversation.repetition.detected', extended.properties, extended.measurements);
		}
		if (lineRepetitionStats.numberOfRepetitions >= 10) {
			/* __GDPR__
				"conversation.repetition.detected" : {
					"owner": "lramos15",
					"comment": "Calculates the number of repetitions in a response. Useful for loop detection",
					"finishReason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason for why a response finished. Helps identify cancellation vs length limits" },
					"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id for this message request." },
					"lengthOfLine": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Length of the repeating line, in characters." },
					"numberOfRepetitions": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Number of times the line repeats." },
					"totalLines": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Number of total lines in the response." }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('conversation.repetition.detected', {
				requestId: chatCompletion.requestId.headerRequestId,
				finishReason: chatCompletion.finishReason,
			}, {
				numberOfRepetitions: lineRepetitionStats.numberOfRepetitions,
				lengthOfLine: lineRepetitionStats.mostRepeatedLine.length,
				totalLines: lineRepetitionStats.totalLines
			});
		}
		return hasRepetition;
	}

	private processCanceledResponse(response: ChatRequestCanceled, requestId: string): ChatResponses {
		return {
			type: ChatFetchResponseType.Canceled,
			reason: response.reason,
			requestId: requestId,
			serverRequestId: undefined,
		};
	}

	private processFailedResponse(response: ChatRequestFailed, requestId: string): ChatFetchError {
		const serverRequestId = response.modelRequestId?.headerRequestId;
		const reason = response.reason;
		if (response.failKind === ChatFailKind.RateLimited) {
			return { type: ChatFetchResponseType.RateLimited, reason, requestId, serverRequestId, retryAfter: response.data?.retryAfter, rateLimitKey: (response.data?.rateLimitKey || ''), capiError: response.data?.capiError };
		}
		if (response.failKind === ChatFailKind.QuotaExceeded) {
			return { type: ChatFetchResponseType.QuotaExceeded, reason, requestId, serverRequestId, retryAfter: response.data?.retryAfter, capiError: response.data?.capiError };
		}
		if (response.failKind === ChatFailKind.OffTopic) {
			return { type: ChatFetchResponseType.OffTopic, reason, requestId, serverRequestId };
		}
		if (response.failKind === ChatFailKind.TokenExpiredOrInvalid || response.failKind === ChatFailKind.ClientNotSupported || reason.includes('Bad request: ')) {
			return { type: ChatFetchResponseType.BadRequest, reason, requestId, serverRequestId };
		}
		if (response.failKind === ChatFailKind.ServerError) {
			return { type: ChatFetchResponseType.Failed, reason, requestId, serverRequestId };
		}
		if (response.failKind === ChatFailKind.ContentFilter) {
			return { type: ChatFetchResponseType.PromptFiltered, reason, category: FilterReason.Prompt, requestId, serverRequestId };
		}
		if (response.failKind === ChatFailKind.AgentUnauthorized) {
			return { type: ChatFetchResponseType.AgentUnauthorized, reason, authorizationUrl: response.data!.authorize_url, requestId, serverRequestId };
		}
		if (response.failKind === ChatFailKind.AgentFailedDependency) {
			return { type: ChatFetchResponseType.AgentFailedDependency, reason, requestId, serverRequestId };
		}
		if (response.failKind === ChatFailKind.ExtensionBlocked) {
			const retryAfter = typeof response.data?.retryAfter === 'number' ? response.data.retryAfter : 300;
			return { type: ChatFetchResponseType.ExtensionBlocked, reason, requestId, retryAfter, learnMoreLink: response.data?.learnMoreLink ?? '', serverRequestId };
		}
		if (response.failKind === ChatFailKind.NotFound) {
			return { type: ChatFetchResponseType.NotFound, reason, requestId, serverRequestId };
		}

		return { type: ChatFetchResponseType.Failed, reason, requestId, serverRequestId };
	}

	private processError(err: unknown, requestId: string): ChatFetchError {
		const fetcher = this._fetcherService;
		// If we cancelled a network request, we don't want to log an error
		if (fetcher.isAbortError(err)) {
			return {
				type: ChatFetchResponseType.Canceled,
				reason: 'network request aborted',
				requestId: requestId,
				serverRequestId: undefined,
			};
		}
		if (isCancellationError(err)) {
			return {
				type: ChatFetchResponseType.Canceled,
				reason: 'Got a cancellation error',
				requestId: requestId,
				serverRequestId: undefined,
			};
		}
		if (err && (
			(err instanceof Error && err.message === 'Premature close') ||
			(typeof err === 'object' && (err as any).code === 'ERR_STREAM_PREMATURE_CLOSE') /* to be extra sure */)
		) {
			return {
				type: ChatFetchResponseType.Canceled,
				reason: 'Stream closed prematurely',
				requestId: requestId,
				serverRequestId: undefined,
			};
		}
		this._logService.error(errorsUtil.fromUnknown(err), `Error on conversation request`);
		this._telemetryService.sendGHTelemetryException(err, 'Error on conversation request');
		// this.logger.exception(err, `Error on conversation request`);
		if (fetcher.isInternetDisconnectedError(err)) {
			return {
				type: ChatFetchResponseType.Failed,
				reason: `It appears you're not connected to the internet, please check your network connection and try again.`,
				requestId: requestId,
				serverRequestId: undefined,
			};
		} else if (fetcher.isFetcherError(err)) {
			return {
				type: ChatFetchResponseType.Failed,
				reason: fetcher.getUserMessageForFetcherError(err),
				requestId: requestId,
				serverRequestId: undefined,
			};
		} else {
			return {
				type: ChatFetchResponseType.Failed,
				reason: 'Error on conversation request. Check the log for more details.',
				requestId: requestId,
				serverRequestId: undefined,
			};
		}
	}
}

/**
 * Validates a chat request payload to ensure it is valid
 * @param params The params being sent in the chat request
 * @returns Whether the chat payload is valid
 */
function isValidChatPayload(params: ChatParams): { isValid: boolean; reason: string } {
	if (params.messages.length === 0) {
		return { isValid: false, reason: asUnexpected('No messages provided') };
	}
	if (params?.postOptions?.max_tokens && params?.postOptions?.max_tokens < 1) {
		return { isValid: false, reason: asUnexpected('Invalid response token parameter') };
	}

	const functionNamePattern = /^[a-zA-Z0-9_-]+$/;
	if (
		params.postOptions?.functions?.some(f => !f.name.match(functionNamePattern)) ||
		params.postOptions?.function_call?.name && !params.postOptions.function_call.name.match(functionNamePattern)
	) {
		return { isValid: false, reason: asUnexpected('Function names must match ^[a-zA-Z0-9_-]+$') };
	}

	if (params.postOptions?.tools && params.postOptions.tools.length > HARD_TOOL_LIMIT) {
		return { isValid: false, reason: `Tool limit exceeded (${params.postOptions.tools.length}/${HARD_TOOL_LIMIT}). Click "Configure Tools" in the chat input to disable ${params.postOptions.tools.length - HARD_TOOL_LIMIT} tools and retry.` };
	}

	return { isValid: true, reason: '' };
}

function asUnexpected(reason: string) {
	return `Prompt failed validation with the reason: ${reason}. Please file an issue.`;
}
