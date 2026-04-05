/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ChatFetchResponseType, ChatResponse } from '../../common/commonTypes';
import { createInitialFetchErrorDetector } from '../../common/chatMLFetcher';

function makeSuccessResponse(value = 'hello'): ChatResponse {
	return {
		type: ChatFetchResponseType.Success,
		value,
		requestId: 'req-1',
		serverRequestId: 'srv-1',
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
		resolvedModel: 'test-model',
	};
}

function makeErrorResponse(type = ChatFetchResponseType.NotFound): ChatResponse {
	return {
		type,
		reason: 'Not found',
		requestId: 'req-1',
		serverRequestId: undefined,
	} as ChatResponse;
}

describe('createInitialFetchErrorDetector', () => {

	it('returns undefined when first token arrives before fetch completes', async () => {
		const { wrapFinishedCb, getInitialFetchError } = createInitialFetchErrorDetector();

		let resolveResult!: (r: ChatResponse) => void;
		const fetchResultPromise = new Promise<ChatResponse>(resolve => { resolveResult = resolve; });

		const wrappedCb = wrapFinishedCb(async () => undefined);

		// Start the race first, then trigger the first token
		const errorPromise = getInitialFetchError(fetchResultPromise);

		// Simulate first token arriving
		await wrappedCb('hello', 0, { text: 'hello' });

		// Resolve the fetch result after the first token
		resolveResult(makeSuccessResponse());

		const result = await errorPromise;
		expect(result).toBeUndefined();
	});

	it('returns the error when fetch fails before any tokens', async () => {
		const { getInitialFetchError } = createInitialFetchErrorDetector();

		const errorResponse = makeErrorResponse(ChatFetchResponseType.NotFound);
		const fetchResultPromise = Promise.resolve(errorResponse);

		const result = await getInitialFetchError(fetchResultPromise);
		expect(result).toBe(errorResponse);
	});

	it('returns undefined when fetch succeeds before any tokens (unusual but not an error)', async () => {
		const { getInitialFetchError } = createInitialFetchErrorDetector();

		const successResponse = makeSuccessResponse();
		const fetchResultPromise = Promise.resolve(successResponse);

		const result = await getInitialFetchError(fetchResultPromise);
		expect(result).toBeUndefined();
	});

	it('invokes the original finishedCb and returns its value', async () => {
		const { wrapFinishedCb, getInitialFetchError } = createInitialFetchErrorDetector();

		const calls: string[] = [];
		const wrappedCb = wrapFinishedCb(async (text) => {
			calls.push(text);
			return undefined;
		});

		const fetchResultPromise = new Promise<ChatResponse>(() => { /* never resolves in this test */ });
		const errorPromise = getInitialFetchError(fetchResultPromise);

		await wrappedCb('chunk1', 0, { text: 'chunk1' });
		await wrappedCb('chunk2', 0, { text: 'chunk2' });

		expect(calls).toEqual(['chunk1', 'chunk2']);

		// Clean up: resolve the promise so the race settles
		const result = await Promise.race([errorPromise, Promise.resolve(undefined)]);
		expect(result).toBeUndefined();
	});

	it('works correctly with undefined finishedCb', async () => {
		const { wrapFinishedCb, getInitialFetchError } = createInitialFetchErrorDetector();

		const wrappedCb = wrapFinishedCb(undefined);

		const fetchResultPromise = new Promise<ChatResponse>(resolve => {
			setTimeout(() => resolve(makeSuccessResponse()), 0);
		});

		const errorPromise = getInitialFetchError(fetchResultPromise);

		// Simulate first token arriving
		const cbResult = await wrappedCb('hello', 0, { text: 'hello' });
		expect(cbResult).toBeUndefined();

		const result = await errorPromise;
		expect(result).toBeUndefined();
	});

	it('handles different error types correctly', async () => {
		const errorTypes = [
			ChatFetchResponseType.Failed,
			ChatFetchResponseType.RateLimited,
			ChatFetchResponseType.NetworkError,
			ChatFetchResponseType.Unknown,
		];

		for (const errorType of errorTypes) {
			const { getInitialFetchError } = createInitialFetchErrorDetector();

			const errorResponse = makeErrorResponse(errorType);
			const fetchResultPromise = Promise.resolve(errorResponse);

			const result = await getInitialFetchError(fetchResultPromise);
			expect(result).toBe(errorResponse);
		}
	});
});
