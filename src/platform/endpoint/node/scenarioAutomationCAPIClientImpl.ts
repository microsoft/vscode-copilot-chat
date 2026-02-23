/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FetchOptions, RequestMetadata, RequestType } from '@vscode/copilot-api';
import { IEnvService } from '../../env/common/envService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { CAPIClientImpl } from './capiClientImpl';

const SCENARIO_AUTOMATION_CODE_SEARCH_URL = 'https://localhost:4443/embeddings/code/search';

export class ScenarioAutomationCAPIClientImpl extends CAPIClientImpl {

	constructor(
		@IFetcherService private readonly _fetcher: IFetcherService,
		@IEnvService envService: IEnvService
	) {
		super(_fetcher, envService);
	}

	override makeRequest<T>(request: FetchOptions, requestMetadata: RequestMetadata): Promise<T> {
		if (requestMetadata.type === RequestType.EmbeddingsCodeSearch) {
			const localRequest: FetchOptions = {
				method: request.method ?? 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request.json),
				timeout: request.timeout,
				signal: request.signal,
			};
			return this._fetcher.fetch(SCENARIO_AUTOMATION_CODE_SEARCH_URL, localRequest) as Promise<T>;
		}
		return super.makeRequest<T>(request, requestMetadata);
	}
}
