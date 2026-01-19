/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MetadataMap, Raw } from '@vscode/prompt-tsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponseProgressPart, ChatResponseReferencePart, ChatResponseStream, LanguageModelToolInformation, Progress } from 'vscode';
import { IChatMLFetcher } from '../../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType, ChatLocation, ChatResponse } from '../../../../platform/chat/common/commonTypes';
import { StaticChatMLFetcher } from '../../../../platform/chat/test/common/staticChatMLFetcher';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { MockEndpoint } from '../../../../platform/endpoint/test/node/mockEndpoint';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { ChatResponseStreamImpl } from '../../../../util/common/chatResponseStreamImpl';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { Conversation, Turn } from '../../../prompt/common/conversation';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { IBuildPromptResult } from '../../../prompt/node/intents';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../toolCallingLoop';

/**
 * Test implementation of ToolCallingLoop for testing endpoint caching
 */
class TestToolCallingLoop extends ToolCallingLoop {
	public buildPromptCallCount = 0;
	public getAvailableToolsCallCount = 0;

	protected async buildPrompt(
		_buildPromptContext: IBuildPromptContext,
		_progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>,
		_token: import('../../../../util/vs/base/common/cancellation').CancellationToken
	): Promise<IBuildPromptResult> {
		this.buildPromptCallCount++;
		return {
			messages: [
				{ role: Raw.ChatRole.User, content: 'test message' }
			],
			references: [],
			omittedReferences: [],
			metadata: new MetadataMap(),
		};
	}

	protected async getAvailableTools(
		_outputStream: ChatResponseStream | undefined,
		_token: import('../../../../util/vs/base/common/cancellation').CancellationToken
	): Promise<LanguageModelToolInformation[]> {
		this.getAvailableToolsCallCount++;
		return [];
	}

	protected async fetch(
		_options: ToolCallingLoopFetchOptions,
		_token: import('../../../../util/vs/base/common/cancellation').CancellationToken
	): Promise<ChatResponse> {
		// Return a simple success response with no tool calls to end the loop
		return {
			type: ChatFetchResponseType.Success,
			response: 'test response',
			modelUsed: 'test-model',
			modelFamily: 'test-family',
		};
	}
}

describe('ToolCallingLoop endpoint caching', () => {
	let accessor: ITestingServicesAccessor;
	let mockEndpoint: IChatEndpoint;
	let mockEndpointProvider: IEndpointProvider;
	let getChatEndpointSpy: ReturnType<typeof vi.fn>;
	let conversation: Conversation;
	let request: ChatRequest;

	beforeEach(async () => {
		const services = createExtensionUnitTestingServices();
		services.define(IChatMLFetcher, new StaticChatMLFetcher([]));
		accessor = services.createTestingAccessor();

		// Create a mock endpoint
		mockEndpoint = accessor.get(IInstantiationService).createInstance(MockEndpoint, undefined);

		// Create a spy for getChatEndpoint
		getChatEndpointSpy = vi.fn().mockResolvedValue(mockEndpoint);

		// Create a mock endpoint provider
		mockEndpointProvider = {
			_serviceBrand: undefined,
			getChatEndpoint: getChatEndpointSpy,
		} as unknown as IEndpointProvider;

		// Create a test conversation and request
		const sessionId = 'test-session-id';
		const turn = new Turn('turn-1', {
			message: 'test message',
			command: undefined,
			references: [],
			location: ChatLocation.Panel,
			enableCommandDetection: false,
			toolInvocationToken: { sessionId } as any,
		} as any);
		conversation = new Conversation(sessionId, [turn]);

		request = {
			prompt: 'test prompt',
			location: ChatLocation.Panel,
			toolInvocationToken: { sessionId } as any,
			toolReferences: [],
		} as ChatRequest;
	});

	afterEach(() => {
		accessor.dispose();
	});

	it('should resolve endpoint only once per turn, not per iteration', async () => {
		// Create a tool calling loop that will run multiple iterations
		const loopOptions: IToolCallingLoopOptions = {
			conversation,
			request,
			toolCallLimit: 5,
		};

		const loop = accessor.get(IInstantiationService).createInstance(
			TestToolCallingLoop,
			loopOptions
		);

		// Override the endpoint provider with our mock
		(loop as any)._endpointProvider = mockEndpointProvider;

		// Create a response stream
		const stream = new ChatResponseStreamImpl();

		// Run the loop (will run one iteration since fetch returns no tool calls)
		await loop.run(stream, CancellationToken.None);

		// Verify getChatEndpoint was called exactly once
		expect(getChatEndpointSpy).toHaveBeenCalledTimes(1);
		expect(getChatEndpointSpy).toHaveBeenCalledWith(request);
	});

	it('should resolve endpoint only once even with multiple tool call iterations', async () => {
		// Create a custom loop that forces multiple iterations
		class MultiIterationLoop extends TestToolCallingLoop {
			private iterationCount = 0;

			protected override async fetch(
				_options: ToolCallingLoopFetchOptions,
				_token: import('../../../../util/vs/base/common/cancellation').CancellationToken
			): Promise<ChatResponse> {
				this.iterationCount++;
				// Return tool calls for first 2 iterations, then return success
				if (this.iterationCount < 3) {
					return {
						type: ChatFetchResponseType.Success,
						response: 'test response with tool call',
						modelUsed: 'test-model',
						modelFamily: 'test-family',
						toolCalls: [{
							id: `tool-${this.iterationCount}`,
							name: 'test_tool',
							input: {}
						}]
					};
				}
				return {
					type: ChatFetchResponseType.Success,
					response: 'final response',
					modelUsed: 'test-model',
					modelFamily: 'test-family',
				};
			}
		}

		const loopOptions: IToolCallingLoopOptions = {
			conversation,
			request,
			toolCallLimit: 5,
		};

		const loop = accessor.get(IInstantiationService).createInstance(
			MultiIterationLoop,
			loopOptions
		);

		// Override the endpoint provider with our mock
		(loop as any)._endpointProvider = mockEndpointProvider;

		const stream = new ChatResponseStreamImpl();

		// Run the loop (will run 3 iterations)
		await loop.run(stream, CancellationToken.None);

		// Verify getChatEndpoint was called exactly once despite multiple iterations
		expect(getChatEndpointSpy).toHaveBeenCalledTimes(1);
		expect(getChatEndpointSpy).toHaveBeenCalledWith(request);

		// Verify that buildPrompt was called 3 times (once per iteration)
		expect(loop.buildPromptCallCount).toBe(3);
	});

	it('should clear cached endpoint after turn completes', async () => {
		const loopOptions: IToolCallingLoopOptions = {
			conversation,
			request,
			toolCallLimit: 5,
		};

		const loop = accessor.get(IInstantiationService).createInstance(
			TestToolCallingLoop,
			loopOptions
		);

		// Override the endpoint provider with our mock
		(loop as any)._endpointProvider = mockEndpointProvider;

		const stream = new ChatResponseStreamImpl();

		// Run the loop
		await loop.run(stream, CancellationToken.None);

		// Verify the cached endpoint is cleared
		expect((loop as any)._cachedEndpointForTurn).toBeUndefined();

		// Run again with a new turn
		getChatEndpointSpy.mockClear();
		await loop.run(stream, CancellationToken.None);

		// Verify getChatEndpoint was called again for the new turn
		expect(getChatEndpointSpy).toHaveBeenCalledTimes(1);
	});
});
