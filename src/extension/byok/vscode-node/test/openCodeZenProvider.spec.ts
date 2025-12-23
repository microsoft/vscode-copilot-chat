/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BlockedExtensionService, IBlockedExtensionService } from '../../../../platform/chat/common/blockedExtensionService';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { IBYOKStorageService } from '../byokStorageService';
import { OpenCodeZenLMProvider } from '../openCodeZenProvider';

describe('OpenCodeZenLMProvider', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;
	let provider: OpenCodeZenLMProvider;
	let mockByokStorageService: IBYOKStorageService;

	const mockModelsResponse = {
		data: [
			{
				id: 'opencode/gpt-5.2',
				name: 'GPT 5.2',
				capabilities: {
					supports: { tool_calls: true, vision: true },
					limits: { max_prompt_tokens: 128000, max_output_tokens: 4096 }
				},
				supported_endpoints: ['/responses']
			},
			{
				id: 'opencode/claude-sonnet-4-5',
				name: 'Claude Sonnet 4.5',
				capabilities: {
					supports: { tool_calls: true, vision: true },
					limits: { max_prompt_tokens: 200000, max_output_tokens: 8192 }
				},
				supported_endpoints: ['/v1/messages']
			}
		]
	};

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();
		testingServiceCollection.define(IBlockedExtensionService, new SyncDescriptor(BlockedExtensionService));

		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		instaService = accessor.get(IInstantiationService);

		mockByokStorageService = {
			getAPIKey: vi.fn().mockResolvedValue('test-zen-api-key'),
			storeAPIKey: vi.fn().mockResolvedValue(undefined),
			deleteAPIKey: vi.fn().mockResolvedValue(undefined),
			getStoredModelConfigs: vi.fn().mockResolvedValue({}),
			saveModelConfig: vi.fn().mockResolvedValue(undefined),
			removeModelConfig: vi.fn().mockResolvedValue(undefined)
		};

		// Mock fetcher service instead of global fetch
		const fetcherService = accessor.get(IFetcherService);
		vi.spyOn(fetcherService, 'fetch').mockImplementation(async (url: string) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					status: 200,
					json: async () => mockModelsResponse
				} as any;
			}
			return { ok: false, status: 404 } as any;
		});

		provider = instaService.createInstance(OpenCodeZenLMProvider, mockByokStorageService);
	});

	afterEach(() => {
		disposables.clear();
		vi.restoreAllMocks();
	});

	describe('getAllModels', () => {
		it('should fetch and parse models from OpenCode Zen API', async () => {
			// Ensure the provider has an API key so it tries to fetch
			mockByokStorageService.getAPIKey = vi.fn().mockResolvedValue('test-zen-api-key');
			const providerWithKey = instaService.createInstance(OpenCodeZenLMProvider, mockByokStorageService);

			const models = await providerWithKey['getAllModels']();
			expect(models['opencode/gpt-5.2'].maxInputTokens).toBe(128000);
		});

		it('should fallback to static models on fetch error if API key exists', async () => {
			const fetcherService = accessor.get(IFetcherService);
			vi.spyOn(fetcherService, 'fetch').mockImplementationOnce(async () => {
				throw new Error('Network error');
			});

			// Set the API key so the fallback logic triggers
			provider['_apiKey'] = 'test-zen-api-key';

			const models = await provider['getAllModels']();

			expect(models['opencode/gpt-5.2']).toBeDefined();
			expect(models['opencode/gpt-5.2'].name).toBe('GPT 5.2');
		});
	});

	describe('endpoint routing', () => {
		it('should route to /responses for GPT models', async () => {
			const models = await provider['getAllModels']();
			expect(models['opencode/gpt-5.2']).toBeDefined();

			const modelInfo = await provider['getModelInfo']('opencode/gpt-5.2', 'key');
			expect(modelInfo.supported_endpoints).toContain('/responses');
		});

		it('should route to /messages for Claude models', async () => {
			await provider['getAllModels']();

			const modelInfo = await provider['getModelInfo']('opencode/claude-sonnet-4-5', 'key');
			expect(modelInfo.supported_endpoints).toContain('/v1/messages');
		});

		it('should route to /models/{id} for Gemini models', async () => {
			const mockModel: vscode.LanguageModelChatInformation = {
				id: 'opencode/gemini-3-pro',
				name: 'Gemini 3 Pro',
				version: '1.0.0',
				maxInputTokens: 2000000,
				maxOutputTokens: 8192,
				family: 'OpenCode Zen',
				capabilities: { toolCalling: true, imageInput: true }
			};

			const endpoint = await provider['getEndpointImpl'](mockModel);
			expect(endpoint.urlOrRequestMetadata).toBe('https://opencode.ai/zen/v1/models/gemini-3-pro');
		});
	});
});
