/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ChatResponseFragment2, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatProvider2, LanguageModelChatRequestHandleOptions, Progress } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, resolveModelInfo } from '../common/byokProvider';
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
}

export class AzureBYOKModelProvider implements LanguageModelChatProvider2<AzureModelInfo> {
	private readonly _lmWrapper: CopilotLanguageModelWrapper;
	static readonly providerName = 'Azure';
	constructor(
		private readonly _byokStorageService: IBYOKStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
	}

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
				maxOutputTokens: modelInfo.maxOutputTokens
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
					version: '1.0.0',
					maxOutputTokens: capabilities.maxOutputTokens,
					maxInputTokens: capabilities.maxInputTokens,
					family: AzureBYOKModelProvider.providerName,
					description: `${capabilities.name} is contributed via the ${AzureBYOKModelProvider.providerName} provider.`,
					capabilities: {
						toolCalling: capabilities.toolCalling,
						vision: capabilities.vision
					},
				};
			});
		} catch {
			return [];
		}
	}
	async provideLanguageModelChatResponse(model: AzureModelInfo, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: LanguageModelChatRequestHandleOptions, progress: Progress<ChatResponseFragment2>, token: CancellationToken): Promise<any> {
		const apiKey = await this._byokStorageService.getAPIKey(AzureBYOKModelProvider.providerName, model.id);
		if (!apiKey) {
			this._logService.logger.error(`No API key found for model ${model.id}`);
			throw new Error(`No API key found for model ${model.id}`);
		}
		const modelInfo = resolveModelInfo(model.id, AzureBYOKModelProvider.providerName, undefined, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.vision || false,
			name: model.name,
			url: model.url
		});
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey, model.url);
		return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.extensionId, progress, token);
	}
	async provideTokenCount(model: AzureModelInfo, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const apiKey = await this._byokStorageService.getAPIKey(AzureBYOKModelProvider.providerName, model.id);
		if (!apiKey) {
			this._logService.logger.error(`No API key found for model ${model.id}`);
			throw new Error(`No API key found for model ${model.id}`);
		}
		const modelInfo = resolveModelInfo(model.id, AzureBYOKModelProvider.providerName, undefined, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.vision || false,
			name: model.name,
			url: model.url
		});
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey, model.url);
		return this._lmWrapper.provideTokenCount(openAIChatEndpoint, text);
	}

}
