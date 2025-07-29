/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { FetchOptions, IAbortController, IFetcherService, Response } from '../common/fetcherService';
import { IFetcher } from '../common/networking';
import { NodeFetcher } from '../node/nodeFetcher';
import { NodeFetchFetcher } from '../node/nodeFetchFetcher';
import { ElectronFetcher } from './electronFetcher';

export class FetcherService implements IFetcherService {

	declare readonly _serviceBrand: undefined;
	private readonly _fetcher: IFetcher;

	constructor(
		fetcher: IFetcher | undefined,
		@ILogService private readonly _logService: ILogService,
		@IEnvService envService: IEnvService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		this._fetcher = fetcher || this._getFetcher(configurationService, envService);
	}

	private _getFetcher(configurationService: IConfigurationService, envService: IEnvService): IFetcher {
		const useElectronFetcher = configurationService.getConfig(ConfigKey.Shared.DebugUseElectronFetcher);
		if (useElectronFetcher) {
			const electronFetcher = ElectronFetcher.create(envService);
			if (electronFetcher) {
				this._logService.info(`Using the Electron fetcher.`);
				return electronFetcher;
			} else {
				this._logService.info(`Can't use the Electron fetcher in this environment.`);
			}
		}

		const useNodeFetcher = configurationService.getConfig(ConfigKey.Shared.DebugUseNodeFetcher);
		if (useNodeFetcher) {
			this._logService.info(`Using the Node fetcher.`);
			return new NodeFetcher(envService);
		}

		const useNodeFetchFetcher = configurationService.getConfig(ConfigKey.Shared.DebugUseNodeFetchFetcher);
		if (useNodeFetchFetcher) {
			this._logService.info(`Using the Node fetch fetcher.`);
			return new NodeFetchFetcher(envService);
		}

		this._logService.info(`Using the Node fetcher.`);
		return new NodeFetcher(envService);
	}

	getUserAgentLibrary(): string {
		return this._fetcher.getUserAgentLibrary();
	}

	fetch(url: string, options: FetchOptions): Promise<Response> {
		return this._fetcher.fetch(url, options);
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
