/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IBYOKStorageService } from './byokStorageService';
import { CustomOAIBYOKModelProvider, hasExplicitApiPath } from './customOAIProvider';

export function resolveAzureUrl(modelId: string, url: string, useResponsesApi: boolean = false): string {
	// The fully resolved url was already passed in
	if (hasExplicitApiPath(url)) {
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
		const apiPath = useResponsesApi ? '/v1/responses' : '/v1/chat/completions';
		return `${url}${apiPath}`;
	} else if (url.includes('openai.azure.com')) {
		if (useResponsesApi) {
			return `${url}/openai/deployments/${modelId}/extensions/responses?api-version=2025-10-01`;
		} else {
			return `${url}/openai/deployments/${modelId}/chat/completions?api-version=2025-01-01-preview`;
		}
	} else {
		throw new Error(`Unrecognized Azure deployment URL: ${url}`);
	}
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

	protected override resolveUrl(modelId: string, url: string, useResponsesApi?: boolean): string {
		return resolveAzureUrl(modelId, url, useResponsesApi);
	}
}
