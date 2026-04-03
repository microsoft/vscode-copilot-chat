/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FetchMiddleware, HttpResponse, WindowStateProvider } from '../fetchTypes';
import { cloneResponse } from '../httpResponse';

/**
 * Prevents fetches while the window is inactive. When inactive and a
 * previous response is available, a clone of the cached response is
 * returned without hitting the network. When no cached response exists,
 * the fetch proceeds regardless of window state so the caller is never
 * starved.
 */
export function windowActiveMiddleware(provider: WindowStateProvider): FetchMiddleware {
	let lastResponse: HttpResponse | undefined;

	return (next) => async (request) => {
		if (!provider.isActive && lastResponse) {
			const [returnCopy, keepCopy] = cloneResponse(lastResponse);
			lastResponse = keepCopy;
			return returnCopy;
		}
		const response = await next(request);
		const [returnCopy, keepCopy] = cloneResponse(response);
		lastResponse = keepCopy;
		return returnCopy;
	};
}
