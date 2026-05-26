/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRequest, LanguageModelChat, LanguageModelToolInformation } from 'vscode';
import { ChatFetchResponseType, ChatResponse } from '../../../../platform/chat/common/commonTypes';
import { toTextPart } from '../../../../platform/chat/common/globalStringUtils';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { IChatEndpoint, IEmbeddingsEndpoint } from '../../../../platform/networking/common/networking';
import { GenAiAttr, GenAiOperationName } from '../../../../platform/otel/common/genAiAttributes';
import { IOTelService } from '../../../../platform/otel/common/otelService';
import { CapturingOTelService } from '../../../../platform/otel/common/test/capturingOTelService';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { Conversation, Turn } from '../../../prompt/common/conversation';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { IBuildPromptResult, nullRenderPromptResult } from '../../../prompt/node/intents';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { IToolCallingLoopOptions, ToolCallingLoop } from '../../node/toolCallingLoop';

class MockEndpointProvider implements IEndpointProvider {
	declare readonly _serviceBrand: undefined;
	readonly onDidModelsRefresh = Event.None;

	async getAllCompletionModels() { return []; }
	async getAllChatEndpoints() { return [this._createEndpoint()]; }
	async getChatEndpoint() { return this._createEndpoint(); }
	async getEmbeddingsEndpoint(): Promise<IEmbeddingsEndpoint> { throw new Error('Not implemented'); }

	private _createEndpoint(): IChatEndpoint {
		return {
			model: 'gpt-4o',
			modelProvider: 'github',
			family: 'gpt-4o',
			name: 'test-endpoint',
			version: '1.0',
			maxOutputTokens: 4096,
			modelMaxPromptTokens: 128000,
			supportsToolCalls: true,
			supportsVision: false,
			supportsPrediction: false,
			showInModelPicker: true,
			isDefault: true,
			isFallback: false,
			policy: 'enabled' as const,
			urlOrRequestMetadata: 'mock://endpoint',
			tokenizer: 'cl100k_base',
			acquireTokenizer: () => ({
				countMessagesTokens: async () => 100,
				countMessageTokens: async () => 10,
				countToolTokens: async () => 50,
				encode: () => [],
				free: () => { },
			}),
		} as unknown as IChatEndpoint;
	}
}

/**
 * Integration tests that exercise the real ToolCallingLoop code path to verify
 * content attributes are properly gated behind captureContent.
 *
 * Unlike the original contentGating.spec.ts (which duplicated the if-check inline),
 * these tests call through ToolCallingLoop.run() so they will fail if the
 * captureContent guards are removed from the production code.
 */

class ContentGatingTestToolCallingLoop extends ToolCallingLoop<IToolCallingLoopOptions> {
	protected override async buildPrompt(_buildPromptContext: IBuildPromptContext): Promise<IBuildPromptResult> {
		return {
			...nullRenderPromptResult(),
			messages: [{ role: Raw.ChatRole.User, content: [toTextPart('fix my code')] }],
		};
	}

	protected override async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		return [
			{ name: 'readFile', description: 'Read a file from the workspace', inputSchema: {}, tags: [], source: undefined },
			{ name: 'writeFile', description: 'Write content to a file', inputSchema: {}, tags: [], source: undefined },
		];
	}

	protected override async fetch(): Promise<ChatResponse> {
		return {
			type: ChatFetchResponseType.Success,
			value: 'Here is the fix for your code.',
			requestId: 'req-123',
			serverRequestId: undefined,
			usage: {
				prompt_tokens: 50,
				completion_tokens: 10,
				total_tokens: 60,
			},
			resolvedModel: 'gpt-4o',
		};
	}
}

const chatPanelLocation: ChatRequest['location'] = 1;

function createMockChatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
	return {
		prompt: 'fix my code',
		command: undefined,
		references: [],
		location: chatPanelLocation,
		location2: undefined,
		attempt: 0,
		enableCommandDetection: false,
		isParticipantDetected: false,
		toolReferences: [],
		toolInvocationToken: {} as ChatRequest['toolInvocationToken'],
		model: { family: 'test' } as LanguageModelChat,
		tools: new Map(),
		id: generateUuid(),
		sessionId: generateUuid(),
		sessionResource: {} as ChatRequest['sessionResource'],
		hasHooksEnabled: false,
		...overrides,
	} satisfies ChatRequest;
}

function createConversation(prompt: string): Conversation {
	return new Conversation(generateUuid(), [
		new Turn(generateUuid(), { type: 'user', message: prompt }),
	]);
}

