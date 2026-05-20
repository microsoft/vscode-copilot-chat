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
import { BYOKKnownModels, BYOKModelCapabilities, byokKnownModelsToAPIInfo } from '../common/byokProvider';
import { AbstractOpenAICompatibleLMProvider, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

// Perplexity Agent API: https://docs.perplexity.ai/docs/agent-api
// OpenAI-Responses-compatible base URL: https://api.perplexity.ai/v1
// Exposes third-party models (OpenAI, Anthropic, Google, etc.) plus presets
// (e.g. pro-search) under one API key. Does not provide a stable `/models`
// discovery endpoint, so we ship a curated list and override `getAllModels`.
const PERPLEXITY_INTEGRATION_HEADER = 'X-Pplx-Integration';

const PERPLEXITY_KNOWN_MODELS: BYOKKnownModels = {
	'openai/gpt-5.4': {
		name: 'GPT-5.4 (via Perplexity Agent API)',
		toolCalling: true,
		vision: true,
		maxInputTokens: 200000,
		maxOutputTokens: 16000,
	},
	'openai/gpt-5.2': {
		name: 'GPT-5.2 (via Perplexity Agent API)',
		toolCalling: true,
		vision: true,
		maxInputTokens: 200000,
		maxOutputTokens: 16000,
	},
	'anthropic/claude-sonnet-4-6': {
		name: 'Claude Sonnet 4.6 (via Perplexity Agent API)',
		toolCalling: true,
		vision: true,
		maxInputTokens: 200000,
		maxOutputTokens: 16000,
	},
	'anthropic/claude-opus-4-7': {
		name: 'Claude Opus 4.7 (via Perplexity Agent API)',
		toolCalling: true,
		vision: true,
		maxInputTokens: 200000,
		maxOutputTokens: 32000,
		thinking: true,
	},
	'google/gemini-3-1-pro': {
		name: 'Gemini 3.1 Pro (via Perplexity Agent API)',
		toolCalling: true,
		vision: true,
		maxInputTokens: 1000000,
		maxOutputTokens: 16000,
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
			merged[id] = { ...caps, requestHeaders: { ...(caps.requestHeaders ?? {}), ...integrationHeader } };
		}
		if (remote) {
			for (const [id, caps] of Object.entries(remote)) {
				merged[id] = { ...caps, requestHeaders: { ...(caps.requestHeaders ?? {}), ...integrationHeader } };
			}
		}
		return merged;
	}

	protected getModelsBaseUrl(): string | undefined {
		// Agent API base URL. The Agent API is OpenAI-Responses-compatible at
		// /v1/responses (alias) and /v1/agent (primary). It exposes third-party
		// models from OpenAI, Anthropic, Google, etc., plus presets like pro-search.
		return 'https://api.perplexity.ai/v1';
	}

	protected override async getAllModels(silent: boolean, apiKey: string | undefined, configuration: LanguageModelChatConfiguration | undefined): Promise<OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		const baseUrl = this.getModelsBaseUrl();
		const merged = this._knownModels ?? {};
		return byokKnownModelsToAPIInfo(this._name, merged).map(model => ({
			...model,
			url: baseUrl ?? 'https://api.perplexity.ai/v1',
		}));
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
