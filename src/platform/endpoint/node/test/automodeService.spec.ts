/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from 'vscode';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatLocation } from '../../../../vscodeTypes';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../configuration/test/common/inMemoryConfigurationService';
import { NullEnvService } from '../../../env/common/nullEnvService';
import { ILogService } from '../../../log/common/logService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { IChatEndpoint } from '../../../networking/common/networking';
import { IExperimentationService, NullExperimentationService } from '../../../telemetry/common/nullExperimentationService';
import { NullTelemetryService } from '../../../telemetry/common/nullTelemetryService';
import { ICAPIClientService } from '../../common/capiClient';
import { AutomodeService } from '../automodeService';

describe('AutomodeService', () => {
	let automodeService: AutomodeService;
	let mockCAPIClientService: ICAPIClientService;
	let mockAuthService: IAuthenticationService;
	let mockLogService: ILogService;
	let mockInstantiationService: IInstantiationService;
	let mockExpService: IExperimentationService;
	let mockFetcherService: IFetcherService;
	let configurationService: IConfigurationService;
	let mockChatEndpoint: IChatEndpoint;
	let envService: NullEnvService;

	beforeEach(() => {
		mockChatEndpoint = {
			model: 'gpt-4o-mini',
			displayName: 'GPT-4o Mini',
			modelProvider: 'OpenAI',
			maxOutputTokens: 4096,
			supportsToolCalls: true,
			supportsVision: false,
			supportsPrediction: false,
			showInModelPicker: true,
			isDefault: false,
			isFallback: false,
			policy: 'enabled',
		} as unknown as IChatEndpoint;

		mockCAPIClientService = {
			makeRequest: vi.fn().mockResolvedValue({
				json: vi.fn().mockResolvedValue({
					available_models: ['gpt-4o', 'gpt-4o-mini'],
					expires_at: Math.floor(Date.now() / 1000) + 3600,
					session_token: 'test-token'
				})
			})
		} as unknown as ICAPIClientService;

		mockAuthService = {
			getCopilotToken: vi.fn().mockResolvedValue({ token: 'test-auth-token' }),
			onDidAuthenticationChange: vi.fn().mockReturnValue({ dispose: vi.fn() })
		} as unknown as IAuthenticationService;

		mockLogService = {
			trace: vi.fn(),
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		} as unknown as ILogService;

		mockInstantiationService = {
			createInstance: vi.fn().mockReturnValue(mockChatEndpoint)
		} as unknown as IInstantiationService;

		mockExpService = new NullExperimentationService();

		mockFetcherService = {
			fetch: vi.fn()
		} as unknown as IFetcherService;

		configurationService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		envService = new NullEnvService();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('resolveAutoModeEndpoint', () => {
		it('should not use router for inline chat', async () => {
			// Enable router via config
			(configurationService as InMemoryConfigurationService).setConfig(
				ConfigKey.TeamInternal.AutoModeRouterUrl,
				'https://router.example.com/api'
			);

			automodeService = new AutomodeService(
				mockCAPIClientService,
				mockAuthService,
				mockLogService,
				mockInstantiationService,
				mockExpService,
				mockFetcherService,
				configurationService,
				envService,
				new NullTelemetryService()
			);

			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Editor,
				prompt: 'test prompt',
				toolInvocationToken: { sessionId: 'test-session' } as any
			};

			await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [mockChatEndpoint]);

			// Verify that router fetch was NOT called for inline chat
			expect(mockFetcherService.fetch).not.toHaveBeenCalled();
		});

		it('should use router for panel chat when enabled', async () => {
			// Enable router via config
			(configurationService as InMemoryConfigurationService).setConfig(
				ConfigKey.TeamInternal.AutoModeRouterUrl,
				'https://router.example.com/api'
			);

			// Mock successful router response
			(mockFetcherService.fetch as any).mockResolvedValue({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue({
					predicted_label: 'needs_reasoning',
					confidence: 0.85,
					latency_ms: 50,
					chosen_model: 'gpt-4o',
					candidate_models: ['gpt-4o', 'gpt-4o-mini'],
					scores: {
						needs_reasoning: 0.85,
						no_reasoning: 0.15
					}
				})
			});

			automodeService = new AutomodeService(
				mockCAPIClientService,
				mockAuthService,
				mockLogService,
				mockInstantiationService,
				mockExpService,
				mockFetcherService,
				configurationService,
				envService,
				new NullTelemetryService()
			);

			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test prompt'
			};

			await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [mockChatEndpoint]);

			// Verify that router fetch WAS called for panel chat
			expect(mockFetcherService.fetch).toHaveBeenCalledWith(
				'https://router.example.com/api',
				expect.objectContaining({
					method: 'POST'
				})
			);
		});

		it('should not use router when router URL is not configured', async () => {
			// Router URL not configured
			automodeService = new AutomodeService(
				mockCAPIClientService,
				mockAuthService,
				mockLogService,
				mockInstantiationService,
				mockExpService,
				mockFetcherService,
				configurationService,
				envService,
				new NullTelemetryService()
			);

			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test prompt'
			};

			await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [mockChatEndpoint]);

			// Verify that router fetch was NOT called (no router URL configured)
			expect(mockFetcherService.fetch).not.toHaveBeenCalled();
		});

		it('should not use router for terminal chat', async () => {
			// Enable router via config
			(configurationService as InMemoryConfigurationService).setConfig(
				ConfigKey.TeamInternal.AutoModeRouterUrl,
				'https://router.example.com/api'
			);

			automodeService = new AutomodeService(
				mockCAPIClientService,
				mockAuthService,
				mockLogService,
				mockInstantiationService,
				mockExpService,
				mockFetcherService,
				configurationService,
				envService,
				new NullTelemetryService()
			);

			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Terminal,
				prompt: 'test prompt'
			};

			await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [mockChatEndpoint]);

			// Verify that router fetch was NOT called for terminal chat
			expect(mockFetcherService.fetch).not.toHaveBeenCalled();
		});
	});

	describe('model selection', () => {
		function createEndpoint(model: string, provider: string, overrides?: Partial<IChatEndpoint>): IChatEndpoint {
			return {
				model,
				modelProvider: provider,
				displayName: model,
				maxOutputTokens: 4096,
				supportsToolCalls: true,
				supportsVision: false,
				supportsPrediction: false,
				showInModelPicker: true,
				isDefault: false,
				isFallback: false,
				policy: 'enabled',
				...overrides,
			} as unknown as IChatEndpoint;
		}

		function createService(): AutomodeService {
			return new AutomodeService(
				mockCAPIClientService,
				mockAuthService,
				mockLogService,
				mockInstantiationService,
				mockExpService,
				mockFetcherService,
				configurationService,
				envService,
				new NullTelemetryService()
			);
		}

		function mockApiResponse(available_models: string[], session_token = 'test-token', expiresInSeconds = 3600): void {
			(mockCAPIClientService.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
				json: vi.fn().mockResolvedValue({
					available_models,
					expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
					session_token,
				})
			});
		}

		it('should pick the first available model with a known endpoint on first mint', async () => {
			const openaiEndpoint = createEndpoint('gpt-4o', 'OpenAI');
			const claudeEndpoint = createEndpoint('claude-sonnet', 'Anthropic');
			mockApiResponse(['claude-sonnet', 'gpt-4o']);

			(mockInstantiationService.createInstance as ReturnType<typeof vi.fn>).mockImplementation(
				(_ctor: any, wrappedEndpoint: IChatEndpoint) => wrappedEndpoint
			);

			automodeService = createService();
			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test',
				sessionId: 'session-first-mint'
			};

			const result = await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [openaiEndpoint, claudeEndpoint]);
			// claude-sonnet is first in available_models and has a known endpoint
			expect(result.model).toBe('claude-sonnet');
		});

		it('should skip models without known endpoints and pick the first match', async () => {
			const openaiEndpoint = createEndpoint('gpt-4o', 'OpenAI');
			// available_models has 'unknown-model' first, but no known endpoint for it
			mockApiResponse(['unknown-model', 'gpt-4o']);

			(mockInstantiationService.createInstance as ReturnType<typeof vi.fn>).mockImplementation(
				(_ctor: any, wrappedEndpoint: IChatEndpoint) => wrappedEndpoint
			);

			automodeService = createService();
			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test',
				sessionId: 'session-skip-unknown'
			};

			const result = await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [openaiEndpoint]);
			expect(result.model).toBe('gpt-4o');
		});

		it('should prefer same provider model on token refresh', async () => {
			vi.useFakeTimers();
			const openaiEndpoint = createEndpoint('gpt-4o', 'OpenAI');
			const openaiMiniEndpoint = createEndpoint('gpt-4o-mini', 'OpenAI');
			const claudeEndpoint = createEndpoint('claude-sonnet', 'Anthropic');

			// First mint: gpt-4o is first available, token expires in 1s to trigger immediate refresh
			mockApiResponse(['gpt-4o', 'claude-sonnet'], 'token-1', 1);
			(mockInstantiationService.createInstance as ReturnType<typeof vi.fn>).mockImplementation(
				(_ctor: any, wrappedEndpoint: IChatEndpoint) => wrappedEndpoint
			);

			automodeService = createService();
			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test',
				sessionId: 'session-affinity'
			};

			const firstResult = await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [openaiEndpoint, openaiMiniEndpoint, claudeEndpoint]);
			expect(firstResult.model).toBe('gpt-4o');

			// Set up new token response, then advance timers to trigger refresh
			mockApiResponse(['claude-sonnet', 'gpt-4o-mini'], 'token-2');
			await vi.advanceTimersByTimeAsync(1);

			const secondResult = await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [openaiEndpoint, openaiMiniEndpoint, claudeEndpoint]);
			// Should pick gpt-4o-mini because it's the first model from the same provider (OpenAI)
			expect(secondResult.model).toBe('gpt-4o-mini');
			vi.useRealTimers();
		});

		it('should fall back to first available model when no same-provider model exists on refresh', async () => {
			vi.useFakeTimers();
			const openaiEndpoint = createEndpoint('gpt-4o', 'OpenAI');
			const claudeEndpoint = createEndpoint('claude-sonnet', 'Anthropic');

			// First mint: gpt-4o is first available, token expires in 1s to trigger immediate refresh
			mockApiResponse(['gpt-4o', 'claude-sonnet'], 'token-1', 1);
			(mockInstantiationService.createInstance as ReturnType<typeof vi.fn>).mockImplementation(
				(_ctor: any, wrappedEndpoint: IChatEndpoint) => wrappedEndpoint
			);

			automodeService = createService();
			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test',
				sessionId: 'session-fallback'
			};

			const firstResult = await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [openaiEndpoint, claudeEndpoint]);
			expect(firstResult.model).toBe('gpt-4o');

			// Set up new token response with only Anthropic models, then advance timers
			mockApiResponse(['claude-sonnet'], 'token-2');
			await vi.advanceTimersByTimeAsync(1);

			const secondResult = await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [openaiEndpoint, claudeEndpoint]);
			// No OpenAI models available, should fall back to first available (claude-sonnet)
			expect(secondResult.model).toBe('claude-sonnet');
		});

		it('should return cached endpoint when session token has not changed', async () => {
			const openaiEndpoint = createEndpoint('gpt-4o', 'OpenAI');
			const claudeEndpoint = createEndpoint('claude-sonnet', 'Anthropic');

			mockApiResponse(['gpt-4o', 'claude-sonnet'], 'token-same');
			(mockInstantiationService.createInstance as ReturnType<typeof vi.fn>).mockImplementation(
				(_ctor: any, wrappedEndpoint: IChatEndpoint) => wrappedEndpoint
			);

			automodeService = createService();
			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test',
				sessionId: 'session-cached'
			};

			const firstResult = await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [openaiEndpoint, claudeEndpoint]);
			const secondResult = await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [openaiEndpoint, claudeEndpoint]);
			// Same object reference since token didn't change
			expect(secondResult).toBe(firstResult);
		});

		it('should throw when no available models match any known endpoint', async () => {
			mockApiResponse(['unknown-model-1', 'unknown-model-2']);

			automodeService = createService();
			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test',
				sessionId: 'session-no-match'
			};

			await expect(
				automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [mockChatEndpoint])
			).rejects.toThrow('no available model found');
		});
	});
});