describe('ToolCallingLoop content gating (integration)', () => {
	let disposables: DisposableStore;
	let tokenSource: CancellationTokenSource;

	beforeEach(() => {
		disposables = new DisposableStore();
		tokenSource = new CancellationTokenSource();
		disposables.add(tokenSource);
	});

	afterEach(() => {
		disposables.dispose();
	});

	function createLoopWithOTel(captureContent: boolean) {
		const otel = new CapturingOTelService({ captureContent });
		const serviceCollection = disposables.add(createExtensionUnitTestingServices());
		serviceCollection.define(IOTelService, otel);
		serviceCollection.define(IEndpointProvider, new MockEndpointProvider());
		const accessor = serviceCollection.createTestingAccessor();
		disposables.add(accessor);
		const instantiationService = accessor.get(IInstantiationService);

		const request = createMockChatRequest();
		const loop = instantiationService.createInstance(
			ContentGatingTestToolCallingLoop,
			{
				conversation: createConversation(request.prompt),
				toolCallLimit: 1,
				request,
			},
		);
		disposables.add(loop);
		return { otel, loop };
	}

	it('does NOT set content attributes on agent span when captureContent is false', async () => {
		const { otel, loop } = createLoopWithOTel(false);

		await loop.run(undefined, tokenSource.token);

		const agentSpan = otel.findSpans('invoke_agent')[0];
		expect(agentSpan).toBeDefined();

		// Content attributes must NOT be set
		expect(agentSpan.attributes[GenAiAttr.INPUT_MESSAGES]).toBeUndefined();
		expect(agentSpan.attributes[GenAiAttr.OUTPUT_MESSAGES]).toBeUndefined();
		expect(agentSpan.attributes[GenAiAttr.TOOL_DEFINITIONS]).toBeUndefined();
		expect(agentSpan.events.filter(e => e.name === 'user_message')).toHaveLength(0);

		// Non-content attributes should still be set
		expect(agentSpan.attributes[GenAiAttr.AGENT_NAME]).toBeDefined();
		expect(agentSpan.attributes[GenAiAttr.OPERATION_NAME]).toBe(GenAiOperationName.INVOKE_AGENT);
	});

	it('sets content attributes on agent span when captureContent is true', async () => {
		const { otel, loop } = createLoopWithOTel(true);

		await loop.run(undefined, tokenSource.token);

		const agentSpan = otel.findSpans('invoke_agent')[0];
		expect(agentSpan).toBeDefined();

		// Content attributes must be set
		expect(agentSpan.attributes[GenAiAttr.INPUT_MESSAGES]).toBeDefined();
		expect(agentSpan.attributes[GenAiAttr.OUTPUT_MESSAGES]).toBeDefined();
		expect(agentSpan.attributes[GenAiAttr.TOOL_DEFINITIONS]).toBeDefined();

		// user_message event should be emitted
		const userMessageEvents = agentSpan.events.filter(e => e.name === 'user_message');
		expect(userMessageEvents).toHaveLength(1);
	});

	it('INPUT_MESSAGES contains the user prompt when captureContent is true', async () => {
		const { otel, loop } = createLoopWithOTel(true);

		await loop.run(undefined, tokenSource.token);

		const agentSpan = otel.findSpans('invoke_agent')[0];
		const inputMessages = agentSpan.attributes[GenAiAttr.INPUT_MESSAGES] as string;
		expect(inputMessages).toContain('fix my code');
	});

	it('OUTPUT_MESSAGES contains the response text when captureContent is true', async () => {
		const { otel, loop } = createLoopWithOTel(true);

		await loop.run(undefined, tokenSource.token);

		const agentSpan = otel.findSpans('invoke_agent')[0];
		const outputMessages = agentSpan.attributes[GenAiAttr.OUTPUT_MESSAGES] as string;
		expect(outputMessages).toContain('Here is the fix for your code.');
	});

	it('TOOL_DEFINITIONS contains the available tools when captureContent is true', async () => {
		const { otel, loop } = createLoopWithOTel(true);

		await loop.run(undefined, tokenSource.token);

		const agentSpan = otel.findSpans('invoke_agent')[0];
		const toolDefs = agentSpan.attributes[GenAiAttr.TOOL_DEFINITIONS] as string;
		expect(toolDefs).toContain('readFile');
		expect(toolDefs).toContain('writeFile');
	});

	it('user_message event content matches user prompt when captureContent is true', async () => {
		const { otel, loop } = createLoopWithOTel(true);

		await loop.run(undefined, tokenSource.token);

		const agentSpan = otel.findSpans('invoke_agent')[0];
		const userMessageEvent = agentSpan.events.find(e => e.name === 'user_message');
		expect(userMessageEvent?.attributes?.content).toBe('fix my code');
	});
});
