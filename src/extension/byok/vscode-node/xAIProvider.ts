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

// https://docs.x.ai/docs/api-reference#list-language-models
interface XAIListLanguageModelsAPIResponse {
	models: Array<{
		id: string;
		fingerprint: string;
		created: number;
		object: string;
		owned_by: string;
		input_modalities: string[];
		output_modalities: string[];
		prompt_text_token_price: number;
		cached_prompt_text_token_price: number;
		prompt_image_token_price: number;
		completion_text_token_price: number;
		search_price?: number;
		version: string;
		aliases: string[];
	}>;
}

export class XAIBYOKLMProvider extends BaseOpenAICompatibleLMProvider {

	public static readonly providerName = 'xAI';

	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.GlobalApiKey,
			XAIBYOKLMProvider.providerName,
			'https://api.x.ai/v1',
			knownModels,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService,
		);
	}

	private parseModelVersion(modelId: string): number | undefined {
		const match = modelId.match(/^grok-(\d+)/);
		return match ? parseInt(match[1], 10) : undefined;
	}

	private humanizeModelId(modelId: string): string {
		const parts = modelId.split('-').filter(p => p.length > 0);
		return parts.map(p => {
			if (/^\d+$/.test(p)) {
				return p; // keep pure numbers as-is
			}
			return p.charAt(0).toUpperCase() + p.slice(1);
		}).join(' ');
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			const response = await this._fetcherService.fetch(`${this._baseUrl}/language-models`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this._apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			const data = await response.json() as XAIListLanguageModelsAPIResponse;
			if (!data.models || !Array.isArray(data.models)) {
				throw new Error('Invalid response format from xAI API');
			}
			this._logService.trace(`Fetched ${data.models.length} language models from xAI`);
			const modelList: BYOKKnownModels = {};
			for (const model of data.models) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList[model.id] = this._knownModels[model.id];
					continue;
				}

				// Add new model with reasonable defaults
				let maxInputTokens;
				let maxOutputTokens;

				// Coding models and Grok 4+ models have larger context windows
				const parsedVersion = this.parseModelVersion(model.id) ?? 0;
				if (model.id.startsWith('grok-code') || parsedVersion >= 4) {
					maxInputTokens = 120000;
					maxOutputTokens = 120000;
				} else {
					maxInputTokens = 80000;
					maxOutputTokens = 30000;
				}

				modelList[model.id] = {
					name: this.humanizeModelId(model.id),
					toolCalling: true,
					vision: model.input_modalities.includes('image'),
					maxInputTokens,
					maxOutputTokens,
				};
			}
			this._logService.trace(`Combined to ${Object.keys(modelList).length} known models for xAI`);
			return modelList;
		} catch (error) {
			throw new Error(error.message ? error.message : error);
		}
	}
}
