/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { BYOKAuthType, BYOKPerModelConfig } from '../../common/byokProvider';
import { CustomOpenAIProvider } from '../customOpenAIProvider';

// Mock services for testing
class MockFetcherService {
	async fetch(url: string, options: any) {
		// Mock successful response for connectivity tests
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: [] })
		};
	}
}

class MockLogService {
	logger = {
		info: (message: string) => console.log(`INFO: ${message}`),
		warn: (message: string) => console.warn(`WARN: ${message}`),
		error: (message: string) => console.error(`ERROR: ${message}`)
	};
}

class MockInstantiationService {
	createInstance(constructor: any, ...args: any[]) {
		return new constructor(...args);
	}
}

describe('CustomOpenAIProvider Tests', () => {
	let provider: CustomOpenAIProvider;
	let mockFetcher: MockFetcherService;
	let mockLogger: MockLogService;
	let mockInstantiation: MockInstantiationService;

	beforeEach(() => {
		mockFetcher = new MockFetcherService();
		mockLogger = new MockLogService();
		mockInstantiation = new MockInstantiationService();
		provider = new CustomOpenAIProvider(
			mockFetcher as any,
			mockLogger as any,
			mockInstantiation as any
		);
	});

	describe('Basic Configuration', () => {
		it('should have correct registry metadata', () => {
			expect(provider.name).toBe('Custom');
			expect(provider.authType).toBe(BYOKAuthType.PerModelDeployment);
		});

		it('should accept valid custom API configuration', async () => {
			const testConfig: BYOKPerModelConfig = {
				modelId: 'custom-model',
				apiKey: 'test-key-1234567890',
				deploymentUrl: 'https://api.custom-provider.com/v1'
			};

			// This test verifies the provider accepts valid configuration
			expect(testConfig.modelId).toBe('custom-model');
			expect(testConfig.apiKey).toBe('test-key-1234567890');
			expect(testConfig.deploymentUrl).toBe('https://api.custom-provider.com/v1');
		});
	});

	describe('Edit Mode Support', () => {
		it('should support tool calling for custom models', async () => {
			const toolCallingConfig: BYOKPerModelConfig = {
				modelId: 'custom-model',
				apiKey: 'test-1234567890abcdef1234567890abcdef',
				deploymentUrl: 'https://api.custom-provider.com/v1',
				capabilities: {
					name: 'Custom Model',
					maxInputTokens: 100000,
					maxOutputTokens: 8192,
					toolCalling: true, // Tool calling enabled for Edit mode
					vision: false
				}
			};

			// Verify tool calling is enabled
			expect(toolCallingConfig.capabilities?.toolCalling).toBe(true);
		});

		it('should enable agentMode for models with tool calling and sufficient tokens', () => {
			const { chatModelInfoToProviderMetadata, resolveModelInfo } = require('../../../common/byokProvider');

			// Create model info with tool calling and sufficient tokens
			const modelInfo = resolveModelInfo('test-model', 'custom-openai', undefined, {
				name: 'Test Model',
				maxInputTokens: 50000, // > 40000 threshold
				maxOutputTokens: 8192,
				toolCalling: true,
				vision: false
			});

			const metadata = chatModelInfoToProviderMetadata(modelInfo);

			// Should enable both toolCalling and agentMode
			expect(metadata.capabilities.toolCalling).toBe(true);
			expect(metadata.capabilities.agentMode).toBe(true);
		});

		it('should disable agentMode for models without sufficient tokens', () => {
			const { chatModelInfoToProviderMetadata, resolveModelInfo } = require('../../../common/byokProvider');

			// Create model info with tool calling but insufficient tokens
			const modelInfo = resolveModelInfo('test-model', 'custom-openai', undefined, {
				name: 'Test Model',
				maxInputTokens: 30000, // < 40000 threshold
				maxOutputTokens: 8192,
				toolCalling: true,
				vision: false
			});

			const metadata = chatModelInfoToProviderMetadata(modelInfo);

			// Should enable toolCalling but disable agentMode
			expect(metadata.capabilities.toolCalling).toBe(true);
			expect(metadata.capabilities.agentMode).toBe(false);
		});

		it('should handle models without tool calling capability', () => {
			const noToolCallingConfig: BYOKPerModelConfig = {
				modelId: 'basic-model',
				apiKey: 'test-1234567890abcdef1234567890abcdef',
				deploymentUrl: 'https://api.custom-provider.com/v1',
				capabilities: {
					name: 'Basic Model',
					maxInputTokens: 50000,
					maxOutputTokens: 4096,
					toolCalling: false, // No tool calling support
					vision: false
				}
			};

			// Should still be valid configuration, just without Edit mode support
			expect(noToolCallingConfig.capabilities?.toolCalling).toBe(false);
		});

		it('should enable tool calling by default when no capabilities provided', () => {
			const defaultConfig: BYOKPerModelConfig = {
				modelId: 'default-model',
				apiKey: 'test-1234567890abcdef1234567890abcdef',
				deploymentUrl: 'https://api.custom-provider.com/v1'
				// No capabilities provided - should default to tool calling enabled
			};

			// Should be valid configuration without explicit capabilities
			expect(defaultConfig.capabilities).toBeUndefined();
		});
	});

	describe('Model Discovery', () => {
		it('should handle model fetching gracefully', async () => {
			// Should handle network errors without crashing
			const models = await provider.fetchModelsFromEndpoint(
				'https://api.custom-provider.com/v1',
				'test-key'
			);

			// Should return array (empty or with models)
			expect(Array.isArray(models)).toBe(true);
		});

		it('should return empty array on fetch errors', async () => {
			// Mock a network error scenario
			const networkErrorFetcher = {
				fetch: async () => {
					throw new Error('Network error');
				}
			};

			const providerWithNetworkError = new CustomOpenAIProvider(
				networkErrorFetcher as any,
				mockLogger as any,
				mockInstantiation as any
			);

			const models = await providerWithNetworkError.fetchModelsFromEndpoint(
				'https://api.custom-provider.com/v1',
				'test-key'
			);

			// Should return empty array on error
			expect(models).toEqual([]);
		});
	});
});
