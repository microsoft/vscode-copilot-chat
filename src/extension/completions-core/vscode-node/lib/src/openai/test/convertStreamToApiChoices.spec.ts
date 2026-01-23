/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { Completion } from '../../../../../../../platform/nesFetch/common/completionsAPI';
import { ResponseStream } from '../../../../../../../platform/nesFetch/common/responseStream';
import { RequestId } from '../../../../../../../platform/networking/common/fetch';
import { IHeaders, Response } from '../../../../../../../platform/networking/common/fetcherService';
import { TelemetryWithExp } from '../../telemetry';
import { LiveOpenAIFetcher } from '../fetch';

/**
 * Helper to collect all items from an async iterable into an array.
 */
async function collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const item of iterable) {
		results.push(item);
	}
	return results;
}

/**
 * Creates a mock IHeaders for testing.
 */
class MockHeaders implements IHeaders {
	get(): string | null {
		return null;
	}

	*[Symbol.iterator](): Iterator<[string, string]> {
		// No headers
	}
}

/**
 * Creates a mock ResponseStream for testing.
 */
function createMockResponseStream(completions: Completion[]): ResponseStream {
	const requestId: RequestId = {
		headerRequestId: 'test-request-id',
		serverExperiments: '',
		deploymentId: '',
		gitHubRequestId: '',
		completionId: '',
		created: 0,
	};

	const mockHeaders = new MockHeaders();

	const fakeResponse = Response.fromText(200, 'OK', mockHeaders, '', 'test-stub');

	async function* generateCompletions(): AsyncGenerator<Completion> {
		for (const completion of completions) {
			yield completion;
		}
	}

	return new ResponseStream(fakeResponse, generateCompletions(), requestId, mockHeaders);
}

/**
 * Creates a Completion with the given parameters.
 */
function createCompletion(choice: Partial<Completion.Choice>): Completion {
	return {
		choices: [{
			index: choice.index ?? 0,
			finish_reason: choice.finish_reason ?? null,
			text: choice.text ?? '',
		}],
		system_fingerprint: 'test',
		object: 'text_completion',
		usage: undefined,
	};
}

