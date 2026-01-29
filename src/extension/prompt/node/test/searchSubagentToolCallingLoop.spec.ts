/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { Conversation, Turn } from '../../common/conversation';
import { ISearchSubagentToolCallingLoopOptions, SearchSubagentToolCallingLoop } from '../searchSubagentToolCallingLoop';

describe('SearchSubagentToolCallingLoop', () => {
	let store: DisposableStore;
	let instantiationService: IInstantiationService;
	let endpointProvider: IEndpointProvider;
	let mockEndpoint: IChatEndpoint;

	beforeEach(() => {
		store = new DisposableStore();

		// Create testing services
		const serviceCollection = store.add(createExtensionUnitTestingServices(store));
		const accessor = serviceCollection.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		
		// Create mock endpoint that simulates Gemini 3 Pro with supportsToolCalls = false
		mockEndpoint = {
			family: 'gemini',
			model: 'gemini-3-pro-preview',
			name: 'Gemini 3 Pro',
			version: '1.0',
			maxOutputTokens: 8192,
			modelMaxPromptTokens: 100000,
			supportsToolCalls: false, // This simulates the bug scenario
			supportsVision: true,
			supportsPrediction: false,
			showInModelPicker: true,
			urlOrRequestMetadata: 'https://test-endpoint',
			tokenizer: 0,
			isDefault: false,
			isFallback: false,
			isPremium: false,
			multiplier: 1,
		} as IChatEndpoint;

		// Get and override the endpoint provider to return our mock endpoint
		endpointProvider = accessor.get(IEndpointProvider);
		endpointProvider.getChatEndpoint = vi.fn(async (_requestOrModel: any) => {
			// Always return the same endpoint - this ensures we don't fallback to GPT-4.1
			return mockEndpoint;
		});
	});

	it('should use the requested model even when supportsToolCalls is false', async () => {
		// Arrange
		const options: ISearchSubagentToolCallingLoopOptions = {
			toolCallLimit: 4,
			conversation: new Conversation('test-session', [
				new Turn('turn-1', { type: 'user', message: 'test query' })
			]),
			request: {} as any,
			location: 7 as any, // ChatLocation.Panel
			promptText: 'test query',
		};

		const loop = instantiationService.createInstance(SearchSubagentToolCallingLoop, options);

		// Act - call the private getEndpoint method via reflection to test the behavior
		const getEndpoint = (loop as any).getEndpoint.bind(loop);
		const endpoint = await getEndpoint(options.request);

		// Assert
		// The endpoint should be our mock Gemini endpoint, not GPT-4.1
		expect(endpoint.model).toBe('gemini-3-pro-preview');
		expect(endpoint.family).toBe('gemini');

		// Verify that getChatEndpoint was called with the original request
		expect(endpointProvider.getChatEndpoint).toHaveBeenCalledWith(options.request);

		// Verify that it was NOT called with 'gpt-4.1' (the old fallback behavior)
		const calls = (endpointProvider.getChatEndpoint as any).mock.calls;
		expect(calls.every((call: any) => call[0] !== 'gpt-4.1')).toBe(true);
	});

	it('should use the requested model with supportsToolCalls true', async () => {
		// Arrange - Update mock endpoint to support tool calls
		mockEndpoint.supportsToolCalls = true;

		const options: ISearchSubagentToolCallingLoopOptions = {
			toolCallLimit: 4,
			conversation: new Conversation('test-session', [
				new Turn('turn-1', { type: 'user', message: 'test query' })
			]),
			request: {} as any,
			location: 7 as any, // ChatLocation.Panel
			promptText: 'test query',
		};

		const loop = instantiationService.createInstance(SearchSubagentToolCallingLoop, options);

		// Act
		const getEndpoint = (loop as any).getEndpoint.bind(loop);
		const endpoint = await getEndpoint(options.request);

		// Assert
		expect(endpoint.model).toBe('gemini-3-pro-preview');
		expect(endpoint.family).toBe('gemini');
		expect(endpoint.supportsToolCalls).toBe(true);
	});
});
