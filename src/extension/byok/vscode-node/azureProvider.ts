/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKModelCapabilities } from '../common/byokProvider';
import { IBYOKStorageService } from './byokStorageService';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';

export function resolveAzureUrl(modelId: string, url: string): string {
	// The fully resolved url was already passed in
	if (url.includes('/chat/completions')) {
		return url;
	}

	// Remove the trailing slash
	if (url.endsWith('/')) {
		url = url.slice(0, -1);
	}
	// if url ends with `/v1` remove it
	if (url.endsWith('/v1')) {
		url = url.slice(0, -3);
	}

	if (url.includes('models.ai.azure.com') || url.includes('inference.ml.azure.com')) {
		return `${url}/v1/chat/completions`;
	} else if (url.includes('openai.azure.com')) {
		return `${url}/openai/deployments/${modelId}/chat/completions?api-version=2025-01-01-preview`;
	} else {
		throw new Error(`Unrecognized Azure deployment URL: ${url}`);
	}
}

export class AzureBYOKModelProvider extends CustomOAIBYOKModelProvider {
	static override readonly providerName = 'Azure';

	constructor(
		byokStorageService: IBYOKStorageService,
		@IConfigurationService protected override readonly _configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExperimentationService private readonly _expService: IExperimentationService
	) {
		super(
			byokStorageService,
			_configurationService,
			logService,
			instantiationService,
			_expService
		);
		// Override the instance properties
		this.providerName = AzureBYOKModelProvider.providerName;
	}

	protected override getConfigKey() {
		return ConfigKey.AzureModels;
	}

	protected override resolveUrl(modelId: string, url: string): string {
		return resolveAzureUrl(modelId, url);
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
