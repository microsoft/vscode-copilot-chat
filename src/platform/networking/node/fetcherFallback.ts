/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import { ILogService } from '../../log/common/logService';
import { FetcherId, FetchOptions, Response } from '../common/fetcherService';
import { IFetcher } from '../common/networking';
import { Config, ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';


const fetcherConfigKeys: Record<FetcherId, Config<boolean>> = {
	'electron-fetch': ConfigKey.Shared.DebugUseElectronFetcher,
	'node-fetch': ConfigKey.Shared.DebugUseNodeFetchFetcher,
	'node-http': ConfigKey.Shared.DebugUseNodeFetcher,
};

export async function fetchWithFallbacks(availableFetchers: readonly IFetcher[], url: string, options: FetchOptions, knownBadFetchers: Set<string>, configurationService: IConfigurationService, logService: ILogService): Promise<{ response: Response; updatedFetchers?: IFetcher[]; updatedKnownBadFetchers?: Set<string> }> {
	if (options.retryFallbacks && availableFetchers.length > 1) {
		let firstResult: { ok: boolean; response: Response } | { ok: false; err: any } | undefined;
		const updatedKnownBadFetchers = new Set<string>();
		for (const fetcher of availableFetchers) {
			const result = await tryFetch(fetcher, url, options, logService);
			if (fetcher === availableFetchers[0]) {
				firstResult = result;
			}
			if (!result.ok) {
				updatedKnownBadFetchers.add(fetcher.getUserAgentLibrary());
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
				return { response: result.response, updatedFetchers, updatedKnownBadFetchers };
			}
			return { response: result.response };
		}
		if ('response' in firstResult!) {
			return { response: firstResult.response };
		}
		throw firstResult!.err;
	}
	let fetcher = availableFetchers[0];
	if (options.useFetcher) {
		if (knownBadFetchers.has(options.useFetcher)) {
			logService.trace(`FetcherService: not using requested fetcher ${options.useFetcher} as it is known to be failing, using ${fetcher.getUserAgentLibrary()} instead.`);
		} else {
			const configKey = fetcherConfigKeys[options.useFetcher];
			if (configKey && configurationService.inspectConfig(configKey)?.globalValue === false) {
				logService.trace(`FetcherService: not using requested fetcher ${options.useFetcher} as it is disabled in user settings, using ${fetcher.getUserAgentLibrary()} instead.`);
			} else {
				const requestedFetcher = availableFetchers.find(f => f.getUserAgentLibrary() === options.useFetcher);
				if (requestedFetcher) {
					fetcher = requestedFetcher;
					logService.trace(`FetcherService: using ${options.useFetcher} as requested.`);
				} else {
					logService.info(`FetcherService: could not find requested fetcher ${options.useFetcher}, using ${fetcher.getUserAgentLibrary()} instead.`);
				}
			}
		}
	}
	return { response: await fetcher.fetch(url, options) };
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
