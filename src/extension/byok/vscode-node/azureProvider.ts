/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


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

/**
 * BYOK registry for Azure OpenAI deployments
 *
 * Azure is different from other providers because each model has its own deployment URL and key,
 * and there's no central listing API. The user needs to manually register each model they want to use.
 */

// export class AzureBYOKModelRegistry extends BaseOpenAICompatibleBYOKRegistry {

// 	constructor(
// 		@IFetcherService _fetcherService: IFetcherService,
// 		@ILogService _logService: ILogService,
// 		@IInstantiationService _instantiationService: IInstantiationService,
// 	) {
// 		super(
// 			BYOKAuthType.PerModelDeployment,
// 			'Azure',
// 			'',
// 			_fetcherService,
// 			_logService,
// 			_instantiationService
// 		);
// 	}

// 	override async getAllModels(_apiKey: string): Promise<{ id: string; name: string }[]> {
// 		// Azure doesn't have a central API for listing models
// 		// Each model has a unique deployment URL
// 		return [];
// 	}
// }
