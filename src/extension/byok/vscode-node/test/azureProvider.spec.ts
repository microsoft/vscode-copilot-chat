/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BlockedExtensionService, IBlockedExtensionService } from '../../../../platform/chat/common/blockedExtensionService';
import { AzureAuthMode, ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { BYOKKnownModels } from '../../common/byokProvider';
import { AzureBYOKModelProvider, resolveAzureUrl } from '../azureProvider';
import { IBYOKStorageService } from '../byokStorageService';
import { CustomOAIModelInfo } from '../customOAIProvider';

describe('AzureBYOKModelProvider', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;
	let provider: AzureBYOKModelProvider;
	let mockByokStorageService: IBYOKStorageService;

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();

		// Add IBlockedExtensionService which is required by CopilotLanguageModelWrapper
		testingServiceCollection.define(IBlockedExtensionService, new SyncDescriptor(BlockedExtensionService));

		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		instaService = accessor.get(IInstantiationService);

		// Create mock storage service
		mockByokStorageService = {
			getAPIKey: vi.fn().mockResolvedValue(undefined),
			storeAPIKey: vi.fn().mockResolvedValue(undefined),
			deleteAPIKey: vi.fn().mockResolvedValue(undefined),
			getStoredModelConfigs: vi.fn().mockResolvedValue({}),
			saveModelConfig: vi.fn().mockResolvedValue(undefined),
			removeModelConfig: vi.fn().mockResolvedValue(undefined)
		};
	});

	afterEach(() => {
		disposables.clear();
		vi.restoreAllMocks();
	});

	describe('resolveAzureUrl', () => {
		it('should handle Azure AI Foundry (models.ai.azure.com) URLs', () => {
			const url = 'https://my-endpoint.models.ai.azure.com';
			const result = resolveAzureUrl('gpt-4', url);
			expect(result).toBe('https://my-endpoint.models.ai.azure.com/v1/chat/completions');
		});

		it('should handle Azure ML (inference.ml.azure.com) URLs', () => {
			const url = 'https://my-endpoint.inference.ml.azure.com';
			const result = resolveAzureUrl('gpt-4', url);
			expect(result).toBe('https://my-endpoint.inference.ml.azure.com/v1/chat/completions');
		});

		it('should handle Azure OpenAI (openai.azure.com) URLs with deployment name', () => {
			const url = 'https://my-resource.openai.azure.com';
			const result = resolveAzureUrl('gpt-4-deployment', url);
			expect(result).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4-deployment/chat/completions?api-version=2025-01-01-preview');
		});

		it('should return URL unchanged if it already has explicit API path', () => {
			const url = 'https://my-endpoint.example.com/v1/chat/completions';
			const result = resolveAzureUrl('gpt-4', url);
			expect(result).toBe(url);
		});

		it('should remove trailing slash before processing', () => {
			const url = 'https://my-endpoint.models.ai.azure.com/';
			const result = resolveAzureUrl('gpt-4', url);
			expect(result).toBe('https://my-endpoint.models.ai.azure.com/v1/chat/completions');
		});

		it('should remove /v1 suffix before processing', () => {
			const url = 'https://my-endpoint.models.ai.azure.com/v1';
			const result = resolveAzureUrl('gpt-4', url);
			expect(result).toBe('https://my-endpoint.models.ai.azure.com/v1/chat/completions');
		});

		it('should throw error for unrecognized Azure URL', () => {
			const url = 'https://unknown.example.com';
			expect(() => resolveAzureUrl('gpt-4', url)).toThrow('Unrecognized Azure deployment URL');
		});
	});

	describe('getModelsWithCredentials - Entra ID mode', () => {
		beforeEach(() => {
			const configService = accessor.get(IConfigurationService);
			vi.spyOn(configService, 'getConfig').mockImplementation((key: any) => {
				if (key === ConfigKey.AzureAuthType) {
					return AzureAuthMode.EntraId;
				}
				if (key === ConfigKey.AzureModels) {
					return {
						'gpt-4': {
							name: 'GPT-4',
							url: 'https://test.models.ai.azure.com',
							toolCalling: true,
							vision: false,
							maxInputTokens: 128000,
							maxOutputTokens: 4096
						},
						'gpt-35-turbo': {
							name: 'GPT-3.5 Turbo',
							url: 'https://test.openai.azure.com',
							toolCalling: true,
							vision: false,
							maxInputTokens: 16000,
							maxOutputTokens: 4096
						}
					};
				}
				return undefined;
			});

			provider = instaService.createInstance(AzureBYOKModelProvider, mockByokStorageService);
		});

		it('should return all models without prompting authentication in silent mode', async () => {
			const getSessionSpy = vi.spyOn(vscode.authentication, 'getSession');

			const models = await provider['getModelsWithCredentials'](true);

			expect(getSessionSpy).not.toHaveBeenCalled();
			expect(Object.keys(models)).toHaveLength(2);
			expect(models['gpt-4']).toBeDefined();
			expect(models['gpt-35-turbo']).toBeDefined();
		});

		it('should return empty object when authentication fails in non-silent mode', async () => {
			const authError = new Error('User canceled authentication');
			vi.spyOn(vscode.authentication, 'getSession').mockRejectedValue(authError);

			const models = await provider['getModelsWithCredentials'](false);

			expect(models).toEqual({});
			expect(vscode.authentication.getSession).toHaveBeenCalledWith(
				AzureAuthMode.MICROSOFT_AUTH_PROVIDER,
				[AzureAuthMode.COGNITIVE_SERVICES_SCOPE],
				{ createIfNone: true }
			);
		});

		it('should use enum constants instead of magic strings for auth provider and scope', async () => {
			const mockSession = { accessToken: 'test-token', account: { id: 'test', label: 'test' }, scopes: [], id: 'test' };
			const getSessionSpy = vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue(mockSession);

			await provider['getModelsWithCredentials'](false);

			const callArgs = getSessionSpy.mock.calls[0];
			expect(callArgs[0]).toBe('microsoft'); // AzureAuthMode.MICROSOFT_AUTH_PROVIDER
			expect(callArgs[1]).toEqual(['https://cognitiveservices.azure.com/.default']); // AzureAuthMode.COGNITIVE_SERVICES_SCOPE
		});
	});

	describe('getModelsWithCredentials - API Key mode', () => {
		beforeEach(() => {
			const configService = accessor.get(IConfigurationService);
			vi.spyOn(configService, 'getConfig').mockImplementation((key: any) => {
				if (key === ConfigKey.AzureAuthType) {
					return AzureAuthMode.ApiKey;
				}
				if (key === ConfigKey.AzureModels) {
					return {
						'gpt-4': {
							name: 'GPT-4',
							url: 'https://test.openai.azure.com',
							toolCalling: true,
							vision: false,
							maxInputTokens: 128000,
							maxOutputTokens: 4096,
							requiresAPIKey: true
						}
					};
				}
				return undefined;
			});

			provider = instaService.createInstance(AzureBYOKModelProvider, mockByokStorageService);
		}); it('should delegate to parent class when in API Key mode', async () => {
			// Mock the parent's getModelsWithCredentials
			const parentProto = Object.getPrototypeOf(Object.getPrototypeOf(provider));
			const parentGetModels = vi.spyOn(parentProto, 'getModelsWithCredentials');
			const expectedModels: BYOKKnownModels = {
				'gpt-4': {
					name: 'GPT-4',
					url: 'https://test.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2025-01-01-preview',
					toolCalling: true,
					vision: false,
					maxInputTokens: 128000,
					maxOutputTokens: 4096
				}
			};
			parentGetModels.mockResolvedValue(expectedModels);

			const getSessionSpy = vi.spyOn(vscode.authentication, 'getSession');

			const models = await provider['getModelsWithCredentials'](false);

			expect(getSessionSpy).not.toHaveBeenCalled();
			expect(parentGetModels).toHaveBeenCalledWith(false);
			expect(models).toEqual(expectedModels);
		});
	});

	describe('provideLanguageModelChatResponse - Entra ID mode', () => {
		let mockModel: CustomOAIModelInfo;
		let mockMessages: vscode.LanguageModelChatMessage[];
		let mockOptions: vscode.ProvideLanguageModelChatResponseOptions;
		let mockProgress: vscode.Progress<vscode.LanguageModelResponsePart2>;
		let mockToken: vscode.CancellationToken;

		beforeEach(() => {
			const configService = accessor.get(IConfigurationService);
			vi.spyOn(configService, 'getConfig').mockImplementation((key: any) => {
				if (key === ConfigKey.AzureAuthType) {
					return AzureAuthMode.EntraId;
				}
				return undefined;
			});

			provider = instaService.createInstance(AzureBYOKModelProvider, mockByokStorageService); mockModel = {
				id: 'gpt-4',
				name: 'GPT-4',
				url: 'https://test.models.ai.azure.com/v1/chat/completions',
				detail: 'Azure',
				version: '1.0.0',
				maxInputTokens: 128000,
				maxOutputTokens: 4096,
				family: 'Azure',
				tooltip: 'GPT-4 via Azure',
				capabilities: {
					toolCalling: true,
					imageInput: false
				},
				thinking: false
			};

			mockMessages = [
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Hello')
			];

			mockOptions = {
				requestInitiator: 'test-extension',
				tools: [],
				toolMode: vscode.LanguageModelChatToolMode.Auto
			};

			mockProgress = { report: vi.fn() };
			mockToken = new vscode.CancellationTokenSource().token;
		});

		it('should acquire Entra ID session and use token for authentication', async () => {
			const mockSession = {
				accessToken: 'test-entra-token-abc123',
				account: { id: 'test', label: 'test' },
				scopes: [AzureAuthMode.COGNITIVE_SERVICES_SCOPE],
				id: 'test'
			};
			vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue(mockSession);

			// Mock the language model wrapper
			const provideResponseSpy = vi.spyOn(provider['_lmWrapper'], 'provideLanguageModelResponse').mockResolvedValue(undefined);

			await provider.provideLanguageModelChatResponse(mockModel, mockMessages, mockOptions, mockProgress, mockToken);

			expect(vscode.authentication.getSession).toHaveBeenCalledWith(
				AzureAuthMode.MICROSOFT_AUTH_PROVIDER,
				[AzureAuthMode.COGNITIVE_SERVICES_SCOPE],
				{ createIfNone: true, silent: false }
			);
			expect(provideResponseSpy).toHaveBeenCalled();
		});

		it('should throw original error when authentication is rejected', async () => {
			const authError = new Error('User did not consent to login.');
			vi.spyOn(vscode.authentication, 'getSession').mockRejectedValue(authError);

			try {
				await provider.provideLanguageModelChatResponse(mockModel, mockMessages, mockOptions, mockProgress, mockToken);
				expect.fail('Should have thrown error');
			} catch (err: any) {
				expect(err.message).toBe('User did not consent to login.');
			}
		});

		it('should pass Entra ID token to AzureOpenAIEndpoint', async () => {
			const mockSession = {
				accessToken: 'test-entra-token-xyz789',
				account: { id: 'test', label: 'test' },
				scopes: [],
				id: 'test'
			};
			vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue(mockSession);

			const createInstanceSpy = vi.spyOn(provider['_instantiationService'], 'createInstance');
			vi.spyOn(provider['_lmWrapper'], 'provideLanguageModelResponse').mockResolvedValue(undefined);

			await provider.provideLanguageModelChatResponse(mockModel, mockMessages, mockOptions, mockProgress, mockToken);

			// Verify AzureOpenAIEndpoint was created with the token
			expect(createInstanceSpy).toHaveBeenCalled();
			const callArgs = createInstanceSpy.mock.calls[0];
			expect(callArgs[1]).toBeDefined(); // modelInfo
			expect(callArgs[2]).toBe('test-entra-token-xyz789'); // Entra ID token passed as apiKey
			expect(callArgs[3]).toBe(mockModel.url); // URL
		});

		it('should use enum constants for auth provider and scope', async () => {
			const mockSession = { accessToken: 'test-token', account: { id: 'test', label: 'test' }, scopes: [], id: 'test' };
			const getSessionSpy = vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue(mockSession);
			vi.spyOn(provider['_lmWrapper'], 'provideLanguageModelResponse').mockResolvedValue(undefined);

			await provider.provideLanguageModelChatResponse(mockModel, mockMessages, mockOptions, mockProgress, mockToken);

			const callArgs = getSessionSpy.mock.calls[0];
			expect(callArgs[0]).toBe('microsoft'); // AzureAuthMode.MICROSOFT_AUTH_PROVIDER
			expect(callArgs[1]).toEqual(['https://cognitiveservices.azure.com/.default']); // AzureAuthMode.COGNITIVE_SERVICES_SCOPE
		});
	});

	describe('provideLanguageModelChatResponse - API Key mode', () => {
		let mockModel: CustomOAIModelInfo;
		let mockMessages: vscode.LanguageModelChatMessage[];
		let mockOptions: vscode.ProvideLanguageModelChatResponseOptions;
		let mockProgress: vscode.Progress<vscode.LanguageModelResponsePart2>;
		let mockToken: vscode.CancellationToken;

		beforeEach(() => {
			const configService = accessor.get(IConfigurationService);
			vi.spyOn(configService, 'getConfig').mockImplementation((key: any) => {
				if (key === ConfigKey.AzureAuthType) {
					return AzureAuthMode.ApiKey;
				}
				return undefined;
			});

			provider = instaService.createInstance(AzureBYOKModelProvider, mockByokStorageService); mockModel = {
				id: 'gpt-4',
				name: 'GPT-4',
				url: 'https://test.openai.azure.com',
				detail: 'Azure',
				version: '1.0.0',
				maxInputTokens: 128000,
				maxOutputTokens: 4096,
				family: 'Azure',
				tooltip: 'GPT-4 via Azure',
				capabilities: {
					toolCalling: true,
					imageInput: false
				},
				thinking: false
			};

			mockMessages = [
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Hello')
			];

			mockOptions = {
				requestInitiator: 'test-extension',
				tools: [],
				toolMode: vscode.LanguageModelChatToolMode.Auto
			};

			mockProgress = { report: vi.fn() };
			mockToken = new vscode.CancellationTokenSource().token;
		});

		it('should delegate to parent class when in API Key mode', async () => {
			const parentProto = Object.getPrototypeOf(Object.getPrototypeOf(provider));
			const parentProvideResponse = vi.spyOn(parentProto, 'provideLanguageModelChatResponse').mockResolvedValue(undefined);
			const getSessionSpy = vi.spyOn(vscode.authentication, 'getSession');

			await provider.provideLanguageModelChatResponse(mockModel, mockMessages, mockOptions, mockProgress, mockToken);

			expect(getSessionSpy).not.toHaveBeenCalled();
			expect(parentProvideResponse).toHaveBeenCalledWith(mockModel, mockMessages, mockOptions, mockProgress, mockToken);
		});

		it('should not use Entra ID authentication in API Key mode', async () => {
			const getSessionSpy = vi.spyOn(vscode.authentication, 'getSession');
			const parentProto = Object.getPrototypeOf(Object.getPrototypeOf(provider));
			vi.spyOn(parentProto, 'provideLanguageModelChatResponse').mockResolvedValue(undefined);

			await provider.provideLanguageModelChatResponse(mockModel, mockMessages, mockOptions, mockProgress, mockToken);

			expect(getSessionSpy).not.toHaveBeenCalled();
		});
	});

	describe('configuration', () => {
		it('should use AzureAuthMode enum for configuration', () => {
			const configService = accessor.get(IConfigurationService);
			const getConfigSpy = vi.spyOn(configService, 'getConfig').mockReturnValue(AzureAuthMode.EntraId);

			provider = instaService.createInstance(AzureBYOKModelProvider, mockByokStorageService);

			configService.getConfig(ConfigKey.AzureAuthType);

			expect(getConfigSpy).toHaveBeenCalledWith(ConfigKey.AzureAuthType);
		});

		it('should default to Entra ID mode', () => {
			const defaultValue = ConfigKey.AzureAuthType.defaultValue;

			expect(defaultValue).toBe(AzureAuthMode.EntraId);
		});
	});
});
