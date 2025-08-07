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

export class OpenRouterLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'OpenRouter';
	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			OpenRouterLMProvider.providerName,
			'https://openrouter.ai/api/v1',
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService
		);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			const response = await this._fetcherService.fetch('https://openrouter.ai/api/v1/models?supported_parameters=tools', { method: 'GET' });
			const data: any = await response.json();
			const knownModels: BYOKKnownModels = {};
			for (const model of data.data) {
				knownModels[model.id] = {
					name: model.name,
					toolCalling: model.supported_parameters?.includes('tools') ?? false,
					vision: model.architecture?.input_modalities?.includes('image') ?? false,
					maxInputTokens: model.top_provider.context_length - 16000,
					maxOutputTokens: 16000
				};
			}
			this._knownModels = knownModels;
			return knownModels;
		} catch (error) {
			this._logService.error(error, `Error fetching available OpenRouter models`);
			throw error;
		}

	}
}