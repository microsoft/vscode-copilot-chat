/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, lm } from 'vscode';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKModelCapabilities, BYOKModelConfig, BYOKModelRegistry, BYOKPerModelConfig, chatModelInfoToProviderMetadata, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';

/**
 * Custom error types for better error handling and user feedback
 */
export class CustomProviderError extends Error {
	constructor(message: string, public readonly code: string, public readonly userMessage: string) {
		super(message);
		this.name = 'CustomProviderError';
	}
}

export class EndpointValidationError extends CustomProviderError {
	constructor(message: string, userMessage: string) {
		super(message, 'ENDPOINT_VALIDATION_ERROR', userMessage);
		this.name = 'EndpointValidationError';
	}
}

export class ApiKeyValidationError extends CustomProviderError {
	constructor(message: string, userMessage: string) {
		super(message, 'API_KEY_VALIDATION_ERROR', userMessage);
		this.name = 'ApiKeyValidationError';
	}
}

export class ConnectionError extends CustomProviderError {
	constructor(message: string, userMessage: string) {
		super(message, 'CONNECTION_ERROR', userMessage);
		this.name = 'ConnectionError';
	}
}

/**
 * Custom OpenAI Provider Registry for user-defined OpenAI-compatible endpoints
 * This allows users to configure their own API endpoints that follow OpenAI standards
 *
 * Features:
 * - Validates API endpoint URLs for proper format and accessibility
 * - Supports secure API key storage per model
 * - Provides comprehensive error handling with user-friendly messages
 * - Compatible with OpenAI-standard APIs
 */
