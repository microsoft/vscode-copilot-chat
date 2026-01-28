/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { CopilotToken } from '../../../../platform/authentication/common/copilotToken';
import { IFetchMLOptions } from '../../../../platform/chat/common/chatMLFetcher';
import { IChatQuotaService } from '../../../../platform/chat/common/chatQuotaService';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { IInteractionService } from '../../../../platform/chat/common/interactionService';
import { ConfigKey } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { ICAPIClientService } from '../../../../platform/endpoint/common/capiClient';
import { MockAuthenticationService } from '../../../../platform/ignore/node/test/mockAuthenticationService';
import { MockCAPIClientService } from '../../../../platform/ignore/node/test/mockCAPIClientService';
import { ILogService } from '../../../../platform/log/common/logService';
import { FinishedCallback } from '../../../../platform/networking/common/fetch';
import { IFetcherService, IHeaders, Response } from '../../../../platform/networking/common/fetcherService';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { NullRequestLogger } from '../../../../platform/requestLogger/node/nullRequestLogger';
import { NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../../platform/telemetry/common/telemetryData';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { ChatMLFetcherImpl } from '../chatMLFetcher';

describe('ChatMLFetcherImpl retry logic', () => {
	let disposables: DisposableStore;
	let fetcher: ChatMLFetcherImpl;
	let mockFetcherService: MockFetcherService;
	let configurationService: InMemoryConfigurationService;
	let cancellationTokenSource: CancellationTokenSource;
	let endpoint: IChatEndpoint;

	beforeEach(() => {
		disposables = new DisposableStore();
		cancellationTokenSource = disposables.add(new CancellationTokenSource());

		mockFetcherService = new MockFetcherService();
		configurationService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '500,502');
		configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, true);

		const logService = new TestLogService();
		const telemetryService = new NullTelemetryService();
		const experimentationService = new NullExperimentationService();

		endpoint = createMockEndpoint();

		fetcher = new ChatMLFetcherImpl(
			mockFetcherService as unknown as IFetcherService,
			telemetryService,
			new NullRequestLogger(),
			logService,
			new TestAuthenticationService() as unknown as IAuthenticationService,
			createMockInteractionService(),
			createMockChatQuotaService(),
			new TestCAPIClientService() as unknown as ICAPIClientService,
			createMockConversationOptions(),
			configurationService,
			experimentationService,
		);

		// Skip delays in tests for faster execution
		fetcher.connectivityCheckDelays = [0, 0, 0];
	});

	afterEach(() => {
		disposables.dispose();
	});

	function createBaseOpts(): IFetchMLOptions {
		return {
			debugName: 'test',
			messages: [{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }] }],
			endpoint,
			location: ChatLocation.Panel,
			enableRetryOnError: true,
			requestOptions: {},
			finishedCb: undefined,
		};
	}

	describe('server error retry with configured status codes', () => {
		it('retries on 500 status code when configured', async () => {
			// Order: 1) initial fetch → 500, 2) connectivity check → 200, 3) retry → success
			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Hello!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
			expect(mockFetcherService.fetchCallCount).toBeGreaterThanOrEqual(2);
		});

		it('retries on 502 status code when configured', async () => {
			// Order: 1) initial fetch → 502, 2) connectivity check → 200, 3) retry → success
			mockFetcherService.queueResponse(createErrorResponse(502, 'Bad Gateway'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
		});

		it('does not retry on 404 status code', async () => {
			mockFetcherService.queueResponse(createErrorResponse(404, 'Not Found'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.NotFound);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});

		it('does not retry when enableRetryOnError is false', async () => {
			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));

			const opts = createBaseOpts();
			opts.enableRetryOnError = false;
			const result = await fetcher.fetchMany(opts, cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Failed);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});

		it('respects custom status codes from configuration', async () => {
			// Configure to only retry on 503
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '503');

			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// Should NOT retry because 500 is not in the configured list
			expect(result.type).toBe(ChatFetchResponseType.Failed);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});
	});

	describe('network error retry', () => {
		it('retries after connectivity check succeeds', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, true);

			// Use ENOTFOUND instead of ECONNRESET - ECONNRESET triggers auto-retry in networking.ts
			// Order: 1) initial fetch → error, 2) connectivity check → 200, 3) retry → success
			mockFetcherService.queueError(createNetworkError('ENOTFOUND'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
		});

		it('does not retry when RetryNetworkErrors is disabled', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, false);

			// Use ENOTFOUND instead of ECONNRESET - ECONNRESET triggers auto-retry in networking.ts
			mockFetcherService.queueError(createNetworkError('ENOTFOUND'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.NetworkError);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});
	});

	describe('status code parsing', () => {
		it('handles comma-separated status codes with spaces', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '500, 502 , 503');

			mockFetcherService.queueResponse(createErrorResponse(502, 'Bad Gateway'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
		});

		it('handles invalid status codes gracefully', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '500,invalid,502');

			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			// Should still retry on 500 even with invalid entry in config
			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
		});

		it('does not retry when configuration is empty string', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '');

			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// Empty config means no status codes to retry - should fail without retry
			expect(result.type).toBe(ChatFetchResponseType.Failed);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});

		it('does not retry when configuration contains only invalid values', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, 'invalid,abc,xyz');

			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// All invalid means no valid status codes - should fail without retry
			expect(result.type).toBe(ChatFetchResponseType.Failed);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});
	});

	describe('connectivity check failure', () => {
		it('does not retry server error when connectivity check fails', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '500,502');

			// Order: 1) initial fetch → 500, 2) connectivity checks fail (3 attempts)
			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));
			// Connectivity check retries 3 times (with 0ms delays in tests)
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 1st connectivity check
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 2nd connectivity check
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 3rd connectivity check

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// Should fail because connectivity check never succeeded
			expect(result.type).toBe(ChatFetchResponseType.Failed);
		});
	});

	describe('Responses API telemetry logging', () => {
		it('converts Responses API input to messages for telemetry', async () => {
			// Create a new telemetry service instance to spy on
			const telemetryService = new NullTelemetryService();
			const telemetrySpy = vi.spyOn(telemetryService, 'sendEnhancedGHTelemetryEvent');

			// Setup endpoint that creates Responses API body with `input` instead of `messages`
			const responsesApiEndpoint = createMockEndpoint();
			responsesApiEndpoint.createRequestBody = () => ({
				model: 'test-model',
				input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello from Responses API' }] }],
				stream: true
			});

			// Create a new fetcher with the spied telemetry service
			const testFetcher = new ChatMLFetcherImpl(
				mockFetcherService as unknown as IFetcherService,
				telemetryService,
				new NullRequestLogger(),
				new TestLogService(),
				new TestAuthenticationService() as unknown as IAuthenticationService,
				createMockInteractionService(),
				createMockChatQuotaService(),
				new TestCAPIClientService() as unknown as ICAPIClientService,
				createMockConversationOptions(),
				configurationService,
				new NullExperimentationService(),
			);
			testFetcher.connectivityCheckDelays = [0, 0, 0];

			mockFetcherService.queueResponse(createSuccessResponse('Hello!'));

			const opts: IFetchMLOptions = {
				debugName: 'test-responses-api',
				messages: [{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }] }],
				endpoint: responsesApiEndpoint,
				location: ChatLocation.Panel,
				enableRetryOnError: false,
				requestOptions: {},
				finishedCb: undefined,
			};

			await testFetcher.fetchMany(opts, cancellationTokenSource.token);

			// Find the engine.messages telemetry call
			const engineMessagesCall = telemetrySpy.mock.calls.find(call => call[0] === 'engine.messages');
			expect(engineMessagesCall).toBeDefined();

			// Verify telemetry received non-empty messages
			const properties = engineMessagesCall![1];
			expect(properties).toBeDefined();
			expect(properties!.messagesJson).toBeDefined();
			expect(properties!.messagesJson).not.toBe('[]');

			// Parse and verify the messages contain expected content
			const messages = JSON.parse(properties!.messagesJson as string);
			expect(messages.length).toBeGreaterThan(0);
		});
	});
});

