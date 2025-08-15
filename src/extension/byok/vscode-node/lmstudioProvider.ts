/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

// REST: GET /api/v0/models and GET /api/v0/models/{model}
interface LmStudioModelInfoAPIResponse {
	id: string;
	object: 'model' | (string & {});
	type?: 'llm' | 'vlm' | 'embeddings' | (string & {});
	publisher?: string;
	arch?: string;
	compatibility_type?: string;
	quantization?: string;
	state?: 'loaded' | 'not-loaded';
	max_context_length?: number;
	capabilities?: ('tool_use' | (string & {}))[];
}

export class LmStudioLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'LmStudio';
	private _modelCache = new Map<string, IChatModelInformation>();

	constructor(
		private readonly _LmStudioBaseUrl: string,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.None,
			LmStudioLMProvider.providerName,
			`${_LmStudioBaseUrl}/v1`,
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService
		);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		// Try LM Studio REST first, then fall back to OpenAI-compatible /v1/models
		const knownModels: BYOKKnownModels = {};
		let modelIds: string[] | undefined;
		let restModels: LmStudioModelInfoAPIResponse[] | undefined;
		try {
			const response = await this._fetcherService.fetch(`${this._LmStudioBaseUrl}/api/v0/models`, { method: 'GET' });
			const json = await response.json() as { object: string; data: LmStudioModelInfoAPIResponse[] };
			restModels = Array.isArray(json?.data) ? json.data : [];
			modelIds = restModels.map(m => m.id);
		} catch {
			throw new Error('Failed to fetch models from LmStudio. Please ensure LmStudio is running. If LmStudio is on another host, please configure the `"github.copilot.chat.byok.LmStudioEndpoint"` setting.');
		}

		for (const id of modelIds) {
			const modelInfo = await this.getModelInfo(id, '', undefined);
			this._modelCache.set(id, modelInfo);
			knownModels[id] = {
				maxInputTokens: modelInfo.capabilities.limits?.max_prompt_tokens ?? 4096,
				maxOutputTokens: modelInfo.capabilities.limits?.max_output_tokens ?? 4096,
				name: modelInfo.name,
				toolCalling: !!modelInfo.capabilities.supports.tool_calls,
				vision: !!modelInfo.capabilities.supports.vision
			};
		}

		return knownModels;
	}


	// No server version gating for LM Studio: rely on OpenAI-compatible or REST endpoints availability

	private async _getLmStudioModelInformation(modelId: string): Promise<LmStudioModelInfoAPIResponse | undefined> {
		// Prefer REST model info if available
		try {
			const res = await this._fetcherService.fetch(`${this._LmStudioBaseUrl}/api/v0/models/${encodeURIComponent(modelId)}`, { method: 'GET' });
			return await res.json() as LmStudioModelInfoAPIResponse;
		} catch {
			return undefined;
		}
	}

	override async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		if (this._modelCache.has(modelId)) {
			return this._modelCache.get(modelId)!;
		}
		if (!modelCapabilities) {
			const modelInfo = await this._getLmStudioModelInformation(modelId);
			const contextWindow = modelInfo?.max_context_length ?? 4096;
			const outputTokens = contextWindow < 4096 ? Math.floor(contextWindow / 2) : 4096;
			modelCapabilities = {
				name: modelInfo?.id ?? modelId,
				maxOutputTokens: outputTokens,
				maxInputTokens: Math.max(1, contextWindow - outputTokens),
				vision: (modelInfo?.type === 'vlm') || false,
				toolCalling: modelInfo?.capabilities?.includes('tool_use') || false
			};
		}
		return super.getModelInfo(modelId, apiKey, modelCapabilities);
	}
}