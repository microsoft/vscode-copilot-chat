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

interface OllamaModelInfoAPIResponse {
	template: string;
	capabilities: string[];
	details: { family: string };
	model_info: {
		"general.basename": string;
		"general.architecture": string;
		[other: string]: any;
	};
}

interface OllamaVersionResponse {
	version: string;
}

// Minimum supported Ollama version - versions below this may have compatibility issues
const MINIMUM_OLLAMA_VERSION = '0.6.4';

export class OllamaLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'Ollama';
	private _modelCache = new Map<string, IChatModelInformation>();

	constructor(
		private readonly _ollamaBaseUrl: string,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.None,
			OllamaLMProvider.providerName,
			`${_ollamaBaseUrl}/v1`,
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService
		);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			// Check Ollama server version before proceeding with model operations
			await this._checkOllamaVersion();

			const response = await this._fetcherService.fetch(`${this._ollamaBaseUrl}/api/tags`, { method: 'GET' });
			const models = (await response.json()).models;
			const knownModels: BYOKKnownModels = {};
			for (const model of models) {
				const modelInfo = await this.getModelInfo(model.model, '', undefined);
				this._modelCache.set(model.model, modelInfo);
				knownModels[model.model] = {
					maxInputTokens: modelInfo.capabilities.limits?.max_prompt_tokens ?? 4096,
					maxOutputTokens: modelInfo.capabilities.limits?.max_output_tokens ?? 4096,
					name: modelInfo.name,
					toolCalling: !!modelInfo.capabilities.supports.tool_calls,
					vision: !!modelInfo.capabilities.supports.vision
				};
			}
			return knownModels;
		} catch (e) {
			// Check if this is our version check error and preserve it
			if (e instanceof Error && e.message.includes('Ollama server version')) {
				throw e;
			}
			throw new Error('Failed to fetch models from Ollama. Please ensure Ollama is running. If ollama is on another host, please configure the `"github.copilot.chat.byok.ollamaEndpoint"` setting.');
		}
	}


	/**
	 * Compare version strings to check if current version meets minimum requirements
	 * @param currentVersion Current Ollama server version
	 * @returns true if version is supported, false otherwise
	 */
	private _isVersionSupported(currentVersion: string): boolean {
		// Simple version comparison: split by dots and compare numerically
		const currentParts = currentVersion.split('.').map(n => parseInt(n, 10));
		const minimumParts = MINIMUM_OLLAMA_VERSION.split('.').map(n => parseInt(n, 10));

		for (let i = 0; i < Math.max(currentParts.length, minimumParts.length); i++) {
			const current = currentParts[i] || 0;
			const minimum = minimumParts[i] || 0;

			if (current > minimum) {
				return true;
			}
			if (current < minimum) {
				return false;
			}
		}

		return true; // versions are equal
	}

	private async _getOllamaModelInformation(modelId: string): Promise<OllamaModelInfoAPIResponse> {
		const response = await this._fetcherService.fetch(`${this._ollamaBaseUrl}/api/show`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ model: modelId })
		});
		return response.json() as unknown as OllamaModelInfoAPIResponse;
	}

	override async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		if (this._modelCache.has(modelId)) {
			return this._modelCache.get(modelId)!;
		}
		if (!modelCapabilities) {
			const modelInfo = await this._getOllamaModelInformation(modelId);
			const contextWindow = modelInfo.model_info[`${modelInfo.model_info['general.architecture']}.context_length`] ?? 4096;
			const outputTokens = contextWindow < 4096 ? Math.floor(contextWindow / 2) : 4096;
			modelCapabilities = {
				name: modelInfo.model_info['general.basename'],
				maxOutputTokens: outputTokens,
				maxInputTokens: contextWindow - outputTokens,
				vision: modelInfo.capabilities.includes("vision"),
				toolCalling: modelInfo.capabilities.includes("tools")
			};
		}
		return super.getModelInfo(modelId, apiKey, modelCapabilities);
	}

	/**
	 * Check if the connected Ollama server version meets the minimum requirements
	 * @throws Error if version is below minimum or version check fails
	 */
	private async _checkOllamaVersion(): Promise<void> {
		try {
			const response = await this._fetcherService.fetch(`${this._ollamaBaseUrl}/api/version`, { method: 'GET' });
			const versionInfo = await response.json() as OllamaVersionResponse;

			if (!this._isVersionSupported(versionInfo.version)) {
				throw new Error(
					`Ollama server version ${versionInfo.version} is not supported. ` +
					`Please upgrade to version ${MINIMUM_OLLAMA_VERSION} or higher. ` +
					`Visit https://ollama.ai for upgrade instructions.`
				);
			}
		} catch (e) {
			if (e instanceof Error && e.message.includes('Ollama server version')) {
				// Re-throw our custom version error
				throw e;
			}
			// If version endpoint fails
			throw new Error(
				`Unable to verify Ollama server version. Please ensure you have Ollama version ${MINIMUM_OLLAMA_VERSION} or higher installed. ` +
				`If you're running an older version, please upgrade from https://ollama.ai`
			);
		}
	}
}