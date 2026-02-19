/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { OpenAI } from 'openai';
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { CopilotToken } from '../../../platform/authentication/common/copilotToken';
import { FetchStreamRecorder, IChatMLFetcher, IFetchMLOptions, Source } from '../../../platform/chat/common/chatMLFetcher';
import { IChatQuotaService } from '../../../platform/chat/common/chatQuotaService';
import { ChatFetchError, ChatFetchResponseType, ChatFetchRetriableError, ChatLocation, ChatResponse, ChatResponses } from '../../../platform/chat/common/commonTypes';
import { IConversationOptions } from '../../../platform/chat/common/conversationOptions';
import { getTextPart, toTextParts } from '../../../platform/chat/common/globalStringUtils';
import { IInteractionService } from '../../../platform/chat/common/interactionService';
import { ConfigKey, HARD_TOOL_LIMIT, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { isAutoModel } from '../../../platform/endpoint/node/autoChatEndpoint';
import { OpenAIResponsesProcessor, responseApiInputToRawMessagesForLogging, sendCompletionOutputTelemetry } from '../../../platform/endpoint/node/responsesApi';
import { collectSingleLineErrorMessage, ILogService } from '../../../platform/log/common/logService';
import { isAnthropicToolSearchEnabled } from '../../../platform/networking/common/anthropic';
import { FinishedCallback, getRequestId, IResponseDelta, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { FetcherId, IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { IBackgroundRequestOptions, IChatEndpoint, IEndpointBody, ISubagentRequestOptions, postRequest, stringifyUrlOrRequestMetadata } from '../../../platform/networking/common/networking';
import { CAPIChatMessage, ChatCompletion, FilterReason, FinishedCompletionReason, rawMessageToCAPI } from '../../../platform/networking/common/openai';
import { sendEngineMessagesTelemetry } from '../../../platform/networking/node/chatStream';
import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';
import { sendCommunicationErrorTelemetry } from '../../../platform/networking/node/stream';
import { ChatFailKind, ChatRequestCanceled, ChatRequestFailed, ChatResults, FetchResponseKind } from '../../../platform/openai/node/fetch';
import { emitInferenceDetailsEvent, GenAiAttr, GenAiMetrics, GenAiOperationName, GenAiProviderName, StdAttr } from '../../../platform/otel/common/index';
import { IOTelService, SpanKind, SpanStatusCode } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryProperties } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { calculateLineRepetitionStats, isRepetitive } from '../../../util/common/anomalyDetection';
import { ErrorUtils } from '../../../util/common/errors';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { escapeRegExpCharacters } from '../../../util/vs/base/common/strings';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { isBYOKModel } from '../../byok/node/openAIEndpoint';
import { EXTENSION_ID } from '../../common/constants';
import { IPowerService } from '../../power/common/powerService';
import { ChatMLFetcherTelemetrySender as Telemetry } from './chatMLFetcherTelemetry';

export interface IMadeChatRequestEvent {
	readonly messages: Raw.ChatMessage[];
	readonly model: string;
	readonly source?: Source;
	readonly tokenCount?: number;
}

export abstract class AbstractChatMLFetcher extends Disposable implements IChatMLFetcher {

	declare _serviceBrand: undefined;

	constructor(
		protected readonly options: IConversationOptions,
	) {
		super();
	}

	protected preparePostOptions(requestOptions: OptionalChatRequestParams): OptionalChatRequestParams {
		return {
			temperature: this.options.temperature,
			top_p: this.options.topP,
			// we disallow `stream=false` because we don't support non-streamed response
			...requestOptions,
			stream: true
		};
	}

	protected readonly _onDidMakeChatMLRequest = this._register(new Emitter<IMadeChatRequestEvent>());
	readonly onDidMakeChatMLRequest = this._onDidMakeChatMLRequest.event;

	public async fetchOne(opts: IFetchMLOptions, token: CancellationToken): Promise<ChatResponse> {
		const resp = await this.fetchMany({
			...opts,
			requestOptions: { ...opts.requestOptions, n: 1 }
		}, token);
		if (resp.type === ChatFetchResponseType.Success) {
			return { ...resp, value: resp.value[0] };
		}
		return resp;
	}

	/**
	 * Note: the returned array of strings may be less than `n` (e.g., in case there were errors during streaming)
	 */
	public abstract fetchMany(opts: IFetchMLOptions, token: CancellationToken): Promise<ChatResponses>;
}

export class ChatMLFetcherImpl extends AbstractChatMLFetcher {

	/**
	 * Delays (in ms) between connectivity check attempts before retrying a failed request.
	 * Configurable for testing purposes.
	 */
	public connectivityCheckDelays = [1000, 10000, 10000];

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@ILogService private readonly _logService: ILogService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IInteractionService private readonly _interactionService: IInteractionService,
		@IChatQuotaService private readonly _chatQuotaService: IChatQuotaService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IConversationOptions options: IConversationOptions,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
		@IPowerService private readonly _powerService: IPowerService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatWebSocketManager private readonly _webSocketManager: IChatWebSocketManager,
		@IOTelService private readonly _otelService: IOTelService,
	) {
		super(options);
	}

	/**
	 * Note: the returned array of strings may be less than `n` (e.g., in case there were errors during streaming)
	 */
	public async fetchMany(opts: IFetchMLOptions, token: CancellationToken): Promise<ChatResponses> {
		let { debugName, endpoint: chatEndpoint, finishedCb, location, messages, requestOptions, source, telemetryProperties, userInitiatedRequest, requestKindOptions, conversationId, turnId } = opts;
		if (!telemetryProperties) {
			telemetryProperties = {};
		}

		if (!telemetryProperties.messageSource) {
			telemetryProperties.messageSource = debugName;
		}

		// When WebSocket is enabled, default to using the stateful marker so
		// only delta history is sent once the server has context from this turn.
		const useWebSocket = !!(turnId && conversationId
			&& chatEndpoint.apiType === 'responses'
			&& this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.ResponsesApiWebSocketEnabled, this._experimentationService));
		const transport = useWebSocket ? 'websocket' : 'http';
		const ignoreStatefulMarker = useWebSocket ? (opts.ignoreStatefulMarker ?? false) : opts.ignoreStatefulMarker;

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
		const requestBody = chatEndpoint.createRequestBody({
			...opts,
			ignoreStatefulMarker,
			requestId: ourRequestId,
			postOptions
		});


		const baseTelemetry = TelemetryData.createAndMarkAsIssued({
			...telemetryProperties,
			baseModel: chatEndpoint.model,
			uiKind: ChatLocation.toString(location)
		});

		const pendingLoggedChatRequest = this._requestLogger.logChatRequest(debugName, chatEndpoint, {
			messages: opts.messages,
			model: chatEndpoint.model,
			ourRequestId,
			location: opts.location,
			body: requestBody,
			ignoreStatefulMarker,
			isConversationRequest: opts.isConversationRequest,
			customMetadata: opts.customMetadata
		});
		let tokenCount = -1;
		const streamRecorder = new FetchStreamRecorder(finishedCb);
		const enableRetryOnError = opts.enableRetryOnError ?? opts.enableRetryOnFilter;
		const canRetryOnce = opts.canRetryOnceWithoutRollback ?? !(opts.enableRetryOnFilter || opts.enableRetryOnError);
		let usernameToScrub: string | undefined;
		let actualFetcher: FetcherId | undefined;
		let actualBytesReceived: number | undefined;
		let actualStatusCode: number | undefined;
		let suspendEventSeen: boolean | undefined;
		let resumeEventSeen: boolean | undefined;
		try {
			let response: ChatResults | ChatRequestFailed | ChatRequestCanceled;
			const payloadValidationResult = isValidChatPayload(opts.messages, postOptions, chatEndpoint, this._configurationService, this._experimentationService);
			if (!payloadValidationResult.isValid) {
				response = {
					type: FetchResponseKind.Failed,
					modelRequestId: undefined,
					failKind: ChatFailKind.ValidationFailed,
					reason: payloadValidationResult.reason,
				};
			} else {
				const copilotToken = await this._authenticationService.getCopilotToken();
				usernameToScrub = copilotToken.username;
				const fetchResult = await this._fetchAndStreamChat(
					chatEndpoint,
					requestBody,
					baseTelemetry,
					streamRecorder.callback,
					requestOptions.secretKey,
					copilotToken,
					opts.location,
					ourRequestId,
					postOptions.n,
					token,
					userInitiatedRequest,
					useWebSocket,
					turnId,
					conversationId,
					telemetryProperties,
					opts.useFetcher,
					canRetryOnce,
					requestKindOptions,
				);
				response = fetchResult.result;
				actualFetcher = fetchResult.fetcher;
				actualBytesReceived = fetchResult.bytesReceived;
				actualStatusCode = fetchResult.statusCode;
				suspendEventSeen = fetchResult.suspendEventSeen;
				resumeEventSeen = fetchResult.resumeEventSeen;
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
					const result = await this.processSuccessfulResponse(response, messages, requestBody, ourRequestId, maxResponseTokens, tokenCount, timeToFirstToken, streamRecorder, baseTelemetry, chatEndpoint, userInitiatedRequest, transport, actualFetcher, actualBytesReceived, suspendEventSeen, resumeEventSeen);

					// Handle FilteredRetry case with augmented messages
					if (result.type === ChatFetchResponseType.FilteredRetry) {

						if (opts.enableRetryOnFilter) {
							streamRecorder.callback('', 0, { text: '', retryReason: result.category });

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
								const retryResult = await this.fetchMany({
									...opts,
									debugName: 'retry-' + debugName,
									messages: augmentedMessages,
									finishedCb,
									location,
									endpoint: chatEndpoint,
									source,
									requestOptions,
									userInitiatedRequest: false, // do not mark the retry as user initiated
									telemetryProperties: { ...telemetryProperties, retryAfterFilterCategory: result.category ?? 'uncategorized' },
									enableRetryOnFilter: false,
									canRetryOnceWithoutRollback: false,
									enableRetryOnError,
								}, token);

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

					// Record OTel token usage metrics if available
					if (result.type === ChatFetchResponseType.Success && result.usage) {
						const otelMetrics = new GenAiMetrics(this._otelService);
						const metricAttrs = {
							operationName: GenAiOperationName.CHAT,
							providerName: GenAiProviderName.OPENAI,
							requestModel: chatEndpoint.model,
							responseModel: result.resolvedModel,
						};
						if (result.usage.prompt_tokens) {
							otelMetrics.recordTokenUsage(result.usage.prompt_tokens, 'input', metricAttrs);
						}
						if (result.usage.completion_tokens) {
							otelMetrics.recordTokenUsage(result.usage.completion_tokens, 'output', metricAttrs);
						}
					}

					// Record OTel time-to-first-token metric
					if (timeToFirstToken > 0) {
						const otelMetrics = new GenAiMetrics(this._otelService);
						otelMetrics.recordTimeToFirstToken(chatEndpoint.model, timeToFirstToken / 1000);
					}

					// Emit OTel inference details event with full token usage
					emitInferenceDetailsEvent(
						this._otelService,
						{
							model: chatEndpoint.model,
							temperature: requestOptions?.temperature,
							maxTokens: requestOptions?.max_tokens,
						},
						result.type === ChatFetchResponseType.Success ? {
							id: result.requestId,
							model: result.resolvedModel,
							finishReasons: ['stop'],
							inputTokens: result.usage?.prompt_tokens,
							outputTokens: result.usage?.completion_tokens,
						} : undefined,
					);

					return result;
				}
				case FetchResponseKind.Canceled:
					Telemetry.sendCancellationTelemetry(
						this._telemetryService,
						{
							source: telemetryProperties.messageSource ?? 'unknown',
							requestId: ourRequestId,
							model: chatEndpoint.model,
							apiType: chatEndpoint.apiType,
							transport,
							associatedRequestId: telemetryProperties.associatedRequestId,
							retryAfterError: telemetryProperties.retryAfterError,
							retryAfterErrorGitHubRequestId: telemetryProperties.retryAfterErrorGitHubRequestId,
							connectivityTestError: telemetryProperties.connectivityTestError,
							connectivityTestErrorGitHubRequestId: telemetryProperties.connectivityTestErrorGitHubRequestId,
							retryAfterFilterCategory: telemetryProperties.retryAfterFilterCategory,
							fetcher: actualFetcher,
							suspendEventSeen,
							resumeEventSeen,
						},
						{
							totalTokenMax: chatEndpoint.modelMaxPromptTokens ?? -1,
							promptTokenCount: tokenCount,
							tokenCountMax: maxResponseTokens,
							timeToFirstToken,
							timeToFirstTokenEmitted: (baseTelemetry && streamRecorder.firstTokenEmittedTime) ? streamRecorder.firstTokenEmittedTime - baseTelemetry.issuedTime : -1,
							timeToCancelled: Date.now() - baseTelemetry.issuedTime,
							isVisionRequest: this.filterImageMessages(messages) ? 1 : -1,
							isBYOK: isBYOKModel(chatEndpoint),
							isAuto: isAutoModel(chatEndpoint),
							bytesReceived: actualBytesReceived,
							issuedTime: baseTelemetry.issuedTime,
						});
					pendingLoggedChatRequest?.resolveWithCancelation();
					return this.processCanceledResponse(response, ourRequestId, streamRecorder, telemetryProperties);
				case FetchResponseKind.Failed: {
					const processed = this.processFailedResponse(response, ourRequestId);
					// Retry on server errors based on configured status codes
					const retryServerErrorStatusCodes = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, this._experimentationService);
					const statusCodesToRetry = retryServerErrorStatusCodes
						.split(',')
						.map(s => parseInt(s.trim(), 10));
					if (enableRetryOnError && actualStatusCode !== undefined && statusCodesToRetry.includes(actualStatusCode)) {
						const { retryResult } = await this._retryAfterError({
							opts,
							processed,
							telemetryProperties,
							requestBody,
							tokenCount,
							maxResponseTokens,
							timeToError: timeToFirstToken,
							transport,
							actualFetcher,
							bytesReceived: actualBytesReceived,
							baseTelemetry,
							streamRecorder,
							retryReason: 'server_error',
							debugNamePrefix: 'retry-server-error-',
							pendingLoggedChatRequest,
							token,
							usernameToScrub,
							suspendEventSeen,
							resumeEventSeen,
						});
						if (retryResult) {
							return retryResult;
						}
					}
					Telemetry.sendResponseErrorTelemetry(this._telemetryService, {
						processed,
						telemetryProperties,
						chatEndpointInfo: chatEndpoint,
						requestBody,
						tokenCount,
						maxResponseTokens,
						timeToFirstToken,
						isVisionRequest: this.filterImageMessages(messages),
						transport,
						fetcher: actualFetcher,
						bytesReceived: actualBytesReceived,
						issuedTime: baseTelemetry.issuedTime,
						wasRetried: false,
						suspendEventSeen,
						resumeEventSeen,
					});
					pendingLoggedChatRequest?.resolve(processed);
					return processed;
				}
			}
		} catch (err) {
			const timeToError = Date.now() - baseTelemetry.issuedTime;
			if (err.fetcherId) {
				actualFetcher = err.fetcherId;
			}
			if (err.suspendEventSeen) {
				suspendEventSeen = true;
			}
			if (err.resumeEventSeen) {
				resumeEventSeen = true;
			}
			const processed = this.processError(err, ourRequestId, err.gitHubRequestId, usernameToScrub);
			if (processed.type === ChatFetchResponseType.NetworkError && enableRetryOnError) {
				const isRetryNetworkErrorEnabled = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.RetryNetworkErrors, this._experimentationService);
				if (isRetryNetworkErrorEnabled) {
					const { retryResult, connectivityTestError, connectivityTestErrorGitHubRequestId } = await this._retryAfterError({
						opts,
						processed,
						telemetryProperties,
						requestBody,
						tokenCount,
						maxResponseTokens,
						timeToError,
						transport,
						actualFetcher,
						bytesReceived: err.bytesReceived,
						baseTelemetry,
						streamRecorder,
						retryReason: 'network_error',
						debugNamePrefix: 'retry-error-',
						pendingLoggedChatRequest,
						token,
						usernameToScrub,
						suspendEventSeen,
						resumeEventSeen,
					});
					if (retryResult) {
						return retryResult;
					}
					telemetryProperties = { ...telemetryProperties, connectivityTestError, connectivityTestErrorGitHubRequestId };
				}
			}
			if (processed.type === ChatFetchResponseType.Canceled) {
				Telemetry.sendCancellationTelemetry(
					this._telemetryService,
					{
						source: telemetryProperties.messageSource ?? 'unknown',
						requestId: ourRequestId,
						model: chatEndpoint.model,
						apiType: chatEndpoint.apiType,
						transport,
						associatedRequestId: telemetryProperties.associatedRequestId,
						retryAfterError: telemetryProperties.retryAfterError,
						retryAfterErrorGitHubRequestId: telemetryProperties.retryAfterErrorGitHubRequestId,
						connectivityTestError: telemetryProperties.connectivityTestError,
						connectivityTestErrorGitHubRequestId: telemetryProperties.connectivityTestErrorGitHubRequestId,
						retryAfterFilterCategory: telemetryProperties.retryAfterFilterCategory,
						fetcher: actualFetcher,
						suspendEventSeen,
						resumeEventSeen,
					},
					{
						totalTokenMax: chatEndpoint.modelMaxPromptTokens ?? -1,
						promptTokenCount: tokenCount,
						tokenCountMax: maxResponseTokens,
						timeToFirstToken: undefined,
						timeToCancelled: timeToError,
						isVisionRequest: this.filterImageMessages(messages) ? 1 : -1,
						isBYOK: isBYOKModel(chatEndpoint),
						isAuto: isAutoModel(chatEndpoint),
						bytesReceived: err.bytesReceived,
						issuedTime: baseTelemetry.issuedTime,
					}
				);
			} else {
				Telemetry.sendResponseErrorTelemetry(this._telemetryService, {
					processed,
					telemetryProperties,
					chatEndpointInfo: chatEndpoint,
					requestBody,
					tokenCount,
					maxResponseTokens,
					timeToFirstToken: timeToError,
					isVisionRequest: this.filterImageMessages(messages),
					transport,
					fetcher: actualFetcher,
					bytesReceived: err.bytesReceived,
					issuedTime: baseTelemetry.issuedTime,
					wasRetried: false,
					suspendEventSeen,
					resumeEventSeen,
				});
			}
			pendingLoggedChatRequest?.resolve(processed);
			return processed;
		}
	}

	private async _checkNetworkConnectivity(useFetcher?: FetcherId): Promise<{ retryRequest: boolean; connectivityTestError?: string; connectivityTestErrorGitHubRequestId?: string }> {
		// Ping CAPI to check network connectivity before retrying
		const delays = this.connectivityCheckDelays;
		let connectivityTestError: string | undefined = undefined;
		let connectivityTestErrorGitHubRequestId: string | undefined = undefined;
		for (const delay of delays) {
			this._logService.info(`Waiting ${delay}ms before pinging CAPI to check network connectivity...`);
			await new Promise(resolve => setTimeout(resolve, delay));
			try {
				const isGHEnterprise = this._capiClientService.dotcomAPIURL !== 'https://api.github.com';
				const url = this._capiClientService.capiPingURL;
				const headers = await this._getAuthHeaders(isGHEnterprise, url);
				const res = await this._fetcherService.fetch(url, {
					headers,
					useFetcher,
				});
				if (res.status >= 200 && res.status < 300) {
					this._logService.info(`CAPI ping successful, proceeding with chat request retry...`);
					return { retryRequest: true, connectivityTestError, connectivityTestErrorGitHubRequestId };
				} else {
					connectivityTestError = `Status ${res.status}: ${res.statusText}`;
					connectivityTestErrorGitHubRequestId = res.headers.get('x-github-request-id') ?? '';
					this._logService.info(`CAPI ping returned status ${res.status}, retrying ping...`);
				}
			} catch (err) {
				connectivityTestError = collectSingleLineErrorMessage(err, true);
				connectivityTestErrorGitHubRequestId = undefined; // no response headers yet
				this._logService.info(`CAPI ping failed with error, retrying ping: ${connectivityTestError}`);
			}
		}
		return { retryRequest: false, connectivityTestError, connectivityTestErrorGitHubRequestId };
	}

	private async _getAuthHeaders(isGHEnterprise: boolean, url: string) {
		const authHeaders: Record<string, string> = {};
		if (isGHEnterprise) {
			let token = '';
			if (url === this._capiClientService.dotcomAPIURL) {
				token = this._authenticationService.anyGitHubSession?.accessToken || '';
			} else {
				try {
					token = (await this._authenticationService.getCopilotToken()).token;
				} catch (_err) {
					// Ignore error
					token = '';
				}
			}
			authHeaders['Authorization'] = `Bearer ${token}`;
		}
		return authHeaders;
	}

	private async _retryAfterError(params: {
		opts: IFetchMLOptions;
		processed: ChatFetchError;
		telemetryProperties: TelemetryProperties;
		requestBody: IEndpointBody;
		tokenCount: number;
		maxResponseTokens: number;
		timeToError: number;
		transport: string;
		actualFetcher: FetcherId | undefined;
		bytesReceived: number | undefined;
		baseTelemetry: TelemetryData;
		streamRecorder: FetchStreamRecorder;
		retryReason: 'network_error' | 'server_error';
		debugNamePrefix: string;
		pendingLoggedChatRequest: ReturnType<IRequestLogger['logChatRequest']>;
		token: CancellationToken;
		usernameToScrub: string | undefined;
		suspendEventSeen: boolean | undefined;
		resumeEventSeen: boolean | undefined;
	}): Promise<{ retryResult?: ChatResponses; connectivityTestError?: string; connectivityTestErrorGitHubRequestId?: string }> {
		const {
			opts,
			processed,
			telemetryProperties,
			requestBody,
			tokenCount,
			maxResponseTokens,
			timeToError,
			transport,
			actualFetcher,
			bytesReceived,
			baseTelemetry,
			streamRecorder,
			retryReason,
			debugNamePrefix,
			pendingLoggedChatRequest,
			token,
			usernameToScrub,
			suspendEventSeen,
			resumeEventSeen,
		} = params;

		// net::ERR_NETWORK_CHANGED: https://github.com/microsoft/vscode/issues/260297
		const isNetworkChangedError = ['darwin', 'linux'].includes(process.platform) && processed.reason.indexOf('net::ERR_NETWORK_CHANGED') !== -1;
		// When Electron's network process crashes, all requests through it fail permanently.
		// Fall back to node-fetch which bypasses Electron's network stack entirely.
		const fallbackEnabled = this._configurationService.getExperimentBasedConfig(
			ConfigKey.TeamInternal.FallbackNodeFetchOnNetworkProcessCrash, this._experimentationService);
		const isNetworkProcessCrash = processed.type === ChatFetchResponseType.NetworkError
			&& processed.isNetworkProcessCrash === true
			&& fallbackEnabled;
		const useFetcher = (isNetworkChangedError || isNetworkProcessCrash) ? 'node-fetch' : opts.useFetcher;
		this._logService.info(`Retrying chat request with ${useFetcher || 'default'} fetcher after: ${processed.reasonDetail || processed.reason}`);
		const connectivity = await this._checkNetworkConnectivity(useFetcher);
		const connectivityTestError = connectivity.connectivityTestError ? this.scrubErrorDetail(connectivity.connectivityTestError, usernameToScrub) : undefined;
		const connectivityTestErrorGitHubRequestId = connectivity.connectivityTestErrorGitHubRequestId;
		if (!connectivity.retryRequest) {
			this._logService.info(`Not retrying chat request as network connectivity could not be re-established.`);
			return { connectivityTestError, connectivityTestErrorGitHubRequestId };
		}

		Telemetry.sendResponseErrorTelemetry(
			this._telemetryService,
			{
				processed,
				telemetryProperties,
				chatEndpointInfo: opts.endpoint,
				requestBody,
				tokenCount,
				maxResponseTokens,
				timeToFirstToken: timeToError,
				isVisionRequest: this.filterImageMessages(opts.messages),
				transport,
				fetcher: actualFetcher,
				bytesReceived,
				issuedTime: baseTelemetry.issuedTime,
				wasRetried: true,
				suspendEventSeen,
				resumeEventSeen,
			},
		);

		streamRecorder.callback('', 0, { text: '', retryReason });

		const retryResult = await this.fetchMany({
			...opts,
			debugName: debugNamePrefix + opts.debugName,
			userInitiatedRequest: false, // do not mark the retry as user initiated
			telemetryProperties: {
				...telemetryProperties,
				retryAfterError: processed.reasonDetail || processed.reason,
				retryAfterErrorGitHubRequestId: processed.serverRequestId,
				connectivityTestError,
				connectivityTestErrorGitHubRequestId,
			},
			enableRetryOnError: false,
			useFetcher,
		}, token);

		pendingLoggedChatRequest?.resolve(retryResult, streamRecorder.deltas);
		return { retryResult, connectivityTestError, connectivityTestErrorGitHubRequestId };
	}

	private async _fetchAndStreamChat(
		chatEndpointInfo: IChatEndpoint,
		request: IEndpointBody,
		baseTelemetryData: TelemetryData,
		finishedCb: FinishedCallback,
		secretKey: string | undefined,
		copilotToken: CopilotToken,
		location: ChatLocation,
		ourRequestId: string,
		nChoices: number | undefined,
		cancellationToken: CancellationToken,
		userInitiatedRequest?: boolean,
		useWebSocket?: boolean,
		turnId?: string,
		conversationId?: string,
		telemetryProperties?: TelemetryProperties | undefined,
		useFetcher?: FetcherId,
		canRetryOnce?: boolean,
		requestKindOptions?: IBackgroundRequestOptions | ISubagentRequestOptions,
	): Promise<{ result: ChatResults | ChatRequestFailed | ChatRequestCanceled; fetcher?: FetcherId; bytesReceived?: number; statusCode?: number; suspendEventSeen?: boolean; resumeEventSeen?: boolean }> {
		const isPowerSaveBlockerEnabled = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.ChatRequestPowerSaveBlocker, this._experimentationService);
		const blockerHandle = isPowerSaveBlockerEnabled && location !== ChatLocation.Other ? this._powerService.acquirePowerSaveBlocker() : undefined;

		let suspendEventSeen = false;
		let resumeEventSeen = false;

		const suspendListener = this._powerService.onDidSuspend(() => {
			suspendEventSeen = true;
			this._logService.info(`System suspended during streaming request ${ourRequestId} (${ChatLocation.toString(location)})`);
		});

		const resumeListener = this._powerService.onDidResume(() => {
			resumeEventSeen = true;
			this._logService.info(`System resumed during streaming request ${ourRequestId} (${ChatLocation.toString(location)})`);
		});

		try {
			const fetchResult = await this._doFetchAndStreamChat(
				chatEndpointInfo,
				request,
				baseTelemetryData,
				finishedCb,
				secretKey,
				copilotToken,
				location,
				ourRequestId,
				nChoices,
				cancellationToken,
				userInitiatedRequest,
				useWebSocket,
				turnId,
				conversationId,
				telemetryProperties,
				useFetcher,
				canRetryOnce,
				requestKindOptions,
			);
			return { ...fetchResult, suspendEventSeen: suspendEventSeen || undefined, resumeEventSeen: resumeEventSeen || undefined };
		} catch (err) {
			if (suspendEventSeen) {
				err.suspendEventSeen = true;
			}
			if (resumeEventSeen) {
				err.resumeEventSeen = true;
			}
			throw err;
		} finally {
			suspendListener.dispose();
			resumeListener.dispose();
			blockerHandle?.dispose();
		}
	}

	private async _doFetchAndStreamChat(
		chatEndpointInfo: IChatEndpoint,
		request: IEndpointBody,
		baseTelemetryData: TelemetryData,
		finishedCb: FinishedCallback,
		secretKey: string | undefined,
		copilotToken: CopilotToken,
		location: ChatLocation,
		ourRequestId: string,
		nChoices: number | undefined,
		cancellationToken: CancellationToken,
		userInitiatedRequest?: boolean,
		useWebSocket?: boolean,
		turnId?: string,
		conversationId?: string,
		telemetryProperties?: TelemetryProperties | undefined,
		useFetcher?: FetcherId,
		canRetryOnce?: boolean,
		requestKindOptions?: IBackgroundRequestOptions | ISubagentRequestOptions,
	): Promise<{ result: ChatResults | ChatRequestFailed | ChatRequestCanceled; fetcher?: FetcherId; bytesReceived?: number; statusCode?: number }> {

		if (cancellationToken.isCancellationRequested) {
			return { result: { type: FetchResponseKind.Canceled, reason: 'before fetch request' } };
		}

		// OTel inference span for this LLM call
		const otelSpan = this._otelService.startSpan(`chat ${chatEndpointInfo.model}`, {
			kind: SpanKind.CLIENT,
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
				[GenAiAttr.PROVIDER_NAME]: GenAiProviderName.OPENAI,
				[GenAiAttr.REQUEST_MODEL]: chatEndpointInfo.model,
				[GenAiAttr.CONVERSATION_ID]: telemetryProperties?.requestId ?? ourRequestId,
				[GenAiAttr.REQUEST_MAX_TOKENS]: request.max_tokens ?? 2048,
			},
		});
		const otelStartTime = Date.now();

		try {

			this._logService.debug(`modelMaxPromptTokens ${chatEndpointInfo.modelMaxPromptTokens}`);
			this._logService.debug(`modelMaxResponseTokens ${request.max_tokens ?? 2048}`);
			this._logService.debug(`chat model ${chatEndpointInfo.model}`);

			secretKey ??= copilotToken.token;
			if (!secretKey) {
				// If no key is set we error
				const urlOrRequestMetadata = stringifyUrlOrRequestMetadata(chatEndpointInfo.urlOrRequestMetadata);
				this._logService.error(`Failed to send request to ${urlOrRequestMetadata} due to missing key`);
				sendCommunicationErrorTelemetry(this._telemetryService, `Failed to send request to ${urlOrRequestMetadata} due to missing key`);
				return {
					result: {
						type: FetchResponseKind.Failed,
						modelRequestId: undefined,
						failKind: ChatFailKind.TokenExpiredOrInvalid,
						reason: 'key is missing'
					}
				};
			}

			// Generate unique ID to link input and output messages
			const modelCallId = generateUuid();

			const response = await this._fetchWithInstrumentation(
				chatEndpointInfo,
				ourRequestId,
				request,
				secretKey,
				location,
				cancellationToken,
				userInitiatedRequest,
				{ ...telemetryProperties, modelCallId },
				useFetcher,
				canRetryOnce,
				requestKindOptions,
			);

			if (cancellationToken.isCancellationRequested) {
				try {
					// Destroy the stream so that the server is hopefully notified we don't want any more data
					// and can cancel/forget about the request itself.
					await response!.body.destroy();
				} catch (e) {
					this._logService.error(e, `Error destroying stream`);
					this._telemetryService.sendGHTelemetryException(e, 'Error destroying stream');
				}
				return {
					result: { type: FetchResponseKind.Canceled, reason: 'after fetch request' },
					fetcher: response.fetcher,
					bytesReceived: response.bytesReceived
				};
			}

			if (response.status === 200 && this._authenticationService.copilotToken?.isFreeUser && this._authenticationService.copilotToken?.isChatQuotaExceeded) {
				this._authenticationService.resetCopilotToken();
			}

			if (response.status !== 200) {
				const telemetryData = createTelemetryData(chatEndpointInfo, location, ourRequestId);
				this._logService.info('Request ID for failed request: ' + ourRequestId);
				const errorResult = await this._handleError(telemetryData, response, ourRequestId);
				otelSpan.setStatus(SpanStatusCode.ERROR, `HTTP ${response.status}`);
				otelSpan.setAttribute(StdAttr.ERROR_TYPE, `HTTP_${response.status}`);
				return {
					result: errorResult,
					fetcher: response.fetcher,
					bytesReceived: response.bytesReceived,
					statusCode: response.status
				};
			}

			// Extend baseTelemetryData with modelCallId for output messages
			const extendedBaseTelemetryData = baseTelemetryData.extendedBy({ modelCallId });

			let chatCompletions;
			const gitHubRequestId = response.headers.get('x-github-request-id') ?? '';
			try {
				const completions = await chatEndpointInfo.processResponseFromChatEndpoint(
					this._telemetryService,
					this._logService,
					response,
					nChoices ?? /* OpenAI's default */ 1,
					finishedCb,
					extendedBaseTelemetryData,
					cancellationToken,
					location,
				);
				chatCompletions = new AsyncIterableObject<ChatCompletion>(async emitter => {
					try {
						for await (const completion of completions) {
							emitter.emitOne(completion);
						}
					} catch (err) {
						err.fetcherId = response.fetcher;
						err.gitHubRequestId = gitHubRequestId;
						err.bytesReceived = response.bytesReceived;
						throw err;
					}
				});
			} catch (err) {
				err.fetcherId = response.fetcher;
				err.gitHubRequestId = gitHubRequestId;
				err.bytesReceived = response.bytesReceived;
				throw err;
			}

			// CAPI will return us a Copilot Edits Session Header which is our token to using the speculative decoding endpoint
			// We should store this in the auth service for easy use later
			if (response.headers.get('Copilot-Edits-Session')) {
				this._authenticationService.speculativeDecodingEndpointToken = response.headers.get('Copilot-Edits-Session') ?? undefined;
			}

			this._chatQuotaService.processQuotaHeaders(response.headers);

			otelSpan.setStatus(SpanStatusCode.OK);
			return {
				result: {
					type: FetchResponseKind.Failed,
					modelRequestId: undefined,
					failKind: ChatFailKind.TokenExpiredOrInvalid,
					reason: 'key is missing'
				}
			};
		}

		// WebSocket path: use persistent WebSocket connection for Responses API endpoints
		if (useWebSocket && turnId && conversationId) {
			return this._doFetchViaWebSocket(
				chatEndpointInfo,
				request,
				baseTelemetryData,
				finishedCb,
				secretKey,
				location,
				ourRequestId,
				turnId,
				conversationId,
				cancellationToken,
				telemetryProperties,
			);
		}

		return this._doFetchViaHttp(
			chatEndpointInfo,
			request,
			baseTelemetryData,
			finishedCb,
			secretKey,
			location,
			ourRequestId,
			nChoices,
			cancellationToken,
			userInitiatedRequest,
			telemetryProperties,
			useFetcher,
			canRetryOnce,
			requestKindOptions,
		);
		} catch (err) {
			otelSpan.setStatus(SpanStatusCode.ERROR, err instanceof Error ? err.message : String(err));
			otelSpan.setAttribute(StdAttr.ERROR_TYPE, err instanceof Error ? err.constructor.name : 'Error');
			otelSpan.recordException(err);
			throw err;
		} finally {
			const durationSec = (Date.now() - otelStartTime) / 1000;
			const metrics = new GenAiMetrics(this._otelService);
			metrics.recordOperationDuration(durationSec, {
				operationName: GenAiOperationName.CHAT,
				providerName: GenAiProviderName.OPENAI,
				requestModel: chatEndpointInfo.model,
			});
			otelSpan.end();
		}
	}

	/**
	 * Sends a chat request via a persistent WebSocket connection instead of HTTP POST.
	 * Events are the same Responses API streaming events, processed by OpenAIResponsesProcessor.
	 */
	private async _doFetchViaWebSocket(
		chatEndpointInfo: IChatEndpoint,
		request: IEndpointBody,
		baseTelemetryData: TelemetryData,
		finishedCb: FinishedCallback,
		secretKey: string,
		location: ChatLocation,
		ourRequestId: string,
		turnId: string,
		conversationId: string,
		cancellationToken: CancellationToken,
		telemetryProperties: TelemetryProperties | undefined,
	): Promise<{ result: ChatResults | ChatRequestFailed | ChatRequestCanceled }> {
		const connection = await this._webSocketManager.getOrCreateConnection(conversationId, turnId, secretKey);

		// Generate unique ID to link input and output messages
		const modelCallId = generateUuid();

		const telemetryData = TelemetryData.createAndMarkAsIssued({
			endpoint: 'completions',
			engineName: 'chat',
			uiKind: ChatLocation.toString(location),
			transport: 'websocket',
			...{ ...telemetryProperties, modelCallId },
		}, {
			maxTokenWindow: chatEndpointInfo.modelMaxPromptTokens
		});

		for (const [key, value] of Object.entries(request)) {
			if (key === 'messages' || key === 'input') {
				continue;
			} // Skip messages (PII)
			telemetryData.properties[`request.option.${key}`] = JSON.stringify(value) ?? 'undefined';
		}

		telemetryData.properties['headerRequestId'] = ourRequestId;
		this._telemetryService.sendGHTelemetryEvent('request.sent', telemetryData.properties, telemetryData.measurements);

		const requestStart = Date.now();
		const handle = connection.sendRequest(request as Record<string, unknown>, cancellationToken);

		const extendedBaseTelemetryData = baseTelemetryData.extendedBy({ modelCallId });
		const processor = this._instantiationService.createInstance(OpenAIResponsesProcessor, extendedBaseTelemetryData, ourRequestId, '');

		const chatCompletions = new AsyncIterableObject<ChatCompletion>(async emitter => {
			try {
				await new Promise<void>((resolve, reject) => {
					handle.onEvent(event => {
						const completion = processor.push(event, finishedCb);
						if (completion) {
							sendCompletionOutputTelemetry(this._telemetryService, this._logService, completion, extendedBaseTelemetryData);
							emitter.emitOne(completion);
						}
					});

					handle.onError(error => {
						if (isCancellationError(error)) {
							reject(error);
							return;
						}

						const warningTelemetry = telemetryData.extendedBy({ error: error.message });
						this._telemetryService.sendGHTelemetryEvent('request.shownWarning', warningTelemetry.properties, warningTelemetry.measurements);

						const totalTimeMs = Date.now() - requestStart;
						telemetryData.measurements.totalTimeMs = totalTimeMs;
						telemetryData.properties.error = error.message;

						this._logService.debug(`request.error: [websocket], took ${totalTimeMs} ms`);
						this._telemetryService.sendGHTelemetryEvent('request.error', telemetryData.properties, telemetryData.measurements);

						reject(error);
					});

					handle.onComplete(() => {
						const totalTimeMs = Date.now() - requestStart;
						telemetryData.measurements.totalTimeMs = totalTimeMs;

						this._logService.debug(`request.response: [websocket], took ${totalTimeMs} ms`);
						this._telemetryService.sendGHTelemetryEvent('request.response', telemetryData.properties, telemetryData.measurements);
						resolve();
					});
				});
			} finally {
				let messagesToLog = request.messages;
				if ((!messagesToLog || messagesToLog.length === 0) && (request as OpenAI.Responses.ResponseCreateParams).input) {
					try {
						const rawMessages = responseApiInputToRawMessagesForLogging(request as OpenAI.Responses.ResponseCreateParams);
						messagesToLog = rawMessageToCAPI(rawMessages);
					} catch (e) {
						this._logService.error(`Failed to convert Response API input to messages for telemetry:`, e);
						messagesToLog = [];
					}
				}
				sendEngineMessagesTelemetry(this._telemetryService, messagesToLog ?? [], telemetryData, false, this._logService);
			}
		});

		return {
			result: {
				type: FetchResponseKind.Success,
				chatCompletions,
			}
		};
	}

	private async _doFetchViaHttp(
		chatEndpointInfo: IChatEndpoint,
		request: IEndpointBody,
		baseTelemetryData: TelemetryData,
		finishedCb: FinishedCallback,
		secretKey: string,
		location: ChatLocation,
		ourRequestId: string,
		nChoices: number | undefined,
		cancellationToken: CancellationToken,
		userInitiatedRequest: boolean | undefined,
		telemetryProperties: TelemetryProperties | undefined,
		useFetcher: FetcherId | undefined,
		canRetryOnce: boolean | undefined,
		requestKindOptions: IBackgroundRequestOptions | ISubagentRequestOptions | undefined,
	): Promise<{ result: ChatResults | ChatRequestFailed | ChatRequestCanceled; fetcher?: FetcherId; bytesReceived?: number; statusCode?: number }> {
		// Generate unique ID to link input and output messages
		const modelCallId = generateUuid();

		const response = await this._fetchWithInstrumentation(
			chatEndpointInfo,
			ourRequestId,
			request,
			secretKey,
			location,
			cancellationToken,
			userInitiatedRequest,
			{ ...telemetryProperties, modelCallId },
			useFetcher,
			canRetryOnce,
			requestKindOptions,
		);

		if (cancellationToken.isCancellationRequested) {
			try {
				// Destroy the stream so that the server is hopefully notified we don't want any more data
				// and can cancel/forget about the request itself.
				await response!.body.destroy();
			} catch (e) {
				this._logService.error(e, `Error destroying stream`);
				this._telemetryService.sendGHTelemetryException(e, 'Error destroying stream');
			}
			return {
				result: { type: FetchResponseKind.Canceled, reason: 'after fetch request' },
				fetcher: response.fetcher,
				bytesReceived: response.bytesReceived
			};
		}
		ourRequestId: string,
		request: IEndpointBody,
		secretKey: string,
		location: ChatLocation,
		cancellationToken: CancellationToken,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
		useFetcher?: FetcherId,
		canRetryOnce?: boolean,
		requestKindOptions?: IBackgroundRequestOptions | ISubagentRequestOptions,
	): Promise<Response> {

		// If request contains an image, we include this header.
		const additionalHeaders: Record<string, string> = {
			'X-Interaction-Id': this._interactionService.interactionId,
			'X-Initiator': userInitiatedRequest ? 'user' : 'agent', // Agent = a system request / not the primary user query.
		};
		if (request.messages?.some((m: CAPIChatMessage) => Array.isArray(m.content) ? m.content.some(c => 'image_url' in c) : false) && chatEndpoint.supportsVision) {
			additionalHeaders['Copilot-Vision-Request'] = 'true';
		}
		const telemetryData = TelemetryData.createAndMarkAsIssued({
			endpoint: 'completions',
			engineName: 'chat',
			uiKind: ChatLocation.toString(location),
			transport: 'http',
			...telemetryProperties // This includes the modelCallId from fetchAndStreamChat
		}, {
			maxTokenWindow: chatEndpoint.modelMaxPromptTokens
		});

		for (const [key, value] of Object.entries(request)) {
			if (key === 'messages' || key === 'input') {
				continue;
			} // Skip messages (PII)
			telemetryData.properties[`request.option.${key}`] = JSON.stringify(value) ?? 'undefined';
		}

		// The request ID we are passed in is sent in the request to the proxy, and included in our pre-request telemetry.
		// We hope (but do not rely on) that the model will use the same ID in the response, allowing us to correlate
		// the request and response.
		telemetryData.properties['headerRequestId'] = ourRequestId;

		this._telemetryService.sendGHTelemetryEvent('request.sent', telemetryData.properties, telemetryData.measurements);

		const requestStart = Date.now();
		const intent = locationToIntent(location);

		// Wrap the Promise with success/error callbacks so we can log/measure it
		return this._instantiationService.invokeFunction(postRequest, {
			endpointOrUrl: chatEndpoint,
			secretKey,
			intent,
			requestId: ourRequestId,
			body: request,
			additionalHeaders,
			cancelToken: cancellationToken,
			useFetcher,
			canRetryOnce,
			location,
			requestKindOptions,
		}).then(response => {
			const apim = response.headers.get('apim-request-id');
			if (apim) {
				this._logService.debug(`APIM request id: ${apim}`);
			}
			const ghRequestId = response.headers.get('x-github-request-id');
			if (ghRequestId) {
				this._logService.debug(`GH request id: ${ghRequestId}`);
			}
			// This ID is hopefully the one the same as ourRequestId, but it is not guaranteed.
			// If they are different then we will override the original one we set in telemetryData above.
			const modelRequestId = getRequestId(response.headers);
			telemetryData.extendWithRequestId(modelRequestId);

			// TODO: Add response length (requires parsing)
			const totalTimeMs = Date.now() - requestStart;
			telemetryData.measurements.totalTimeMs = totalTimeMs;

			this._logService.debug(`request.response: [${stringifyUrlOrRequestMetadata(chatEndpoint.urlOrRequestMetadata)}], took ${totalTimeMs} ms`);

			this._telemetryService.sendGHTelemetryEvent('request.response', telemetryData.properties, telemetryData.measurements);

			return response;
		})
			.catch(error => {
				if (this._fetcherService.isAbortError(error)) {
					// If we cancelled a network request, we don't want to log a `request.error`
					throw error;
				}

				const warningTelemetry = telemetryData.extendedBy({ error: 'Network exception' });
				this._telemetryService.sendGHTelemetryEvent('request.shownWarning', warningTelemetry.properties, warningTelemetry.measurements);

				telemetryData.properties.code = String(error.code ?? '');
				telemetryData.properties.errno = String(error.errno ?? '');
				telemetryData.properties.message = String(error.message ?? '');
				telemetryData.properties.type = String(error.type ?? '');

				const totalTimeMs = Date.now() - requestStart;
				telemetryData.measurements.totalTimeMs = totalTimeMs;

				this._logService.debug(`request.response: [${stringifyUrlOrRequestMetadata(chatEndpoint.urlOrRequestMetadata)}] took ${totalTimeMs} ms`);

				this._telemetryService.sendGHTelemetryEvent('request.error', telemetryData.properties, telemetryData.measurements);

				throw error;
			})
			.finally(() => {
				let messagesToLog = request.messages;

				// For Response API (has input but no messages), convert input to messages for logging
				if ((!messagesToLog || messagesToLog.length === 0) && (request as OpenAI.Responses.ResponseCreateParams).input) {
					try {
						const rawMessages = responseApiInputToRawMessagesForLogging(request as OpenAI.Responses.ResponseCreateParams);
						messagesToLog = rawMessageToCAPI(rawMessages);
					} catch (e) {
						this._logService.error(`Failed to convert Response API input to messages for telemetry:`, e);
						messagesToLog = [];
					}
				}

				sendEngineMessagesTelemetry(this._telemetryService, messagesToLog ?? [], telemetryData, false, this._logService);
			});
	}

	private async _handleError(
		telemetryData: TelemetryData,
		response: Response,
		requestId: string
	): Promise<ChatRequestFailed> {
		const modelRequestIdObj = getRequestId(response.headers);
		requestId = modelRequestIdObj.headerRequestId || requestId;
		modelRequestIdObj.headerRequestId = requestId;

		telemetryData.properties.error = `Response status was ${response.status}`;
		telemetryData.properties.status = String(response.status);
		this._telemetryService.sendGHTelemetryEvent('request.shownWarning', telemetryData.properties, telemetryData.measurements);

		const text = await response.text();
		let jsonData: Record<string, any> | undefined;
		try {
			jsonData = JSON.parse(text);
			jsonData = jsonData?.error ?? jsonData; // Extract nested error object if it exists
		} catch {
			// JSON parsing failed, it's not json content.
		}

		const reasonNoText = `Server error: ${response.status}`;
		const reason = `${reasonNoText} ${text}`;
		this._logService.error(reason);

		if (400 <= response.status && response.status < 500) {

			if (response.status === 400 && text.includes('off_topic')) {
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.OffTopic,
					reason: 'filtered as off_topic by intent classifier: message was not programming related',
				};
			}

			if (response.status === 401 && text.includes('authorize_url') && jsonData?.authorize_url) {
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.AgentUnauthorized,
					reason: response.statusText || response.statusText,
					data: jsonData
				};
			}

			if (response.status === 400 && jsonData?.code === 'previous_response_not_found') {
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.InvalidPreviousResponseId,
					reason: jsonData.message || 'Invalid previous response ID',
					data: jsonData,
				};
			}

			if (response.status === 401 || response.status === 403) {
				// Token has expired or invalid, fetch a new one on next request
				// TODO(drifkin): these actions should probably happen in vsc specific code
				this._authenticationService.resetCopilotToken(response.status);
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.TokenExpiredOrInvalid,
					reason: jsonData?.message || `token expired or invalid: ${response.status}`,
				};
			}

			if (response.status === 402) {
				// When we receive a 402, we have exceed a quota
				// This is stored on the token so let's refresh it
				if (!this._authenticationService.copilotToken?.isChatQuotaExceeded) {
					this._authenticationService.resetCopilotToken(response.status);
					await this._authenticationService.getCopilotToken();
				}


				const retryAfter = response.headers.get('retry-after');

				const convertToDate = (retryAfterString: string | null): Date | undefined => {
					if (!retryAfterString) {
						return undefined;
					}

					// Try treating it as a date
					const retryAfterDate = new Date(retryAfterString);
					if (!isNaN(retryAfterDate.getDate())) {
						return retryAfterDate;
					}

					// It is not a date, try treating it as a duration from the current date
					const retryAfterDuration = parseInt(retryAfterString, 10);
					if (isNaN(retryAfterDuration)) {
						return undefined;
					}

					return new Date(Date.now() + retryAfterDuration * 1000);
				};

				const retryAfterDate = convertToDate(retryAfter);

				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.QuotaExceeded,
					reason: jsonData?.message ?? 'Free tier quota exceeded',
					data: {
						capiError: jsonData,
						retryAfter: retryAfterDate
					}
				};
			}

			if (response.status === 404) {
				let errorReason: string;

				// Check if response body is valid JSON
				if (!jsonData) {
					errorReason = text;
				} else {
					errorReason = JSON.stringify(jsonData);
				}

				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.NotFound,
					reason: errorReason
				};
			}

			if (response.status === 422) {
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.ContentFilter,
					reason: 'Filtered by Responsible AI Service\n\n' + text,
				};
			}

			if (response.status === 424) {
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.AgentFailedDependency,
					reason: text
				};
			}

			if (response.status === 429) {
				let rateLimitReason = text;
				rateLimitReason = jsonData?.message ?? jsonData?.code;

				if (text.includes('extension_blocked') && jsonData?.code === 'extension_blocked' && jsonData?.type === 'rate_limit_error') {
					return {
						type: FetchResponseKind.Failed,
						modelRequestId: modelRequestIdObj,
						failKind: ChatFailKind.ExtensionBlocked,
						reason: 'Extension blocked',
						data: {
							...jsonData?.message,
							retryAfter: response.headers.get('retry-after'),
						}
					};
				}

				// HTTP 429 Too Many Requests
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.RateLimited,
					reason: rateLimitReason,
					data: {
						retryAfter: response.headers.get('retry-after'),
						rateLimitKey: response.headers.get('x-ratelimit-exceeded'),
						capiError: jsonData
					}
				};
			}

			if (response.status === 466) {
				this._logService.info(text);
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.ClientNotSupported,
					reason: `client not supported: ${text}`
				};
			}

			if (response.status === 499) {
				this._logService.info('Cancelled by server');
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.ServerCanceled,
					reason: 'canceled by server'
				};
			}

		} else if (500 <= response.status && response.status < 600) {

			if (response.status === 503) {
				return {
					type: FetchResponseKind.Failed,
					modelRequestId: modelRequestIdObj,
					failKind: ChatFailKind.RateLimited,
					reason: 'Upstream provider rate limit hit',
					data: {
						retryAfter: null,
						rateLimitKey: null,
						capiError: { code: 'upstream_provider_rate_limit', message: text }
					}
				};
			}

			// HTTP 5xx Server Error
			return {
				type: FetchResponseKind.Failed,
				modelRequestId: modelRequestIdObj,
				failKind: ChatFailKind.ServerError,
				reason: reasonNoText,
			};
		}

		this._logService.error(`Request Failed: ${response.status} ${text}`);

		sendCommunicationErrorTelemetry(this._telemetryService, 'Unhandled status from server: ' + response.status, text);

		return {
			type: FetchResponseKind.Failed,
			modelRequestId: modelRequestIdObj,
			failKind: ChatFailKind.Unknown,
			reason: `Request Failed: ${response.status} ${text}`
		};
	}

	private async processSuccessfulResponse(
		response: ChatResults,
		messages: Raw.ChatMessage[],
		requestBody: IEndpointBody,
		requestId: string,
		maxResponseTokens: number,
		promptTokenCount: number,
		timeToFirstToken: number,
		streamRecorder: FetchStreamRecorder,
		baseTelemetry: TelemetryData,
		chatEndpointInfo: IChatEndpoint,
		userInitiatedRequest: boolean | undefined,
		transport: string,
		fetcher: FetcherId | undefined,
		bytesReceived: number | undefined,
		suspendEventSeen: boolean | undefined,
		resumeEventSeen: boolean | undefined,
	): Promise<ChatResponses | ChatFetchRetriableError<string[]>> {

		const completions: ChatCompletion[] = [];

		for await (const chatCompletion of response.chatCompletions) {
			Telemetry.sendSuccessTelemetry(
				this._telemetryService,
				{
					chatCompletion,
					baseTelemetry,
					userInitiatedRequest,
					chatEndpointInfo,
					requestBody,
					maxResponseTokens,
					promptTokenCount,
					timeToFirstToken,
					timeToFirstTokenEmitted: (baseTelemetry && streamRecorder.firstTokenEmittedTime) ? streamRecorder.firstTokenEmittedTime - baseTelemetry.issuedTime : -1,
					hasImageMessages: this.filterImageMessages(messages),
					transport,
					fetcher,
					bytesReceived,
					suspendEventSeen,
					resumeEventSeen,
				}
			);

			if (!this.isRepetitive(chatCompletion, baseTelemetry?.properties)) {
				completions.push(chatCompletion);
			}
		}
		const successFinishReasons = new Set([FinishedCompletionReason.Stop, FinishedCompletionReason.ClientTrimmed, FinishedCompletionReason.FunctionCall, FinishedCompletionReason.ToolCalls]);
		const successfulCompletions = completions.filter(c => successFinishReasons.has(c.finishReason));
		if (successfulCompletions.length >= 1) {
			return {
				type: ChatFetchResponseType.Success,
				resolvedModel: successfulCompletions[0].model,
				usage: successfulCompletions.length === 1 ? successfulCompletions[0].usage : undefined,
				value: successfulCompletions.map(c => getTextPart(c.message.content)),
				requestId,
				serverRequestId: successfulCompletions[0].requestId.headerRequestId,
			};
		}

		const result = completions.at(0);

		switch (result?.finishReason) {
			case FinishedCompletionReason.ContentFilter:
				return {
					type: ChatFetchResponseType.FilteredRetry,
					category: result.filterReason ?? FilterReason.Copyright,
					reason: 'Response got filtered.',
					value: completions.map(c => getTextPart(c.message.content)),
					requestId: requestId,
					serverRequestId: result.requestId.headerRequestId,
				};
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

	/**
	 * Check for repetition in partial response deltas from a cancelled request.
	 *
	 * This method performs the same repetition detection as the `isRepetitive` method,
	 * but operates on partial response data collected before the request was cancelled.
	 *
	 * Key differences from completed requests:
	 * - Text is reconstructed from delta.text values instead of message.content
	 * - Tokens are approximated by splitting text on whitespace instead of using
	 *   the actual token array (which is only available in completed responses)
	 * - Enhanced telemetry won't include RequestId fields since we only have the
	 *   headerRequestId string, not the full RequestId object
	 * - The finishReason is marked as 'canceled' to distinguish from server-generated
	 *   finish reasons
	 */
	private checkRepetitionInDeltas(
		deltas: IResponseDelta[],
		requestId: string,
		telemetryProperties?: TelemetryProperties
	): void {
		// Reconstruct the text content from deltas (filter out null, undefined, and empty text values)
		const textContent = deltas.filter(delta => delta.text?.length > 0).map(delta => delta.text).join('');

		// Early exit if no content
		if (!textContent || textContent.trim().length === 0) {
			return;
		}

		// For cancelled requests, we don't have the actual token array (only available in ChatCompletion),
		// so we approximate by splitting text content on whitespace. This is less precise than actual
		// tokenization but sufficient for detecting obvious repetition patterns.
		const tokens = textContent.split(/\s+/).filter(t => t.length > 0);

		// Check for line repetition
		const lineRepetitionStats = calculateLineRepetitionStats(textContent);

		// Check for token-level repetition
		const hasRepetition = isRepetitive(tokens);

		// Send telemetry if repetition is detected
		if (hasRepetition) {
			const telemetryData = TelemetryData.createAndMarkAsIssued();
			const extended = telemetryData.extendedBy(telemetryProperties);
			// Note: For cancelled requests, we don't have a full RequestId object,
			// so we can't use extendWithRequestId like the non-cancelled path does.
			// This means enhanced telemetry for cancelled requests won't include
			// completionId, created, deploymentId, or serverExperiments fields.
			this._telemetryService.sendEnhancedGHTelemetryEvent('conversation.repetition.detected', extended.properties, extended.measurements);
		}

		if (lineRepetitionStats.numberOfRepetitions >= 10) {
			this._telemetryService.sendMSFTTelemetryEvent('conversation.repetition.detected', {
				requestId: requestId,
				finishReason: 'canceled', // Client-side finish reason to distinguish from server-generated reasons
			}, {
				numberOfRepetitions: lineRepetitionStats.numberOfRepetitions,
				lengthOfLine: lineRepetitionStats.mostRepeatedLine.length,
				totalLines: lineRepetitionStats.totalLines
			});
		}
	}

	private processCanceledResponse(
		response: ChatRequestCanceled,
		requestId: string,
		streamRecorder?: FetchStreamRecorder,
		telemetryProperties?: TelemetryProperties
	): ChatResponses {
		// Check for repetition in the partial response before cancellation
		if (streamRecorder && streamRecorder.deltas.length > 0) {
			this.checkRepetitionInDeltas(streamRecorder.deltas, requestId, telemetryProperties);
		}

		return {
			type: ChatFetchResponseType.Canceled,
			reason: response.reason,
			requestId: requestId,
			serverRequestId: undefined,
		};
	}

	private processFailedResponse(response: ChatRequestFailed, requestId: string): ChatFetchError {
		const serverRequestId = response.modelRequestId?.gitHubRequestId;
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
		if (response.failKind === ChatFailKind.InvalidPreviousResponseId) {
			return { type: ChatFetchResponseType.InvalidStatefulMarker, reason, requestId, serverRequestId };
		}

		return { type: ChatFetchResponseType.Failed, reason, requestId, serverRequestId };
	}

	private processError(err: unknown, requestId: string, gitHubRequestId: string | undefined, usernameToScrub: string | undefined): ChatFetchError {
		const fetcher = this._fetcherService;
		// If we cancelled a network request, we don't want to log an error
		if (fetcher.isAbortError(err)) {
			return {
				type: ChatFetchResponseType.Canceled,
				reason: 'network request aborted',
				requestId: requestId,
				serverRequestId: gitHubRequestId,
			};
		}
		if (isCancellationError(err)) {
			return {
				type: ChatFetchResponseType.Canceled,
				reason: 'Got a cancellation error',
				requestId: requestId,
				serverRequestId: gitHubRequestId,
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
				serverRequestId: gitHubRequestId,
			};
		}
		this._logService.error(ErrorUtils.fromUnknown(err), `Error on conversation request`);
		this._telemetryService.sendGHTelemetryException(err, 'Error on conversation request');
		const userMessage = fetcher.getUserMessageForFetcherError(err);
		const errorDetail = collectSingleLineErrorMessage(err, true);
		const scrubbedErrorDetail = this.scrubErrorDetail(errorDetail, usernameToScrub);
		if (fetcher.isInternetDisconnectedError(err)) {
			return {
				type: ChatFetchResponseType.NetworkError,
				reason: `It appears you're not connected to the internet, please check your network connection and try again.`,
				reasonDetail: scrubbedErrorDetail,
				requestId: requestId,
				serverRequestId: gitHubRequestId,
			};
		} else if (fetcher.isFetcherError(err)) {
			const isNetworkProcessCrash = fetcher.isNetworkProcessCrashedError(err);
			return {
				type: ChatFetchResponseType.NetworkError,
				reason: userMessage,
				reasonDetail: scrubbedErrorDetail,
				requestId: requestId,
				serverRequestId: gitHubRequestId,
				...(isNetworkProcessCrash ? { isNetworkProcessCrash: true } : {}),
			};
		} else {
			return {
				type: ChatFetchResponseType.Failed,
				reason: 'Error on conversation request. Check the log for more details.',
				reasonDetail: scrubbedErrorDetail,
				requestId: requestId,
				serverRequestId: gitHubRequestId,
			};
		}
	}

	private scrubErrorDetail(errorDetail: string, usernameToScrub: string | undefined) {
		if (usernameToScrub) {
			const regex = new RegExp(escapeRegExpCharacters(usernameToScrub), 'ig');
			errorDetail = errorDetail.replaceAll(regex, '<login>');
		}
		return errorDetail.replaceAll(/(?<=logged in as )(?!<login>)[^\s]+/ig, '!<login>!'); // marking fallback with !
	}
}

/**
 * Validates a chat request payload to ensure it is valid
 * @param params The params being sent in the chat request
 * @returns Whether the chat payload is valid
 */
function isValidChatPayload(messages: Raw.ChatMessage[], postOptions: OptionalChatRequestParams, endpoint: IChatEndpoint, configurationService: IConfigurationService, experimentationService: IExperimentationService): { isValid: boolean; reason: string } {
	if (messages.length === 0) {
		return { isValid: false, reason: asUnexpected('No messages provided') };
	}
	if (postOptions?.max_tokens && postOptions?.max_tokens < 1) {
		return { isValid: false, reason: asUnexpected('Invalid response token parameter') };
	}

	const functionNamePattern = /^[a-zA-Z0-9_-]+$/;
	if (
		postOptions?.functions?.some(f => !f.name.match(functionNamePattern)) ||
		postOptions?.function_call?.name && !postOptions.function_call.name.match(functionNamePattern)
	) {
		return { isValid: false, reason: asUnexpected('Function names must match ^[a-zA-Z0-9_-]+$') };
	}

	if (postOptions?.tools && postOptions.tools.length > HARD_TOOL_LIMIT && !isAnthropicToolSearchEnabled(endpoint, configurationService)) {
		return { isValid: false, reason: `Tool limit exceeded (${postOptions.tools.length}/${HARD_TOOL_LIMIT}). Click "Configure Tools" in the chat input to disable ${postOptions.tools.length - HARD_TOOL_LIMIT} tools and retry.` };
	}

	return { isValid: true, reason: '' };
}

function asUnexpected(reason: string) {
	return `Prompt failed validation with the reason: ${reason}. Please file an issue.`;
}

export function createTelemetryData(chatEndpointInfo: IChatEndpoint, location: ChatLocation, headerRequestId: string) {
	return TelemetryData.createAndMarkAsIssued({
		endpoint: 'completions',
		engineName: 'chat',
		uiKind: ChatLocation.toString(location),
		headerRequestId
	});
}

/**
 * WARNING: The value that is returned from this function drives the disablement of RAI for full-file rewrite requests
 * in Copilot Edits, Copilot Chat, Agent Mode, and Inline Chat.
 * If your chat location generates full-file rewrite requests and you are unsure if changing something here will cause problems, please talk to @roblourens
 */

export function locationToIntent(location: ChatLocation): string {
	switch (location) {
		case ChatLocation.Panel:
			return 'conversation-panel';
		case ChatLocation.Editor:
			return 'conversation-inline';
		case ChatLocation.EditingSession:
			return 'conversation-edits';
		case ChatLocation.Notebook:
			return 'conversation-notebook';
		case ChatLocation.Terminal:
			return 'conversation-terminal';
		case ChatLocation.Other:
			return 'conversation-other';
		case ChatLocation.Agent:
			return 'conversation-agent';
		case ChatLocation.ResponsesProxy:
			return 'responses-proxy';
		case ChatLocation.MessagesProxy:
			return 'messages-proxy';
	}
}
