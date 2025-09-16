/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commands, LanguageModelChatInformation, lm } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, BYOKModelCapabilities, BYOKModelProvider, isBYOKEnabled } from '../../byok/common/byokProvider';
import { IExtensionContribution } from '../../common/contributions';
import { AnthropicLMProvider } from './anthropicProvider';
import { AzureBYOKModelProvider } from './azureProvider';
import { BedrockLMProvider } from './bedrockProvider';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { CustomOAIModelConfigurator } from './customOAIModelConfigurator';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';
import { GeminiBYOKLMProvider } from './geminiProvider';
import { GroqBYOKLMProvider } from './groqProvider';
import { OllamaLMProvider } from './ollamaProvider';
import { OAIBYOKLMProvider } from './openAIProvider';
import { OpenRouterLMProvider } from './openRouterProvider';
import { XAIBYOKLMProvider } from './xAIProvider';

const BYOKProviders = { AnthropicLMProvider, AzureBYOKModelProvider, BedrockLMProvider, CustomOAIBYOKModelProvider, GeminiBYOKLMProvider, GroqBYOKLMProvider, OllamaLMProvider, OAIBYOKLMProvider, OpenRouterLMProvider, XAIBYOKLMProvider };

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private readonly _byokStorageService: IBYOKStorageService;
	private readonly _providers: Map<string, BYOKModelProvider<LanguageModelChatInformation>> = new Map();
	private _byokProvidersRegistered = false;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IAuthenticationService authService: IAuthenticationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._register(commands.registerCommand('github.copilot.chat.manageBYOK', async (vendor: string) => {
			const provider = this._providers.get(vendor);

			// Show quick pick for Azure and CustomOAI providers
			if (provider && (vendor === AzureBYOKModelProvider.providerName.toLowerCase() || vendor === CustomOAIBYOKModelProvider.providerName.toLowerCase())) {
				const configurator = new CustomOAIModelConfigurator(this._configurationService, vendor, provider);
				await configurator.configureModelOrUpdateAPIKey();
			} else if (provider) {
				// For all other providers, directly go to API key management
				await provider.updateAPIKey();
			}
		}));

		this._byokStorageService = new BYOKStorageService(extensionContext);
		this._authChange(authService, this._instantiationService);

		this._register(authService.onDidAuthenticationChange(() => {
			this._authChange(authService, this._instantiationService);
		}));
	}

	private async _authChange(authService: IAuthenticationService, instantiationService: IInstantiationService) {
		if (authService.copilotToken && isBYOKEnabled(authService.copilotToken, this._capiClientService) && !this._byokProvidersRegistered) {
			this._byokProvidersRegistered = true;
			// Update known models list from CDN so all providers have the same list
			const knownModels = await this.fetchKnownModelList(this._fetcherService);

			for (const ProviderClass of Object.values(BYOKProviders)) {
				const providerName = ProviderClass.providerName.toLowerCase();
				let providerInstance;

				// Handle special instantiation cases
				if (ProviderClass === OllamaLMProvider) {
					providerInstance = instantiationService.createInstance(ProviderClass, this._configurationService.getConfig(ConfigKey.OllamaEndpoint), this._byokStorageService);
				} else if (ProviderClass === AzureBYOKModelProvider || ProviderClass === CustomOAIBYOKModelProvider || ProviderClass === OpenRouterLMProvider) {
					// These providers don't need knownModels
					providerInstance = instantiationService.createInstance(ProviderClass, this._byokStorageService);
				} else if (ProviderClass === BedrockLMProvider) {
					// Bedrock doesn't use byokStorageService
					providerInstance = instantiationService.createInstance(ProviderClass, knownModels[ProviderClass.providerName]);
				} else {
					// Standard providers that need knownModels and byokStorageService
					providerInstance = instantiationService.createInstance(ProviderClass, knownModels[ProviderClass.providerName], this._byokStorageService);
				}

				this._providers.set(providerName, providerInstance);
			}

			for (const [providerName, provider] of this._providers) {
				this._store.add(lm.registerLanguageModelChatProvider(providerName, provider));
			}
		}
	}
	private async fetchKnownModelList(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
		let knownModels: Record<string, BYOKKnownModels> = {};

		try {
			const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json', { method: "GET" })).json();
			if (data.version !== 1) {
				this._logService.warn('BYOK: Copilot Chat known models list is not in the expected format. Falling back to configuration-based models.');
			} else {
				knownModels = data.modelInfo;
				this._logService.info(`BYOK: Available providers in known models: ${Object.keys(knownModels).join(', ')}`);
			}
		} catch (error) {
			this._logService.warn(`BYOK: Failed to fetch known models from CDN. Falling back to configuration-based models. Error: ${error}`);
		}

		// Fallback: Add models from configuration for providers that don't have models from CDN
		// Useful for local testing of new BYOK providers or if CDN is unreachable
		this._addConfiguredModelsToKnownList(knownModels);

		this._logService.info('BYOK: Copilot Chat known models list processed successfully.');
		return knownModels;
	}

	private _addConfiguredModelsToKnownList(knownModels: Record<string, BYOKKnownModels>): void {
		// Mapping of provider names to their config keys
		const providerConfigKeys: Record<string, any> = {
			[BYOKProviders.AzureBYOKModelProvider.providerName]: ConfigKey.AzureModels,
			[BYOKProviders.CustomOAIBYOKModelProvider.providerName]: ConfigKey.CustomOAIModels,
			[BYOKProviders.BedrockLMProvider.providerName]: ConfigKey.BedrockModels,
			// Add more providers here as needed for local testing
		};

		for (const ProviderClass of Object.values(BYOKProviders)) {
			const providerName = ProviderClass.providerName;

			// Initialize models object if it doesn't exist
			if (!knownModels[providerName]) {
				knownModels[providerName] = {};
			}

			// Check if this provider has a corresponding config key
			const configKey = providerConfigKeys[providerName];
			if (!configKey) {
				continue;
			}

			const configuredModels = this._configurationService.getConfig(configKey);
			if (configuredModels && Object.keys(configuredModels).length > 0) {
				let addedCount = 0;

				for (const [modelId, modelConfig] of Object.entries(configuredModels)) {
					// Skip if model already exists from CDN (don't override)
					if (knownModels[providerName][modelId]) {
						continue;
					}

					addedCount++;
					// Use standard model config format if available, otherwise provide defaults
					if (typeof modelConfig === 'object' && modelConfig.name) {
						// Standard format with all properties specified
						knownModels[providerName][modelId] = {
							name: modelConfig.name,
							maxInputTokens: modelConfig.maxInputTokens || 200000,
							maxOutputTokens: modelConfig.maxOutputTokens || 8192,
							toolCalling: modelConfig.toolCalling ?? true,
							vision: modelConfig.vision ?? false,
							thinking: modelConfig.thinking
						} as BYOKModelCapabilities;
					}
				}

				if (addedCount > 0) {
					this._logService.info(`BYOK: Added ${addedCount} ${providerName} models from configuration.`);
				}
			}
		}
	}
}