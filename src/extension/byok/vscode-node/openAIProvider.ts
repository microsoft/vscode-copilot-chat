/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

export class OAIBYOKLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'OpenAI';

	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			OAIBYOKLMProvider.providerName,
			'https://api.openai.com/v1',
			knownModels,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService,
		);
	}

	protected override async getModelInfo(modelId: string, apiKey: string | undefined, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		const modelInfo = await super.getModelInfo(modelId, apiKey, modelCapabilities);
		const enableResponsesApi = this._configurationService.getExperimentBasedConfig(ConfigKey.UseResponsesApi, this._expService);
		if (enableResponsesApi) {
			modelInfo.supported_endpoints = [
				ModelSupportedEndpoint.ChatCompletions,
				ModelSupportedEndpoint.Responses
			];
		}

		return modelInfo;
	}
}
