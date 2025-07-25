/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

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


export class HuggingFaceBYOKLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'HuggingFace';
	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			HuggingFaceBYOKLMProvider.providerName,
			'https://router.huggingface.co/v1',
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService
		);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			const response = await this._fetcherService.fetch('https://router.huggingface.co/v1/models', { method: 'GET' });
			const data: HuggingFaceAPIResponse = await response.json();
			const knownModels: BYOKKnownModels = {};
			// Filter models that have at least one provider with supports_tools set to true
			const toolsSupportedModels = data.data.filter(model =>
				model.providers.some(provider => provider.supports_tools === true)
			);
			for (const model of toolsSupportedModels) {
				const toolsSupportedProvider = model.providers.find(provider => provider.supports_tools === true);
				if (!toolsSupportedProvider) {
					continue; // Skip if no provider supports tools
				}
				// Use the provider name and context length from the tools supported provider
				const modelName = `${model.id} (${toolsSupportedProvider.provider})`;
				knownModels[model.id] = {
					name: modelName,
					toolCalling: true,
					vision: model.id.toLowerCase().includes('vision') ||
						model.id.toLowerCase().includes('vl'),
					maxInputTokens: (toolsSupportedProvider.context_length || 128000) - 16000,
					maxOutputTokens: 16000
				};
			}
			return knownModels;
		} catch (error) {
			this._logService.logger.error(error, `Error fetching available Hugging Face models`);
			throw error;
		}

	}
}

