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
	deploymentType?: 'completions' | 'responses';
	deploymentName?: string;
	apiVersion?: string;
}

export function resolveAzureUrl(modelId: string, url: string, options?: AzureUrlOptions, logService?: ILogService): string {
	logService?.info(`[Azure Debug] resolveAzureUrl called - modelId: ${modelId}, url: ${url}`);
	logService?.info(`[Azure Debug] options: ${JSON.stringify(options, null, 2)}`);

	// The fully resolved url was already passed in
	if (hasExplicitApiPath(url)) {
		logService?.info(`[Azure Debug] URL has explicit API path, returning as-is: ${url}`);
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

	logService?.info(`[Azure Debug] Resolved values - deploymentName: ${deploymentName}, deploymentType: ${deploymentType}, apiVersion: ${apiVersion}`);

	// Determine if this is an Azure OpenAI endpoint (requires deployment name in path)
	const isAzureOpenAIEndpointv1 = url.includes('models.ai.azure.com') || url.includes('inference.ml.azure.com');
	const isAzureOpenAIEndpoint = url.includes('openai.azure.com') || url.includes('cognitiveservices.azure.com');

	logService?.info(`[Azure Debug] Endpoint detection - v1: ${isAzureOpenAIEndpointv1}, standard: ${isAzureOpenAIEndpoint}`);

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
		logService?.info(`[Azure Debug] Responses API URL resolved to: ${resolvedUrl}`);
		logService?.info(`[Azure Debug] NOTE: Deployment name '${deploymentName}' will be sent in request body as 'model' field`);
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
		logService?.info(`[Azure Debug] Completions API URL resolved to: ${resolvedUrl}`);
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

		// Bind methods to ensure proper context
		this.resolveUrl = this.resolveUrl.bind(this);
		this.getModelInfo = this.getModelInfo.bind(this);
		this.getConfigKey = this.getConfigKey.bind(this);
	}

	protected override getConfigKey() {
		return ConfigKey.AzureModels;
	}

	protected override resolveUrl(modelId: string, url: string): string {
		this._logService?.info(`[Azure Debug] resolveUrl called for modelId: ${modelId}`);
		try {
			// Get model config to access deployment options
			const modelConfig = this._configurationService?.getConfig(this.getConfigKey()) as Record<string, {
				deploymentType?: 'completions' | 'responses';
				deploymentName?: string;
				apiVersion?: string;
				url: string;
			}> | undefined;

			const config = modelConfig?.[modelId];
			this._logService?.info(`[Azure Debug] Model config for ${modelId}: ${JSON.stringify(config, null, 2)}`);

			const options: AzureUrlOptions | undefined = config ? {
				deploymentType: config.deploymentType,
				deploymentName: config.deploymentName,
				apiVersion: config.apiVersion
			} : undefined;

			const resolvedUrl = resolveAzureUrl(modelId, url, options, this._logService);
			this._logService?.info(`[Azure Debug] Final resolved URL: ${resolvedUrl}`);
			return resolvedUrl;
		} catch (error) {
			this._logService?.error(`AzureBYOKModelProvider: Error resolving URL for model ${modelId}:`, error);
			// Fallback to basic URL resolution
			return resolveAzureUrl(modelId, url, undefined, this._logService);
		}
	}

	protected override async getModelInfo(modelId: string, apiKey: string | undefined, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		this._logService?.info(`[Azure Debug] getModelInfo called for modelId: ${modelId}`);
		this._logService?.info(`[Azure Debug] Initial modelCapabilities: ${JSON.stringify(modelCapabilities, null, 2)}`);
		try {
			// Get model config to check deployment type and deployment name
			const configKey = this.getConfigKey();
			this._logService?.info(`[Azure Debug] Config key: ${configKey}`);

			const modelConfig = this._configurationService?.getConfig(configKey);
			this._logService?.info(`[Azure Debug] Raw modelConfig type: ${typeof modelConfig}, value: ${JSON.stringify(modelConfig, null, 2)}`);

			// Safely access the model-specific config
			let config: { deploymentType?: 'completions' | 'responses'; deploymentName?: string } | undefined;
			if (modelConfig && typeof modelConfig === 'object' && modelId in modelConfig) {
				config = (modelConfig as Record<string, any>)[modelId];
			}

			this._logService?.info(`[Azure Debug] Model config for ${modelId}: ${JSON.stringify(config, null, 2)}`);

			const deploymentType = config?.deploymentType || 'completions';
			// If no deployment name is provided, use modelId as fallback
			const deploymentName = config?.deploymentName || modelId;

			this._logService?.info(`[Azure Debug] Deployment info - type: ${deploymentType}, name: ${deploymentName}`);

			// For Azure Responses API, the 'model' field in the request body must be the deployment name
			// We override the modelCapabilities.name to be the deployment name so it gets used correctly
			let updatedCapabilities = modelCapabilities;
			if (deploymentType === 'responses' && modelCapabilities) {
				updatedCapabilities = {
					...modelCapabilities,
					name: deploymentName
				};
				this._logService?.info(`[Azure Debug] RESPONSES API: Overriding model name from '${modelCapabilities.name}' to '${deploymentName}'`);
				this._logService?.info(`[Azure Debug] Updated capabilities: ${JSON.stringify(updatedCapabilities, null, 2)}`);
			} else {
				this._logService?.info(`[Azure Debug] COMPLETIONS API: Using capabilities as-is (deployment name in URL)`);
			}

			const modelInfo = await super.getModelInfo(modelId, apiKey, updatedCapabilities);

			// Always set modelInfo.id to deployment name for Azure deployments
			modelInfo.id = deploymentName;

			// Set supported endpoints based on deployment type
			if (deploymentType === 'responses') {
				modelInfo.supported_endpoints = [ModelSupportedEndpoint.Responses];
				this._logService?.info(`[Azure Debug] Set supported_endpoints to: [Responses]`);
			} else {
				// For completions API, only support chat completions
				modelInfo.supported_endpoints = [ModelSupportedEndpoint.ChatCompletions];
				this._logService?.info(`[Azure Debug] Set supported_endpoints to: [ChatCompletions]`);
			}
			this._logService?.info(`[Azure Debug] Set modelInfo.id to deployment name: '${deploymentName}'`);
			this._logService?.info(`[Azure Debug] Final modelInfo.id: ${modelInfo.id}`);
			this._logService?.info(`[Azure Debug] Final modelInfo.supported_endpoints: ${JSON.stringify(modelInfo.supported_endpoints)}`);

			return modelInfo;
		} catch (error) {
			this._logService?.error(`AzureBYOKModelProvider: Error getting model info for ${modelId}:`, error);
			throw error;
		}
	}
}
