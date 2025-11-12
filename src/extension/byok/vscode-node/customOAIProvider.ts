/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, Progress, ProvideLanguageModelChatResponseOptions, QuickPickItem, window } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { EndpointEditToolName, IChatModelInformation, isEndpointEditToolName, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities, BYOKModelProvider, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { IBYOKStorageService } from './byokStorageService';
import { promptForAPIKey } from './byokUIService';
import { CustomOAIModelConfigurator } from './customOAIModelConfigurator';

export function resolveCustomOAIUrl(modelId: string, url: string): string {
	// The fully resolved url was already passed in
	if (hasExplicitApiPath(url)) {
		return url;
	}

	// Remove the trailing slash
	if (url.endsWith('/')) {
		url = url.slice(0, -1);
	}

	// Default to chat completions for base URLs
	const defaultApiPath = '/chat/completions';

	// Check if URL already contains any version pattern like /v1, /v2, etc
	const versionPattern = /\/v\d+$/;
	if (versionPattern.test(url)) {
		return `${url}${defaultApiPath}`;
	}

	// For standard OpenAI-compatible endpoints, just append the standard path
	return `${url}/v1${defaultApiPath}`;
}

export function hasExplicitApiPath(url: string): boolean {
	return url.includes('/responses') || url.includes('/chat/completions');
}

interface CustomOAIModelInfo extends LanguageModelChatInformation {
	url: string;
	thinking: boolean;
	requestHeaders?: Record<string, string>;
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

	protected async getModelInfo(modelId: string, apiKey: string | undefined, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		const modelInfo = await resolveModelInfo(modelId, this.providerName, undefined, modelCapabilities);
		if (modelCapabilities?.url?.includes('/responses')) {
			modelInfo.supported_endpoints = [
				ModelSupportedEndpoint.ChatCompletions,
				ModelSupportedEndpoint.Responses
			];
		}
		return modelInfo;
	}

	private getUserModelConfig(): Record<string, { name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; requiresAPIKey: boolean; thinking?: boolean; editTools?: EndpointEditToolName[]; requestHeaders?: Record<string, string> }> {
		const modelConfig = this._configurationService.getConfig(this.getConfigKey()) as Record<string, { name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; requiresAPIKey: boolean; thinking?: boolean; editTools?: EndpointEditToolName[]; requestHeaders?: Record<string, string> }>;
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
			const resolvedUrl = this.resolveUrl(modelId, modelInfo.url);
			this._logService.info(`BYOK: Resolved URL for model ${this.providerName}/${modelId}: ${resolvedUrl}`);

			models[modelId] = {
				name: modelInfo.name,
				url: resolvedUrl,
				toolCalling: modelInfo.toolCalling,
				vision: modelInfo.vision,
				maxInputTokens: modelInfo.maxInputTokens,
				maxOutputTokens: modelInfo.maxOutputTokens,
				thinking: modelInfo.thinking,
				editTools: modelInfo.editTools,
				requestHeaders: modelInfo.requestHeaders ? { ...modelInfo.requestHeaders } : undefined
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
				imageInput: capabilities.vision,
				editTools: capabilities.editTools
			},
			thinking: capabilities.thinking || false,
			requestHeaders: capabilities.requestHeaders,
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

	async provideLanguageModelChatResponse(model: CustomOAIModelInfo, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		const requireAPIKey = this.requiresAPIKey(model.id);
		let apiKey: string | undefined;
		if (requireAPIKey) {
			apiKey = await this._byokStorageService.getAPIKey(this.providerName, model.id);
			if (!apiKey) {
				this._logService.error(`No API key found for model ${model.id}`);
				throw new Error(`No API key found for model ${model.id}`);
			}
		}
		const modelInfo = await this.getModelInfo(model.id, apiKey, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.imageInput || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking,
			editTools: model.capabilities.editTools?.filter(isEndpointEditToolName),
			requestHeaders: model.requestHeaders,
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

		const modelInfo = await this.getModelInfo(model.id, apiKey, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.imageInput || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking,
			requestHeaders: model.requestHeaders
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

	public async updateAPIKeyViaCmd(envVarName: string, action: 'update' | 'remove' = 'update', modelId: string): Promise<void> {
		if (action === 'remove') {
			await this._byokStorageService.deleteAPIKey(this.providerName, this.authType, modelId);
			this._logService.info(`BYOK: API key removed for provider ${this.providerName}${modelId ? ` and model ${modelId}` : ''}`);
			return;
		}

		const apiKey = process.env[envVarName];
		if (!apiKey) {
			throw new Error(`BYOK: Environment variable ${envVarName} not found or empty for API key management`);
		}

		await this._byokStorageService.storeAPIKey(this.providerName, apiKey, this.authType, modelId);
		this._logService.info(`BYOK: API key updated for provider ${this.providerName}${modelId ? ` and model ${modelId}` : ''} from environment variable ${envVarName}`);
	}
}