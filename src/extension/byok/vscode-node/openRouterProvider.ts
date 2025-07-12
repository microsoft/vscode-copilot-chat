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

interface OpenRouterModel {
	id: string;
	name: string;
	created: number;
	description: string;
	architecture: {
		tokenizer: string;
		input_modalities: string[];
		instruct_type: string | null;
		modality: string;
	};
	endpoints: OpenRouterEndpoint[];
}

interface OpenRouterEndpoint {
	name: string;
	context_length: number;
	pricing: {
		request: string;
		image: string;
		prompt: string;
		completion: string;
	};
	provider_name: string;
	quantization: string | null;
	max_completion_tokens: number | null;
	max_prompt_tokens: number | null;
	supported_parameters: string[];
}

export class OpenRouterBYOKModelRegistry extends BaseOpenAICompatibleBYOKRegistry {
	constructor(
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			'OpenRouter',
			'https://openrouter.ai/api/v1',
			_fetcherService,
			_logService,
			_instantiationService
		);
	}

	override async getAllModels(apiKey: string): Promise<{ id: string; name: string }[]> {
		const response = await this._fetcherService.fetch('https://openrouter.ai/api/v1/models?supported_parameters=tools', { method: 'GET' });
		const data: any = await response.json();
		return data.data;
	}

	private async fetchOpenRouterModel(modelId: string): Promise<OpenRouterModel> {
		const modelParts = modelId.split('/');
		if (modelParts.length !== 2) {
			throw new Error('Invalid model ID');
		}
		const author = modelParts[0];
		const slug = modelParts[1];
		const response = await this._fetcherService.fetch(`https://openrouter.ai/api/v1/models/${author}/${slug}/endpoints`, { method: 'GET' });
		const data: any = await response.json();
		return data.data;
	}

	override async getModelInfo(modelId: string, apiKey: string): Promise<IChatModelInformation> {
		const model = await this.fetchOpenRouterModel(modelId);
		const endpointInfo = model.endpoints.find(e => e.supported_parameters.includes('tools')) ?? model.endpoints[0];
		const modelInfo: IChatModelInformation = {
			id: model.id,
			name: model.name.includes(':') ? model.name : `${this.name}: ${model.name}`,
			version: '1.0.0',
			capabilities: {
				type: 'chat',
				family: 'openrouter',
				supports: {
					streaming: true,
					vision: model.architecture.input_modalities.includes('image'),
					tool_calls: endpointInfo.supported_parameters.includes('tools'),
				},
				tokenizer: TokenizerType.O200K,
				limits: {
					max_context_window_tokens: endpointInfo.context_length,
					max_prompt_tokens: endpointInfo.max_prompt_tokens ?? endpointInfo.context_length,
					max_output_tokens: endpointInfo.max_completion_tokens ?? (endpointInfo.context_length / 2)
				}
			},
			is_chat_default: false,
			is_chat_fallback: false,
			model_picker_enabled: true
		};
		return modelInfo;
	}
}