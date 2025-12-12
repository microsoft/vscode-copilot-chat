/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
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
	protected _apiKey: string | undefined;
	constructor(
		public readonly authType: BYOKAuthType,
		private readonly _name: string,
		protected readonly _baseUrl: string,
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
			this._logService.trace(`Fetched ${models.data.length} models from ${this._name}`);
			const modelList: BYOKKnownModels = {};
			for (const model of models.data) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList[model.id] = this._knownModels[model.id];
				}
			}
			this._logService.trace(`Filtered to ${Object.keys(modelList).length} known models for ${this._name}`);
			return modelList;
		} catch (error) {
			throw new Error(error.message ? error.message : error);
		}
	}

	async provideLanguageModelChatInformation(options: { silent: boolean }, token: CancellationToken): Promise<LanguageModelChatInformation[]> {
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
		} catch (e) {
			// Likely bad API key so we will prompt user to update it one more time
			if (!options.silent && e instanceof Error && e.message.includes('key')) {
				await this.updateAPIKey();
				// Silent as to not prompt the user again
				return this.provideLanguageModelChatInformation({ silent: true }, token);
			}
			this._logService.error(e, `Error fetching available ${this._name} models`);
			return [];
		}
	}
	async provideLanguageModelChatResponse(model: LanguageModelChatInformation, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		const openAIChatEndpoint = await this.getEndpointImpl(model);
		return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.requestInitiator, progress, token);
	}
	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const openAIChatEndpoint = await this.getEndpointImpl(model);
		return this._lmWrapper.provideTokenCount(openAIChatEndpoint, text);
	}

	private async getEndpointImpl(model: LanguageModelChatInformation): Promise<OpenAIEndpoint> {
		const modelInfo: IChatModelInformation = await this.getModelInfo(model.id, this._apiKey);
		const url = modelInfo.supported_endpoints?.includes(ModelSupportedEndpoint.Responses) ?
			`${this._baseUrl}/responses` :
			`${this._baseUrl}/chat/completions`;
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, this._apiKey ?? '', url);
	}

	async updateAPIKey(): Promise<void> {
		if (this.authType === BYOKAuthType.None) {
			return;
		}
		const newAPIKey = await promptForAPIKey(this._name, await this._byokStorageService.getAPIKey(this._name) !== undefined);
		if (newAPIKey === undefined) {
			return;
		} else if (newAPIKey === '') {
			this._apiKey = undefined;
			await this._byokStorageService.deleteAPIKey(this._name, this.authType);
		} else if (newAPIKey !== undefined) {
			this._apiKey = newAPIKey;
			await this._byokStorageService.storeAPIKey(this._name, this._apiKey, BYOKAuthType.GlobalApiKey);
		}
	}

	async updateAPIKeyViaCmd(envVarName: string, action: 'update' | 'remove' = 'update', modelId?: string): Promise<void> {
		if (this.authType === BYOKAuthType.None) {
			return;
		}

		if (action === 'remove') {
			this._apiKey = undefined;
			await this._byokStorageService.deleteAPIKey(this._name, this.authType, modelId);
			this._logService.info(`BYOK: API key removed for provider ${this._name}`);
			return;
		}

		const apiKey = process.env[envVarName];
		if (!apiKey) {
			throw new Error(`BYOK: Environment variable ${envVarName} not found or empty for API key management`);
		}

		this._apiKey = apiKey;
		await this._byokStorageService.storeAPIKey(this._name, apiKey, this.authType, modelId);
		this._logService.info(`BYOK: API key updated for provider ${this._name} from environment variable ${envVarName}`);
	}
}
