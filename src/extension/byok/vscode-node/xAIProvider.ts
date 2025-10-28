/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';


export class XAIBYOKLMProvider extends BaseOpenAICompatibleLMProvider {

	public static readonly providerName = 'xAI';

	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			XAIBYOKLMProvider.providerName,
			'https://api.x.ai/v1',
			knownModels,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService,
		);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			const response = await this._fetcherService.fetch(`${this._baseUrl}/language-models`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this._apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			const data = await response.json();
			if (!data.models || !Array.isArray(data.models)) {
				throw new Error('Invalid response format from xAI API');
			}
			this._logService.trace(`Fetched ${data.models.length} language models from xAI`);
			const modelList: BYOKKnownModels = {};
			for (const model of data.models) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList[model.id] = this._knownModels[model.id];
				}
			}
			this._logService.trace(`Filtered to ${Object.keys(modelList).length} known models for xAI`);
			return modelList;
		} catch (error) {
			throw new Error(error.message ? error.message : error);
		}
	}
}