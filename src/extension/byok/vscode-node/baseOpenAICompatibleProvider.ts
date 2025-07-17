/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ChatResponseFragment2, Disposable, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatProvider2, LanguageModelChatRequestHandleOptions, lm, Progress } from 'vscode';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKGlobalKeyModelConfig, BYOKKnownModels, BYOKModelCapabilities, BYOKModelConfig, BYOKModelRegistry, BYOKPerModelConfig, chatModelInfoToProviderMetadata, isNoAuthConfig, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';

/**
 * A base class to make implementing registries which provide open AI compatible models easy.
 * See Gemini, OpenRouter, and OpenAI for example extensions of this class
 */
export abstract class BaseOpenAICompatibleBYOKRegistry implements BYOKModelRegistry {
	private _knownModels: BYOKKnownModels | undefined;
	constructor(
		public readonly authType: BYOKAuthType,
		public readonly name: string,
		private readonly _baseUrl: string,
		@IFetcherService protected readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) { }

	updateKnownModelsList(knownModels: BYOKKnownModels | undefined): void {
		this._knownModels = knownModels;
	}

	async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		return resolveModelInfo(modelId, this.name, this._knownModels, modelCapabilities);
	}

	async getAllModels(apiKey: string): Promise<{ id: string; name: string }[]> {
		try {
			const response = await this._fetcherService.fetch(`${this._baseUrl}/models`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			const models = await response.json();
			if (models.error) {
				throw models.error;
			}
			const modelList: { id: string; name: string }[] = [];
			for (const model of models.data) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList.push({
						id: model.id,
						name: this._knownModels[model.id].name,
					});
				}
			}
			return modelList;
		} catch (error) {
			this._logService.logger.error(error, `Error fetching available ${this.name} models`);
			throw new Error(error.message ? error.message : error);
		}
	}

	async registerModel(config: BYOKModelConfig): Promise<Disposable> {
		const apiKey: string = isNoAuthConfig(config) ? '' : (config as BYOKPerModelConfig | BYOKGlobalKeyModelConfig).apiKey;
		try {
			const modelInfo: IChatModelInformation = await this.getModelInfo(config.modelId, apiKey, config.capabilities);

			const lmModelMetadata = chatModelInfoToProviderMetadata(modelInfo);

			const modelUrl = (config as BYOKPerModelConfig)?.deploymentUrl ?? `${this._baseUrl}/chat/completions`;
			const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey, modelUrl);
			const wrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper, openAIChatEndpoint);

			// Convert the legacy metadata to new API format
			const modelInformation: LanguageModelChatInformation = {
				id: `${this.name}-${config.modelId}`,
				name: lmModelMetadata.name,
				family: lmModelMetadata.family,
				description: lmModelMetadata.description,
				version: lmModelMetadata.version,
				maxInputTokens: lmModelMetadata.maxInputTokens,
				maxOutputTokens: lmModelMetadata.maxOutputTokens,
				capabilities: {
					toolCalling: lmModelMetadata.capabilities?.toolCalling,
					vision: lmModelMetadata.capabilities?.vision,
				},
				auth: true
			};

			const provider = new BYOKCopilotWrapperProvider(wrapper, modelInformation);

			const disposable = lm.registerChatModelProvider(
				this.name,
				provider
			);
			return disposable;
		} catch (e) {
			this._logService.logger.error(`Error registering ${this.name} model ${config.modelId}`);
			throw e;
		}
	}
}

/**
 * Wrapper class to adapt CopilotLanguageModelWrapper to the new LanguageModelChatProvider2 API
 */
class BYOKCopilotWrapperProvider implements LanguageModelChatProvider2<LanguageModelChatInformation> {
	constructor(
		private readonly wrapper: CopilotLanguageModelWrapper,
		private readonly modelInfo: LanguageModelChatInformation
	) { }

	async prepareLanguageModelChat(options: { silent: boolean }, token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		return [this.modelInfo];
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		options: LanguageModelChatRequestHandleOptions,
		progress: Progress<ChatResponseFragment2>,
		token: CancellationToken
	): Promise<any> {
		// The wrapper expects the old interface, so we need to adapt
		return this.wrapper.provideLanguageModelResponse(
			messages as any,
			{
				...options,
				modelOptions: options.modelOptions
			} as any,
			options.extensionId,
			progress,
			token
		);
	}

	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage | LanguageModelChatMessage2,
		token: CancellationToken
	): Promise<number> {
		return this.wrapper.provideTokenCount(text as any);
	}
}