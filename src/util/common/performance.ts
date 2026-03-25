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
 * These marks live inside the vscode-side `agent/willInvoke` → `agent/didInvoke`
 * window and break down what happens in the extension during a chat request.
 *
 * ## Per-Request Scenarios (scoped by requestId via {@link markChatExt})
 *
 * **Extension Handler Duration** — total time in the participant handler:
 * `willHandleParticipant` → `didHandleParticipant`
 * Corresponds to vscode's `agent/willInvoke` → `agent/didInvoke`.
 *
 * **Prompt Build Time** — context gathering and prompt assembly (per turn):
 * `willBuildPrompt` → `didBuildPrompt`
 * If this is slow, context resolution (workspace search, file reads, instructions) is the bottleneck.
 *
 * **LLM Fetch Time** — network round-trip to the language model (per turn):
 * `willFetch` → `didFetch`
 * If this is slow, model latency or network is the bottleneck.
 *
 * ## One-Time Activation Scenarios (global marks, not request-scoped)
 *
 * **Extension Activation Duration** — cold-start time:
 * `code/chat/ext/willActivate` → `code/chat/ext/didActivate`
 *
 * **Copilot Token Wait** — authentication readiness blocking activation:
 * `code/chat/ext/willWaitForCopilotToken` → `code/chat/ext/didWaitForCopilotToken`
 */
export const ChatExtPerfMark = {
	/** Chat participant handler starts */
	WillHandleParticipant: 'willHandleParticipant',
	/** Chat participant handler completes */
	DidHandleParticipant: 'didHandleParticipant',
	/** Prompt building starts (per turn) */
	WillBuildPrompt: 'willBuildPrompt',
	/** Prompt building completes (per turn) */
	DidBuildPrompt: 'didBuildPrompt',
	/** LLM fetch starts (per turn) */
	WillFetch: 'willFetch',
	/** LLM fetch completes (per turn) */
	DidFetch: 'didFetch',
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
