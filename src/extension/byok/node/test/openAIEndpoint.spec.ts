/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { beforeEach, describe, expect, it } from 'vitest';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IChatMLFetcher } from '../../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../../platform/endpoint/common/domainService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { ICreateEndpointBodyOptions } from '../../../../platform/networking/common/networking';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { ITokenizerProvider } from '../../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from '../openAIEndpoint';

// Test fixtures for thinking content
const createThinkingMessage = (thinkingId: string, thinkingText: string): Raw.ChatMessage => ({
	role: Raw.ChatRole.Assistant,
	content: [
		{
			type: Raw.ChatCompletionContentPartKind.Opaque,
			value: {
				type: 'thinking',
				thinking: {
					id: thinkingId,
					text: thinkingText
				}
			}
		}
	]
});

const createTestOptions = (messages: Raw.ChatMessage[]): ICreateEndpointBodyOptions => ({
	debugName: 'test',
	messages,
	requestId: 'test-req-123',
	postOptions: {},
	finishedCb: undefined,
	location: undefined as any
});

// Mock implementations
const createMockServices = (useResponsesApi = false) => ({
	fetcherService: {} as IFetcherService,
	domainService: {} as IDomainService,
	capiClientService: {} as ICAPIClientService,
	envService: {} as IEnvService,
	telemetryService: {} as ITelemetryService,
	authService: {} as IAuthenticationService,
	chatMLFetcher: {} as IChatMLFetcher,
	tokenizerProvider: {} as ITokenizerProvider,
	instantiationService: {
		createInstance: (ctor: any, ...args: any[]) => new ctor(...args)
	} as IInstantiationService,
	configurationService: {
		getExperimentBasedConfig: () => useResponsesApi
	} as unknown as IConfigurationService,
	expService: {} as IExperimentationService,
	logService: {} as ILogService
});

describe('OpenAIEndpoint - Reasoning Properties', () => {
	let modelMetadata: IChatModelInformation;

	beforeEach(() => {
		modelMetadata = {
			id: 'test-model',
			name: 'Test Model',
			version: '1.0',
			model_picker_enabled: true,
			is_chat_default: false,
			is_chat_fallback: false,
			supported_endpoints: [ModelSupportedEndpoint.ChatCompletions, ModelSupportedEndpoint.Responses],
			capabilities: {
				type: 'chat',
				family: 'openai',
				tokenizer: 'o200k_base' as any,
				supports: {
					parallel_tool_calls: false,
					streaming: true,
					tool_calls: false,
					vision: false,
					prediction: false,
					thinking: true
				},
				limits: {
					max_prompt_tokens: 4096,
					max_output_tokens: 2048,
					max_context_window_tokens: 6144
				}
			}
		};
	});

	describe('CAPI mode (useResponsesApi = false)', () => {
		it('should set cot_id and cot_summary properties when processing thinking content', () => {
			const mockServices = createMockServices(false); // CAPI mode
			const endpoint = new OpenAIEndpoint(
				modelMetadata,
				'test-api-key',
				'https://api.openai.com/v1/chat/completions',
				mockServices.fetcherService,
				mockServices.domainService,
				mockServices.capiClientService,
				mockServices.envService,
				mockServices.telemetryService,
				mockServices.authService,
				mockServices.chatMLFetcher,
				mockServices.tokenizerProvider,
				mockServices.instantiationService,
				mockServices.configurationService,
				mockServices.expService,
				mockServices.logService
			);

			const thinkingMessage = createThinkingMessage('test-thinking-123', 'this is my reasoning');
			const options = createTestOptions([thinkingMessage]);

			const body = endpoint.createRequestBody(options);

			expect(body.messages).toBeDefined();
			const messages = body.messages as any[];
			expect(messages).toHaveLength(1);
			expect(messages[0].cot_id).toBe('test-thinking-123');
			expect(messages[0].cot_summary).toBe('this is my reasoning');
		});

		it('should handle multiple messages with thinking content', () => {
			const mockServices = createMockServices(false); // CAPI mode
			const endpoint = new OpenAIEndpoint(
				modelMetadata,
				'test-api-key',
				'https://api.openai.com/v1/chat/completions',
				mockServices.fetcherService,
				mockServices.domainService,
				mockServices.capiClientService,
				mockServices.envService,
				mockServices.telemetryService,
				mockServices.authService,
				mockServices.chatMLFetcher,
				mockServices.tokenizerProvider,
				mockServices.instantiationService,
				mockServices.configurationService,
				mockServices.expService,
				mockServices.logService
			);

			const userMessage: Raw.ChatMessage = {
				role: Raw.ChatRole.User,
				content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }]
			};
			const thinkingMessage = createThinkingMessage('reasoning-456', 'complex reasoning here');
			const options = createTestOptions([userMessage, thinkingMessage]);

			const body = endpoint.createRequestBody(options);

			expect(body.messages).toBeDefined();
			const messages = body.messages as any[];
			expect(messages).toHaveLength(2);

			// User message should not have thinking properties
			expect(messages[0].cot_id).toBeUndefined();
			expect(messages[0].cot_summary).toBeUndefined();

			// Assistant message should have thinking properties
			expect(messages[1].cot_id).toBe('reasoning-456');
			expect(messages[1].cot_summary).toBe('complex reasoning here');
		});
	});

	describe('Responses API mode (useResponsesApi = true)', () => {
		it('should preserve reasoning object when thinking is supported', () => {
			const mockServices = createMockServices(true); // Responses API mode
			const endpoint = new OpenAIEndpoint(
				modelMetadata,
				'test-api-key',
				'https://api.openai.com/v1/chat/completions',
				mockServices.fetcherService,
				mockServices.domainService,
				mockServices.capiClientService,
				mockServices.envService,
				mockServices.telemetryService,
				mockServices.authService,
				mockServices.chatMLFetcher,
				mockServices.tokenizerProvider,
				mockServices.instantiationService,
				mockServices.configurationService,
				mockServices.expService,
				mockServices.logService
			);

			const thinkingMessage = createThinkingMessage('resp-api-789', 'responses api reasoning');
			const options = createTestOptions([thinkingMessage]);

			const body = endpoint.createRequestBody(options);

			expect(body.store).toBe(true);
			expect(body.n).toBeUndefined();
			expect(body.stream_options).toBeUndefined();
			expect(body.reasoning).toBeDefined(); // Should preserve reasoning object
		});

		it('should remove reasoning object when thinking is not supported', () => {
			const modelWithoutThinking = {
				...modelMetadata,
				capabilities: {
					...modelMetadata.capabilities,
					supports: {
						...modelMetadata.capabilities.supports,
						thinking: false
					}
				}
			};

			const mockServices = createMockServices(true); // Responses API mode
			const endpoint = new OpenAIEndpoint(
				modelWithoutThinking,
				'test-api-key',
				'https://api.openai.com/v1/chat/completions',
				mockServices.fetcherService,
				mockServices.domainService,
				mockServices.capiClientService,
				mockServices.envService,
				mockServices.telemetryService,
				mockServices.authService,
				mockServices.chatMLFetcher,
				mockServices.tokenizerProvider,
				mockServices.instantiationService,
				mockServices.configurationService,
				mockServices.expService,
				mockServices.logService
			);

			const thinkingMessage = createThinkingMessage('no-thinking-999', 'should be removed');
			const options = createTestOptions([thinkingMessage]);

			const body = endpoint.createRequestBody(options);

			expect(body.reasoning).toBeUndefined(); // Should be removed
		});
	});
});