/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commands, LanguageModelChatInformation, lm, window } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, BYOKModelProvider, isBYOKEnabled } from '../../byok/common/byokProvider';
import { IExtensionContribution } from '../../common/contributions';
import { AnthropicLMProvider } from './anthropicProvider';
import { AzureBYOKModelProvider } from './azureProvider';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { CustomOAIModelConfigurator } from './customOAIModelConfigurator';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';
import { GeminiBYOKLMProvider } from './geminiProvider';
import { GroqBYOKLMProvider } from './groqProvider';
import { OllamaLMProvider } from './ollamaProvider';
import { OAIBYOKLMProvider } from './openAIProvider';
import { OpenRouterLMProvider } from './openRouterProvider';
import { XAIBYOKLMProvider } from './xAIProvider';

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
			if (vendor === AzureBYOKModelProvider.providerName.toLowerCase() || vendor === CustomOAIBYOKModelProvider.providerName.toLowerCase()) {
				interface BYOKQuickPickItem {
					label: string;
					detail: string;
					action: 'apiKey' | 'configureModels';
				}

				const options: BYOKQuickPickItem[] = [
					{
						label: '$(key) Manage API Key',
						detail: 'Update or configure the API key for this provider',
						action: 'apiKey'
					},
					{
						label: '$(settings-gear) Configure Models',
						detail: 'Add, edit, or remove model configurations',
						action: 'configureModels'
					}
				];

				const quickPick = window.createQuickPick<BYOKQuickPickItem>();
				quickPick.title = `Manage ${vendor === AzureBYOKModelProvider.providerName.toLowerCase() ? 'Azure' : 'Custom OpenAI'} Provider`;
				quickPick.placeholder = 'Choose an action';
				quickPick.items = options;
				quickPick.ignoreFocusOut = true;

				const selected = await new Promise<BYOKQuickPickItem | undefined>((resolve) => {
					quickPick.onDidAccept(() => {
						const selectedItem = quickPick.selectedItems[0];
						resolve(selectedItem);
						quickPick.hide();
					});

					quickPick.onDidHide(() => {
						resolve(undefined);
					});

					quickPick.show();
				});

				if (selected?.action === 'apiKey' && provider) {
					await provider.updateAPIKey();
				} else if (selected?.action === 'configureModels') {
					if (vendor === AzureBYOKModelProvider.providerName.toLowerCase()) {
						const configurator = new CustomOAIModelConfigurator(this._configurationService, ConfigKey.AzureModels, true);
						await configurator.configure();
					} else if (vendor === CustomOAIBYOKModelProvider.providerName.toLowerCase()) {
						const configurator = new CustomOAIModelConfigurator(this._configurationService);
						await configurator.configure();
					}
				}
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
			this._providers.set(OllamaLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OllamaLMProvider, this._configurationService.getConfig(ConfigKey.OllamaEndpoint), this._byokStorageService));
			this._providers.set(AnthropicLMProvider.providerName.toLowerCase(), instantiationService.createInstance(AnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService));
			this._providers.set(GroqBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(GroqBYOKLMProvider, knownModels[GroqBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(GeminiBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(GeminiBYOKLMProvider, knownModels[GeminiBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(XAIBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(XAIBYOKLMProvider, knownModels[XAIBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(OAIBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OAIBYOKLMProvider, knownModels[OAIBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(OpenRouterLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OpenRouterLMProvider, this._byokStorageService));
			this._providers.set(AzureBYOKModelProvider.providerName.toLowerCase(), instantiationService.createInstance(AzureBYOKModelProvider, this._byokStorageService));
			this._providers.set(CustomOAIBYOKModelProvider.providerName.toLowerCase(), instantiationService.createInstance(CustomOAIBYOKModelProvider, this._byokStorageService));

			for (const [providerName, provider] of this._providers) {
				this._store.add(lm.registerLanguageModelChatProvider(providerName, provider));
			}
		}
	}
	private async fetchKnownModelList(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
		const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json', { method: "GET" })).json();
		let knownModels: Record<string, BYOKKnownModels>;
		if (data.version !== 1) {
			this._logService.warn('BYOK: Copilot Chat known models list is not in the expected format. Defaulting to empty list.');
			knownModels = {};
		} else {
			knownModels = data.modelInfo;
		}
		this._logService.info('BYOK: Copilot Chat known models list fetched successfully.');
		return knownModels;
	}
}