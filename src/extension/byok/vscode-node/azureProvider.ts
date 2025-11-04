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
import { CustomOAIBYOKModelProvider, hasExplicitApiPath } from './customOAIProvider';

export interface AzureUrlOptions {
	deploymentType: 'completions' | 'responses';
	deploymentName: string;
	apiVersion: string;
}

interface AzureModelConfig {
	deploymentType?: 'completions' | 'responses';
	deploymentName?: string;
	apiVersion?: string;
	temperature?: number;
	url: string;
}

export function resolveAzureUrl(modelId: string, url: string, options?: AzureUrlOptions): string {

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

	// Check if deployment type is specified
	// If no deployment name is provided, use modelId as fallback
	const deploymentName = options?.deploymentName || modelId;
	const deploymentType = options?.deploymentType || 'completions';
	const apiVersion = options?.apiVersion || '2025-01-01-preview';

	// Determine if this is an Azure OpenAI endpoint (requires deployment name in path)
	const isAzureOpenAIEndpointv1 = url.includes('models.ai.azure.com') || url.includes('inference.ml.azure.com');
	const isAzureOpenAIEndpoint = url.includes('openai.azure.com') || url.includes('cognitiveservices.azure.com');

	if (deploymentType === 'responses') {
		// Handle Responses API
		// Deployment name is passed in the request body as 'model' parameter, not in URL
		let resolvedUrl: string;
		if (isAzureOpenAIEndpointv1) {
			resolvedUrl = `${url}/v1/responses?api-version=${apiVersion}`;
		} else if (isAzureOpenAIEndpoint) {
			resolvedUrl = `${url}/openai/responses?api-version=${apiVersion}`;
		} else {
			throw new Error(`Unrecognized Azure deployment URL for Responses API: ${url}`);
		}

		return resolvedUrl;
	} else if (deploymentType === 'completions') {
		// Handle Chat Completions API (default)
		const defaultApiPath = '/chat/completions';
		let resolvedUrl: string;

		if (isAzureOpenAIEndpointv1) {
			resolvedUrl = `${url}/v1${defaultApiPath}`;
		} else if (isAzureOpenAIEndpoint) {
			resolvedUrl = `${url}/openai/deployments/${deploymentName}${defaultApiPath}?api-version=${apiVersion}`;
		} else {
			throw new Error(`Unrecognized Azure deployment URL: ${url}`);
		}
		return resolvedUrl;
	} else {
		throw new Error(`Invalid deployment type specified for model ${modelId}: ${deploymentType}`);
	}
}

export class AzureBYOKModelProvider extends CustomOAIBYOKModelProvider {
	static override readonly providerName = 'Azure';

	constructor(
		_byokStorageService: IBYOKStorageService,
		@IConfigurationService _configurationService: IConfigurationService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IExperimentationService _experimentationService: IExperimentationService
	) {
		super(
			_byokStorageService,
			_configurationService,
			_logService,
			_instantiationService,
			_experimentationService
		);
		// Override the instance properties
		this.providerName = AzureBYOKModelProvider.providerName;
	}

	protected override getConfigKey() {
		return ConfigKey.AzureModels;
	}

	protected override resolveUrl(modelId: string, url: string): string {
		try {
			// Get model config to access deployment options
			const modelConfig = this._configurationService?.getConfig(this.getConfigKey()) as Record<string, AzureModelConfig> | undefined;

			const config = modelConfig?.[modelId];

			const options: AzureUrlOptions | undefined = config ? {
				deploymentType: config.deploymentType || 'completions',
				deploymentName: config.deploymentName || modelId,
				apiVersion: config.apiVersion || '2025-01-01-preview'
			} : undefined;

			const resolvedUrl = resolveAzureUrl(modelId, url, options);
			return resolvedUrl;
		} catch (error) {
			this._logService?.error(`AzureBYOKModelProvider: Error resolving URL for model ${modelId}, falling back to basic resolution:`, error);
			return resolveAzureUrl(modelId, url, undefined);
		}
	}

	protected override async getModelInfo(modelId: string, apiKey: string | undefined, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		try {
			// Get model config to check deployment type and deployment name
			const configKey = this.getConfigKey();

			const modelConfig = this._configurationService?.getConfig(configKey);

			// Safely access the model-specific config
			let config: AzureModelConfig | undefined;
			if (modelConfig && typeof modelConfig === 'object' && modelId in modelConfig) {
				config = (modelConfig as Record<string, AzureModelConfig>)[modelId];
			}

			const deploymentType = config?.deploymentType || 'completions';
			// If no deployment name is provided, use modelId as fallback
			const deploymentName = config?.deploymentName || modelId;

			const modelInfo = await super.getModelInfo(modelId, apiKey, modelCapabilities);

			// Set modelInfo.id to deployment name (or modelId if no deployment name configured)
			modelInfo.id = deploymentName;

			// Set temperature from config if specified
			if (config?.temperature !== undefined) {
				modelInfo.temperature = config.temperature;
			}

			// Set supported endpoints based on deployment type
			if (deploymentType === 'responses') {
				modelInfo.supported_endpoints = [ModelSupportedEndpoint.Responses];
			} else {
				// For completions API, only support chat completions
				modelInfo.supported_endpoints = [ModelSupportedEndpoint.ChatCompletions];
			}

			return modelInfo;
		} catch (error) {
			this._logService?.error(`AzureBYOKModelProvider: Error getting model info for ${modelId}:`, error);
			throw error;
		}
	}
}
