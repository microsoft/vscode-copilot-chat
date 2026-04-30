/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { packageJson } from '../../../platform/env/common/packagejson';
import { BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { AbstractOpenAICompatibleLMProvider } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

// https://docs.perplexity.ai/models/model-cards
// Perplexity exposes an OpenAI-compatible chat completions API at https://api.perplexity.ai
// but does not provide a stable `/models` discovery endpoint. We ship a curated list.
const PERPLEXITY_INTEGRATION_HEADER = 'X-Pplx-Integration';

const PERPLEXITY_KNOWN_MODELS: BYOKKnownModels = {
	'sonar-pro': {
		name: 'Sonar Pro',
		toolCalling: true,
		vision: false,
		maxInputTokens: 200000,
		maxOutputTokens: 8000,
	},
	'sonar': {
		name: 'Sonar',
		toolCalling: true,
		vision: false,
		maxInputTokens: 128000,
		maxOutputTokens: 8000,
	},
	'sonar-reasoning-pro': {
		name: 'Sonar Reasoning Pro',
		toolCalling: true,
		vision: false,
		maxInputTokens: 128000,
		maxOutputTokens: 8000,
		thinking: true,
	},
	'sonar-reasoning': {
		name: 'Sonar Reasoning',
		toolCalling: true,
		vision: false,
		maxInputTokens: 128000,
		maxOutputTokens: 8000,
		thinking: true,
	},
};

export class PerplexityLMProvider extends AbstractOpenAICompatibleLMProvider {

	public static readonly providerName = 'Perplexity';

	constructor(
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService
	) {
		super(
			PerplexityLMProvider.providerName.toLowerCase(),
			PerplexityLMProvider.providerName,
			PerplexityLMProvider.mergeKnownModels(knownModels),
			byokStorageService,
			fetcherService,
			logService,
			instantiationService,
			configurationService,
			expService
		);
	}

	private static mergeKnownModels(remote: BYOKKnownModels | undefined): BYOKKnownModels {
		const integrationHeader = {
			[PERPLEXITY_INTEGRATION_HEADER]: `vscode-copilot/${packageJson.version}`,
		};
		const merged: BYOKKnownModels = {};
		for (const [id, caps] of Object.entries(PERPLEXITY_KNOWN_MODELS)) {
			merged[id] = { ...caps, requestHeaders: { ...integrationHeader, ...(caps.requestHeaders ?? {}) } };
		}
		if (remote) {
			for (const [id, caps] of Object.entries(remote)) {
				merged[id] = { ...caps, requestHeaders: { ...integrationHeader, ...(caps.requestHeaders ?? {}) } };
			}
		}
		return merged;
	}

	protected getModelsBaseUrl(): string | undefined {
		return 'https://api.perplexity.ai';
	}

	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		const data = modelData as { id?: string; name?: string };
		if (!data?.id) {
			return undefined;
		}
		// Sensible defaults for any model returned by /models that we don't already know about.
		return {
			name: data.name ?? data.id,
			toolCalling: true,
			vision: false,
			maxInputTokens: 128000,
			maxOutputTokens: 8000,
			requestHeaders: {
				[PERPLEXITY_INTEGRATION_HEADER]: `vscode-copilot/${packageJson.version}`,
			},
		};
	}
}