export class CustomOpenAIProvider implements BYOKModelRegistry {
	public readonly name = 'Custom';
	public readonly authType = BYOKAuthType.PerModelDeployment;
	private _knownModels: any;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) { }

	/**
	 * Updates the known models list from the CDN.
	 *
	 * For custom providers, this provides fallback model information
	 * when users configure models that aren't in our known models database.
	 *
	 * @param knownModels The known models data from the CDN
	 */
	updateKnownModelsList(knownModels: any): void {
		this._knownModels = knownModels;
	}

	/**
	 * Retrieves available models from the provider.
	 *
	 * For custom providers, we return an empty array because:
	 * 1. Each custom endpoint may have different available models
	 * 2. Not all endpoints support the `/models` endpoint
	 * 3. Users need to manually specify the model ID they want to use
	 *
	 * This signals to the UI that manual model entry is required.
	 *
	 * @param apiKey Optional API key (unused for custom providers)
	 * @returns Empty array to indicate manual model entry is required
	 */
	async getAllModels(apiKey?: string): Promise<{ id: string; name: string }[]> {
		// For custom providers, we don't pre-fetch models since each endpoint is different
		// Users will need to manually specify model IDs
		// Return empty array to indicate manual model entry is required
		return [];
	}

	/**
	 * Fetches available models from a specific endpoint during onboarding
	 * This is used by the UI service to populate the model selection dropdown
	 *
	 * @param deploymentUrl The API endpoint URL
	 * @param apiKey The API key for authentication
	 * @returns Array of available models
	 */
	async fetchModelsFromEndpoint(deploymentUrl: string, apiKey: string): Promise<{ id: string; name: string }[]> {
		try {
			const response = await this._fetcherService.fetch(`${deploymentUrl}/models`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				// If the endpoint doesn't support /models, return empty array
				if (response.status === 404 || response.status === 501) {
					return [];
				}
				throw new Error(`API request failed: ${response.status} ${response.statusText}`);
			}

			const data: any = await response.json();

			if (!data.data || !Array.isArray(data.data)) {
				return [];
			}

			const models = data.data.map((model: any) => ({
				id: model.id,
				name: model.name || model.id
			}));

			return models;

		} catch (error) {
			// Return empty array to fall back to manual entry
			return [];
		}
	}

	/**
	 * Validates the API endpoint URL format and accessibility
	 * @param deploymentUrl The API endpoint URL to validate
	 * @throws {EndpointValidationError} If the URL is invalid or inaccessible
	 */
	private validateEndpointUrl(deploymentUrl: string): void {
		// Basic URL format validation
		try {
			const url = new URL(deploymentUrl);

			// Ensure it's HTTP or HTTPS
			if (!['http:', 'https:'].includes(url.protocol)) {
				throw new EndpointValidationError(
					`Invalid protocol: ${url.protocol}`,
					'API endpoint must use HTTP or HTTPS protocol. Please check your endpoint URL.'
				);
			}

			// Ensure it has a valid hostname
			if (!url.hostname || url.hostname.length === 0) {
				throw new EndpointValidationError(
					'Missing hostname in URL',
					'API endpoint URL must include a valid hostname. Please check your endpoint URL.'
				);
			}

			// Warn about localhost/local IPs for security
			if (url.hostname === 'localhost' || url.hostname.startsWith('127.') || url.hostname.startsWith('192.168.') || url.hostname.startsWith('10.')) {
				this._logService.logger.warn(`Custom provider using local endpoint: ${deploymentUrl}. Ensure this is intentional.`);
			}

		} catch (error) {
			if (error instanceof EndpointValidationError) {
				throw error;
			}
			throw new EndpointValidationError(
				`Invalid URL format: ${error}`,
				'The API endpoint URL format is invalid. Please enter a valid URL (e.g., https://api.example.com/v1).'
			);
		}
	}

	/**
	 * Validates the API key format and basic requirements
	 * @param apiKey The API key to validate
	 * @param modelId The model ID for context in error messages
	 * @throws {ApiKeyValidationError} If the API key is invalid
	 */
	private validateApiKey(apiKey: string, modelId: string): void {
		if (!apiKey || apiKey.trim().length === 0) {
			throw new ApiKeyValidationError(
				'Empty API key provided',
				`API key is required for model '${modelId}'. Please provide a valid API key.`
			);
		}

		// Basic API key format validation (most API keys are at least 20 characters)
		if (apiKey.trim().length < 10) {
			throw new ApiKeyValidationError(
				'API key too short',
				`The API key for model '${modelId}' appears to be too short. Please verify you've entered the complete API key.`
			);
		}

		// Check for common placeholder values
		const placeholders = ['your-api-key', 'api-key-here', 'replace-me', 'example-key'];
		if (placeholders.some(placeholder => apiKey.toLowerCase().includes(placeholder))) {
			throw new ApiKeyValidationError(
				'Placeholder API key detected',
				`Please replace the placeholder API key with your actual API key for model '${modelId}'.`
			);
		}
	}

	/**
	 * Validates the model ID format and requirements
	 * @param modelId The model ID to validate
	 * @throws {CustomProviderError} If the model ID is invalid
	 */
	private validateModelId(modelId: string): void {
		if (!modelId || modelId.trim().length === 0) {
			throw new CustomProviderError(
				'Empty model ID provided',
				'MODEL_ID_VALIDATION_ERROR',
				'Model ID is required. Please specify the model you want to use (e.g., gpt-4, claude-3-opus, etc.).'
			);
		}

		// Check for reasonable model ID format (no spaces, reasonable length)
		if (modelId.includes(' ')) {
			throw new CustomProviderError(
				'Model ID contains spaces',
				'MODEL_ID_VALIDATION_ERROR',
				'Model ID should not contain spaces. Please use the exact model identifier from your API provider.'
			);
		}

		if (modelId.length > 100) {
			throw new CustomProviderError(
				'Model ID too long',
				'MODEL_ID_VALIDATION_ERROR',
				'Model ID appears to be too long. Please verify you\'ve entered the correct model identifier.'
			);
		}
	}

	private async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		const modelInfo = resolveModelInfo(modelId, this.name, this._knownModels, modelCapabilities);
		return modelInfo;
	}

	/**
	 * Tests connectivity to the API endpoint with a simple request.
	 *
	 * This method attempts to connect to the `/models` endpoint to verify:
	 * - The endpoint is reachable
	 * - The API key is valid and has proper permissions
	 * - The service is responding correctly
	 *
	 * Note: Some providers may not support the `/models` endpoint, in which case
	 * connectivity errors are logged but don't fail the registration process.
	 *
	 * @param deploymentUrl The API endpoint URL to test
	 * @param apiKey The API key to use for authentication
	 * @param modelId The model ID for context in error messages
	 * @throws {ConnectionError} If the endpoint is not accessible
	 * @throws {ApiKeyValidationError} If authentication fails
	 */
	private async testEndpointConnectivity(deploymentUrl: string, apiKey: string, modelId: string): Promise<void> {
		try {
			const testUrl = `${deploymentUrl}/models`;
			const response = await this._fetcherService.fetch(testUrl, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
					'User-Agent': 'VSCode-Copilot-Chat/1.0'
				},
				timeout: 10000 // 10 second timeout
			});

			if (!response.ok) {
				if (response.status === 401) {
					throw new ApiKeyValidationError(
						`Authentication failed: ${response.status}`,
						`The API key for model '${modelId}' is invalid or expired. Please check your API key and try again.`
					);
				} else if (response.status === 403) {
					throw new ApiKeyValidationError(
						`Access forbidden: ${response.status}`,
						`Access denied for model '${modelId}'. Please verify your API key has the necessary permissions.`
					);
				} else if (response.status === 404) {
					// 404 on /models endpoint might be normal for some providers
					this._logService.logger.info(`Models endpoint returned 404 for ${deploymentUrl}, this may be normal for some providers.`);
				} else if (response.status >= 500) {
					throw new ConnectionError(
						`Server error: ${response.status}`,
						`The API server for model '${modelId}' is currently experiencing issues. Please try again later.`
					);
				} else {
					throw new ConnectionError(
						`HTTP error: ${response.status}`,
						`Failed to connect to the API endpoint for model '${modelId}'. Please verify the endpoint URL is correct.`
					);
				}
			}

			this._logService.logger.info(`Successfully validated connectivity to custom endpoint: ${deploymentUrl}`);
		} catch (error) {
			if (error instanceof CustomProviderError) {
				throw error;
			}

			// Handle network-level errors
			if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
				throw new ConnectionError(
					`Network error: ${error.code}`,
					`Cannot reach the API endpoint for model '${modelId}'. Please check the URL and your internet connection.`
				);
			} else if (error.code === 'ETIMEDOUT') {
				throw new ConnectionError(
					'Connection timeout',
					`Connection to the API endpoint for model '${modelId}' timed out. The server may be slow or unreachable.`
				);
			} else {
				throw new ConnectionError(
					`Unexpected error: ${error.message}`,
					`An unexpected error occurred while connecting to the API endpoint for model '${modelId}'. Please try again.`
				);
			}
		}
	}

	/**
	 * Registers a custom model with the VS Code language model system.
	 *
	 * This method performs comprehensive validation and setup:
	 * 1. Validates the configuration type (must be per-model deployment)
	 * 2. Validates model ID, endpoint URL, and API key formats
	 * 3. Tests endpoint connectivity (optional, non-blocking for unsupported endpoints)
	 * 4. Creates and registers the language model provider
	 *
	 * The registered model will be available in VS Code's chat interface and can be
	 * selected by users for conversations.
	 *
	 * @param config The model configuration containing modelId, apiKey, deploymentUrl, and optional capabilities
	 * @returns A disposable that can be used to unregister the model
	 * @throws {CustomProviderError} If configuration validation fails
	 * @throws {EndpointValidationError} If the endpoint URL is invalid
	 * @throws {ApiKeyValidationError} If the API key is invalid or authentication fails
	 * @throws {ConnectionError} If the endpoint cannot be reached
	 *
	 * @example
	 * ```typescript
	 * const config: BYOKPerModelConfig = {
	 *   modelId: 'custom-model',
	 *   apiKey: 'your-api-key',
	 *   deploymentUrl: 'https://api.openai.com/v1',
	 *   capabilities: {
	 *     name: 'Custom Model',
	 *     maxInputTokens: 100000,
	 *     maxOutputTokens: 8192,
	 *     toolCalling: true,
	 *     vision: false
	 *   }
	 * };
	 *
	 * const disposable = await provider.registerModel(config);
	 * // Model is now available in VS Code
	 *
	 * // Later, to unregister:
	 * disposable.dispose();
	 * ```
	 */
	async registerModel(config: BYOKModelConfig): Promise<Disposable> {
		if (!this.isPerModelConfig(config)) {
			throw new CustomProviderError(
				'Invalid configuration type',
				'CONFIGURATION_ERROR',
				'Custom OpenAI provider requires both an API endpoint URL and API key for each model.'
			);
		}

		try {
			// Comprehensive validation before attempting registration
			this.validateModelId(config.modelId);
			this.validateEndpointUrl(config.deploymentUrl);
			this.validateApiKey(config.apiKey, config.modelId);

			// Test endpoint connectivity (optional, can be disabled for faster setup)
			try {
				await this.testEndpointConnectivity(config.deploymentUrl, config.apiKey, config.modelId);
			} catch (connectivityError) {
				// Log connectivity issues but don't fail registration entirely
				// Some endpoints might not support the /models endpoint
				this._logService.logger.warn(`Connectivity test failed for ${config.modelId}: ${connectivityError.message}`);

				// Only fail if it's an authentication error
				if (connectivityError instanceof ApiKeyValidationError) {
					throw connectivityError;
				}
			}

			const modelInfo: IChatModelInformation = await this.getModelInfo(config.modelId, config.apiKey, config.capabilities);
			const lmModelMetadata = chatModelInfoToProviderMetadata(modelInfo);

			// Ensure the deployment URL ends with the correct path
			let modelUrl = config.deploymentUrl;
			if (!modelUrl.endsWith('/chat/completions')) {
				modelUrl = modelUrl.endsWith('/') ?
					`${modelUrl}chat/completions` :
					`${modelUrl}/chat/completions`;
			}

			const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, config.apiKey, modelUrl);
			const provider = this._instantiationService.createInstance(CopilotLanguageModelWrapper, openAIChatEndpoint, lmModelMetadata);

			const disposable = lm.registerChatModelProvider(
				`${this.name}-${config.modelId}`,
				provider,
				lmModelMetadata
			);

			this._logService.logger.info(`Successfully registered custom model: ${config.modelId}`);

			return disposable;

		} catch (error) {
			// Enhanced error logging with user-friendly messages
			if (error instanceof CustomProviderError) {
				this._logService.logger.error(`${error.name} for model ${config.modelId}: ${error.message}`);
				// Re-throw with user message for UI display
				const enhancedError = new Error(error.userMessage);
				enhancedError.name = error.name;
				throw enhancedError;
			} else {
				this._logService.logger.error(`Unexpected error registering ${this.name} model ${config.modelId}: ${error}`);
				throw new Error(`Failed to register model '${config.modelId}'. Please check your configuration and try again.`);
			}
		}
	}

	private isPerModelConfig(config: BYOKModelConfig): config is BYOKPerModelConfig {
		return 'deploymentUrl' in config && 'apiKey' in config;
	}
}
