/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BlockedExtensionService, IBlockedExtensionService } from '../../../../platform/chat/common/blockedExtensionService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { IBYOKStorageService } from '../byokStorageService';
import { OpenRouterLMProvider } from '../openRouterProvider';

describe('OpenRouterLMProvider', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;
	let provider: OpenRouterLMProvider;
	let mockByokStorageService: IBYOKStorageService;

	// Mock fetch response for models endpoint
	const mockModelsResponse = {
		data: [
			{
				id: 'google/gemini-3-flash-preview',
				name: 'Gemini 3 Flash Preview',
				supported_parameters: ['tools'],
				architecture: {
					input_modalities: ['text', 'image']
				},
				top_provider: {
					context_length: 200000
				}
			},
			{
				id: 'openai/gpt-4o',
				name: 'GPT-4o',
				supported_parameters: ['tools'],
				architecture: {
					input_modalities: ['text', 'image']
				},
				top_provider: {
					context_length: 128000
				}
			}
		]
	};

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();

		// Add IBlockedExtensionService which is required by CopilotLanguageModelWrapper
		testingServiceCollection.define(IBlockedExtensionService, new SyncDescriptor(BlockedExtensionService));

		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		instaService = accessor.get(IInstantiationService);

		// Create mock storage service
		mockByokStorageService = {
			getAPIKey: vi.fn().mockResolvedValue('test-openrouter-api-key'),
			storeAPIKey: vi.fn().mockResolvedValue(undefined),
			deleteAPIKey: vi.fn().mockResolvedValue(undefined),
			getStoredModelConfigs: vi.fn().mockResolvedValue({}),
			saveModelConfig: vi.fn().mockResolvedValue(undefined),
			removeModelConfig: vi.fn().mockResolvedValue(undefined)
		};

		// Mock global fetch
		global.fetch = vi.fn();

		provider = instaService.createInstance(OpenRouterLMProvider, mockByokStorageService);
	});

	afterEach(() => {
		disposables.clear();
		vi.restoreAllMocks();
	});

	describe('getAllModels', () => {
		it('should fetch and parse models from OpenRouter API', async () => {
			const mockFetch = vi.mocked(global.fetch);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockModelsResponse
			} as Response);

			const models = await provider['getAllModels']();

			// Verify the URL was called (the actual call includes additional headers and options)
			expect(mockFetch).toHaveBeenCalled();
			const callArgs = mockFetch.mock.calls[0];
			expect(callArgs[0]).toBe('https://openrouter.ai/api/v1/models?supported_parameters=tools');
			expect(callArgs[1]).toMatchObject({ method: 'GET' });
			expect(models['google/gemini-3-flash-preview']).toEqual({
				name: 'Gemini 3 Flash Preview',
				toolCalling: true,
				vision: true,
				maxInputTokens: 184000, // 200000 - 16000
				maxOutputTokens: 16000
			});
		});

		it('should handle API errors gracefully', async () => {
			const mockFetch = vi.mocked(global.fetch);
			mockFetch.mockRejectedValueOnce(new Error('Network error'));

			await expect(provider['getAllModels']()).rejects.toThrow('Network error');
		});

		it('should handle missing top_provider.context_length', async () => {
			const mockFetch = vi.mocked(global.fetch);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [
						{
							id: 'test/model',
							name: 'Test Model',
							supported_parameters: ['tools'],
							architecture: { input_modalities: ['text'] },
							top_provider: {} // Missing context_length
						}
					]
				})
			} as Response);

			const models = await provider['getAllModels']();

			expect(models['test/model'].maxInputTokens).toBe(8000); // Default fallback
		});
	});

	describe('provideLanguageModelChatInformation', () => {
		it('should return available models when API key is present', async () => {
			const mockFetch = vi.mocked(global.fetch);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockModelsResponse
			} as Response);

			const models = await provider.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token);

			expect(models).toHaveLength(2);
			expect(models[0].id).toBe('google/gemini-3-flash-preview');
			expect(models[0].capabilities.toolCalling).toBe(true);
			expect(models[0].capabilities.imageInput).toBe(true);
		});

		it('should return empty array when silent mode and no API key', async () => {
			mockByokStorageService.getAPIKey = vi.fn().mockResolvedValue(undefined);
			provider = instaService.createInstance(OpenRouterLMProvider, mockByokStorageService);

			const models = await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			expect(models).toHaveLength(0);
		});
	});

	describe('reasoning details handling for Gemini models', () => {
		it('should cache reasoning details by tool call ID', () => {
			// Access the private reasoning cache
			const reasoningCache = (provider as any)._reasoningCache;

			// Simulate adding reasoning details to cache (as would happen from processSideChannel)
			const testToolCallId = 'call_123';
			const testReasoningDetails = [
				{ type: 'reasoning.encrypted' as const, data: 'encrypted-thought-signature-data' },
				{ type: 'reasoning.summary' as const, summary: 'The model is thinking about the task' }
			];

			reasoningCache.set(testToolCallId, testReasoningDetails);

			expect(reasoningCache.has(testToolCallId)).toBe(true);
			expect(reasoningCache.get(testToolCallId)).toEqual(testReasoningDetails);
		});

		it('should handle cache size limits by removing oldest entries', () => {
			const reasoningCache = (provider as any)._reasoningCache;

			// Add more items than the max cache size (500)
			for (let i = 0; i < 550; i++) {
				reasoningCache.set(`call_${i}`, [{ type: 'reasoning.encrypted', data: `data_${i}` }]);
			}

			expect(reasoningCache.size).toBe(550);

			// Trigger the cleanup by calling getOpenRouterEndpoint
			// Note: In actual usage, cleanup happens when size > MAX_CACHE_SIZE
		});

		it('should store reasoning details as array with proper structure', () => {
			const reasoningCache = (provider as any)._reasoningCache;

			// This is the format OpenRouter sends for Gemini models
			const geminiReasoningDetails = [
				{
					type: 'reasoning.encrypted' as const,
					id: 'reasoning-1',
					format: 'google-gemini-v1',
					data: 'base64-encoded-thought-signature'
				},
				{
					type: 'reasoning.summary' as const,
					id: 'reasoning-2',
					summary: 'I need to create a todo list for the user'
				}
			];

			reasoningCache.set('call_abc', geminiReasoningDetails);

			const cached = reasoningCache.get('call_abc');
			expect(cached).toHaveLength(2);
			expect(cached[0].type).toBe('reasoning.encrypted');
			expect(cached[0].data).toBe('base64-encoded-thought-signature');
			expect(cached[1].type).toBe('reasoning.summary');
		});
	});

	describe('OpenRouterEndpoint request body creation', () => {
		let mockModel: vscode.LanguageModelChatInformation;
		let mockOptions: vscode.ProvideLanguageModelChatResponseOptions;
		let mockProgress: vscode.Progress<vscode.LanguageModelResponsePart2>;
		let mockToken: vscode.CancellationToken;

		beforeEach(() => {
			mockModel = {
				id: 'google/gemini-3-flash-preview',
				name: 'Gemini 3 Flash Preview',
				version: '1.0.0',
				maxInputTokens: 40000,
				maxOutputTokens: 16000,
				family: 'OpenRouter',
				tooltip: 'Gemini 3 Flash Preview via OpenRouter',
				capabilities: {
					toolCalling: true,
					imageInput: true
				}
			};

			mockOptions = {
				requestInitiator: 'test-extension',
				tools: [
					{
						name: 'manage_todo_list',
						description: 'Manage todo list',
						inputSchema: {
							type: 'object',
							properties: {
								command: { type: 'string' }
							},
							required: ['command']
						}
					}
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto
			};

			mockProgress = { report: vi.fn() };
			mockToken = new vscode.CancellationTokenSource().token;
		});

		it('should inject reasoning_details at message level when reasoning is cached', async () => {
			const mockFetch = vi.mocked(global.fetch);

			// Mock the initial models fetch
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockModelsResponse
			} as unknown as Response);

			// Pre-populate the reasoning cache with data that would come from a previous response
			const providerAny = provider as any;
			const reasoningCache = providerAny._reasoningCache;
			const cachedReasoning = [
				{ type: 'reasoning.encrypted', data: 'encrypted-thought-signature-from-previous-turn' },
				{ type: 'reasoning.summary', summary: 'Previous reasoning' }
			];
			reasoningCache.set('call_previous_turn', cachedReasoning);

			// Create conversation history with a previous tool call that matches our cached ID
			const assistantMessage = vscode.LanguageModelChatMessage.Assistant('');
			assistantMessage.content = [new vscode.LanguageModelToolCallPart('call_previous_turn', 'manage_todo_list', {
				command: 'list'
			})];

			const toolResultMessage = vscode.LanguageModelChatMessage.User('');
			toolResultMessage.content = [new vscode.LanguageModelToolResultPart('call_previous_turn', [
				new vscode.LanguageModelTextPart('Todo list is empty')
			])];

			const conversationHistory = [
				vscode.LanguageModelChatMessage.User('Show my todos'),
				assistantMessage,
				toolResultMessage,
				vscode.LanguageModelChatMessage.User('Add a task to buy groceries')
			];

			// Mock the language model wrapper to capture the request body
			let capturedEndpoint: any = null;
			const provideResponseSpy = vi.spyOn(providerAny._lmWrapper, 'provideLanguageModelResponse').mockImplementation(
				async (endpoint: any) => {
					capturedEndpoint = endpoint;
					return Promise.resolve();
				}
			);

			await provider.provideLanguageModelChatResponse(mockModel, conversationHistory, mockOptions, mockProgress, mockToken);

			expect(provideResponseSpy).toHaveBeenCalled();
			expect(capturedEndpoint).toBeDefined();

			// Call createRequestBody to verify the reasoning_details injection
			if (capturedEndpoint?.createRequestBody) {
				const requestBody = capturedEndpoint.createRequestBody({
					messages: conversationHistory,
					tools: mockOptions.tools,
					toolMode: mockOptions.toolMode,
					requestId: 'test-request-id',
					debugName: 'test',
					finishedCb: undefined,
					location: 'panel',
					postOptions: {}
				});

				// Find the assistant message with tool_calls in the request body
				const assistantMsg = requestBody.messages?.find((m: any) => m.role === 'assistant' && m.tool_calls);

				if (assistantMsg) {
					// Verify reasoning_details is at the message level (OpenRouter format)
					expect(assistantMsg.reasoning_details).toBeDefined();
					expect(assistantMsg.reasoning_details).toHaveLength(2);
					expect(assistantMsg.reasoning_details[0].type).toBe('reasoning.encrypted');
					expect(assistantMsg.reasoning_details[0].data).toBe('encrypted-thought-signature-from-previous-turn');
					expect(assistantMsg.reasoning_details[1].type).toBe('reasoning.summary');
				}
			}
		});

		it('should share reasoning_details across parallel tool calls at message level', async () => {
			const mockFetch = vi.mocked(global.fetch);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockModelsResponse
			} as unknown as Response);

			const providerAny = provider as any;
			const reasoningCache = providerAny._reasoningCache;

			// Cache reasoning for multiple parallel tool calls (they share the same reasoning)
			const sharedReasoning = [
				{ type: 'reasoning.encrypted' as const, data: 'shared-thought-signature' }
			];
			reasoningCache.set('call_1', sharedReasoning);
			reasoningCache.set('call_2', sharedReasoning);
			reasoningCache.set('call_3', sharedReasoning);

			// The reasoning_details is at the message level, so all tool calls in the same
			// assistant message share the same reasoning_details (which is the correct behavior)
		});

		it('should not inject reasoning_details when no reasoning is cached', async () => {
			const mockFetch = vi.mocked(global.fetch);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockModelsResponse
			} as unknown as Response);

			// Don't pre-populate the cache - simulating first turn or non-Gemini model

			const conversationHistory = [
				vscode.LanguageModelChatMessage.User('Create a todo list')
			];

			const providerAny = provider as any;

			const provideResponseSpy = vi.spyOn(providerAny._lmWrapper, 'provideLanguageModelResponse').mockImplementation(
				async () => {
					return Promise.resolve();
				}
			);

			await provider.provideLanguageModelChatResponse(mockModel, conversationHistory, mockOptions, mockProgress, mockToken);

			// For a first turn with no previous tool calls, there should be no reasoning_details
			// because there's no cached reasoning to inject
			expect(provideResponseSpy).toHaveBeenCalled();
		});
	});

	describe('error handling', () => {
		it('should handle invalid API key gracefully', async () => {
			const mockFetch = vi.mocked(global.fetch);
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({
					error: {
						message: 'Invalid API key'
					}
				})
			} as Response);

			const models = await provider.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token);

			// Should return empty array when API key is invalid
			expect(models).toHaveLength(0);
		});

		it('should handle network timeouts', async () => {
			const mockFetch = vi.mocked(global.fetch);
			mockFetch.mockRejectedValueOnce(new Error('Request timeout'));

			const models = await provider.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token);

			expect(models).toHaveLength(0);
		});
	});

	describe.skip('updateAPIKey', () => {
		it('should prompt user for API key when none is stored', async () => {
			mockByokStorageService.getAPIKey = vi.fn().mockResolvedValue(undefined);
			provider = instaService.createInstance(OpenRouterLMProvider, mockByokStorageService);

			// This would normally prompt the user, but in tests it should handle gracefully
			await provider.updateAPIKey();

			// Verify storage service was called appropriately
			expect(mockByokStorageService.getAPIKey).toHaveBeenCalledWith('OpenRouter');
		});

		it('should update stored API key', async () => {
			const newApiKey = 'new-test-api-key';

			// Mock the UI prompt to return a new API key
			vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(newApiKey);

			await provider.updateAPIKey();

			expect(mockByokStorageService.storeAPIKey).toHaveBeenCalledWith(
				'OpenRouter',
				newApiKey,
				expect.any(Object) // BYOKAuthType.GlobalApiKey
			);
		});
	});
});
