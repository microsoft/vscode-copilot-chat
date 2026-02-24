/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FetchOptions, RequestMetadata, RequestType } from '@vscode/copilot-api';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { CAPIClientImpl } from './capiClientImpl';

export class ScenarioAutomationCAPIClientImpl extends CAPIClientImpl {

	constructor(
		@IFetcherService private readonly _fetcher: IFetcherService,
		@IEnvService envService: IEnvService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) {
		super(_fetcher, envService);
	}

	override makeRequest<T>(request: FetchOptions, requestMetadata: RequestMetadata): Promise<T> {
		const overrideUrl = this._configurationService.getConfig(ConfigKey.Advanced.DebugOverrideEmbeddingsUrl);
		if (overrideUrl && requestMetadata.type === RequestType.EmbeddingsCodeSearch) {
			const localRequest: FetchOptions = {
				method: request.method ?? 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request.json),
				timeout: request.timeout,
				signal: request.signal,
			};
			return this._fetcher.fetch(overrideUrl, localRequest) as Promise<T>;
		}
		return super.makeRequest<T>(request, requestMetadata);
	}
}
