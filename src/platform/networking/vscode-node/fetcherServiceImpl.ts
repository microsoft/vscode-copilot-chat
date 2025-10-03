/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Config, ConfigKey, ExperimentBasedConfig, ExperimentBasedConfigType, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { FetchOptions, IAbortController, IFetcherService, Response } from '../common/fetcherService';
import { IFetcher } from '../common/networking';
import { fetchWithFallbacks } from '../node/fetcherFallback';
import { NodeFetcher } from '../node/nodeFetcher';
import { NodeFetchFetcher } from '../node/nodeFetchFetcher';
import { ElectronFetcher } from './electronFetcher';

export class FetcherService implements IFetcherService {

	declare readonly _serviceBrand: undefined;
	private _availableFetchers: readonly IFetcher[] | undefined;
	private _experimentationService: IExperimentationService | undefined;

	constructor(
		fetcher: IFetcher | undefined,
		@ILogService private readonly _logService: ILogService,
		@IEnvService private readonly _envService: IEnvService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		this._availableFetchers = fetcher ? [fetcher] : undefined;
	}

	setExperimentationService(experimentationService: IExperimentationService) {
		this._experimentationService = experimentationService;
	}

	private _getAvailableFetchers(): readonly IFetcher[] {
		if (!this._availableFetchers) {
			if (!this._experimentationService) {
				this._logService.info('FetcherService: Experimentation service not available yet, using default fetcher configuration.');
			} else {
				this._logService.debug('FetcherService: Using experimentation service to determine fetcher configuration.');
			}
			this._availableFetchers = this._getFetchers(this._configurationService, this._experimentationService, this._envService);
		}
		return this._availableFetchers;
	}

	private _getFetchers(configurationService: IConfigurationService, experimentationService: IExperimentationService | undefined, envService: IEnvService): IFetcher[] {
		const useElectronFetcher = getShadowedConfig<boolean>(configurationService, experimentationService, ConfigKey.Shared.DebugUseElectronFetcher, ConfigKey.Internal.DebugExpUseElectronFetcher);
		const electronFetcher = ElectronFetcher.create(envService);
		const useNodeFetcher = !(useElectronFetcher && electronFetcher) && getShadowedConfig<boolean>(configurationService, experimentationService, ConfigKey.Shared.DebugUseNodeFetcher, ConfigKey.Internal.DebugExpUseNodeFetcher); // Node https wins over Node fetch. (historical order)
		const useNodeFetchFetcher = !(useElectronFetcher && electronFetcher) && !useNodeFetcher && getShadowedConfig<boolean>(configurationService, experimentationService, ConfigKey.Shared.DebugUseNodeFetchFetcher, ConfigKey.Internal.DebugExpUseNodeFetchFetcher);

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
		return this._getAvailableFetchers()[0].getUserAgentLibrary();
	}

	async fetch(url: string, options: FetchOptions): Promise<Response> {
		const { response: res, updatedFetchers } = await fetchWithFallbacks(this._getAvailableFetchers(), url, options, this._logService);
		if (updatedFetchers) {
			this._availableFetchers = updatedFetchers;
		}
		return res;
	}

	disconnectAll(): Promise<unknown> {
		return this._getAvailableFetchers()[0].disconnectAll();
	}
	makeAbortController(): IAbortController {
		return this._getAvailableFetchers()[0].makeAbortController();
	}
	isAbortError(e: any): boolean {
		return this._getAvailableFetchers()[0].isAbortError(e);
	}
	isInternetDisconnectedError(e: any): boolean {
		return this._getAvailableFetchers()[0].isInternetDisconnectedError(e);
	}
	isFetcherError(e: any): boolean {
		return this._getAvailableFetchers()[0].isFetcherError(e);
	}
	getUserMessageForFetcherError(err: any): string {
		return this._getAvailableFetchers()[0].getUserMessageForFetcherError(err);
	}
}

export function getShadowedConfig<T extends ExperimentBasedConfigType>(configurationService: IConfigurationService, experimentationService: IExperimentationService | undefined, configKey: Config<T>, expKey: ExperimentBasedConfig<T | undefined>): T {
	if (!experimentationService) {
		return configurationService.getConfig<T>(configKey);
	}

	const inspect = configurationService.inspectConfig<T>(configKey);
	if (inspect?.globalValue !== undefined) {
		return inspect.globalValue;
	}
	const expValue = configurationService.getExperimentBasedConfig(expKey, experimentationService);
	if (expValue !== undefined) {
		return expValue;
	}
	return configurationService.getConfig<T>(configKey);
}
