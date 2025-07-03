/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, lm } from 'vscode';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities, BYOKModelConfig, BYOKModelRegistry, chatModelInfoToProviderMetadata, isNoAuthConfig, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';

export interface CustomProviderConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
	enabled: boolean;
}

/**
 * A registry for custom OpenAI-compatible providers configured by the user
 */
export class CustomBYOKModelRegistry implements BYOKModelRegistry {
	private _knownModels: BYOKKnownModels | undefined;

	constructor(
		public readonly authType: BYOKAuthType,
		public readonly name: string,
		private readonly _customProvider: CustomProviderConfig,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) { }

	updateKnownModelsList(knownModels: BYOKKnownModels | undefined): void {
		this._knownModels = knownModels;
	}

	async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		return resolveModelInfo(modelId, this.name, this._knownModels, modelCapabilities);
	}

	async getAllModels(apiKey?: string): Promise<{ id: string; name: string }[]> {
		try {
			const effectiveApiKey = apiKey || this._customProvider.apiKey;
			const baseUrl = this._customProvider.baseUrl.replace(/\/$/, ''); // Remove trailing slash

			this._logService.logger.debug(`Fetching models from ${this.name} at ${baseUrl}/models`);

			const response = await this._fetcherService.fetch(`${baseUrl}/models`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${effectiveApiKey}`,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const models = await response.json();
			if (models.error) {
				throw new Error(models.error.message || 'API returned an error');
			}

			const modelList: { id: string; name: string }[] = [];
			const modelData = models.data || models.models || []; // Support different response formats

			for (const model of modelData) {
				// Handle different model object formats
				const modelId = model.id || model.model || model.name;
				if (modelId) {
					// Use known model info if available, otherwise use the model id as name
					const knownModelInfo = this._knownModels?.[modelId];
					modelList.push({
						id: modelId,
						name: knownModelInfo?.name || model.name || modelId,
					});
				}
			}

			this._logService.logger.debug(`Found ${modelList.length} models from ${this.name}`);
			return modelList;
		} catch (error) {
			this._logService.logger.error(error, `Error fetching available ${this.name} models from ${this._customProvider.baseUrl}`);
			throw new Error(`Failed to fetch models from ${this.name}: ${error.message || error}`);
		}
	}

	async registerModel(config: BYOKModelConfig): Promise<Disposable> {
		const apiKey: string = isNoAuthConfig(config) ? this._customProvider.apiKey : (config as any).apiKey;
		try {
			const modelInfo: IChatModelInformation = await this.getModelInfo(config.modelId, apiKey, config.capabilities);

			const lmModelMetadata = chatModelInfoToProviderMetadata(modelInfo);

			const baseUrl = this._customProvider.baseUrl.replace(/\/$/, ''); // Remove trailing slash
			const modelUrl = `${baseUrl}/chat/completions`;
			const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey, modelUrl);
			const provider = this._instantiationService.createInstance(CopilotLanguageModelWrapper, openAIChatEndpoint, lmModelMetadata);

			const disposable = lm.registerChatModelProvider(
				`${this.name}-${config.modelId}`,
				provider,
				lmModelMetadata
			);
			return disposable;
		} catch (e) {
			this._logService.logger.error(`Error registering ${this.name} model ${config.modelId}`);
			throw e;
		}
	}

	/**
	 * Validates if the custom provider configuration is valid
	 */
	async validateProvider(): Promise<{ valid: boolean; error?: string }> {
		try {
			// Basic configuration validation
			if (!this._customProvider.name?.trim()) {
				return { valid: false, error: 'Provider name is required' };
			}

			if (!this._customProvider.baseUrl?.trim()) {
				return { valid: false, error: 'Base URL is required' };
			}

			if (!this._customProvider.apiKey?.trim()) {
				return { valid: false, error: 'API key is required' };
			}

			// URL format validation
			try {
				new URL(this._customProvider.baseUrl);
			} catch {
				return { valid: false, error: 'Invalid base URL format' };
			}

			const baseUrl = this._customProvider.baseUrl.replace(/\/$/, '');

			this._logService.logger.debug(`Validating provider ${this.name} at ${baseUrl}`);

			// Test basic connectivity and API key validity
			const response = await this._fetcherService.fetch(`${baseUrl}/models`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this._customProvider.apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				return {
					valid: false,
					error: `HTTP ${response.status}: ${response.statusText}`
				};
			}

			const data = await response.json();
			if (data.error) {
				return {
					valid: false,
					error: data.error.message || 'API returned an error'
				};
			}

			// Check if response has expected structure
			const hasModels = data.data || data.models || Array.isArray(data);
			if (!hasModels) {
				return {
					valid: false,
					error: 'Provider response does not contain models list'
				};
			}

			this._logService.logger.debug(`Provider ${this.name} validation successful`);
			return { valid: true };
		} catch (error) {
			this._logService.logger.error(error, `Validation failed for provider ${this.name}`);
			return {
				valid: false,
				error: error.message || 'Failed to connect to provider'
			};
		}
	}
}

/**
 * Factory function to create custom provider registries from configuration
 */
export function createCustomProviderRegistries(
	customProviders: CustomProviderConfig[],
	fetcherService: IFetcherService,
	logService: ILogService,
	instantiationService: IInstantiationService
): CustomBYOKModelRegistry[] {
	return customProviders
		.filter(provider => provider.enabled)
		.map(provider => new CustomBYOKModelRegistry(
			BYOKAuthType.GlobalApiKey,
			provider.name,
			provider,
			fetcherService,
			logService,
			instantiationService
		));
}