describe('LiveOpenAIFetcher.convertStreamToApiChoices', () => {
	const baseTelemetryData = TelemetryWithExp.createEmptyConfigForTesting();

	describe('finishReason behavior - must match SSEProcessor behavior', () => {
		it('should return finish_reason "stop" when server provides finish_reason "stop"', async () => {
			// GIVEN: stream with explicit 'stop' finish_reason from server
			const completions = [
				createCompletion({ index: 0, text: 'hello', finish_reason: null }),
				createCompletion({ index: 0, text: ' world', finish_reason: Completion.FinishReason.Stop }),
			];
			const responseStream = createMockResponseStream(completions);

			// WHEN: processing the stream
			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, () => undefined, baseTelemetryData)
			);

			// THEN: finishReason should be 'stop'
			expect(choices).toHaveLength(1);
			expect(choices[0].finishReason).toBe('stop');
		});

		it('should return finish_reason "content_filter" when server provides finish_reason "content_filter"', async () => {
			// GIVEN: stream with 'content_filter' finish_reason from server
			const completions = [
				createCompletion({ index: 0, text: 'hello', finish_reason: null }),
				createCompletion({ index: 0, text: ' world', finish_reason: Completion.FinishReason.ContentFilter }),
			];
			const responseStream = createMockResponseStream(completions);

			// WHEN: processing the stream
			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, () => undefined, baseTelemetryData)
			);

			// THEN: finishReason should be 'content_filter'
			expect(choices).toHaveLength(1);
			expect(choices[0].finishReason).toBe('content_filter');
		});

		it('should return finish_reason "length" when server provides finish_reason "length"', async () => {
			// GIVEN: stream with 'length' finish_reason from server
			const completions = [
				createCompletion({ index: 0, text: 'hello world', finish_reason: Completion.FinishReason.Length }),
			];
			const responseStream = createMockResponseStream(completions);

			// WHEN: processing the stream
			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, () => undefined, baseTelemetryData)
			);

			// THEN: finishReason should be 'length'
			expect(choices).toHaveLength(1);
			expect(choices[0].finishReason).toBe('length');
		});

		it('should return finish_reason "DONE" when stream ends without server-provided finish_reason', async () => {
			// GIVEN: stream that ends without server providing a finish_reason
			// This is the key behavior difference we're testing:
			// - Old behavior (SSEProcessor): returns 'DONE'
			// - Fixed behavior (convertStreamToApiChoices): should also return 'DONE'
			// - Broken behavior: would return 'stop', which affects hasAcceptedCurrentCompletion
			const completions = [
				createCompletion({ index: 0, text: 'hello', finish_reason: null }),
				createCompletion({ index: 0, text: ' world', finish_reason: null }),
				// Stream ends here without a finish_reason
			];
			const responseStream = createMockResponseStream(completions);

			// WHEN: processing the stream
			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, () => undefined, baseTelemetryData)
			);

			// THEN: finishReason should be 'DONE' (NOT 'stop')
			// This is critical for hasAcceptedCurrentCompletion to work correctly
			expect(choices).toHaveLength(1);
			expect(choices[0].finishReason).toBe('DONE');
		});

		it('should return finish_reason "DONE" for each unfinished completion when stream ends', async () => {
			// GIVEN: multiple completions where none have server-provided finish_reason
			const completions = [
				createCompletion({ index: 0, text: 'hello', finish_reason: null }),
				createCompletion({ index: 1, text: 'world', finish_reason: null }),
			];
			const responseStream = createMockResponseStream(completions);

			// WHEN: processing the stream
			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, () => undefined, baseTelemetryData)
			);

			// THEN: all unfinished completions should have finishReason 'DONE'
			expect(choices).toHaveLength(2);
			expect(choices[0].finishReason).toBe('DONE');
			expect(choices[1].finishReason).toBe('DONE');
		});
	});

	describe('finishedCb early termination', () => {
		it('should yield with correct finishReason when finishedCb triggers early termination', async () => {
			// GIVEN: finishedCb that triggers yield after seeing enough text
			const completions = [
				createCompletion({ index: 0, text: 'line1\n', finish_reason: null }),
				createCompletion({ index: 0, text: 'line2\n', finish_reason: null }),
				createCompletion({ index: 0, text: 'line3\n', finish_reason: null }),
			];
			const responseStream = createMockResponseStream(completions);

			// finishedCb that yields after first newline and continues streaming
			const finishedCb = (text: string) => {
				const newlineIdx = text.indexOf('\n');
				if (newlineIdx !== -1) {
					return { yieldSolution: true, continueStreaming: true, finishOffset: newlineIdx };
				}
				return undefined;
			};

			// WHEN: processing the stream
			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, finishedCb, baseTelemetryData)
			);

			// THEN: should yield with finishReason 'stop' (since no server finish_reason yet)
			// and have blockFinished=true due to finishOffset
			expect(choices.length).toBeGreaterThanOrEqual(1);
			expect(choices[0].blockFinished).toBe(true);
		});
	});

	describe('blockFinished behavior', () => {
		it('should set blockFinished=false when no finishOffset is provided', async () => {
			// GIVEN: stream with server finish_reason but no finishOffset from finishedCb
			const completions = [
				createCompletion({ index: 0, text: 'hello world', finish_reason: Completion.FinishReason.Stop }),
			];
			const responseStream = createMockResponseStream(completions);

			// WHEN: processing the stream
			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, () => undefined, baseTelemetryData)
			);

			// THEN: blockFinished should be false (finish was from server, not client-side truncation)
			expect(choices).toHaveLength(1);
			expect(choices[0].blockFinished).toBe(false);
		});

		it('should set blockFinished=true when finishOffset is provided by finishedCb', async () => {
			// GIVEN: stream where finishedCb provides a finishOffset
			const completions = [
				createCompletion({ index: 0, text: 'hello\nworld', finish_reason: null }),
			];
			const responseStream = createMockResponseStream(completions);

			// finishedCb that truncates at newline
			const finishedCb = (text: string) => {
				const newlineIdx = text.indexOf('\n');
				if (newlineIdx !== -1) {
					return { yieldSolution: true, continueStreaming: false, finishOffset: newlineIdx };
				}
				return undefined;
			};

			// WHEN: processing the stream
			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, finishedCb, baseTelemetryData)
			);

			// THEN: blockFinished should be true
			expect(choices).toHaveLength(1);
			expect(choices[0].blockFinished).toBe(true);
			expect(choices[0].completionText).toBe('hello');
		});
	});

	describe('integration with hasAcceptedCurrentCompletion', () => {
		// These tests document the behavior difference that was causing the bug.
		// hasAcceptedCurrentCompletion returns true only when finishReason === 'stop'.
		// If we incorrectly return 'stop' when the stream ends without a server finish_reason,
		// hasAcceptedCurrentCompletion will return true when it should return false,
		// causing incorrect multiline follow-up behavior.

		it('should NOT have finishReason "stop" when stream ends without server finish_reason', async () => {
			// This test documents the critical invariant that was broken before the fix.
			// When stream ends without server finish_reason:
			// - hasAcceptedCurrentCompletion should return false
			// - This requires finishReason !== 'stop'
			// - The correct value is 'DONE' (matching SSEProcessor)

			const completions = [
				createCompletion({ index: 0, text: 'hello world', finish_reason: null }),
			];
			const responseStream = createMockResponseStream(completions);

			const choices = await collectAsyncIterable(
				LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, () => undefined, baseTelemetryData)
			);

			expect(choices).toHaveLength(1);
			// CRITICAL: This MUST NOT be 'stop' or hasAcceptedCurrentCompletion will misbehave
			expect(choices[0].finishReason).not.toBe('stop');
			expect(choices[0].finishReason).toBe('DONE');
		});
	});
});
