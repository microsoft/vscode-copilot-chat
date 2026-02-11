/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../configuration/test/common/inMemoryConfigurationService';
import { ILogService } from '../../../log/common/logService';
import { IAbortController, IFetcherService, PaginationOptions } from '../../../networking/common/fetcherService';
import { IExperimentationService, NullExperimentationService } from '../../../telemetry/common/nullExperimentationService';
import { NullTelemetryService } from '../../../telemetry/common/nullTelemetryService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { createFakeResponse } from '../../../test/node/fetcher';
import { RouterDecisionFetcher } from '../routerDecisionFetcher';

const createValidRouterResponse = (chosenModel = 'gpt-4o') => ({
	predicted_label: 'needs_reasoning' as const,
	confidence: 0.85,
	latency_ms: 50,
	chosen_model: chosenModel,
	candidate_models: ['gpt-4o', 'gpt-4o-mini'],
	scores: {
		needs_reasoning: 0.85,
		no_reasoning: 0.15
	}
});

describe('RouterDecisionFetcher', () => {
	let mockFetch: ReturnType<typeof vi.fn>;
	let fetcherService: IFetcherService;
	let logService: ILogService;
	let configurationService: IConfigurationService;
	let experimentationService: IExperimentationService;
	let telemetryService: ITelemetryService;
	let routerDecisionFetcher: RouterDecisionFetcher;

	beforeEach(() => {
		mockFetch = vi.fn();
		fetcherService = {
			_serviceBrand: undefined,
			fetch: mockFetch,
			fetchWithPagination<T>(_baseUrl: string, _options: PaginationOptions<T>): Promise<T[]> {
				throw new Error('Method not implemented.');
			},
			getUserAgentLibrary(): string {
				return 'test';
			},
			disconnectAll(): Promise<unknown> {
				throw new Error('Method not implemented.');
			},
			makeAbortController(): IAbortController {
				throw new Error('Method not implemented.');
			},
			isAbortError(_e: unknown): boolean {
				return false;
			},
			isInternetDisconnectedError(_e: unknown): boolean {
				return false;
			},
			isFetcherError(_err: unknown): boolean {
				return false;
			},
			getUserMessageForFetcherError(_err: unknown): string {
				return '';
			}
		};

		logService = {
			trace: vi.fn(),
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		} as unknown as ILogService;

		configurationService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		(configurationService as InMemoryConfigurationService).setConfig(
			ConfigKey.TeamInternal.AutoModeRouterUrl,
			'https://router.example.com/api'
		);

		experimentationService = new NullExperimentationService();

		telemetryService = new NullTelemetryService();

		routerDecisionFetcher = new RouterDecisionFetcher(
			fetcherService,
			logService,
			configurationService,
			experimentationService,
			telemetryService
		);
	});

	describe('getRoutedModel', () => {
		it('should return the chosen model on successful response', async () => {
			mockFetch.mockResolvedValue(createFakeResponse(200, createValidRouterResponse('claude-sonnet')));

			const result = await routerDecisionFetcher.getRoutedModel(
				'complex query',
				['gpt-4o', 'claude-sonnet'],
				['claude-sonnet']
			);

			expect(result).toBe('claude-sonnet');
			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(mockFetch).toHaveBeenCalledWith(
				'https://router.example.com/api',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						prompt: 'complex query',
						available_models: ['gpt-4o', 'claude-sonnet'],
						preferred_models: ['claude-sonnet']
					})
				})
			);
		});

		it('should log trace message with prediction details', async () => {
			mockFetch.mockResolvedValue(createFakeResponse(200, createValidRouterResponse('gpt-4o')));

			await routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], ['gpt-4o']);

			expect(logService.trace).toHaveBeenCalledWith(
				expect.stringContaining('[RouterDecisionFetcher] Prediction: needs_reasoning')
			);
		});

		it('should throw error when router API URL is not configured', async () => {
			(configurationService as InMemoryConfigurationService).setConfig(
				ConfigKey.TeamInternal.AutoModeRouterUrl,
				undefined
			);

			await expect(
				routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], ['gpt-4o'])
			).rejects.toThrow('Router API URL not configured');

			expect(mockFetch).not.toHaveBeenCalled();
		});

		describe('retry logic', () => {
			it('should retry on network errors up to 3 times', async () => {
				const networkError = new Error('Network error');
				mockFetch
					.mockRejectedValueOnce(networkError)
					.mockRejectedValueOnce(networkError)
					.mockResolvedValueOnce(createFakeResponse(200, createValidRouterResponse()));

				const result = await routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], []);

				expect(result).toBe('gpt-4o');
				expect(mockFetch).toHaveBeenCalledTimes(3);
				expect(logService.warn).toHaveBeenCalledTimes(2);
			});

			it('should throw after exhausting all retries on network errors', async () => {
				const networkError = new Error('Network error');
				mockFetch.mockRejectedValue(networkError);

				await expect(
					routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], [])
				).rejects.toThrow('Network error');

				expect(mockFetch).toHaveBeenCalledTimes(3);
				expect(logService.error).toHaveBeenCalledWith(
					'[RouterDecisionFetcher] Failed after retries: ',
					'Network error'
				);
			});

			it.each([429, 500, 502, 503, 504])(
				'should retry on status code %i',
				async (statusCode) => {
					mockFetch
						.mockResolvedValueOnce(createFakeResponse(statusCode, {}))
						.mockResolvedValueOnce(createFakeResponse(200, createValidRouterResponse()));

					const result = await routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], []);

					expect(result).toBe('gpt-4o');
					expect(mockFetch).toHaveBeenCalledTimes(2);
					expect(logService.warn).toHaveBeenCalledWith(
						expect.stringContaining(`Returned ${statusCode}, retrying`)
					);
				}
			);

			it('should throw after exhausting retries on retryable status codes', async () => {
				mockFetch.mockResolvedValue(createFakeResponse(503, {}));

				await expect(
					routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], [])
				).rejects.toThrow(/API request failed/);

				expect(mockFetch).toHaveBeenCalledTimes(3);
			});
		});

		describe('non-retryable errors', () => {
			it.each([400, 401, 403, 404])(
				'should fail immediately on status code %i without retrying',
				async (statusCode) => {
					mockFetch.mockResolvedValue(createFakeResponse(statusCode, {}));

					await expect(
						routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], [])
					).rejects.toThrow(`[RouterDecisionFetcher] API request failed: ${statusCode}`);

					expect(mockFetch).toHaveBeenCalledTimes(1);
					expect(logService.error).toHaveBeenCalledWith(
						'[RouterDecisionFetcher] Request failed: ',
						expect.stringContaining(`${statusCode}`)
					);
				}
			);
		});

		describe('response validation', () => {
			it('should throw on malformed JSON response', async () => {
				const mockResponse = createFakeResponse(200, {});
				// Override json() to simulate malformed JSON
				vi.spyOn(mockResponse, 'json').mockRejectedValue(new Error('Invalid JSON'));
				mockFetch.mockResolvedValue(mockResponse);

				await expect(
					routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], [])
				).rejects.toThrow('Invalid router decision response: malformed JSON');
			});

			it('should throw on missing required fields', async () => {
				const invalidResponse = { predicted_label: 'needs_reasoning' };
				mockFetch.mockResolvedValue(createFakeResponse(200, invalidResponse));

				await expect(
					routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], [])
				).rejects.toThrow(/Invalid router decision response:/);
			});

			it('should throw on invalid predicted_label value', async () => {
				const invalidResponse = {
					...createValidRouterResponse(),
					predicted_label: 'invalid_label'
				};
				mockFetch.mockResolvedValue(createFakeResponse(200, invalidResponse));

				await expect(
					routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], [])
				).rejects.toThrow(/Invalid router decision response:/);
			});

			it('should accept no_reasoning as a valid predicted_label', async () => {
				const response = {
					...createValidRouterResponse(),
					predicted_label: 'no_reasoning'
				};
				mockFetch.mockResolvedValue(createFakeResponse(200, response));

				const result = await routerDecisionFetcher.getRoutedModel('query', ['gpt-4o'], []);

				expect(result).toBe('gpt-4o');
			});
		});
	});
});
