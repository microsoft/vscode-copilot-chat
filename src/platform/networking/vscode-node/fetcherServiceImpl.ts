/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import { Config, ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { FetcherId, FetchOptions, IAbortController, IFetcherService, Response } from '../common/fetcherService';
import { IFetcher } from '../common/networking';
import { NodeFetcher } from '../node/nodeFetcher';
import { NodeFetchFetcher } from '../node/nodeFetchFetcher';
import { ElectronFetcher } from './electronFetcher';

const fetcherConfigKeys: Record<FetcherId, Config<boolean>> = {
	'electron-fetch': ConfigKey.Shared.DebugUseElectronFetcher,
	'node-fetch': ConfigKey.Shared.DebugUseNodeFetchFetcher,
	'node-http': ConfigKey.Shared.DebugUseNodeFetcher,
};

export class FetcherService implements IFetcherService {

	declare readonly _serviceBrand: undefined;
	private readonly _availableFetchers: IFetcher[];
	private _fetcher: IFetcher;
	private _knownBadFetchers = new Set<string>();

	constructor(
		fetcher: IFetcher | undefined,
		@ILogService private readonly _logService: ILogService,
		@IEnvService envService: IEnvService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		this._availableFetchers = fetcher ? [fetcher] : this._getFetchers(_configurationService, envService);
		this._fetcher = this._availableFetchers[0];
	}

	private _getFetchers(configurationService: IConfigurationService, envService: IEnvService): IFetcher[] {
		const useElectronFetcher = configurationService.getConfig(ConfigKey.Shared.DebugUseElectronFetcher);
		const electronFetcher = ElectronFetcher.create(envService);
		const useNodeFetcher = !(useElectronFetcher && electronFetcher) && configurationService.getConfig(ConfigKey.Shared.DebugUseNodeFetcher); // Node https wins over Node fetch. (historical order)
		const useNodeFetchFetcher = !(useElectronFetcher && electronFetcher) && !useNodeFetcher && configurationService.getConfig(ConfigKey.Shared.DebugUseNodeFetchFetcher);

		const fetchers = [];
		if (electronFetcher) {
			fetchers.push(electronFetcher);
		}
		if (useElectronFetcher) {
			if (electronFetcher) {
				this._logService.info(`Using the Electron fetcher.`);
			} else {
				this._logService.info(`Can't use the Electron fetcher in this environment.`);
			}
		}

		// Node fetch preferred over Node https in fallbacks. (HTTP2 support)
		const nodeFetchFetcher = new NodeFetchFetcher(envService);
		if (useNodeFetchFetcher) {
			this._logService.info(`Using the Node fetch fetcher.`);
			fetchers.unshift(nodeFetchFetcher);
		} else {
			fetchers.push(nodeFetchFetcher);
		}

		const nodeFetcher = new NodeFetcher(envService);
		if (useNodeFetcher || (!(useElectronFetcher && electronFetcher) && !useNodeFetchFetcher)) { // Node https used when none is configured. (historical)
			this._logService.info(`Using the Node fetcher.`);
			fetchers.unshift(nodeFetcher);
		} else {
			fetchers.push(nodeFetcher);
		}

		return fetchers;
	}

	getUserAgentLibrary(): string {
		return this._fetcher.getUserAgentLibrary();
	}

	async fetch(url: string, options: FetchOptions): Promise<Response> {
		if (options.verifyJSONAndRetry && this._fetcher === this._availableFetchers[0] && this._availableFetchers.length > 1) {
			let firstResponse: Response | undefined;
			let firstError: any;
			const knownBadFetchers = new Set<string>();
			for (const fetcher of this._availableFetchers) {
				try {
					const res = await fetcher.fetch(url, options);
					if (fetcher === this._availableFetchers[0]) {
						firstResponse = res;
					}
					if (!res.ok) {
						knownBadFetchers.add(fetcher.getUserAgentLibrary());
						this._logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed with status: ${res.status} ${res.statusText}`);
						continue;
					}
					const text = await res.text();
					if (fetcher === this._availableFetchers[0]) {
						// Update to unconsumed response
						firstResponse = new Response(
							res.status,
							res.statusText,
							res.headers,
							async () => text,
							async () => JSON.parse(text),
							async () => Readable.from([text])
						);
					}
					const json = JSON.parse(text); // Verify JSON
					this._logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} succeeded`);
					if (fetcher !== this._availableFetchers[0]) {
						const retry = await this.retryFetchJSON(this._availableFetchers[0], url, options);
						if ('res' in retry && retry.res.ok) {
							return retry.res;
						}
						this._logService.info(`FetcherService: using ${fetcher.getUserAgentLibrary()} from now on`);
						this._fetcher = fetcher;
						this._knownBadFetchers = knownBadFetchers;
					}
					return new Response(
						res.status,
						res.statusText,
						res.headers,
						async () => text,
						async () => json,
						async () => Readable.from([text])
					);
				} catch (err) {
					if (fetcher === this._availableFetchers[0]) {
						firstError = err;
					}
					knownBadFetchers.add(fetcher.getUserAgentLibrary());
					this._logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed with error: ${err.message}`);
				}
			}
			if (firstResponse) {
				return firstResponse;
			}
			throw firstError;
		}
		let fetcher = this._fetcher;
		if (options.useFetcher) {
			if (this._knownBadFetchers.has(options.useFetcher)) {
				this._logService.trace(`FetcherService: not using requested fetcher ${options.useFetcher} as it is known to be failing, using ${fetcher.getUserAgentLibrary()} instead.`);
			} else {
				const configKey = fetcherConfigKeys[options.useFetcher];
				if (configKey && this._configurationService.inspectConfig(configKey)?.globalValue === false) {
					this._logService.trace(`FetcherService: not using requested fetcher ${options.useFetcher} as it is disabled in user settings, using ${fetcher.getUserAgentLibrary()} instead.`);
				} else {
					const requestedFetcher = this._availableFetchers.find(f => f.getUserAgentLibrary() === options.useFetcher);
					if (requestedFetcher) {
						fetcher = requestedFetcher;
						this._logService.trace(`FetcherService: using ${options.useFetcher} as requested.`);
					} else {
						this._logService.info(`FetcherService: could not find requested fetcher ${options.useFetcher}, using ${fetcher.getUserAgentLibrary()} instead.`);
					}
				}
			}
		}
		return fetcher.fetch(url, options);
	}
	private async retryFetchJSON(fetcher: IFetcher, url: string, options: FetchOptions): Promise<{ res: Response } | { err: any }> {
		try {
			const res = await fetcher.fetch(url, options);
			if (!res.ok) {
				this._logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed with status: ${res.status} ${res.statusText}`);
				return { res };
			}
			const text = await res.text();
			const json = JSON.parse(text); // Verify JSON
			this._logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} succeeded`);
			return {
				res: new Response(
					res.status,
					res.statusText,
					res.headers,
					async () => text,
					async () => json,
					async () => Readable.from([text])
				)
			};
		} catch (err) {
			this._logService.info(`FetcherService: ${fetcher.getUserAgentLibrary()} failed with error: ${err.message}`);
			return { err };
		}
	}
	disconnectAll(): Promise<unknown> {
		return this._fetcher.disconnectAll();
	}
	makeAbortController(): IAbortController {
		return this._fetcher.makeAbortController();
	}
	isAbortError(e: any): boolean {
		return this._fetcher.isAbortError(e);
	}
	isInternetDisconnectedError(e: any): boolean {
		return this._fetcher.isInternetDisconnectedError(e);
	}
	isFetcherError(e: any): boolean {
		return this._fetcher.isFetcherError(e);
	}
	getUserMessageForFetcherError(err: any): string {
		return this._fetcher.getUserMessageForFetcherError(err);
	}
}
