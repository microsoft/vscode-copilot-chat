/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ChatResponseFragment2, Event, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatRequestHandleOptions, Progress, QuickPickItem, window } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, BYOKModelProvider, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { IBYOKStorageService } from './byokStorageService';
import { promptForAPIKey } from './byokUIService';


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

interface AzureModelInfo extends LanguageModelChatInformation {
	url: string;
	thinking: boolean;
}

export class AzureBYOKModelProvider implements BYOKModelProvider<AzureModelInfo> {
	private readonly _lmWrapper: CopilotLanguageModelWrapper;
	static readonly providerName = 'Azure';
	public readonly authType: BYOKAuthType = BYOKAuthType.PerModelDeployment;
	constructor(
		private readonly _byokStorageService: IBYOKStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
	}

	onDidChange?: Event<void> | undefined;

	private async getAllModels(): Promise<BYOKKnownModels> {
		const azureModelConfig = this._configurationService.getConfig(ConfigKey.AzureModels);
		const models: BYOKKnownModels = {};
		for (const [modelId, modelInfo] of Object.entries(azureModelConfig)) {
			models[modelId] = {
				name: modelInfo.name,
				url: resolveAzureUrl(modelId, modelInfo.url),
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
			let apiKey = await this._byokStorageService.getAPIKey(AzureBYOKModelProvider.providerName, modelId);
			if (!silent && !apiKey) {
				apiKey = await promptForAPIKey(`Azure - ${modelId}`, false);
				if (apiKey) {
					await this._byokStorageService.storeAPIKey(AzureBYOKModelProvider.providerName, apiKey, BYOKAuthType.PerModelDeployment, modelId);
				}
			}
			if (apiKey) {
				modelsWithApiKeys[modelId] = modelInfo;
			}
		}
		return modelsWithApiKeys;
	}

	async prepareLanguageModelChat(options: { silent: boolean }, token: CancellationToken): Promise<AzureModelInfo[]> {
		try {
			const knownModels = await this.getModelsWithAPIKeys(options.silent);
			return Object.entries(knownModels).map(([id, capabilities]) => {
				return {
					id,
					url: capabilities.url || '',
					name: capabilities.name,
					cost: AzureBYOKModelProvider.providerName,
					version: '1.0.0',
					maxOutputTokens: capabilities.maxOutputTokens,
					maxInputTokens: capabilities.maxInputTokens,
					family: AzureBYOKModelProvider.providerName,
					description: `${capabilities.name} is contributed via the ${AzureBYOKModelProvider.providerName} provider.`,
					capabilities: {
						toolCalling: capabilities.toolCalling,
						vision: capabilities.vision
					},
					thinking: capabilities.thinking || false,
				};
			});
		} catch {
			return [];
		}
	}
	async provideLanguageModelChatResponse(model: AzureModelInfo, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: LanguageModelChatRequestHandleOptions, progress: Progress<ChatResponseFragment2>, token: CancellationToken): Promise<any> {
		const apiKey = await this._byokStorageService.getAPIKey(AzureBYOKModelProvider.providerName, model.id);
		if (!apiKey) {
			this._logService.error(`No API key found for model ${model.id}`);
			throw new Error(`No API key found for model ${model.id}`);
		}
		const modelInfo = resolveModelInfo(model.id, AzureBYOKModelProvider.providerName, undefined, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.vision || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking
		});
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey, model.url);
		return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.extensionId, progress, token);
	}
	async provideTokenCount(model: AzureModelInfo, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const apiKey = await this._byokStorageService.getAPIKey(AzureBYOKModelProvider.providerName, model.id);
		if (!apiKey) {
			this._logService.error(`No API key found for model ${model.id}`);
			throw new Error(`No API key found for model ${model.id}`);
		}
		const modelInfo = resolveModelInfo(model.id, AzureBYOKModelProvider.providerName, undefined, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.vision || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking
		});
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey, model.url);
		return this._lmWrapper.provideTokenCount(openAIChatEndpoint, text);
	}

	public async updateAPIKey(): Promise<void> {
		// Get all available models
		const allModels = await this.getAllModels();

		if (Object.keys(allModels).length === 0) {
			await window.showInformationMessage('No Azure models are configured. Please configure models first.');
			return;
		}

		// Create quick pick items for all models
		interface ModelQuickPickItem extends QuickPickItem {
			modelId: string;
		}

		const modelItems: ModelQuickPickItem[] = Object.entries(allModels).map(([modelId, modelInfo]) => ({
			label: modelInfo.name || modelId,
			description: modelId,
			detail: `URL: ${modelInfo.url}`,
			modelId: modelId
		}));

		// Show quick pick to select which model's API key to update
		const quickPick = window.createQuickPick<ModelQuickPickItem>();
		quickPick.title = 'Update Azure Model API Key';
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
		const newApiKey = await promptForAPIKey(`Azure - ${selectedModel.modelId}`, true);

		if (newApiKey !== undefined) {
			if (newApiKey.trim() === '') {
				// Empty string means delete the API key
				await this._byokStorageService.deleteAPIKey(AzureBYOKModelProvider.providerName, BYOKAuthType.PerModelDeployment, selectedModel.modelId);
				await window.showInformationMessage(`API key for ${selectedModel.label} has been deleted.`);
			} else {
				// Store the new API key
				await this._byokStorageService.storeAPIKey(AzureBYOKModelProvider.providerName, newApiKey, BYOKAuthType.PerModelDeployment, selectedModel.modelId);
				await window.showInformationMessage(`API key for ${selectedModel.label} has been updated.`);
			}
		}
	}

}
