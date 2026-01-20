/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from 'vscode';
import { ChatLocation } from '../../../../vscodeTypes';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../configuration/test/common/inMemoryConfigurationService';
import { ILogService } from '../../../log/common/logService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { IExperimentationService, NullExperimentationService } from '../../../telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ICAPIClientService } from '../../common/capiClient';
import { AutomodeService } from '../automodeService';
import { IChatEndpoint } from '../../../networking/common/networking';

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

	beforeEach(() => {
		mockChatEndpoint = {
			model: 'gpt-4o-mini',
			displayName: 'GPT-4o Mini',
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
					selected_model: 'gpt-4o-mini',
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
	});

	describe('resolveAutoModeEndpoint', () => {
		it('should not use router for inline chat (ChatLocation.Editor)', async () => {
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
				configurationService
			);

			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Editor,
				prompt: 'test prompt'
			};

			await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [mockChatEndpoint]);

			// Verify that router fetch was NOT called (inline chat should skip router)
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
				configurationService
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
				configurationService
			);

			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Panel,
				prompt: 'test prompt'
			};

			await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [mockChatEndpoint]);

			// Verify that router fetch was NOT called (no router URL configured)
			expect(mockFetcherService.fetch).not.toHaveBeenCalled();
		});

		it('should use router for terminal chat when enabled', async () => {
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
					predicted_label: 'no_reasoning',
					confidence: 0.85,
					latency_ms: 50,
					chosen_model: 'gpt-4o-mini',
					candidate_models: ['gpt-4o', 'gpt-4o-mini'],
					scores: {
						needs_reasoning: 0.15,
						no_reasoning: 0.85
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
				configurationService
			);

			const chatRequest: Partial<ChatRequest> = {
				location: ChatLocation.Terminal,
				prompt: 'test prompt'
			};

			await automodeService.resolveAutoModeEndpoint(chatRequest as ChatRequest, [mockChatEndpoint]);

			// Verify that router fetch WAS called for terminal chat
			expect(mockFetcherService.fetch).toHaveBeenCalledWith(
				'https://router.example.com/api',
				expect.objectContaining({
					method: 'POST'
				})
			);
		});
	});
});
