/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

export class GroqBYOKLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'Groq';
	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IConfigurationService _configurationService: IConfigurationService,
		@IExperimentationService _expService: IExperimentationService
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			GroqBYOKLMProvider.providerName,
			'https://api.groq.com/openai/v1',
			knownModels,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService,
			_configurationService,
			_expService
		);
	}
}