// --- Test Helpers ---

/**
 * Mock fetcher service that queues responses for testing retry logic.
 */
class MockFetcherService {
	private _responseQueue: (Response | Error)[] = [];
	private _fetchCallCount = 0;

	get fetchCallCount(): number {
		return this._fetchCallCount;
	}

	queueResponse(response: Response): void {
		this._responseQueue.push(response);
	}

	queueError(error: Error): void {
		this._responseQueue.push(error);
	}

	async fetch(_url: string, _options?: unknown): Promise<Response> {
		this._fetchCallCount++;
		const next = this._responseQueue.shift();
		if (!next) {
			throw new Error('No more queued responses');
		}
		if (next instanceof Error) {
			throw next;
		}
		return next;
	}

	fetchWithPagination<T>(): Promise<T[]> {
		throw new Error('Method not implemented.');
	}

	disconnectAll(): Promise<void> {
		return Promise.resolve();
	}

	makeAbortController(): AbortController {
		return new AbortController();
	}

	isAbortError(_err: unknown): boolean {
		return false;
	}

	isInternetDisconnectedError(_err: unknown): boolean {
		return false;
	}

	isFetcherError(err: unknown): boolean {
		return err instanceof Error && 'code' in err;
	}

	getUserMessageForFetcherError(_err: unknown): string {
		return 'Network error occurred';
	}

