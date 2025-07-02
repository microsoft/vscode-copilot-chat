/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { BYOKAuthType, BYOKModelCapabilities } from '../../byok/common/byokProvider';

export interface StoredModelConfig {
	deploymentUrl?: string;
	isRegistered?: boolean; // Will be undefined for now but eventually storage will update to be true / false.
	isCustomModel?: boolean; // Will be undefined for now but eventually storage will update to be true / false.
	modelCapabilities?: BYOKModelCapabilities;
}

export interface CustomProviderConfig {
	name: string;
	url: string;
	addedAt: number; // timestamp
}

export interface IBYOKStorageService {
	/**
	 * Get API key for a provider or model
	 */
	getAPIKey(providerName: string, modelId?: string): Promise<string | undefined>;

	/**
	 * Store API key for a provider or model based on auth type
	 */
	storeAPIKey(providerName: string, apiKey: string, authType: BYOKAuthType, modelId?: string): Promise<void>;

	/**
	 * Delete API key for a provider or model based on auth type
	 */
	deleteAPIKey(providerName: string, authType: BYOKAuthType, modelId?: string): Promise<void>;

	/**
	 * Get all stored model configurations for a provider
	 */
	getStoredModelConfigs(providerName: string): Promise<Record<string, StoredModelConfig>>;

	/**
	 * Save model configuration to storage
	 */
	saveModelConfig(
		modelId: string,
		providerName: string,
		config: {
			apiKey: string;
			deploymentUrl?: string;
			modelCapabilities?: BYOKModelCapabilities;
		},
		authType: BYOKAuthType
	): Promise<void>;
	/**
	 * Handles the cases
	 * 1. Non custom model, and isDeletingCustomModel = false -> Delete from storage as we have the known model list
	 * 2. Custom model, and isDeletingCustomModel = true -> Delete from storage as we have the known model list
	 * 3. Custom model, and isDeletingCustomModel = false -> Do not delete from storage as we do not have the known model list. Instead mark unregistered
	 */
	removeModelConfig(modelId: string, providerName: string, isDeletingCustomModel: boolean): Promise<void>;

	/**
	 * Get all custom providers
	 */
	getCustomProviders(): Promise<CustomProviderConfig[]>;

	/**
	 * Add a custom provider
	 */
	addCustomProvider(provider: CustomProviderConfig): Promise<void>;

	/**
	 * Remove a custom provider
	 */
	removeCustomProvider(providerName: string): Promise<void>;
}

export class BYOKStorageService implements IBYOKStorageService {
	private readonly _extensionContext: IVSCodeExtensionContext;

	constructor(extensionContext: IVSCodeExtensionContext) {
		this._extensionContext = extensionContext;
	}

	public async getAPIKey(providerName: string, modelId?: string): Promise<string | undefined> {
		// If model-specific key is requested, try to get it first
		if (modelId) {
			const modelKey = await this._extensionContext.secrets.get(`copilot-byok-${providerName}-${modelId}-api-key`);
			if (modelKey) {
				return modelKey;
			}
		}

		// Fall back to provider key if no model-specific key or it was requested directly
		const providerKey = await this._extensionContext.secrets.get(`copilot-byok-${providerName}-api-key`);
		return providerKey;
	}

	public async storeAPIKey(providerName: string, apiKey: string, authType: BYOKAuthType, modelId?: string): Promise<void> {
		// Store API keys based on the provider's auth type
		if (authType === BYOKAuthType.None) {
			// Don't store keys for None auth type providers
			return;
		} else if (authType === BYOKAuthType.GlobalApiKey) {
			// For GlobalApiKey providers, only store at provider level
			await this._extensionContext.secrets.store(`copilot-byok-${providerName}-api-key`, apiKey);
		} else if (authType === BYOKAuthType.PerModelDeployment && modelId) {
			// For PerModelDeployment providers, store per model
			await this._extensionContext.secrets.store(`copilot-byok-${providerName}-${modelId}-api-key`, apiKey);
		}
	}

