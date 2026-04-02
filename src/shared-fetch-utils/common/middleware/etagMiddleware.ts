/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FetchMiddleware, HttpResponse } from '../fetchTypes';

/**
 * Adds `If-None-Match` / `If-Modified-Since` conditional request headers
 * and transparently handles `304 Not Modified` responses by returning the
 * previously cached response body.
 */
export function etagMiddleware(): FetchMiddleware {
	let cachedEtag: string | undefined;
	let cachedLastModified: string | undefined;
	let cachedResponse: HttpResponse | undefined;

	return (next) => async (request) => {
		const headers = { ...request.headers };
		if (cachedEtag) {
			headers['If-None-Match'] = cachedEtag;
		}
		if (cachedLastModified) {
			headers['If-Modified-Since'] = cachedLastModified;
		}

		const response = await next({ ...request, headers });

		if (response.status === 304 && cachedResponse) {
			return cachedResponse;
		}

		const etag = response.headers.get('etag') ?? undefined;
		const lastModified = response.headers.get('last-modified') ?? undefined;
		if (etag) {
			cachedEtag = etag;
		}
		if (lastModified) {
			cachedLastModified = lastModified;
		}
		cachedResponse = response;

		return response;
	};
}