	getUserAgentLibrary(): string {
		return 'test-agent';
	}
}

/**
 * Extended mock authentication service that returns a valid token.
 */
class TestAuthenticationService extends MockAuthenticationService {
	override getCopilotToken(_force?: boolean): Promise<CopilotToken> {
		return Promise.resolve({
			token: 'test-token',
			username: 'test-user',
		} as CopilotToken);
	}
}

/**
 * Extended mock CAPI client service that provides the ping URL.
 */
class TestCAPIClientService extends MockCAPIClientService {
	get capiPingURL(): string {
		return 'https://api.github.com/copilot_internal/ping';
	}
}

function createMockInteractionService(): IInteractionService {
	return {
		_serviceBrand: undefined,
		onInteractionStateChanged: Event.None,
		sendChatInteraction: () => { },
		getInteractionState: () => undefined,
	} as unknown as IInteractionService;
}

function createMockEndpoint(): IChatEndpoint {
	return {
		url: 'https://api.github.com/copilot/chat/completions',
		urlOrRequestMetadata: 'https://api.github.com/copilot/chat/completions',
		model: 'test-model',
		modelMaxPromptTokens: 8192,
		maxOutputTokens: 4096,
		supportsToolCalls: true,
		supportsVision: false,
		supportsPrediction: false,
		showInModelPicker: true,
		isDefault: true,
		isFallback: false,
		policy: 'enabled',
		getHeaders: async () => ({}),
		createRequestBody: () => ({
			model: 'test-model',
			messages: [],
			stream: true
		}),
		acquireTokenizer: () => ({
			countMessagesTokens: async () => 100,
			countTokens: async () => 100,
			tokenize: async () => [],
		}),
		processResponseFromChatEndpoint: async (_telemetryService: ITelemetryService, _logService: ILogService, response: Response, _expectedNumChoices: number, finishedCb: FinishedCallback, telemetryData: TelemetryData, _cancellationToken?: CancellationToken) => {
			// Stream the response text through the callback
			const text = await response.text();
			if (finishedCb) {
				await finishedCb(text, 0, { text });
			}
			// Return an async iterable of ChatCompletion objects
			return {
				[Symbol.asyncIterator]: async function* () {
					yield {
						message: { role: Raw.ChatRole.Assistant, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }] },
						choiceIndex: 0,
						requestId: {
							headerRequestId: response.headers.get('x-request-id') || 'test-request-id',
							gitHubRequestId: response.headers.get('x-github-request-id') || '',
							completionId: '',
							created: 0,
							serverExperiments: '',
							deploymentId: '',
						},
						tokens: [],
						usage: undefined,
						model: 'test-model',
						blockFinished: true,
						finishReason: 'stop',
						telemetryData: telemetryData,
					};
				}
			};
		},
		acceptChatPolicy: async () => true,
		doRequest: async () => {
			throw new Error('Not implemented');
		},
	} as unknown as IChatEndpoint;
}

function createMockChatQuotaService(): IChatQuotaService {
	return {
		_serviceBrand: undefined,
		processQuotaHeaders: () => { },
	} as unknown as IChatQuotaService;
}

function createMockConversationOptions() {
	return {
		_serviceBrand: undefined,
		maxResponseTokens: 4096,
		temperature: 0.5,
		topP: 1,
		rejectionMessage: 'rejected',
	};
}

/**
 * Simple FakeHeaders implementation that accepts initial headers.
 */
class FakeHeaders implements IHeaders {
	constructor(private readonly headers = new Map<string, string>()) { }
	get(name: string): string | null {
		return this.headers.get(name.toLowerCase()) ?? null;
	}
	*[Symbol.iterator](): Iterator<[string, string]> {
		yield* this.headers.entries();
	}
}

function createSuccessResponse(content: string): Response {
	const streamContent = `data: {"choices":[{"delta":{"content":"${content}"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n`;
	return Response.fromText(
		200,
		'OK',
		new FakeHeaders(new Map([
			['content-type', 'text/event-stream'],
		])),
		streamContent,
		'node-fetch'
	);
}

function createErrorResponse(status: number, statusText: string): Response {
	return Response.fromText(
		status,
		statusText,
		new FakeHeaders(),
		JSON.stringify({ error: { message: statusText } }),
		'node-fetch'
	);
}

function createNetworkError(code: string): Error & { code: string } {
	const error = new Error(`Network error: ${code}`) as Error & { code: string };
	error.code = code;
	return error;
}