	public async deleteAPIKey(providerName: string, authType: BYOKAuthType, modelId?: string): Promise<void> {
		// Delete API keys based on the provider's auth type
		if (authType === BYOKAuthType.None) {
			// Nothing to delete for None auth type providers
			return;
		} else if (authType === BYOKAuthType.GlobalApiKey) {
			// For GlobalApiKey providers, delete at provider level
			await this._extensionContext.secrets.delete(`copilot-byok-${providerName}-api-key`);
		} else if (authType === BYOKAuthType.PerModelDeployment && modelId) {
			// For PerModelDeployment providers, delete per model
			await this._extensionContext.secrets.delete(`copilot-byok-${providerName}-${modelId}-api-key`);
		}
	}

	public async getStoredModelConfigs(providerName: string): Promise<Record<string, StoredModelConfig>> {
		return this._extensionContext.globalState.get<Record<string, StoredModelConfig>>(
			`copilot-byok-${providerName}-models-config`,
			{}
		);
	}

	public async saveModelConfig(
		modelId: string,
		providerName: string,
		config: {
			apiKey: string;
			isCustomModel: boolean;
			deploymentUrl?: string;
			modelCapabilities?: BYOKModelCapabilities;
		},
		authType: BYOKAuthType
	): Promise<void> {
		// Save model configuration data
		const configToSave: StoredModelConfig = {
			isCustomModel: config.isCustomModel,
			deploymentUrl: config.deploymentUrl,
			isRegistered: true,
			modelCapabilities: config.modelCapabilities
		};
		const existingConfigs = await this.getStoredModelConfigs(providerName);
		existingConfigs[modelId] = configToSave;
		await this._extensionContext.globalState.update(`copilot-byok-${providerName}-models-config`, existingConfigs);

		await this.storeAPIKey(providerName, config.apiKey, authType, modelId);
	}

	public async removeModelConfig(modelId: string, providerName: string, isDeletingCustomModel: boolean): Promise<void> {
		const existingConfigs = await this.getStoredModelConfigs(providerName);
		const existingConfig = existingConfigs[modelId];
		const isCustomModel = existingConfig?.isCustomModel || false;
		if (existingConfig && (isDeletingCustomModel || !isCustomModel)) {
			delete existingConfigs[modelId];
			await this._extensionContext.globalState.update(
				`copilot-byok-${providerName}-models-config`,
				existingConfigs
			);
			// Remove API key from secrets
			await this._extensionContext.secrets.delete(`copilot-byok-${providerName}-${modelId}-api-key`);
		} else {
			existingConfig.isRegistered = false;
			await this._extensionContext.globalState.update(
				`copilot-byok-${providerName}-models-config`,
				existingConfigs
			);
		}
	}

	public async getCustomProviders(): Promise<CustomProviderConfig[]> {
		return this._extensionContext.globalState.get<CustomProviderConfig[]>(
			'copilot-byok-custom-providers',
			[]
		);
	}

	public async addCustomProvider(provider: CustomProviderConfig): Promise<void> {
		const existingProviders = await this.getCustomProviders();

		// Check if provider with this name already exists
		const existingIndex = existingProviders.findIndex(p => p.name === provider.name);
		if (existingIndex >= 0) {
			// Update existing provider
			existingProviders[existingIndex] = provider;
		} else {
			// Add new provider
			existingProviders.push(provider);
		}

		await this._extensionContext.globalState.update(
			'copilot-byok-custom-providers',
			existingProviders
		);
	}

	public async removeCustomProvider(providerName: string): Promise<void> {
		const existingProviders = await this.getCustomProviders();
		const filteredProviders = existingProviders.filter(p => p.name !== providerName);

		await this._extensionContext.globalState.update(
			'copilot-byok-custom-providers',
			filteredProviders
		);

		// Also remove all model configs for this provider
		await this._extensionContext.globalState.update(
			`copilot-byok-${providerName}-models-config`,
			{}
		);

		// Remove provider API key
		await this._extensionContext.secrets.delete(`copilot-byok-${providerName}-api-key`);
	}
}