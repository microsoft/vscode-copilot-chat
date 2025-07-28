/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClientHttp2Stream } from 'http2';
import type { CancellationToken } from 'vscode';
import { createRequestHMAC } from '../../../util/common/crypto';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IntentParams } from '../../chat/common/chatMLFetcher';
import { IChatQuotaService } from '../../chat/common/chatQuotaService';
import { ChatLocation } from '../../chat/common/commonTypes';
import { IInteractionService } from '../../chat/common/interactionService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { FinishedCallback, OptionalChatRequestParams, RequestId, getProcessingTime, getRequestId } from '../../networking/common/fetch';
import { IFetcherService, Response } from '../../networking/common/fetcherService';
import { IChatEndpoint, postRequest, stringifyUrlOrRequestMetadata } from '../../networking/common/networking';
import { CAPIChatMessage, ChatCompletion } from '../../networking/common/openai';
import { sendEngineMessagesTelemetry } from '../../networking/node/chatStream';
import { sendCommunicationErrorTelemetry } from '../../networking/node/stream';
import { ITelemetryService, TelemetryProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';

/** based on https://platform.openai.com/docs/api-reference/chat/create */
interface RequiredChatRequestParams {
	model: string;
	messages: CAPIChatMessage[];
}

interface CopilotOnlyParams {

	/** Copilot-only: names of experimental features to enable in the proxy. */
	feature_flags?: string[];

	/** Copilot-only: NWO of repository, if any */
	nwo?: string;

	copilot_thread_id?: string;
}

export declare interface ChatRequest extends
	RequiredChatRequestParams, OptionalChatRequestParams, CopilotOnlyParams, IntentParams {
}

export interface ChatParams {
	messages: CAPIChatMessage[];
	model: string;
	location: ChatLocation;
	allowEmptyChoices?: boolean;
	postOptions?: OptionalChatRequestParams;
	ourRequestId: string;
	requestLogProbs?: boolean;
	intent?: boolean;
	intent_threshold?: number;
	secretKey?: string;
}

export enum FetchResponseKind {
	Success = 'success',
	Failed = 'failed',
	Canceled = 'canceled',
}

export interface ChatResults {
	type: FetchResponseKind.Success;
	chatCompletions: AsyncIterable<ChatCompletion>;
	getProcessingTime(): number;
}

export interface ChatRequestFailed {
	type: FetchResponseKind.Failed;
	modelRequestId: RequestId | undefined;
	failKind: ChatFailKind;
	reason: string;
	data?: Record<string, any>;
}

export interface ChatRequestCanceled {
	type: FetchResponseKind.Canceled;
	reason: string;
}

export enum ChatFailKind {
	OffTopic = 'offTopic',
	TokenExpiredOrInvalid = 'tokenExpiredOrInvalid',
	ServerCanceled = 'serverCanceled',
	ClientNotSupported = 'clientNotSupported',
	RateLimited = 'rateLimited',
	QuotaExceeded = 'quotaExceeded',
	ExtensionBlocked = 'extensionBlocked',
	ServerError = 'serverError',
	ContentFilter = 'contentFilter',
	AgentUnauthorized = 'unauthorized',
	AgentFailedDependency = 'failedDependency',
	ValidationFailed = 'validationFailed',
	NotFound = 'notFound',
	Unknown = 'unknown',
}

/**
 * A fetcher specialized to fetch ChatML completions. This differs from the standard fetcher in the form that ChatML
 * requires a different datamodel. Details can be found here https://platform.openai.com/docs/guides/chat
 *
 * This fetcher was created because the standard fetcher is tightly coupled to the OpenAI API completion models and a major refactoring
 * or rewrite is necessary to have a more generic fetcher that can be used for both completions and chat models.
 */
export async function fetchAndStreamChat(
	logService: ILogService,
	telemetryService: ITelemetryService,
	fetcherService: IFetcherService,
	envService: IEnvService,
	chatQuotaService: IChatQuotaService,
	domainService: IDomainService,
	capiClientService: ICAPIClientService,
	authenticationService: IAuthenticationService,
	interactionService: IInteractionService,
	chatEndpointInfo: IChatEndpoint,
	params: ChatParams,
	baseTelemetryData: TelemetryData,
	finishedCb: FinishedCallback,
	userInitiatedRequest?: boolean,
	cancel?: CancellationToken | undefined,
	telemetryProperties?: TelemetryProperties | undefined
): Promise<ChatResults | ChatRequestFailed | ChatRequestCanceled> {
	const request = createChatRequest(params);

	if (cancel?.isCancellationRequested) {
		return { type: FetchResponseKind.Canceled, reason: 'before fetch request' };
	}

	logService.debug(`modelMaxPromptTokens ${chatEndpointInfo.modelMaxPromptTokens}`);
	logService.debug(`modelMaxResponseTokens ${request.max_tokens ?? 2048}`);
	logService.debug(`chat model ${params.model}`);

	const secretKey = params.secretKey ?? (await authenticationService.getCopilotToken()).token;
	if (!secretKey) {
		// If no key is set we error
		const urlOrRequestMetadata = stringifyUrlOrRequestMetadata(chatEndpointInfo.urlOrRequestMetadata);
		logService.error(`Failed to send request to ${urlOrRequestMetadata} due to missing key`);
		sendCommunicationErrorTelemetry(telemetryService, `Failed to send request to ${urlOrRequestMetadata} due to missing key`);
		return {
			type: FetchResponseKind.Failed,
			modelRequestId: undefined,
			failKind: ChatFailKind.TokenExpiredOrInvalid,
			reason: 'key is missing'
		};
	}

	const response = await fetchWithInstrumentation(
		logService,
		telemetryService,
		fetcherService,
		envService,
		domainService,
		capiClientService,
		interactionService,
		chatEndpointInfo,
		params.ourRequestId,
		request,
		secretKey,
		params.location,
		userInitiatedRequest,
		cancel,
		telemetryProperties);

	if (cancel?.isCancellationRequested) {
		const body = await response!.body();
		try {
			// Destroy the stream so that the server is hopefully notified we don't want any more data
			// and can cancel/forget about the request itself.
			(body as ClientHttp2Stream).destroy();
		} catch (e) {
			logService.error(e, `Error destroying stream`);
			telemetryService.sendGHTelemetryException(e, 'Error destroying stream');
		}
		return { type: FetchResponseKind.Canceled, reason: 'after fetch request' };
	}

	if (response.status === 200 && authenticationService.copilotToken?.isFreeUser && authenticationService.copilotToken?.isChatQuotaExceeded) {
		authenticationService.resetCopilotToken();
	}

	if (response.status !== 200) {
		const telemetryData = createTelemetryData(chatEndpointInfo, params.location, params.ourRequestId);
		logService.info('Request ID for failed request: ' + params.ourRequestId);
		return handleError(logService, telemetryService, authenticationService, telemetryData, response, params.ourRequestId);
	}

	const nChoices = params.postOptions?.n ?? /* OpenAI's default */ 1;
	const chatCompletions = await chatEndpointInfo.processResponseFromChatEndpoint(
		telemetryService,
		logService,
		response,
		nChoices,
		finishedCb,
		baseTelemetryData,
		cancel
	);

	// CAPI will return us a Copilot Edits Session Header which is our token to using the speculative decoding endpoint
	// We should store this in the auth service for easy use later
	if (response.headers.get('Copilot-Edits-Session')) {
		authenticationService.speculativeDecodingEndpointToken = response.headers.get('Copilot-Edits-Session') ?? undefined;
	}

	chatQuotaService.processQuotaHeaders(response.headers);

	return {
		type: FetchResponseKind.Success,
		chatCompletions: chatCompletions,
		getProcessingTime: () => getProcessingTime(response),
	};
}

function createTelemetryData(chatEndpointInfo: IChatEndpoint, location: ChatLocation, headerRequestId: string) {
	return TelemetryData.createAndMarkAsIssued({
		endpoint: 'completions',
		engineName: 'chat',
		uiKind: ChatLocation.toString(location),
		headerRequestId
	});
}

function createChatRequest(params: ChatParams): ChatRequest {

	// FIXME@ulugbekna: need to investigate why language configs have such stop words, eg
	// python has `\ndef` and `\nclass` which must be stop words for ghost text
	// const stops = getLanguageConfig<string[]>(accessor, ConfigKey.Stops);

	const request: ChatRequest = {
		messages: params.messages,
		model: params.model,
		// stop: stops,
	};

	if (params.postOptions) {
		Object.assign(request, params.postOptions);
	}

	if (params.intent) {
		request['intent'] = params.intent;
		if (params.intent_threshold) {
			request['intent_threshold'] = params.intent_threshold;
		}
	}

	return request;
}

async function handleError(
	logService: ILogService,
	telemetryService: ITelemetryService,
	authenticationService: IAuthenticationService,
	telemetryData: TelemetryData,
	response: Response,
	requestId: string,
): Promise<ChatRequestFailed> {
	const modelRequestIdObj = getRequestId(response, undefined);
	requestId = modelRequestIdObj.headerRequestId || requestId;
	modelRequestIdObj.headerRequestId = requestId;

	telemetryData.properties.error = `Response status was ${response.status}`;
	telemetryData.properties.status = String(response.status);
	telemetryService.sendGHTelemetryEvent('request.shownWarning', telemetryData.properties, telemetryData.measurements);

	const text = await response.text();
	let jsonData: Record<string, any> | undefined;
	try {
		jsonData = JSON.parse(text);
		jsonData = jsonData?.error ?? jsonData; // Extract nested error object if it exists
	} catch {
		// JSON parsing failed, it's not json content.
	}

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

		if (response.status === 401 || response.status === 403) {
			// Token has expired or invalid, fetch a new one on next request
			// TODO(drifkin): these actions should probably happen in vsc specific code
			authenticationService.resetCopilotToken(response.status);
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
			authenticationService.resetCopilotToken(response.status);

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
			return {
				type: FetchResponseKind.Failed,
				modelRequestId: modelRequestIdObj,
				failKind: ChatFailKind.NotFound,
				reason: 'Resource not found'
			};
		}

		if (response.status === 422) {
			return {
				type: FetchResponseKind.Failed,
				modelRequestId: modelRequestIdObj,
				failKind: ChatFailKind.ContentFilter,
				reason: 'Filtered by Responsible AI Service'
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
			logService.info(text);
			return {
				type: FetchResponseKind.Failed,
				modelRequestId: modelRequestIdObj,
				failKind: ChatFailKind.ClientNotSupported,
				reason: `client not supported: ${text}`
			};
		}

		if (response.status === 499) {
			logService.info('Cancelled by server');
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

		const reasonNoText = `Server error: ${response.status}`;
		const reason = `${reasonNoText} ${text}`;
		logService.error(reason);
		// HTTP 5xx Server Error
		return {
			type: FetchResponseKind.Failed,
			modelRequestId: modelRequestIdObj,
			failKind: ChatFailKind.ServerError,
			reason: reasonNoText,
		};
	}

	logService.error(`Request Failed: ${response.status} ${text}`);

	sendCommunicationErrorTelemetry(telemetryService, 'Unhandled status from server: ' + response.status, text);

	return {
		type: FetchResponseKind.Failed,
		modelRequestId: modelRequestIdObj,
		failKind: ChatFailKind.Unknown,
		reason: `Request Failed: ${response.status} ${text}`
	};
}

async function fetchWithInstrumentation(
	logService: ILogService,
	telemetryService: ITelemetryService,
	fetcherService: IFetcherService,
	envService: IEnvService,
	domainService: IDomainService,
	capiClientService: ICAPIClientService,
	interactionService: IInteractionService,
	chatEndpoint: IChatEndpoint,
	ourRequestId: string,
	request: Partial<ChatRequest>,
	secretKey: string,
	location: ChatLocation,
	userInitiatedRequest?: boolean,
	cancel?: CancellationToken,
	telemetryProperties?: TelemetryProperties
): Promise<Response> {

	// If request contains an image, we include this header.
	const additionalHeaders: Record<string, string> = {
		'X-Interaction-Id': interactionService.interactionId,
		'X-Initiator': userInitiatedRequest ? 'user' : 'agent', // Agent = a system request / not the primary user query.
	};
	if (request.messages?.some(m => Array.isArray(m.content) ? m.content.some(c => 'image_url' in c) : false) && chatEndpoint.supportsVision) {
		additionalHeaders['Copilot-Vision-Request'] = 'true';
	}
	const telemetryData = TelemetryData.createAndMarkAsIssued({
		endpoint: 'completions',
		engineName: 'chat',
		uiKind: ChatLocation.toString(location),
		...telemetryProperties
	}, {
		maxTokenWindow: chatEndpoint.modelMaxPromptTokens
	});

	for (const [key, value] of Object.entries(request)) {
		if (key === 'messages') {
			continue;
		} // Skip messages (PII)
		telemetryData.properties[`request.option.${key}`] = JSON.stringify(value) ?? 'undefined';
	}

	// The request ID we are passed in is sent in the request to the proxy, and included in our pre-request telemetry.
	// We hope (but do not rely on) that the model will use the same ID in the response, allowing us to correlate
	// the request and response.
	telemetryData.properties['headerRequestId'] = ourRequestId;

	telemetryService.sendGHTelemetryEvent('request.sent', telemetryData.properties, telemetryData.measurements);

	const requestStart = Date.now();
	const intent = locationToIntent(location);

	// Wrap the Promise with success/error callbacks so we can log/measure it
	return postRequest(
		fetcherService,
		envService,
		telemetryService,
		domainService,
		capiClientService,
		chatEndpoint,
		secretKey,
		await createRequestHMAC(process.env.HMAC_SECRET),
		intent,
		ourRequestId,
		request,
		additionalHeaders,
		cancel
	).then(response => {
		const apim = response.headers.get('apim-request-id');
		if (apim) {
			logService.debug(`APIM request id: ${apim}`);
		}
		// This ID is hopefully the one the same as ourRequestId, but it is not guaranteed.
		// If they are different then we will override the original one we set in telemetryData above.
		const modelRequestId = getRequestId(response, undefined);
		telemetryData.extendWithRequestId(modelRequestId);

		// TODO: Add response length (requires parsing)
		const totalTimeMs = Date.now() - requestStart;
		telemetryData.measurements.totalTimeMs = totalTimeMs;

		logService.debug(`request.response: [${stringifyUrlOrRequestMetadata(chatEndpoint.urlOrRequestMetadata)}], took ${totalTimeMs} ms`);

		logService.debug(`messages: ${JSON.stringify(request.messages)}`);

		telemetryService.sendGHTelemetryEvent('request.response', telemetryData.properties, telemetryData.measurements);

		return response;
	})
		.catch(error => {
			if (fetcherService.isAbortError(error)) {
				// If we cancelled a network request, we don't want to log a `request.error`
				throw error;
			}

			const warningTelemetry = telemetryData.extendedBy({ error: 'Network exception' });
			telemetryService.sendGHTelemetryEvent('request.shownWarning', warningTelemetry.properties, warningTelemetry.measurements);

			telemetryData.properties.code = String(error.code ?? '');
			telemetryData.properties.errno = String(error.errno ?? '');
			telemetryData.properties.message = String(error.message ?? '');
			telemetryData.properties.type = String(error.type ?? '');

			const totalTimeMs = Date.now() - requestStart;
			telemetryData.measurements.totalTimeMs = totalTimeMs;

			logService.debug(`request.response: [${chatEndpoint.urlOrRequestMetadata}] took ${totalTimeMs} ms`);

			telemetryService.sendGHTelemetryEvent('request.error', telemetryData.properties, telemetryData.measurements);

			throw error;
		})
		.finally(() => {
			sendEngineMessagesTelemetry(telemetryService, request.messages!, telemetryData);
		});
}

/**
 * WARNING: The value that is returned from this function drives the disablement of RAI for full-file rewrite requests
 * in Copilot Edits, Copilot Chat, Agent Mode, and Inline Chat.
 * If your chat location generates full-file rewrite requests and you are unsure if changing something here will cause problems, please talk to @roblourens
 */
function locationToIntent(location: ChatLocation): string {
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
	}
}
