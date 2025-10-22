/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IBYOKStorageService } from './byokStorageService';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';

export function resolveAzureUrl(modelId: string, url: string): string {
	let cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url;

	if (cleanUrl.includes('/responses') || cleanUrl.includes('/chat/completions')) {
		return cleanUrl;
	}

	if (cleanUrl.endsWith('/v1')) {
		cleanUrl = cleanUrl.slice(0, -3);
	}

	if (cleanUrl.includes('models.ai.azure.com') || cleanUrl.includes('inference.ml.azure.com')) {
		return `${cleanUrl}/v1/chat/completions`;
	}

	if (cleanUrl.includes('openai.azure.com')) {
		return `${cleanUrl}/openai/deployments/${modelId}/chat/completions?api-version=2025-01-01-preview`;
	}

	throw new Error(`Unrecognized Azure deployment URL: ${cleanUrl}`);
}

export class AzureBYOKModelProvider extends CustomOAIBYOKModelProvider {
	static override readonly providerName = 'Azure';

	constructor(
		byokStorageService: IBYOKStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExperimentationService experimentationService: IExperimentationService
	) {
		super(
			byokStorageService,
			configurationService,
			logService,
			instantiationService,
			experimentationService
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

}
