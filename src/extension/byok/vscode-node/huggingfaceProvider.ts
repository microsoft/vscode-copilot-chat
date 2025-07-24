/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType } from '../common/byokProvider';
import { BaseOpenAICompatibleBYOKRegistry } from './baseOpenAICompatibleProvider';

interface HuggingFaceAPIResponse {
	object: string;
	data: HuggingFaceModel[];
}

interface HuggingFaceProvider {
	provider: string;
	status: string;
	supports_tools?: boolean;
	supports_structured_output?: boolean;
	context_length?: number;
	pricing?: {
		input: number;
		output: number;
	};
}

interface HuggingFaceModel {
	id: string;
	object: string;
	created: number;
	owned_by: string;
	providers: HuggingFaceProvider[];
}

export class HuggingFaceBYOKModelRegistry extends BaseOpenAICompatibleBYOKRegistry {
	constructor(
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			'Hugging Face',
			'https://router.huggingface.co/v1',
			_fetcherService,
			_logService,
			_instantiationService
		);
	}

	override async getAllModels(apiKey: string): Promise<{ id: string; name: string }[]> {
		const response = await this._fetcherService.fetch('https://router.huggingface.co/v1/models', { method: 'GET' });
		const data: HuggingFaceAPIResponse = await response.json();

		// Filter models that have at least one provider with supports_tools: true
		const toolsSupportedModels = data.data.filter(model =>
			model.providers.some(provider => provider.supports_tools === true)
		);

		return toolsSupportedModels.map(model => ({ id: model.id, name: model.id }));
	}

	private async fetchHuggingFaceModel(modelId: string): Promise<HuggingFaceModel> {
		const response = await this._fetcherService.fetch('https://router.huggingface.co/v1/models', { method: 'GET' });
		const data: HuggingFaceAPIResponse = await response.json();
		const model = data.data.find(m => m.id === modelId);
		if (!model) {
			throw new Error(`Model ${modelId} not found`);
		}
		return model;
	}

	override async getModelInfo(modelId: string, apiKey: string): Promise<IChatModelInformation> {
		const model = await this.fetchHuggingFaceModel(modelId);

		// Find the first provider that supports tool calling
		const toolsSupportedModel = model.providers.find(provider => provider.supports_tools === true);
		if (!toolsSupportedModel) {
			throw new Error(`Model ${modelId} does not support tool calling`);
		}

		// Hack to to infer vision capabilities from the model name
		const isVisionModel = modelId.toLowerCase().includes('vision') ||
			modelId.toLowerCase().includes('vl');

		// Use context length if available, otherwise fall back to a default value
		const contextWindow = toolsSupportedModel.context_length || 128000; // Default

		// Use the provider name in the model display name
		const modelName = `${model.id} (${toolsSupportedModel.provider})`;

		const modelInfo: IChatModelInformation = {
			id: model.id,
			name: `${this.name}: ${modelName}`,
			version: '1.0.0',
			capabilities: {
				type: 'chat',
				family: 'HuggingFace',
				supports: {
					streaming: true,
					vision: isVisionModel,
					tool_calls: true,
				},
				tokenizer: TokenizerType.O200K,
				limits: {
					max_context_window_tokens: contextWindow,
					max_prompt_tokens: contextWindow, // Use the full context window for max prompt tokens, as the information is not available
					max_output_tokens: contextWindow / 2
				}
			},
			is_chat_default: false,
			is_chat_fallback: false,
			model_picker_enabled: true
		};
		return modelInfo;
	}
}