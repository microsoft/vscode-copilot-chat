/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import { ILogService } from '../../log/common/logService';
import { FetchOptions, Response } from '../common/fetcherService';
import { IFetcher } from '../common/networking';


export async function fetchWithFallbacks(availableFetchers: readonly IFetcher[], url: string, options: FetchOptions, logService: ILogService): Promise<{ response: Response; updatedFetchers?: IFetcher[] }> {
	if (options.retryFallbacks && availableFetchers.length > 1) {
		let firstResult: { ok: boolean; response: Response } | { ok: false; err: any } | undefined;
		for (const fetcher of availableFetchers) {
			const result = await tryFetch(fetcher, url, options, logService);
			if (fetcher === availableFetchers[0]) {
				firstResult = result;
			}
			if (!result.ok) {
				continue;
			}
			if (fetcher !== availableFetchers[0]) {
				const retry = await tryFetch(availableFetchers[0], url, options, logService);
				if (retry.ok) {
					return { response: retry.response };
				}
				logService.info(`FetcherService: using ${fetcher.getUserAgentLibrary()} from now on`);
				const updatedFetchers = availableFetchers.slice();
				updatedFetchers.splice(updatedFetchers.indexOf(fetcher), 1);
				updatedFetchers.unshift(fetcher);
				return { response: result.response, updatedFetchers };
			}
			return { response: result.response };
		}
		if ('response' in firstResult!) {
			return { response: firstResult.response };
		}
		throw firstResult!.err;
	}
	return { response: await availableFetchers[0].fetch(url, options) };
}

async function tryFetch(fetcher: IFetcher, url: string, options: FetchOptions, logService: ILogService): Promise<{ ok: boolean; response: Response } | { ok: false; err: any }> {
	try {
		const response = await fetcher.fetch(url, options);
		if (!response.ok) {
			logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed with status: ${response.status} ${response.statusText}`);
			return { ok: false, response };
		}
		if (!options.expectJSON) {
			logService.debug(`FetcherService: ${fetcher.getUserAgentLibrary()} succeeded (not JSON)`);
			return { ok: response.ok, response };
		}
		const text = await response.text();
		try {
			const json = JSON.parse(text); // Verify JSON
			logService.debug(`FetcherService: ${fetcher.getUserAgentLibrary()} succeeded (JSON)`);
			return { ok: true, response: new Response(response.status, response.statusText, response.headers, async () => text, async () => json, async () => Readable.from([text])) };
		} catch (err) {
			logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed to parse JSON: ${err.message}`);
			return { ok: false, err, response: new Response(response.status, response.statusText, response.headers, async () => text, async () => { throw err; }, async () => Readable.from([text])) };
		}
	} catch (err) {
		logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed with error: ${err.message}`);
		return { ok: false, err };
	}
}
