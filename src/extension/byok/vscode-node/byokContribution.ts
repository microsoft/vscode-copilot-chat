/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commands, Disposable as VSCodeDisposable, window } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels, BYOKModelConfig, BYOKModelRegistry, isBYOKEnabled } from '../../byok/common/byokProvider';
import { AnthropicBYOKModelRegistry } from '../../byok/vscode-node/anthropicProvider';
import { AzureBYOKModelRegistry } from '../../byok/vscode-node/azureProvider';
import { OAIBYOKModelRegistry } from '../../byok/vscode-node/openAIProvider';
import { IExtensionContribution } from '../../common/contributions';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { BYOKUIService, ModelConfig } from './byokUIService';
import { CerebrasModelRegistry } from './cerebrasProvider';
import { GeminiBYOKModelRegistry } from './geminiProvider';
import { GroqModelRegistry } from './groqProvider';
import { OllamaModelRegistry } from './ollamaProvider';
import { OpenRouterBYOKModelRegistry } from './openRouterProvider';
import { OAICompatibleModelRegistry } from './openAICompatibleProvider';

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private _modelRegistries: BYOKModelRegistry[] = [];
	private _registeredModelDisposables = new Map<string, VSCodeDisposable>();
	private _byokUIService!: BYOKUIService; // Set in authChange, so ok to !
	private readonly _byokStorageService: IBYOKStorageService;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IAuthenticationService authService: IAuthenticationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService
	) {
		super();
		this._byokStorageService = new BYOKStorageService(extensionContext);
		this._authChange(authService, instantiationService);

		this._register(authService.onDidAuthenticationChange(() => {
			this._authChange(authService, instantiationService);
		}));

		this._register(window.onDidChangeWindowState((e) => {
			if (e.focused) {
				this.restoreModels();
			}
		}));

		this._register(commands.registerCommand('github.copilot.chat.manageModels', () => this.registerModelCommand()));
	}

	private async _authChange(authService: IAuthenticationService, instantiationService: IInstantiationService) {
		this._modelRegistries = [];
		if (authService.copilotToken?.isInternal) {
			this.testLargeTelemetryPayload();
		}
		if (authService.copilotToken && isBYOKEnabled(authService.copilotToken, this._capiClientService)) {
			// These are intentionally registered in alphabetical order so we don't need to sort them later.
			// They will be shown to the user in the same order.
			this._modelRegistries.push(instantiationService.createInstance(AnthropicBYOKModelRegistry));
			this._modelRegistries.push(instantiationService.createInstance(AzureBYOKModelRegistry));
			if (authService.copilotToken.isInternal) {
				this._modelRegistries.push(instantiationService.createInstance(CerebrasModelRegistry));
			}
			this._modelRegistries.push(instantiationService.createInstance(GeminiBYOKModelRegistry));
			this._modelRegistries.push(instantiationService.createInstance(GroqModelRegistry));
			this._modelRegistries.push(instantiationService.createInstance(OAIBYOKModelRegistry));
			// OpenAI Compatible providers (Like LM Studio, etc.)
			const openAICompatibleProviders = this._configurationService.getConfig(ConfigKey.OpenAICompatibleProviders);
			for (const provider of openAICompatibleProviders) {
				this._modelRegistries.push(instantiationService.createInstance(OAICompatibleModelRegistry, provider.name, provider.url));
			}
			this._modelRegistries.push(instantiationService.createInstance(OllamaModelRegistry, this._configurationService.getConfig(ConfigKey.OllamaEndpoint)));
			this._modelRegistries.push(instantiationService.createInstance(OpenRouterBYOKModelRegistry));
			// Update known models list from CDN so all providers have the same list
			await this.fetchKnownModelList(this._fetcherService);
		}
		this._byokUIService = new BYOKUIService(this._byokStorageService, this._modelRegistries);
		this.restoreModels(true);
	}

	private testLargeTelemetryPayload(): void {
		try {
			// Test different payload sizes
			const sizes = [
				500000,   // 500KB
				800000,   // 800KB
				1000000,  // ~1MB
				1048576,  // Exactly 1MB
			];

			sizes.forEach((size, index) => {
				const payload = 'x'.repeat(size);
				this._telemetryService.sendInternalMSFTTelemetryEvent(`largeTelemetryTest_${index}`, {
					testPayload: payload,
				}, {
					payloadSize: size,
				});

				this._logService.logger.info(`Sent telemetry payload ${index + 1} with ${size} bytes`);
			});
		} catch (error) {
			this._logService.logger.error('Large telemetry test failed', error);
		}
	}


	private async fetchKnownModelList(fetcherService: IFetcherService) {
		const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json', { method: "GET" })).json();
		let knownModels: Record<string, BYOKKnownModels>;
		if (data.version !== 1) {
			this._logService.logger.warn('BYOK: Copilot Chat known models list is not in the expected format. Defaulting to empty list.');
			knownModels = {};
		} else {
			knownModels = data.modelInfo;
		}
		this._logService.logger.info('BYOK: Copilot Chat known models list fetched successfully.');
		for (const registry of this._modelRegistries) {
			registry.updateKnownModelsList(knownModels[registry.name]);
		}
	}

	private async registerModelCommand() {
		// Start the model management flow - this will handle both provider selection and model selection
		const result = await this._byokUIService.startModelManagementFlow();
		if (!result) {
			return;
		}

		const { providerName, selectedModels, customModel, newApiKeyProvided, apiKey, customModelToDelete } = result;
		const providerInfo = this._modelRegistries.find(p => p.name === providerName);
		if (!providerInfo) {
			return;
		}

		// If a new API key was providedd we should re-register all models to ensure they are using the new key
		if (newApiKeyProvided && providerInfo.authType === BYOKAuthType.GlobalApiKey) {
			await this.restoreModels(true);
			return;
		}

		// User pressed trash, we should not only deregister the custom model but also delete it from storage
		if (customModelToDelete) {
			await this.deregisterModel(customModelToDelete, providerName, true);
			return;
		}

		// Get currently registered models
		const modelConfigs = await this._byokStorageService.getStoredModelConfigs(providerName);
		const registeredModels = Object.entries(modelConfigs).filter(c => c[1].isRegistered !== false).map(c => c[0]);

		// Register custom model if provided
		if (customModel) {
			await this.registerModel(customModel.id, providerName, providerInfo, customModel);
		}

		// Models to register (selected but not registered)
		for (const modelId of selectedModels) {
			if (!registeredModels.includes(modelId)) {
				const modelConfig: ModelConfig = {
					id: modelId,
					isCustomModel: modelConfigs[modelId]?.isCustomModel || false,
					apiKey: apiKey || '',
				};
				await this.registerModel(modelId, providerName, providerInfo, modelConfig);
			}
		}

		// Models to deregister (registered but not selected)
		for (const modelId of registeredModels) {
			if (!selectedModels.includes(modelId)) {
				await this.deregisterModel(modelId, providerName, false);
			}
		}
	}



	private async registerModel(
		modelId: string,
		providerName: string,
		providerInfo: BYOKModelRegistry,
		config: ModelConfig
	): Promise<void> {
		try {
			// Create the appropriate BYOKModelConfig based on the provider's authType
			let modelConfig: BYOKModelConfig;

			if (providerInfo.authType === BYOKAuthType.PerModelDeployment && config.deploymentUrl) {
				// For per-model deployment providers like Azure
				modelConfig = {
					modelId,
					apiKey: config.apiKey,
					deploymentUrl: config.deploymentUrl,
					capabilities: config.modelCapabilities
				};
			} else if (providerInfo.authType === BYOKAuthType.GlobalApiKey) {
				// For global API key providers like OpenAI
				modelConfig = {
					modelId,
					apiKey: config.apiKey,
					capabilities: config.modelCapabilities
				};
			} else {
				// For providers that don't require auth like Ollama
				modelConfig = {
					modelId,
					capabilities: config.modelCapabilities
				};
			}

			const disposable = await providerInfo.registerModel(modelConfig);

			this._registeredModelDisposables.set(`${providerName}-${modelId}`, disposable);
			this._register(disposable);

			window.showInformationMessage(`Successfully registered ${providerName} model: ${modelId}`);
			await this._byokStorageService.saveModelConfig(modelId, providerName, config, providerInfo.authType);
		} catch (error) {
			window.showErrorMessage(`Failed to register ${providerName} model: ${error}`);
		}
	}

	private async deregisterModel(modelId: string, providerName: string, isDeletingCustomModel: boolean): Promise<void> {
		try {
			const key = `${providerName}-${modelId}`;
			const disposable = this._registeredModelDisposables.get(key);
			if (disposable) {
				disposable.dispose();
				this._registeredModelDisposables.delete(key);
			}

			await this._byokStorageService.removeModelConfig(modelId, providerName, isDeletingCustomModel);
		} catch (error) {
			window.showErrorMessage(`Failed to deregister ${providerName} model: ${error}`);
		}
	}

	/**
	 * Restores models by registering them based on what is in the storage services
	 * @param force Whether or not we should dispose of all existing registrations and restore from a fresh state
	 */
	private async restoreModels(force?: boolean): Promise<void> {
		if (force) {
			for (const modelDisposable of this._registeredModelDisposables.values()) {
				modelDisposable.dispose();
			}
			this._registeredModelDisposables.clear();
		}
		for (const registry of this._modelRegistries) {
			// Get provider API key for GlobalApiKey type providers
			const providerApiKey = registry.authType === BYOKAuthType.GlobalApiKey ?
				await this._byokStorageService.getAPIKey(registry.name) :
				undefined;

			// If provider requires global API key and we don't have it, skip
			if (registry.authType === BYOKAuthType.GlobalApiKey && !providerApiKey) {
				continue;
			}

			// Get list of registered models from config
			const modelConfigs = await this._byokStorageService.getStoredModelConfigs(registry.name);

			for (const modelId of Object.keys(modelConfigs)) {
				const storageKey = `${registry.name}-${modelId}`;
				if (this._registeredModelDisposables.has(storageKey)) {
					continue;
				}
				try {
					const modelConfig = modelConfigs[modelId];
					let registrationConfig: BYOKModelConfig;

					// Get model-specific API key if needed
					if (registry.authType !== BYOKAuthType.None) {
						const modelApiKey = registry.authType === BYOKAuthType.PerModelDeployment ?
							await this._byokStorageService.getAPIKey(registry.name, modelId) :
							providerApiKey;

						if (!modelApiKey) {
							continue;
						}

						if (registry.authType === BYOKAuthType.PerModelDeployment && modelConfig.deploymentUrl) {
							// For per-model deployment providers like Azure
							registrationConfig = {
								modelId,
								apiKey: modelApiKey,
								deploymentUrl: modelConfig.deploymentUrl,
								capabilities: modelConfig.modelCapabilities
							};
						} else {
							// For global API key providers like OpenAI
							registrationConfig = {
								modelId,
								apiKey: modelApiKey,
								capabilities: modelConfig.modelCapabilities
							};
						}
					} else {
						// For providers that don't require auth like Ollama
						registrationConfig = {
							modelId,
							capabilities: modelConfig.modelCapabilities
						};
					}

					// Register the model with its configuration
					const disposable = await registry.registerModel(registrationConfig);

					this._registeredModelDisposables.set(storageKey, disposable);
					this._register(disposable);
				} catch (error) {
					// Skip registering this model if it fails
				}
			}
		}
	}
}