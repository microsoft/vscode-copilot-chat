/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as vscode from 'vscode';
import { IChatMLFetcher } from '../../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType } from '../../../../platform/chat/common/commonTypes';
import { MockChatMLFetcher } from '../../../../platform/chat/test/common/mockChatMLFetcher';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionTestingServices } from '../../../test/vscode-node/services';
import { CopilotLanguageModelWrapper } from '../languageModelAccess';


suite('CopilotLanguageModelWrapper', () => {
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;

	function createAccessor(vscodeExtensionContext?: IVSCodeExtensionContext) {
		const testingServiceCollection = createExtensionTestingServices();
		testingServiceCollection.define(IChatMLFetcher, new MockChatMLFetcher());

		accessor = testingServiceCollection.createTestingAccessor();
		instaService = accessor.get(IInstantiationService);
	}

	suite('validateRequest - invalid', async () => {
		let wrapper: CopilotLanguageModelWrapper;
		let endpoint: IChatEndpoint;
		setup(async () => {
			createAccessor();
			endpoint = await accessor.get(IEndpointProvider).getChatEndpoint('gpt-4.1');
			wrapper = instaService.createInstance(CopilotLanguageModelWrapper);
		});

		const runTest = async (messages: vscode.LanguageModelChatMessage[], tools?: vscode.LanguageModelChatTool[], errMsg?: string) => {
			await assert.rejects(
				() => wrapper.provideLanguageModelResponse(endpoint, messages, { tools, requestInitiator: 'unknown', toolMode: vscode.LanguageModelChatToolMode.Auto }, vscode.extensions.all[0].id, { report: () => { } }, CancellationToken.None),
				err => {
					errMsg ??= 'Invalid request';
					assert.ok(err instanceof Error, 'expected an Error');
					assert.ok(err.message.includes(errMsg), `expected error to include "${errMsg}", got ${err.message}`);
					return true;
				}
			);
		};

		test('empty', async () => {
			await runTest([]);
		});

		test('bad tool name', async () => {
			await runTest([vscode.LanguageModelChatMessage.User('hello')], [{ name: 'hello world', description: 'my tool' }], 'Invalid tool name');
		});
	});

	suite('validateRequest - valid', async () => {
		let wrapper: CopilotLanguageModelWrapper;
		let endpoint: IChatEndpoint;
		setup(async () => {
			createAccessor();
			endpoint = await accessor.get(IEndpointProvider).getChatEndpoint('gpt-4.1');
			wrapper = instaService.createInstance(CopilotLanguageModelWrapper);
		});
		const runTest = async (messages: vscode.LanguageModelChatMessage[], tools?: vscode.LanguageModelChatTool[]) => {
			await wrapper.provideLanguageModelResponse(endpoint, messages, { tools, requestInitiator: 'unknown', toolMode: vscode.LanguageModelChatToolMode.Auto }, vscode.extensions.all[0].id, { report: () => { } }, CancellationToken.None);
		};

		test('simple', async () => {
			await runTest([vscode.LanguageModelChatMessage.User('hello')]);
		});

		test('tool call and user message', async () => {
			const toolCall = vscode.LanguageModelChatMessage.Assistant('');
			toolCall.content = [new vscode.LanguageModelToolCallPart('id', 'func', { param: 123 })];
			const toolResult = vscode.LanguageModelChatMessage.User('');
			toolResult.content = [new vscode.LanguageModelToolResultPart('id', [new vscode.LanguageModelTextPart('result')])];
			await runTest([toolCall, toolResult, vscode.LanguageModelChatMessage.User('user message')]);
		});

		test('good tool name', async () => {
			await runTest([vscode.LanguageModelChatMessage.User('hello2')], [{ name: 'hello_world', description: 'my tool' }]);
		});
	});

	suite('delta ordering - text before thinking', () => {
		let wrapper: CopilotLanguageModelWrapper;
		let endpoint: IChatEndpoint;

		setup(async () => {
			createAccessor();
			endpoint = await accessor.get(IEndpointProvider).getChatEndpoint('gpt-4.1');
			wrapper = instaService.createInstance(CopilotLanguageModelWrapper);
		});

		test('when delta contains both text and thinking, text is reported first', async () => {
			const reportedParts: Array<{ type: string; value: string }> = [];
			const progress = {
				report: (part: vscode.LanguageModelTextPart | vscode.LanguageModelThinkingPart) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						reportedParts.push({ type: 'text', value: part.value });
					} else if (part instanceof vscode.LanguageModelThinkingPart) {
						const value = Array.isArray(part.value) ? part.value.join('') : part.value;
						reportedParts.push({ type: 'thinking', value });
					}
				}
			};

			// Create a mock endpoint that will call the callback with a delta containing both text and thinking
			const mockEndpoint: IChatEndpoint = {
				...endpoint,
				makeChatRequest: async (_source, _messages, callback, _token, _location, _extra, _options, _userInitiatedRequest, _telemetryProperties) => {
					// Simulate a delta with both text and thinking
					if (callback) {
						await callback('some text', 0, {
							text: 'some text',
							thinking: {
								id: 'thinking-1',
								text: 'some thinking',
								metadata: {}
							}
						});
					}
					return {
						type: ChatFetchResponseType.Success as const,
						requestId: 'test-request-id',
						serverRequestId: 'test-server-request-id',
						usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
						value: 'some text',
						resolvedModel: 'test-model'
					};
				}
			};

			await wrapper.provideLanguageModelResponse(
				mockEndpoint,
				[vscode.LanguageModelChatMessage.User('test')],
				{ requestInitiator: 'unknown', toolMode: vscode.LanguageModelChatToolMode.Auto },
				vscode.extensions.all[0].id,
				progress,
				CancellationToken.None
			);

			// Verify that text was reported before thinking
			assert.strictEqual(reportedParts.length, 2, 'Expected 2 parts to be reported');
			assert.strictEqual(reportedParts[0].type, 'text', 'First part should be text');
			assert.strictEqual(reportedParts[0].value, 'some text', 'Text value should match');
			assert.strictEqual(reportedParts[1].type, 'thinking', 'Second part should be thinking');
			assert.strictEqual(reportedParts[1].value, 'some thinking', 'Thinking value should match');
		});

		test('when delta contains only text, only text is reported', async () => {
			const reportedParts: Array<{ type: string; value: string }> = [];
			const progress = {
				report: (part: vscode.LanguageModelTextPart | vscode.LanguageModelThinkingPart) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						reportedParts.push({ type: 'text', value: part.value });
					} else if (part instanceof vscode.LanguageModelThinkingPart) {
						const value = Array.isArray(part.value) ? part.value.join('') : part.value;
						reportedParts.push({ type: 'thinking', value });
					}
				}
			};

			const mockEndpoint: IChatEndpoint = {
				...endpoint,
				makeChatRequest: async (_source, _messages, callback, _token, _location, _extra, _options, _userInitiatedRequest, _telemetryProperties) => {
					if (callback) {
						await callback('only text', 0, { text: 'only text' });
					}
					return {
						type: ChatFetchResponseType.Success as const,
						requestId: 'test-request-id',
						serverRequestId: 'test-server-request-id',
						usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
						value: 'only text',
						resolvedModel: 'test-model'
					};
				}
			};

			await wrapper.provideLanguageModelResponse(
				mockEndpoint,
				[vscode.LanguageModelChatMessage.User('test')],
				{ requestInitiator: 'unknown', toolMode: vscode.LanguageModelChatToolMode.Auto },
				vscode.extensions.all[0].id,
				progress,
				CancellationToken.None
			);

			assert.strictEqual(reportedParts.length, 1, 'Expected 1 part to be reported');
			assert.strictEqual(reportedParts[0].type, 'text', 'Part should be text');
			assert.strictEqual(reportedParts[0].value, 'only text', 'Text value should match');
		});

		test('when delta contains only thinking, only thinking is reported', async () => {
			const reportedParts: Array<{ type: string; value: string }> = [];
			const progress = {
				report: (part: vscode.LanguageModelTextPart | vscode.LanguageModelThinkingPart) => {
					if (part instanceof vscode.LanguageModelTextPart) {
						reportedParts.push({ type: 'text', value: part.value });
					} else if (part instanceof vscode.LanguageModelThinkingPart) {
						const value = Array.isArray(part.value) ? part.value.join('') : part.value;
						reportedParts.push({ type: 'thinking', value });
					}
				}
			};

			const mockEndpoint: IChatEndpoint = {
				...endpoint,
				makeChatRequest: async (_source, _messages, callback, _token, _location, _extra, _options, _userInitiatedRequest, _telemetryProperties) => {
					if (callback) {
						await callback('', 0, {
							text: '',
							thinking: {
								id: 'thinking-1',
								text: 'only thinking',
								metadata: {}
							}
						});
					}
					return {
						type: ChatFetchResponseType.Success as const,
						requestId: 'test-request-id',
						serverRequestId: 'test-server-request-id',
						usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
						value: '',
						resolvedModel: 'test-model'
					};
				}
			};

			await wrapper.provideLanguageModelResponse(
				mockEndpoint,
				[vscode.LanguageModelChatMessage.User('test')],
				{ requestInitiator: 'unknown', toolMode: vscode.LanguageModelChatToolMode.Auto },
				vscode.extensions.all[0].id,
				progress,
				CancellationToken.None
			);

			assert.strictEqual(reportedParts.length, 1, 'Expected 1 part to be reported');
			assert.strictEqual(reportedParts[0].type, 'thinking', 'Part should be thinking');
			assert.strictEqual(reportedParts[0].value, 'only thinking', 'Thinking value should match');
		});
	});
});
