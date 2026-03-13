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

	override async makeRequest<T>(request: FetchOptions, requestMetadata: RequestMetadata): Promise<T> {
		const overrideUrl = this._configurationService.getConfig(ConfigKey.Advanced.DebugOverrideEmbeddingsUrl);
		if (overrideUrl && requestMetadata.type === RequestType.EmbeddingsCodeSearch) {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			const authToken = process.env.COPILOT_EMBEDDINGS_AUTH_TOKEN;
			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
			}
			const localRequest: FetchOptions = {
				method: request.method ?? 'POST',
				headers,
				body: JSON.stringify(request.json),
				timeout: request.timeout,
				signal: request.signal,
			};
			try {
				return await this._fetcher.fetch(overrideUrl, localRequest) as unknown as T;
			} catch (e) {
				throw new Error(`Embeddings override request to ${overrideUrl} failed: ${e instanceof Error ? e.message : e}`);
			}
		}
		return super.makeRequest<T>(request, requestMetadata);
	}
}
