/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKModelCapabilities } from '../common/byokProvider';
import { BaseOpenAICompatibleBYOKRegistry } from './baseOpenAICompatibleProvider';

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

export class OllamaModelRegistry extends BaseOpenAICompatibleBYOKRegistry {

	constructor(
		private readonly _ollamaBaseUrl: string,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super(
			BYOKAuthType.None,
			'Ollama',
			`${_ollamaBaseUrl}/v1`,
			_fetcherService,
			_logService,
			_instantiationService
		);
	}

	override async getAllModels(apiKey: string): Promise<{ id: string; name: string }[]> {
		try {
			// Check Ollama server version before proceeding with model operations
			await this._checkOllamaVersion();
			
			const response = await this._fetcherService.fetch(`${this._ollamaBaseUrl}/api/tags`, { method: 'GET' });
			const models = (await response.json()).models;
			return models.map((model: { model: string; name: string }) => ({ id: model.model, name: model.name }));
		} catch (e) {
			// Check if this is our version check error and preserve it
			if (e instanceof Error && e.message.includes('Ollama server version')) {
				throw e;
			}
			throw new Error('Failed to fetch models from Ollama. Please ensure Ollama is running. If ollama is on another host, please configure the `"github.copilot.chat.byok.ollamaEndpoint"` setting.');
		}
	}

	override async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
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
}