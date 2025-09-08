/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { FetchOptions, IAbortController, IFetcherService, Response } from '../common/fetcherService';
import { IFetcher } from '../common/networking';
import { fetchWithFallbacks } from '../node/fetcherFallback';
import { NodeFetcher } from '../node/nodeFetcher';
import { NodeFetchFetcher } from '../node/nodeFetchFetcher';
import { ElectronFetcher } from './electronFetcher';

export class FetcherService implements IFetcherService {

	declare readonly _serviceBrand: undefined;
	private _availableFetchers: readonly IFetcher[];
	private _fetcher: IFetcher;

	constructor(
		fetcher: IFetcher | undefined,
		@ILogService private readonly _logService: ILogService,
		@IEnvService envService: IEnvService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		this._availableFetchers = fetcher ? [fetcher] : this._getFetchers(configurationService, envService);
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
		const { response: res, updatedFetchers } = await fetchWithFallbacks(this._availableFetchers, url, options, this._logService);
		if (updatedFetchers) {
			this._availableFetchers = updatedFetchers;
			this._fetcher = this._availableFetchers[0];
		}
		return res;
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
