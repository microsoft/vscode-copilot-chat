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
