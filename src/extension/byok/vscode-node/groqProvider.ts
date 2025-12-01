/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IExperimentationService } from '../../../lib/node/chatLibMain';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels } from '../common/byokProvider';
import { AbstractOpenAICompatibleLMProvider } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

export class GroqBYOKLMProvider extends AbstractOpenAICompatibleLMProvider {
	public static readonly providerName = 'Groq';
	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService
	) {
		super(
			GroqBYOKLMProvider.providerName.toLowerCase(),
			GroqBYOKLMProvider.providerName,
			knownModels,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService,
			configurationService,
			expService
		);
	}

	protected getModelsBaseUrl(): string {
		return 'https://api.groq.com/openai/v1';
	}
}