/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ChatResponseFragment2, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatRequestHandleOptions, Progress } from 'vscode';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, byokKnownModelsToAPIInfo, BYOKModelCapabilities, BYOKModelProvider, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { IBYOKStorageService } from './byokStorageService';
import { promptForAPIKey } from './byokUIService';

export abstract class BaseOpenAICompatibleLMProvider implements BYOKModelProvider<LanguageModelChatInformation> {

	private readonly _lmWrapper: CopilotLanguageModelWrapper;
	private _apiKey: string | undefined;
	constructor(
		public readonly authType: BYOKAuthType,
		private readonly _name: string,
		private readonly _baseUrl: string,
		protected _knownModels: BYOKKnownModels | undefined,
		private readonly _byokStorageService: IBYOKStorageService,
		@IFetcherService protected readonly _fetcherService: IFetcherService,
		@ILogService protected readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
	}

	protected async getModelInfo(modelId: string, apiKey: string | undefined, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		return resolveModelInfo(modelId, this._name, this._knownModels, modelCapabilities);
	}

	protected async getAllModels(): Promise<BYOKKnownModels> {
		try {
			const response = await this._fetcherService.fetch(`${this._baseUrl}/models`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this._apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			const models = await response.json();
			if (models.error) {
				throw models.error;
			}
			const modelList: BYOKKnownModels = {};
			for (const model of models.data) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList[model.id] = this._knownModels[model.id];
				}
			}
			return modelList;
		} catch (error) {
			this._logService.error(error, `Error fetching available ${this._name} models`);
			throw new Error(error.message ? error.message : error);
		}
	}

	async prepareLanguageModelChat(options: { silent: boolean }, token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		if (!this._apiKey && this.authType === BYOKAuthType.GlobalApiKey) { // If we don't have the API key it might just be in storage, so we try to read it first
			this._apiKey = await this._byokStorageService.getAPIKey(this._name);
		}
		try {
			if (this._apiKey || this.authType === BYOKAuthType.None) {
				return byokKnownModelsToAPIInfo(this._name, await this.getAllModels());
			} else if (options.silent && !this._apiKey) {
				return [];
			} else { // Not silent, and no api key = good to prompt user for api key
				await this.updateAPIKey();
				if (this._apiKey) {
					return byokKnownModelsToAPIInfo(this._name, await this.getAllModels());
				} else {
					return [];
				}
			}
		} catch {
			return [];
		}
	}
	async provideLanguageModelChatResponse(model: LanguageModelChatInformation, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: LanguageModelChatRequestHandleOptions, progress: Progress<ChatResponseFragment2>, token: CancellationToken): Promise<any> {
		const modelInfo: IChatModelInformation = await this.getModelInfo(model.id, this._apiKey);
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, this._apiKey ?? '', `${this._baseUrl}/chat/completions`);
		return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.extensionId, progress, token);
	}
	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const modelInfo: IChatModelInformation = await this.getModelInfo(model.id, this._apiKey);
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, this._apiKey ?? '', `${this._baseUrl}/chat/completions`);
		return this._lmWrapper.provideTokenCount(openAIChatEndpoint, text);
	}

	async updateAPIKey(): Promise<void> {
		if (this.authType === BYOKAuthType.None) {
			return;
		}
		this._apiKey = await promptForAPIKey(this._name, await this._byokStorageService.getAPIKey(this._name) !== undefined);
		if (this._apiKey) {
			this._byokStorageService.storeAPIKey(this._name, this._apiKey, BYOKAuthType.GlobalApiKey);
		}
	}
}