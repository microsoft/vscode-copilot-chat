/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { ChatExtPerfMark, clearChatExtMarks, markChatExt } from '../performance';

describe('performance', () => {

	const TEST_PREFIX = 'code/chat/ext/';
	let testRequestId: string;
	let testCounter = 0;

	afterEach(() => {
		clearChatExtMarks(testRequestId);
	});

	function uniqueRequestId(): string {
		testRequestId = `test-req-${testCounter++}-${Date.now()}`;
		return testRequestId;
	}

	describe('markChatExt', () => {
		it('emits a mark with the expected prefix', () => {
			const reqId = uniqueRequestId();
			markChatExt(reqId, ChatExtPerfMark.WillHandleParticipant);

			const marks = performance.getEntriesByType('mark').filter(m => m.name.includes(reqId));
			expect(marks).toHaveLength(1);
			expect(marks[0].name).toBe(`${TEST_PREFIX}${reqId}/${ChatExtPerfMark.WillHandleParticipant}`);
		});

		it('emits multiple marks for the same request', () => {
			const reqId = uniqueRequestId();
			markChatExt(reqId, ChatExtPerfMark.WillBuildPrompt);
			markChatExt(reqId, ChatExtPerfMark.DidBuildPrompt);

			const marks = performance.getEntriesByType('mark').filter(m => m.name.includes(reqId));
			expect(marks).toHaveLength(2);
		});
	});

	describe('clearChatExtMarks', () => {
		it('removes all marks for the request', () => {
			const reqId = uniqueRequestId();
			markChatExt(reqId, ChatExtPerfMark.WillRunLoop);
			markChatExt(reqId, ChatExtPerfMark.DidRunLoop);

			clearChatExtMarks(reqId);

			const marks = performance.getEntriesByType('mark').filter(m => m.name.includes(reqId));
			expect(marks).toHaveLength(0);
		});

		it('does not affect marks from a different request', () => {
			const reqId1 = uniqueRequestId();
			const reqId2 = `other-req-${Date.now()}`;
			markChatExt(reqId1, ChatExtPerfMark.WillFetch);
			markChatExt(reqId2, ChatExtPerfMark.DidFetch);

			clearChatExtMarks(reqId1);

			const remaining = performance.getEntriesByType('mark').filter(m => m.name.includes(reqId2));
			expect(remaining).toHaveLength(1);

			clearChatExtMarks(reqId2);
		});
	});

	describe('ChatExtPerfMark', () => {
		it('contains all expected mark names', () => {
			expect(ChatExtPerfMark.WillHandleParticipant).toBe('willHandleParticipant');
			expect(ChatExtPerfMark.DidHandleParticipant).toBe('didHandleParticipant');
			expect(ChatExtPerfMark.WillRunLoop).toBe('willRunLoop');
			expect(ChatExtPerfMark.DidRunLoop).toBe('didRunLoop');
			expect(ChatExtPerfMark.WillBuildPrompt).toBe('willBuildPrompt');
			expect(ChatExtPerfMark.DidBuildPrompt).toBe('didBuildPrompt');
			expect(ChatExtPerfMark.WillFetch).toBe('willFetch');
			expect(ChatExtPerfMark.DidFetch).toBe('didFetch');
			expect(ChatExtPerfMark.WillGetSystemPrompt).toBe('willGetSystemPrompt');
			expect(ChatExtPerfMark.DidGetSystemPrompt).toBe('didGetSystemPrompt');
			expect(ChatExtPerfMark.WillGetGlobalAgentContext).toBe('willGetGlobalAgentContext');
			expect(ChatExtPerfMark.DidGetGlobalAgentContext).toBe('didGetGlobalAgentContext');
		});
	});
});
