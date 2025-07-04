/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from 'vitest';
import { CustomBYOKModelRegistry, CustomProviderConfig, createCustomProviderRegistries } from '../../src/extension/byok/vscode-node/customProvider';
import { BYOKAuthType } from '../../src/extension/byok/common/byokProvider';
const mockFetcherService = {
	fetch: async (url: string, options?: any) => {
		// Mock successful response for /models endpoint
		if (url.endsWith('/models')) {
			return {
				ok: true,
				json: async () => ({
					data: [
						{ id: 'test-model-1', name: 'Test Model 1' },
						{ id: 'test-model-2', name: 'Test Model 2' }
					]
				})
			};
		}
		throw new Error(`Unexpected URL: ${url}`);
	}
} as any;

const mockLogService = {
	logger: {
		error: () => {},
		warn: () => {},
		info: () => {},
		debug: () => {}
	}
} as any;

const mockInstantiationService = {
	createInstance: () => ({})
} as any;

const testProviderConfig: CustomProviderConfig = {
	name: 'Test Provider',
	baseUrl: 'https://api.test.com/v1',
	apiKey: 'test-api-key',
	enabled: true
};

const testProviderConfigNoAuth: CustomProviderConfig = {
	name: 'Test Provider No Auth',
	baseUrl: 'https://api.test.com/v1',
	enabled: true
};

test('should create a custom provider registry with correct properties', () => {
	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	expect(registry.name).toBe('Test Provider');
	expect(registry.authType).toBe(BYOKAuthType.GlobalApiKey);
});

test('should fetch models from custom provider', async () => {
	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	const models = await registry.getAllModels();
	expect(models.length).toBe(2);
	expect(models[0].id).toBe('test-model-1');
	expect(models[1].id).toBe('test-model-2');
});

test('should validate provider configuration', async () => {
	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	const validation = await registry.validateProvider();
	expect(validation.valid).toBe(true);
	expect(validation.error).toBeUndefined();
});

test('should create multiple registries from configuration', () => {
	const customProviders: CustomProviderConfig[] = [
		{
			name: 'Provider 1',
			baseUrl: 'https://api.provider1.com/v1',
			apiKey: 'key1',
			enabled: true
		},
		{
			name: 'Provider 2',
			baseUrl: 'https://api.provider2.com/v1',
			apiKey: 'key2',
			enabled: false // This should be filtered out
		},
		{
			name: 'Provider 3',
			baseUrl: 'https://api.provider3.com/v1',
			apiKey: 'key3',
			enabled: true
		}
	];

	const registries = createCustomProviderRegistries(
		customProviders,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	// Should only include enabled providers
	expect(registries.length).toBe(2);
	expect(registries[0].name).toBe('Provider 1');
	expect(registries[1].name).toBe('Provider 3');
});

test('should handle trailing slashes in base URL', async () => {
	const configWithTrailingSlash: CustomProviderConfig = {
		...testProviderConfig,
		baseUrl: 'https://api.test.com/v1/'
	};

	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		configWithTrailingSlash.name,
		configWithTrailingSlash,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	// Should work without issues - the implementation removes trailing slashes
	const models = await registry.getAllModels();
	expect(models.length).toBe(2);
});

test('should work without API key for providers that do not require authentication', async () => {
	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfigNoAuth.name,
		testProviderConfigNoAuth,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	const models = await registry.getAllModels();
	expect(models.length).toBe(2);
});

test('should test getModelInfo method', async () => {
	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	const modelInfo = await registry.getModelInfo('test-model-1', 'test-api-key');
	expect(modelInfo).toBeDefined();
});

test('should test updateKnownModelsList method', () => {
	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	const knownModels = {
		'test-model-1': {
			name: 'Test Model 1',
			id: 'test-model-1',
			maxInputTokens: 4096,
			maxOutputTokens: 4096,
			toolCalling: false,
			vision: false
		}
	};

	registry.updateKnownModelsList(knownModels);
	// The method should update internal state without throwing
	expect(true).toBe(true);
});

test('should handle different model response formats', async () => {
	const mockFetcherWithDifferentFormats = {
		fetch: async (url: string) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					json: async () => ({
						models: [
							{ id: 'model-1', name: 'Model 1' },
							{ id: 'model-2', name: 'Model 2' }
						]
					})
				};
			}
			throw new Error(`Unexpected URL: ${url}`);
		}
	} as any;

	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherWithDifferentFormats,
		mockLogService,
		mockInstantiationService
	);

	const models = await registry.getAllModels();
	expect(models.length).toBe(2);
	expect(models[0].id).toBe('model-1');
});

test('should handle root-level array response format', async () => {
	const mockFetcherWithArrayResponse = {
		fetch: async (url: string) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					json: async () => [
						{ id: 'model-1', name: 'Model 1' },
						{ id: 'model-2', name: 'Model 2' }
					]
				};
			}
			throw new Error(`Unexpected URL: ${url}`);
		}
	} as any;

	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherWithArrayResponse,
		mockLogService,
		mockInstantiationService
	);

	const models = await registry.getAllModels();
	expect(models.length).toBe(2);
	expect(models[0].id).toBe('model-1');
});

test('should handle validation failure for missing name', async () => {
	const invalidConfig = {
		name: '',
		baseUrl: 'https://api.test.com/v1',
		apiKey: 'test-key',
		enabled: true
	};

	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		invalidConfig.name,
		invalidConfig,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	const validation = await registry.validateProvider();
	expect(validation.valid).toBe(false);
	expect(validation.error).toBe('Provider name is required');
});

test('should handle validation failure for invalid URL', async () => {
	const invalidConfig = {
		name: 'Test Provider',
		baseUrl: 'not-a-valid-url',
		apiKey: 'test-key',
		enabled: true
	};

	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		invalidConfig.name,
		invalidConfig,
		mockFetcherService,
		mockLogService,
		mockInstantiationService
	);

	const validation = await registry.validateProvider();
	expect(validation.valid).toBe(false);
	expect(validation.error).toBe('Invalid base URL format');
});

test('should handle API error responses', async () => {
	const mockFetcherWithError = {
		fetch: async (url: string) => {
			if (url.endsWith('/models')) {
				return {
					ok: false,
					status: 401,
					statusText: 'Unauthorized'
				};
			}
			throw new Error(`Unexpected URL: ${url}`);
		}
	} as any;

	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherWithError,
		mockLogService,
		mockInstantiationService
	);

	const validation = await registry.validateProvider();
	expect(validation.valid).toBe(false);
	expect(validation.error).toBe('HTTP 401: Unauthorized');
});

test('should handle network errors', async () => {
	const mockFetcherWithNetworkError = {
		fetch: async () => {
			throw new Error('Network error');
		}
	} as any;

	const registry = new CustomBYOKModelRegistry(
		BYOKAuthType.GlobalApiKey,
		testProviderConfig.name,
		testProviderConfig,
		mockFetcherWithNetworkError,
		mockLogService,
		mockInstantiationService
	);

	try {
		await registry.getAllModels();
		expect(false).toBe(true); // Should not reach here
	} catch (error) {
		expect(error.message).toContain('Failed to fetch models from Test Provider');
	}
});
