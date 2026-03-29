/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test, beforeEach, afterEach, expect, vi } from 'vitest';
import { Emitter } from '../../../util/vs/base/common/event';
import { IChatSessionService } from '../../../platform/chat/common/chatSessionService';
import { ConversationStore } from './conversationStore';
import { Conversation, Turn } from '../../prompt/common/conversation';

function createConversation(sessionId: string): Conversation {
	return new Conversation(sessionId, [new Turn('turn-1', { message: 'test', type: 'user' })]);
}

describe('ConversationStore', () => {
	let disposeChatSession: Emitter<string>;
	let store: ConversationStore;

	beforeEach(() => {
		vi.useFakeTimers();
		disposeChatSession = new Emitter<string>();
		const chatSessionService: IChatSessionService = {
			_serviceBrand: undefined,
			onDidDisposeChatSession: disposeChatSession.event,
		};
		store = new ConversationStore(chatSessionService);
	});

	afterEach(() => {
		store.dispose();
		disposeChatSession.dispose();
		vi.useRealTimers();
	});

	test('basic add and get', () => {
		const conv = createConversation('session-1');
		store.addConversation('resp-1', conv);
		expect(store.getConversation('resp-1')).toBe(conv);
		expect(store.lastConversation).toBe(conv);
	});

	test('cleans up session conversations after timeout', () => {
		const conv = createConversation('session-1');
		store.addConversation('resp-1', conv);

		disposeChatSession.fire('session-1');
		expect(store.getConversation('resp-1')).toBe(conv);

		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(store.getConversation('resp-1')).toBeUndefined();
	});

	test('accessing conversation resets cleanup timer', () => {
		const conv = createConversation('session-1');
		store.addConversation('resp-1', conv);

		disposeChatSession.fire('session-1');

		// Advance 7 minutes, then access — should reset the timer
		vi.advanceTimersByTime(7 * 60 * 1000);
		expect(store.getConversation('resp-1')).toBe(conv);

		// Advance another 7 minutes — less than 10 from last access, should still exist
		vi.advanceTimersByTime(7 * 60 * 1000);
		expect(store.getConversation('resp-1')).toBe(conv);

		// Advance past the full 10-minute window without access
		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(store.getConversation('resp-1')).toBeUndefined();
	});

	test('accessing lastConversation resets cleanup timer', () => {
		const conv = createConversation('session-1');
		store.addConversation('resp-1', conv);

		disposeChatSession.fire('session-1');

		vi.advanceTimersByTime(7 * 60 * 1000);
		expect(store.lastConversation).toBe(conv);

		vi.advanceTimersByTime(7 * 60 * 1000);
		expect(store.lastConversation).toBe(conv);

		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(store.lastConversation).toBeUndefined();
	});

	test('adding conversation for pending-cleanup session resets timer', () => {
		const conv1 = createConversation('session-1');
		store.addConversation('resp-1', conv1);

		disposeChatSession.fire('session-1');
		vi.advanceTimersByTime(7 * 60 * 1000);

		// Late write for the same session — should reset the 10-minute timer
		const conv2 = createConversation('session-1');
		store.addConversation('resp-2', conv2);

		// Advance 9 minutes from late write — not yet 10 minutes, should survive
		vi.advanceTimersByTime(9 * 60 * 1000);
		expect(store.getConversation('resp-2')).toBe(conv2);

		// Now pass the full 10 minutes from the access above (which also resets the timer)
		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(store.getConversation('resp-1')).toBeUndefined();
		expect(store.getConversation('resp-2')).toBeUndefined();
	});

	test('does not clean up sessions that were not disposed', () => {
		const conv = createConversation('session-1');
		store.addConversation('resp-1', conv);

		vi.advanceTimersByTime(30 * 60 * 1000);
		expect(store.getConversation('resp-1')).toBe(conv);
	});

	test('only cleans up the disposed session, not others', () => {
		const conv1 = createConversation('session-1');
		const conv2 = createConversation('session-2');
		store.addConversation('resp-1', conv1);
		store.addConversation('resp-2', conv2);

		disposeChatSession.fire('session-1');
		vi.advanceTimersByTime(10 * 60 * 1000);

		expect(store.getConversation('resp-1')).toBeUndefined();
		expect(store.getConversation('resp-2')).toBe(conv2);
	});

	test('late write after cleanup already ran still gets cleaned up', () => {
		const conv1 = createConversation('session-1');
		store.addConversation('resp-1', conv1);

		disposeChatSession.fire('session-1');
		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(store.getConversation('resp-1')).toBeUndefined();

		// Late write after cleanup already ran
		const conv2 = createConversation('session-1');
		store.addConversation('resp-2', conv2);
		expect(store.getConversation('resp-2')).toBe(conv2);

		// Should still get cleaned up after a new timeout
		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(store.getConversation('resp-2')).toBeUndefined();
	});
});
