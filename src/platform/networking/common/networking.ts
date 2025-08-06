/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestMetadata } from '@vscode/copilot-api';
import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { IntentParams, Source } from '../../chat/common/chatMLFetcher';
import type { ChatLocation, ChatResponse } from '../../chat/common/commonTypes';
import { EMBEDDING_MODEL } from '../../configuration/common/configurationService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService, TelemetryProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { FinishedCallback, OpenAiFunctionTool, OptionalChatRequestParams } from './fetch';
import { FetchOptions, IAbortController, IFetcherService, Response } from './fetcherService';
import { ChatCompletion } from './openai';

/**
 * Encapsulates all the functionality related to making GET/POST requests using
 * different libraries (and in the future, different environments like web vs
 * node).
 */
export interface IFetcher {
	getUserAgentLibrary(): string;
	fetch(url: string, options: FetchOptions): Promise<Response>;
	disconnectAll(): Promise<unknown>;
	makeAbortController(): IAbortController;
	isAbortError(e: any): boolean;
	isInternetDisconnectedError(e: any): boolean;
	isFetcherError(err: any): boolean;
	getUserMessageForFetcherError(err: any): string;
}

export const userAgentLibraryHeader = 'X-VSCode-User-Agent-Library-Version';

export type ReqHeaders = { [key: string]: string };
/**
 * The HeaderContributor provides the interface which allows implmentors
 * to decorate a request's `headers` object with additional key / value pairs.
 */
export interface HeaderContributor {
	contributeHeaderValues(headers: ReqHeaders): void;
}

// The maximum time to wait for a request to complete.
const requestTimeoutMs = 30 * 1000; // 30 seconds


/**
 * Rough shape of an endpoint body. A superset of the parameters of any request,
 * but provided to at least have rough typings.
 */
export interface IEndpointBody {
	/** General or completions: */
	tools?: OpenAiFunctionTool[];
	inputs?: string[];
	model?: string;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	stream?: boolean;
	messages?: any[];
	intent?: boolean;
	state?: 'enabled';
	snippy?: { enabled: boolean };
	stream_options?: { include_usage?: boolean };
	prompt?: string;
	/** Embeddings endpoints only: */
	dimensions?: number;
	embed?: boolean;
	/** Chunking endpoints: */
	qos?: any;
	content?: string;
	path?: string;
	local_hashes?: string[];
	language_id?: number;
	/** docs search */
	query?: string;
	scopingQuery?: string;
	limit?: number;
	similarity?: number;
	/** Code search: */
	scoping_query?: string;
	include_embeddings?: boolean;
	reasoning_effort?: string;
}

export interface IEndpoint {
	readonly urlOrRequestMetadata: string | RequestMetadata;
	getExtraHeaders?(): Record<string, string>;
	interceptBody?(body: IEndpointBody | undefined): void;
	acquireTokenizer(): ITokenizer;
	readonly modelMaxPromptTokens: number;
	readonly name: string;
	readonly version: string;
	readonly family: string;
	readonly tokenizer: TokenizerType;
}

export function stringifyUrlOrRequestMetadata(urlOrRequestMetadata: string | RequestMetadata): string {
	if (typeof urlOrRequestMetadata === 'string') {
		return urlOrRequestMetadata;
	}
	return JSON.stringify(urlOrRequestMetadata);
}

export interface IEmbeddingEndpoint extends IEndpoint {
	readonly maxBatchSize: number;
	readonly model: EMBEDDING_MODEL;
}

export interface IChatEndpoint extends IEndpoint {
	readonly maxOutputTokens: number;
	/** The model ID- this may change and will be `copilot-base` for the base model. Use `family` to switch behavior based on model type. */
	readonly model: string;
	readonly supportsToolCalls: boolean;
	readonly supportsVision: boolean;
	readonly supportsPrediction: boolean;
	readonly showInModelPicker: boolean;
	readonly isPremium?: boolean;
	readonly multiplier?: number;
	readonly restrictedToSkus?: string[];
	readonly isDefault: boolean;
	readonly isFallback: boolean;
	readonly policy: 'enabled' | { terms: string };
	/**
	 * Handles processing of responses from a chat endpoint. Each endpoint can have different response formats.
	 * @param telemetryService The telemetry service
	 * @param logService The log service
	 * @param response The response from the chat endpoint
	 * @param expectedNumChoices The expected number of choices in the response
	 * @param finishCallback A finish callback to indicate when the response should be complete
	 * @param telemetryData GH telemetry data from the originating request, will be extended with request information
	 * @param cancellationToken A cancellation tokenf for cancelling the request
	 * @returns An async iterable object of chat completions
	 */
	processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken
	): Promise<AsyncIterableObject<ChatCompletion>>;

	/**
	 * Accepts the chat policy for the given endpoint, enabling its usage.
	 * @returns A promise that resolves to true if the chat policy was accepted, false otherwise.
	 */
	acceptChatPolicy(): Promise<boolean>;

	/**
	 * Flights a request from the chat endpoint returning a chat response.
	 * Most of the time this is ChatMLFetcher#fetchOne, but it can be overridden for special cases.
	 * TODO @lramos15 - Support multiple completions in the future, we don't use this at the moment.
	 *
	 * @param userInitiatedRequest Is only applicable to CAPI requests
	 * @param telemetryProperties An object containing various properties for telemetry, e.g., can contain a field `requestId` that sets the header request ID
	 */
	makeChatRequest(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		source?: Source,
		requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
		intentParams?: IntentParams
	): Promise<ChatResponse>;

	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint;
}

