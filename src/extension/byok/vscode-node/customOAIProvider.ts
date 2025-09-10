/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, Progress, ProvideLanguageModelChatResponseOptions, QuickPickItem, window } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, BYOKModelProvider, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { IBYOKStorageService } from './byokStorageService';
import { promptForAPIKey } from './byokUIService';
import { CustomOAIModelConfigurator } from './customOAIModelConfigurator';

export function resolveCustomOAIUrl(modelId: string, url: string): string {
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

	// For standard OpenAI-compatible endpoints, just append the standard path
	return `${url}/v1/chat/completions`;
}

interface CustomOAIModelInfo extends LanguageModelChatInformation {
	url: string;
	thinking: boolean;
}

export class CustomOAIBYOKModelProvider implements BYOKModelProvider<CustomOAIModelInfo> {
	protected readonly _lmWrapper: CopilotLanguageModelWrapper;
	public readonly authType: BYOKAuthType = BYOKAuthType.PerModelDeployment;

	static readonly providerName: string = 'CustomOAI';
	protected providerName: string = CustomOAIBYOKModelProvider.providerName;

	constructor(
		private readonly _byokStorageService: IBYOKStorageService,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@ILogService protected readonly _logService: ILogService,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IExperimentationService protected readonly _experimentationService: IExperimentationService
	) {
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
	}

	protected getConfigKey() {
		return ConfigKey.CustomOAIModels;
	}

	protected resolveUrl(modelId: string, url: string): string {
		return resolveCustomOAIUrl(modelId, url);
	}

	private getUserModelConfig(): Record<string, { name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; requiresAPIKey: boolean; thinking?: boolean }> {
		const modelConfig = this._configurationService.getConfig(this.getConfigKey()) as Record<string, { name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; requiresAPIKey: boolean; thinking?: boolean }>;
		return modelConfig;
	}

	private requiresAPIKey(modelId: string): boolean {
		const userModelConfig = this.getUserModelConfig();
		return userModelConfig[modelId]?.requiresAPIKey !== false;
	}

	private async getAllModels(): Promise<BYOKKnownModels> {
		const modelConfig = this.getUserModelConfig();
		const models: BYOKKnownModels = {};
		for (const [modelId, modelInfo] of Object.entries(modelConfig)) {
			models[modelId] = {
				name: modelInfo.name,
				url: this.resolveUrl(modelId, modelInfo.url),
				toolCalling: modelInfo.toolCalling,
				vision: modelInfo.vision,
				maxInputTokens: modelInfo.maxInputTokens,
				maxOutputTokens: modelInfo.maxOutputTokens,
				thinking: modelInfo.thinking,
			};
		}
		return models;
	}

	private async getModelsWithAPIKeys(silent: boolean): Promise<BYOKKnownModels> {
		const models = await this.getAllModels();
		const modelsWithApiKeys: BYOKKnownModels = {};
		for (const [modelId, modelInfo] of Object.entries(models)) {
			const requireAPIKey = this.requiresAPIKey(modelId);
			if (!requireAPIKey) {
				modelsWithApiKeys[modelId] = modelInfo;
				continue;
			}
			let apiKey = await this._byokStorageService.getAPIKey(this.providerName, modelId);
			if (!silent && !apiKey) {
				apiKey = await promptForAPIKey(`${this.providerName} - ${modelId}`, false);
				if (apiKey) {
					await this._byokStorageService.storeAPIKey(this.providerName, apiKey, BYOKAuthType.PerModelDeployment, modelId);
				}
			}
			if (apiKey) {
				modelsWithApiKeys[modelId] = modelInfo;
			}
		}
		return modelsWithApiKeys;
	}

	private createModelInfo(id: string, capabilities: BYOKKnownModels[string]): CustomOAIModelInfo {
		const baseInfo: CustomOAIModelInfo = {
			id,
			url: capabilities.url || '',
			name: capabilities.name,
			detail: this.providerName,
			version: '1.0.0',
			maxOutputTokens: capabilities.maxOutputTokens,
			maxInputTokens: capabilities.maxInputTokens,
			family: this.providerName,
			tooltip: `${capabilities.name} is contributed via the ${this.providerName} provider.`,
			capabilities: {
				toolCalling: capabilities.toolCalling,
				imageInput: capabilities.vision
			},
			thinking: capabilities.thinking || false,
		};
		return baseInfo;
	}

