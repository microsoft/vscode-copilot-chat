/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelChatInformation } from 'vscode';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

export class OpenCodeZenLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'OpenCodeZen';
	private readonly _zenInstantiationService: IInstantiationService;

	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			OpenCodeZenLMProvider.providerName,
			'https://opencode.ai/zen/v1',
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			instantiationService,
		);
		this._zenInstantiationService = instantiationService;
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		if (!this._apiKey) {
			return {};
		}
		try {
			const response = await this._fetcherService.fetch(`${this._baseUrl}/models`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this._apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch OpenCode Zen models: ${response.statusText}`);
			}

			const data = await response.json();
			const knownModels: BYOKKnownModels = {};

			// The spec says models are at /models. We'll map them to BYOKKnownModels.
			// If the API returns a 'data' array (standard OpenAI-like), we iterate it.
			const models = Array.isArray(data) ? data : (data.data || []);

			for (const model of models) {
				knownModels[model.id] = {
					name: model.name || model.id,
					toolCalling: model.capabilities?.supports?.tool_calls ?? true,
					vision: model.capabilities?.supports?.vision ?? false,
					maxInputTokens: model.capabilities?.limits?.max_prompt_tokens ?? 128000,
					maxOutputTokens: model.capabilities?.limits?.max_output_tokens ?? 4096,
					// Store the supported endpoints if available to help with routing
					supportedEndpoints: model.supported_endpoints
				};
			}

			this._knownModels = knownModels;
			return knownModels;
		} catch (error) {
			this._logService.error(error, `Error fetching available OpenCode Zen models`);
			throw error;
		}
	}



	protected override async getModelInfo(modelId: string, apiKey: string | undefined): Promise<IChatModelInformation> {
		const info = await super.getModelInfo(modelId, apiKey);

		// OpenCode Zen uses specific endpoints based on the model family
		// This logic is based on the official documentation
		if (modelId.includes('claude')) {
			info.supported_endpoints = [ModelSupportedEndpoint.Messages];
		} else if (modelId.includes('gpt')) {
			info.supported_endpoints = [ModelSupportedEndpoint.Responses];
		} else if (modelId.includes('gemini')) {
			info.supported_endpoints = [ModelSupportedEndpoint.ChatCompletions]; // Will be handled specially in getEndpointImpl
		} else {
			// All other models (GLM, Kimi, Qwen, Grok, Big Pickle) use /chat/completions
			info.supported_endpoints = [ModelSupportedEndpoint.ChatCompletions];
		}

		return info;
	}

	protected override async getEndpointImpl(model: LanguageModelChatInformation): Promise<OpenAIEndpoint> {
		const modelInfo = await this.getModelInfo(model.id, this._apiKey);
		let urlSuffix = '/chat/completions';

		if (model.id.includes('claude')) {
			urlSuffix = '/messages';
		} else if (model.id.includes('gpt')) {
			urlSuffix = '/responses';
		} else if (model.id.includes('gemini')) {
			// Special case for Gemini as per spec: https://opencode.ai/zen/v1/models/gemini-3-pro
			urlSuffix = `/models/${model.id.replace('opencode/', '')}`;
		}
		// All other models use the default /chat/completions

		const url = `${this._baseUrl}${urlSuffix}`;
		return this._zenInstantiationService.createInstance(OpenAIEndpoint, modelInfo, this._apiKey ?? '', url);
	}
}