function networkRequest(
	fetcher: IFetcher,
	envService: IEnvService,
	telemetryService: ITelemetryService,
	domainService: IDomainService,
	capiClientService: ICAPIClientService,
	requestType: 'GET' | 'POST',
	endpointOrUrl: IEndpoint | string | RequestMetadata,
	secretKey: string,
	hmac: string | undefined,
	intent: string,
	requestId: string,
	body?: IEndpointBody,
	additionalHeaders?: Record<string, string>,
	cancelToken?: CancellationToken
): Promise<Response> {
	// TODO @lramos15 Eventually don't even construct this fake endpoint object.
	const endpoint = typeof endpointOrUrl === 'string' || 'type' in endpointOrUrl ? {
		modelMaxPromptTokens: 0,
		urlOrRequestMetadata: endpointOrUrl,
		family: '',
		tokenizer: TokenizerType.O200K,
		acquireTokenizer: () => {
			throw new Error('Method not implemented.');
		},
		name: '',
		version: '',
	} satisfies IEndpoint : endpointOrUrl;
	const headers: ReqHeaders = {
		Authorization: `Bearer ${secretKey}`,
		'X-Request-Id': requestId,
		'X-Interaction-Type': intent,
		'OpenAI-Intent': intent, // Tells CAPI who flighted this request. Helps find buggy features
		'X-GitHub-Api-Version': '2025-05-01',
		...additionalHeaders,
		...(endpoint.getExtraHeaders ? endpoint.getExtraHeaders() : {}),
	};

	if (endpoint.interceptBody) {
		endpoint.interceptBody(body);
	}

	const request: FetchOptions = {
		method: requestType,
		headers: headers,
		json: body,
		timeout: requestTimeoutMs,
	};

	if (cancelToken) {
		const abort = fetcher.makeAbortController();
		cancelToken.onCancellationRequested(() => {
			// abort the request when the token is canceled
			telemetryService.sendGHTelemetryEvent('networking.cancelRequest', {
				headerRequestId: requestId,
			});
			abort.abort();
		});
		// pass the controller abort signal to the request
		request.signal = abort.signal;
	}
	if (typeof endpoint.urlOrRequestMetadata === 'string') {
		const requestPromise = fetcher.fetch(endpoint.urlOrRequestMetadata, request).catch(reason => {
			if (canRetryOnceNetworkError(reason)) {
				// disconnect and retry the request once if the connection was reset
				telemetryService.sendGHTelemetryEvent('networking.disconnectAll');
				return fetcher.disconnectAll().then(() => {
					return fetcher.fetch(endpoint.urlOrRequestMetadata as string, request);
				});
			} else if (fetcher.isAbortError(reason)) {
				throw new CancellationError();
			} else {
				throw reason;
			}
		});
		return requestPromise;
	} else {
		return capiClientService.makeRequest(request, endpoint.urlOrRequestMetadata as RequestMetadata);
	}
}

export function canRetryOnceNetworkError(reason: any) {
	return [
		'ECONNRESET',
		'ETIMEDOUT',
		'ERR_NETWORK_CHANGED',
		'ERR_HTTP2_INVALID_SESSION',
		'ERR_HTTP2_STREAM_CANCEL',
		'ERR_HTTP2_GOAWAY_SESSION',
		'ERR_HTTP2_PROTOCOL_ERROR',
	].includes(reason?.code);
}

export function postRequest(
	fetcherService: IFetcherService,
	envService: IEnvService,
	telemetryService: ITelemetryService,
	domainService: IDomainService,
	capiClientService: ICAPIClientService,
	endpointOrUrl: IEndpoint | string | RequestMetadata,
	secretKey: string,
	hmac: string | undefined,
	intent: string,
	requestId: string,
	body?: IEndpointBody,
	additionalHeaders?: Record<string, string>,
	cancelToken?: CancellationToken
): Promise<Response> {
	return networkRequest(fetcherService,
		envService,
		telemetryService,
		domainService,
		capiClientService,
		'POST',
		endpointOrUrl,
		secretKey,
		hmac,
		intent,
		requestId,
		body,
		additionalHeaders,
		cancelToken
	);
}

export function getRequest(
	fetcherService: IFetcher,
	envService: IEnvService,
	telemetryService: ITelemetryService,
	domainService: IDomainService,
	capiClientService: ICAPIClientService,
	endpointOrUrl: IEndpoint | string | RequestMetadata,
	secretKey: string,
	hmac: string | undefined,
	intent: string,
	requestId: string,
	body?: IEndpointBody,
	additionalHeaders?: Record<string, string>,
	cancelToken?: CancellationToken
): Promise<Response> {
	return networkRequest(fetcherService,
		envService,
		telemetryService,
		domainService,
		capiClientService,
		'GET',
		endpointOrUrl,
		secretKey,
		hmac,
		intent,
		requestId,
		body,
		additionalHeaders,
		cancelToken
	);
}

export const IHeaderContributors = createServiceIdentifier<HeaderContributors>('headerContributors');

export interface IHeaderContributors {
	readonly _serviceBrand: undefined;
	add(contributor: HeaderContributor): void;
	remove(contributor: HeaderContributor): void;
	contributeHeaders(headers: ReqHeaders): void;
	size(): number;
}

export class HeaderContributors implements IHeaderContributors {
	declare readonly _serviceBrand: undefined;
	private readonly contributors: HeaderContributor[] = [];

	add(contributor: HeaderContributor) {
		this.contributors.push(contributor);
	}

	remove(contributor: HeaderContributor) {
		const index = this.contributors.indexOf(contributor);

		if (index === -1) {
			return;
		}

		this.contributors.splice(index, 1);
	}

	contributeHeaders(headers: ReqHeaders) {
		for (const contributor of this.contributors) {
			contributor.contributeHeaderValues(headers);
		}
	}

	size() {
		return this.contributors.length;
	}
}
