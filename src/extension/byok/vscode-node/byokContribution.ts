/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { lm } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, isBYOKEnabled } from '../../byok/common/byokProvider';
import { IExtensionContribution } from '../../common/contributions';
import { AnthropicLMProvider } from './anthropicProvider';
import { AzureBYOKModelProvider } from './azureProvider';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { GeminiBYOKLMProvider } from './geminiProvider';
import { GroqBYOKLMProvider } from './groqProvider';
import { OllamaLMProvider } from './ollamaProvider';
import { OAIBYOKLMProvider } from './openAIProvider';
import { OpenRouterLMProvider } from './openRouterProvider';

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private readonly _byokStorageService: IBYOKStorageService;

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
		this._byokStorageService = new BYOKStorageService(extensionContext);
		this._authChange(authService, this._instantiationService);

		this._register(authService.onDidAuthenticationChange(() => {
			this._authChange(authService, this._instantiationService);
		}));
	}

	private async _authChange(authService: IAuthenticationService, instantiationService: IInstantiationService) {
		if (authService.copilotToken && isBYOKEnabled(authService.copilotToken, this._capiClientService)) {
			// Update known models list from CDN so all providers have the same list
			const knownModels = await this.fetchKnownModelList(this._fetcherService);
			this._store.add(lm.registerChatModelProvider(OllamaLMProvider.providerName.toLowerCase(), this._instantiationService.createInstance(OllamaLMProvider, this._configurationService.getConfig(ConfigKey.OllamaEndpoint), this._byokStorageService)));
			this._store.add(lm.registerChatModelProvider(AnthropicLMProvider.providerName.toLowerCase(), this._instantiationService.createInstance(AnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService)));
			this._store.add(lm.registerChatModelProvider(GroqBYOKLMProvider.providerName.toLowerCase(), this._instantiationService.createInstance(GroqBYOKLMProvider, knownModels[GroqBYOKLMProvider.providerName], this._byokStorageService)));
			this._store.add(lm.registerChatModelProvider(GeminiBYOKLMProvider.providerName.toLowerCase(), this._instantiationService.createInstance(GeminiBYOKLMProvider, knownModels[GeminiBYOKLMProvider.providerName], this._byokStorageService)));
			this._store.add(lm.registerChatModelProvider(OAIBYOKLMProvider.providerName.toLowerCase(), this._instantiationService.createInstance(OAIBYOKLMProvider, knownModels[OAIBYOKLMProvider.providerName], this._byokStorageService)));
			this._store.add(lm.registerChatModelProvider(OpenRouterLMProvider.providerName.toLowerCase(), this._instantiationService.createInstance(OpenRouterLMProvider, this._byokStorageService)));
			this._store.add(lm.registerChatModelProvider('azure', this._instantiationService.createInstance(AzureBYOKModelProvider, this._byokStorageService)));
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