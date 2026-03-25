/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const chatExtPrefix = 'code/chat/ext/';

/**
 * Well-defined perf marks for the chat extension request lifecycle.
 * Each mark is a boundary of a measurable scenario — don't add marks
 * without defining what scenario they belong to.
 *
 * ## Scenarios
 *
 * **Participant Handler Duration**:
 * `willHandleParticipant` → `didHandleParticipant`
 *
 * **Tool Calling Loop Duration**:
 * `willRunLoop` → `didRunLoop`
 *
 * **Prompt Build Time**:
 * `willBuildPrompt` → `didBuildPrompt`
 *
 * **LLM Fetch Round-Trip**:
 * `willFetch` → `didFetch`
 *
 * **System Prompt Generation**:
 * `willGetSystemPrompt` → `didGetSystemPrompt`
 *
 * **Global Agent Context**:
 * `willGetGlobalAgentContext` → `didGetGlobalAgentContext`
 */
export const ChatExtPerfMark = {
	/** Chat participant handler starts */
	WillHandleParticipant: 'willHandleParticipant',
	/** Chat participant handler completes */
	DidHandleParticipant: 'didHandleParticipant',
	/** Tool calling loop starts */
	WillRunLoop: 'willRunLoop',
	/** Tool calling loop completes */
	DidRunLoop: 'didRunLoop',
	/** Prompt building starts */
	WillBuildPrompt: 'willBuildPrompt',
	/** Prompt building completes */
	DidBuildPrompt: 'didBuildPrompt',
	/** LLM fetch starts */
	WillFetch: 'willFetch',
	/** LLM fetch completes */
	DidFetch: 'didFetch',
	/** System prompt generation starts */
	WillGetSystemPrompt: 'willGetSystemPrompt',
	/** System prompt generation completes */
	DidGetSystemPrompt: 'didGetSystemPrompt',
	/** Global agent context starts */
	WillGetGlobalAgentContext: 'willGetGlobalAgentContext',
	/** Global agent context completes */
	DidGetGlobalAgentContext: 'didGetGlobalAgentContext',
} as const;

/**
 * Emits a performance mark scoped to a chat request:
 * `code/chat/ext/<requestId>/<name>`
 *
 * Marks are automatically cleaned up via {@link clearChatExtMarks}
 * when the request completes.
 */
export function markChatExt(requestId: string | undefined, name: string): void {
	if (requestId) {
		performance.mark(`${chatExtPrefix}${requestId}/${name}`);
	}
}

/**
 * Clears all performance marks for the given chat request.
 * Called when the request handler completes.
 */
export function clearChatExtMarks(requestId: string): void {
	const prefix = `${chatExtPrefix}${requestId}/`;
	const toRemove = new Set<string>();
	for (const entry of performance.getEntriesByType('mark')) {
		if (entry.name.startsWith(prefix)) {
			toRemove.add(entry.name);
		}
	}
	for (const name of toRemove) {
		performance.clearMarks(name);
	}
}
