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
const MINIMUM_OLLAMA_VERSION = 'v0.6.4-rc0';

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
			// Try the standard /api/version endpoint first
			let response;
			try {
				response = await this._fetcherService.fetch(`${this._ollamaBaseUrl}/api/version`, { method: 'GET' });
			} catch (e) {
				// Fallback to /version endpoint if /api/version doesn't exist
				response = await this._fetcherService.fetch(`${this._ollamaBaseUrl}/version`, { method: 'GET' });
			}
			
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
			// If version endpoint fails, try a fallback approach
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
		try {
			const current = this._parseVersion(currentVersion);
			const minimum = this._parseVersion(MINIMUM_OLLAMA_VERSION);
			
			// Compare major.minor.patch
			if (current.major > minimum.major) {
				return true;
			}
			if (current.major < minimum.major) {
				return false;
			}
			
			if (current.minor > minimum.minor) {
				return true;
			}
			if (current.minor < minimum.minor) {
				return false;
			}
			
			return current.patch >= minimum.patch;
		} catch (e) {
			// If we can't parse the version, assume it's not supported
			return false;
		}
	}

	/**
	 * Parse a semantic version string into components
	 * @param version Version string like "0.1.23", "v0.1.23" or "v0.1.23-beta"
	 * @returns Object with major, minor, patch numbers
	 */
	private _parseVersion(version: string): { major: number; minor: number; patch: number } {
		// Remove "v" prefix if present
		let cleanVersion = version.startsWith('v') ? version.slice(1) : version;
		// Remove any pre-release or build metadata (e.g. "0.1.23-beta" -> "0.1.23")
		cleanVersion = cleanVersion.split('-')[0];
		const parts = cleanVersion.split('.').map(part => parseInt(part, 10));
		
		if (parts.length < 3 || parts.some(isNaN)) {
			throw new Error(`Invalid version format: ${version}`);
		}
		
		return {
			major: parts[0],
			minor: parts[1], 
			patch: parts[2]
		};
	}
}