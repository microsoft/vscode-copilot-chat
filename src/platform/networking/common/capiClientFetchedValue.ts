/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MakeRequestOptions, RequestMetadata } from '@vscode/copilot-api';
import { composeFetchMiddleware } from '../../../shared-fetch-utils/common/advancedFetcher';
import type { HttpResponse } from '../../../shared-fetch-utils/common/fetchTypes';
import { FetchedValue } from '../../../shared-fetch-utils/common/fetchedValue';
import { authBlockedMiddleware } from '../../../shared-fetch-utils/common/middleware/authBlockedMiddleware';
import { etagMiddleware } from '../../../shared-fetch-utils/common/middleware/etagMiddleware';
import { serverErrorBackoffMiddleware } from '../../../shared-fetch-utils/common/middleware/serverErrorBackoffMiddleware';
import { windowActiveMiddleware } from '../../../shared-fetch-utils/common/middleware/windowActiveMiddleware';
import type { ICAPIClientService } from '../../endpoint/common/capiClient';
import type { IEnvService } from '../../env/common/envService';

/**
 * A request-options provider that can be synchronous or asynchronous.
 * Async providers are useful when headers depend on runtime state such
 * as an auth token that must be fetched first.
 */
export type CapiRequestProvider = MakeRequestOptions | (() => MakeRequestOptions | Promise<MakeRequestOptions>);

export interface CapiClientFetchedValueOptions<T> {
	/**
	 * The request options passed to {@link ICAPIClientService.makeRequest}.
	 * May be a static object, a synchronous factory, or an async factory
	 * (useful when headers depend on runtime state such as an auth token).
	 */
	readonly request: CapiRequestProvider;

	/**
	 * Metadata for the CAPI request (e.g. {@link RequestType}).
	 */
	readonly requestMetadata: RequestMetadata;

	/**
	 * Extracts the domain value `T` from the parsed HTTP response.
	 * The {@link HttpResponse.body} contains the JSON-parsed result.
	 *
	 * Defaults to `res.body as T` when omitted.
	 */
	readonly parseResponse?: (response: HttpResponse) => T;

	/**
	 * Determines whether the current cached value is stale and should be
	 * re-fetched. Passed through to {@link FetchedValueOptions.isStale}.
	 */
	readonly isStale: (value: T) => boolean;

	/**
	 * When `true`, automatically resolves once per minute to keep the cache
	 * hot. Passed through to {@link FetchedValueOptions.keepCacheHot}.
	 */
	readonly keepCacheHot?: boolean;
}

/**
 * Creates a {@link FetchedValue} that fetches via
 * {@link ICAPIClientService.makeRequest} with the full advanced-fetcher
 * middleware stack applied.
 *
 * This is the recommended way to create periodically-refreshed cached
 * values backed by CAPI endpoints.
 *
 * @example
 * ```ts
 * const config = createCapiClientFetchedValue(capiClientService, envService, {
 *     request: async () => ({
 *         headers: { Authorization: `Bearer ${await getToken()}` },
 *         method: 'POST',
 *         json: { key: 'value' },
 *     }),
 *     requestMetadata: { type: RequestType.CopilotToken },
 *     isStale: (c) => c.expiresAt < Date.now(),
 * });
 *
 * const fresh = await config.resolve();
 * ```
 */
export function createCapiClientFetchedValue<T>(
	capiClientService: ICAPIClientService,
	envService: IEnvService,
	options: CapiClientFetchedValueOptions<T>,
): FetchedValue<T> {
	const {
		request,
		requestMetadata,
		parseResponse = (res) => res.body as T,
		isStale,
		keepCacheHot,
	} = options;

	const resolveRequest = typeof request === 'function'
		? request
		: () => request;

	// Compose the middleware stack around the CAPI transport. The resolved
	// request options are captured in `currentRequestOpts` before the
	// middleware pipeline runs so they are available to the base fetch.
	let currentRequestOpts: MakeRequestOptions;

	const composedFetch = composeFetchMiddleware(
		windowActiveMiddleware(envService),
		etagMiddleware(),
		authBlockedMiddleware(),
		serverErrorBackoffMiddleware(),
	)(async (httpRequest) => {
		const response = await capiClientService.makeRequest<Response>({
			...currentRequestOpts,
			// Use the headers from the middleware pipeline (may include
			// If-None-Match, If-Modified-Since, etc.)
			headers: httpRequest.headers,
		}, requestMetadata);

		const body = await response.json();
		return {
			status: response.status,
			headers: response.headers,
			body,
		};
	});

	return new FetchedValue<T>({
		fetch: async () => {
			currentRequestOpts = await resolveRequest();
			const httpRequest = { url: '', headers: currentRequestOpts.headers ?? {} };
			const response = await composedFetch(httpRequest);
			return parseResponse(response);
		},
		isStale,
		keepCacheHot,
	});
}
