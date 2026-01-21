/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Config, ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { collectSingleLineErrorMessage, ILogService } from '../../log/common/logService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { FetcherId, FetchOptions, Response } from '../common/fetcherService';
import { IFetcher } from '../common/networking';


const fetcherConfigKeys: Partial<Record<FetcherId, Config<boolean>>> = {
	'electron-fetch': ConfigKey.Shared.DebugUseElectronFetcher,
	'node-fetch': ConfigKey.Shared.DebugUseNodeFetchFetcher,
	'node-http': ConfigKey.Shared.DebugUseNodeFetcher,
};

export async function fetchWithFallbacks(availableFetchers: readonly IFetcher[], url: string, options: FetchOptions, knownBadFetchers: Set<string>, configurationService: IConfigurationService, logService: ILogService, telemetryService: ITelemetryService | undefined): Promise<{ response: Response; updatedFetchers?: IFetcher[]; updatedKnownBadFetchers?: Set<string> }> {
	if (options.retryFallbacks && availableFetchers.length > 1) {
		let firstResult: { ok: boolean; response: Response } | { ok: false; err: any } | undefined;
		const updatedKnownBadFetchers = new Set<string>();
		let lastError: string | undefined;
		for (const fetcher of availableFetchers) {
			const result = await tryFetch(fetcher, url, options, logService);
			if (fetcher === availableFetchers[0]) {
				firstResult = result;
			}
			if (!result.ok) {
				const fetcherId = fetcher.getUserAgentLibrary();
				if ('response' in result) {
					lastError = `${fetcherId}: ${result.response.status} ${result.response.statusText}`;
				} else {
					lastError = `${fetcherId}: ${collectSingleLineErrorMessage(result.err, true)}`;
				}
				updatedKnownBadFetchers.add(fetcherId);
				continue;
			}
			if (fetcher !== availableFetchers[0]) {
				const retry = await tryFetch(availableFetchers[0], url, options, logService);
				if (retry.ok) {
					return { response: retry.response };
				}
				logService.info(`FetcherService: using ${fetcher.getUserAgentLibrary()} from now on`);
				/* __GDPR__
					"fetcherFallback" : {
						"owner": "chrmarti",
						"comment": "Sent when the fetcher service switches to a fallback fetcher due to the primary fetcher failing",
						"newFetcher": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The name of the fetcher that is now being used" },
						"knownBadFetchers": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Comma-separated list of fetchers that are known to be failing" },
						"knownBadFetchersCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of fetchers that are known to be failing" },
						"lastError": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The last error encountered, containing fetcher ID, status code and error message" }
					}
				*/
				telemetryService?.sendTelemetryEvent('fetcherFallback', { github: true, microsoft: true }, {
					newFetcher: fetcher.getUserAgentLibrary(),
					knownBadFetchers: Array.from(updatedKnownBadFetchers).join(','),
					lastError,
				}, {
					knownBadFetchersCount: updatedKnownBadFetchers.size,
				});
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
			JSON.parse(text); // Verify JSON
			logService.debug(`FetcherService: ${fetcher.getUserAgentLibrary()} succeeded (JSON)`);
			return { ok: true, response: Response.fromText(response.status, response.statusText, response.headers, text, response.fetcher) };
		} catch (err) {
			logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed to parse JSON: ${err.message}`);
			return { ok: false, err, response: Response.fromText(response.status, response.statusText, response.headers, text, response.fetcher) };
		}
	} catch (err) {
		logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed with error: ${err.message}`);
		return { ok: false, err };
	}
}
