/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { MockChatResponseStream, TestChatContext } from '../../../test/node/testHelpers';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { GrowthChatSessionProvider, GrowthSessionUri } from '../growthChatSessionProvider';

describe('GrowthChatSessionProvider', () => {
	const store = new DisposableStore();
	let provider: GrowthChatSessionProvider;

	beforeEach(() => {
		const serviceCollection = store.add(createExtensionUnitTestingServices(store));
		const accessor = serviceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		provider = store.add(instantiationService.createInstance(GrowthChatSessionProvider));
	});

	afterEach(() => {
		store.clear();
	});

	it('should create a growth chat session provider', () => {
		expect(provider).toBeDefined();
	});

	it('should create handler', () => {
		const handler = provider.createHandler();
		expect(handler).toBeDefined();
		expect(typeof handler).toBe('function');
	});

	it('should return NeedsInput status initially', async () => {
		const items = await provider.provideChatSessionItems(CancellationToken.None);
		expect(items).toHaveLength(1);
		expect(items[0].status).toBe(vscode.ChatSessionStatus.NeedsInput);
		expect(items[0].label).toBe('Try Copilot');
	});

	it('should transition to Completed after opening content', async () => {
		const resource = GrowthSessionUri.forSessionId(GrowthChatSessionProvider.sessionId);
		await provider.provideChatSessionContent(resource, CancellationToken.None);

		const items = await provider.provideChatSessionItems(CancellationToken.None);
		expect(items[0].status).toBe(vscode.ChatSessionStatus.Completed);
	});

	it('should fire onDidChangeChatSessionItems when marked seen', async () => {
		const listener = vi.fn();
		store.add(provider.onDidChangeChatSessionItems(listener));

		const resource = GrowthSessionUri.forSessionId(GrowthChatSessionProvider.sessionId);
		await provider.provideChatSessionContent(resource, CancellationToken.None);

		expect(listener).toHaveBeenCalledOnce();
	});

	it('should not fire onDidChangeChatSessionItems on second open', async () => {
		const resource = GrowthSessionUri.forSessionId(GrowthChatSessionProvider.sessionId);
		await provider.provideChatSessionContent(resource, CancellationToken.None);

		const listener = vi.fn();
		store.add(provider.onDidChangeChatSessionItems(listener));
		await provider.provideChatSessionContent(resource, CancellationToken.None);

		expect(listener).not.toHaveBeenCalled();
	});

	it('should return empty history for unknown session ids', async () => {
		const resource = GrowthSessionUri.forSessionId('unknown-session');
		const session = await provider.provideChatSessionContent(resource, CancellationToken.None);
		expect(session.history).toHaveLength(0);
	});

	it('should return pre-seeded history for growth-tip session', async () => {
		const resource = GrowthSessionUri.forSessionId(GrowthChatSessionProvider.sessionId);
		const session = await provider.provideChatSessionContent(resource, CancellationToken.None);
		expect(session.history).toHaveLength(2);
	});

	it('handler should stream a Copilot tip', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic tip selection
		const stream = new MockChatResponseStream();
		const handler = provider.createHandler();

		await handler(
			{ prompt: 'hello' } as vscode.ChatRequest,
			new TestChatContext(),
			stream as unknown as vscode.ChatResponseStream,
			CancellationToken.None,
		);

		expect(stream.output).toHaveLength(1);
		expect(stream.output[0]).toContain('Inline suggestions');
		expect(stream.output[0]).toContain('Send a message to get another GitHub Copilot tip.');
	});
});