	async provideLanguageModelChatInformation(options: { silent: boolean }, token: CancellationToken): Promise<CustomOAIModelInfo[]> {
		try {
			let knownModels = await this.getModelsWithAPIKeys(options.silent);
			if (Object.keys(knownModels).length === 0 && !options.silent) {
				await new CustomOAIModelConfigurator(this._configurationService, this.providerName.toLowerCase(), this).configure(true);
				knownModels = await this.getModelsWithAPIKeys(options.silent);
			}
			return Object.entries(knownModels).map(([id, capabilities]) => {
				return this.createModelInfo(id, capabilities);
			});
		} catch {
			return [];
		}
	}

	async provideLanguageModelChatResponse(model: CustomOAIModelInfo, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<any> {
		const requireAPIKey = this.requiresAPIKey(model.id);
		let apiKey: string | undefined;
		if (requireAPIKey) {
			apiKey = await this._byokStorageService.getAPIKey(this.providerName, model.id);
			if (!apiKey) {
				this._logService.error(`No API key found for model ${model.id}`);
				throw new Error(`No API key found for model ${model.id}`);
			}
		}
		const modelInfo = resolveModelInfo(model.id, this.providerName, undefined, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.imageInput || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking
		});
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey ?? '', model.url);
		return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.requestInitiator, progress, token);
	}

	async provideTokenCount(model: CustomOAIModelInfo, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const requireAPIKey = this.requiresAPIKey(model.id);
		let apiKey: string | undefined;
		if (requireAPIKey) {
			apiKey = await this._byokStorageService.getAPIKey(this.providerName, model.id);
			if (!apiKey) {
				this._logService.error(`No API key found for model ${model.id}`);
				throw new Error(`No API key found for model ${model.id}`);
			}
		}

		const modelInfo = resolveModelInfo(model.id, this.providerName, undefined, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.imageInput || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking
		});
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey ?? '', model.url);
		return this._lmWrapper.provideTokenCount(openAIChatEndpoint, text);
	}

	public async updateAPIKey(): Promise<void> {
		// Get all available models
		const allModels = await this.getAllModels();

		if (Object.keys(allModels).length === 0) {
			await window.showInformationMessage(`No ${this.providerName} models are configured. Please configure models first.`);
			return;
		}

		// Create quick pick items for all models
		interface ModelQuickPickItem extends QuickPickItem {
			modelId: string;
		}

		const modelItems: ModelQuickPickItem[] = Object.entries(allModels).filter(m => this.requiresAPIKey(m[0])).map(([modelId, modelInfo]) => ({
			label: modelInfo.name || modelId,
			description: modelId,
			detail: `URL: ${modelInfo.url}`,
			modelId: modelId
		}));

		// Show quick pick to select which model's API key to update
		const quickPick = window.createQuickPick<ModelQuickPickItem>();
		quickPick.title = `Update ${this.providerName} Model API Key`;
		quickPick.placeholder = 'Select a model to update its API key';
		quickPick.items = modelItems;
		quickPick.ignoreFocusOut = true;

		const selectedModel = await new Promise<ModelQuickPickItem | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				const selected = quickPick.selectedItems[0];
				quickPick.hide();
				resolve(selected);
			});

			quickPick.onDidHide(() => {
				resolve(undefined);
			});

			quickPick.show();
		});

		if (!selectedModel) {
			return; // User cancelled
		}

		// Prompt for new API key
		const newApiKey = await promptForAPIKey(`${this.providerName} - ${selectedModel.modelId}`, true);

		if (newApiKey !== undefined) {
			if (newApiKey.trim() === '') {
				// Empty string means delete the API key
				await this._byokStorageService.deleteAPIKey(this.providerName, BYOKAuthType.PerModelDeployment, selectedModel.modelId);
				await window.showInformationMessage(`API key for ${selectedModel.label} has been deleted.`);
			} else {
				// Store the new API key
				await this._byokStorageService.storeAPIKey(this.providerName, newApiKey, BYOKAuthType.PerModelDeployment, selectedModel.modelId);
				await window.showInformationMessage(`API key for ${selectedModel.label} has been updated.`);
			}
		}
	}
}