/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { BackgroundSummarizer, BackgroundSummarizationState, IBackgroundSummarizationResult } from '../backgroundSummarizer';

describe('BackgroundSummarizer', () => {

	test('initial state is Idle', () => {
		const summarizer = new BackgroundSummarizer(100_000);
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
		expect(summarizer.error).toBeUndefined();
		expect(summarizer.token).toBeUndefined();
	});

	test('start transitions to InProgress', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => {
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		expect(summarizer.state).toBe(BackgroundSummarizationState.InProgress);
		expect(summarizer.token).toBeDefined();
		await summarizer.waitForCompletion();
	});

	test('successful work transitions to Completed', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		const result: IBackgroundSummarizationResult = { summary: 'test summary', toolCallRoundId: 'round1' };
		summarizer.start(async () => result);
		await summarizer.waitForCompletion();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Completed);
	});

	test('failed work transitions to Failed', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => {
			throw new Error('summarization failed');
		});
		await summarizer.waitForCompletion();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Failed);
		expect(summarizer.error).toBeInstanceOf(Error);
	});

	test('consumeAndReset returns result and resets to Idle', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		const expected: IBackgroundSummarizationResult = { summary: 'test summary', toolCallRoundId: 'round1' };
		summarizer.start(async () => expected);
		await summarizer.waitForCompletion();

		const result = summarizer.consumeAndReset();
		expect(result).toEqual(expected);
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
		expect(summarizer.token).toBeUndefined();
	});

	test('consumeAndReset returns undefined while InProgress', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		let resolveFn: () => void;
		const gate = new Promise<void>(resolve => { resolveFn = resolve; });
		summarizer.start(async () => {
			await gate;
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		expect(summarizer.consumeAndReset()).toBeUndefined();
		expect(summarizer.state).toBe(BackgroundSummarizationState.InProgress);
		summarizer.cancel();
		resolveFn!();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	});

	test('consumeAndReset returns undefined after failure', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => {
			throw new Error('fail');
		});
		await summarizer.waitForCompletion();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Failed);

		const result = summarizer.consumeAndReset();
		expect(result).toBeUndefined();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
	});

	test('start is a no-op when already InProgress', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		let callCount = 0;
		let resolveFn: () => void;
		const gate = new Promise<void>(resolve => { resolveFn = resolve; });
		summarizer.start(async () => {
			callCount++;
			await gate;
			return { summary: 'first', toolCallRoundId: 'r1' };
		});
		// Second start should be ignored
		summarizer.start(async () => {
			callCount++;
			return { summary: 'second', toolCallRoundId: 'r2' };
		});
		resolveFn!();
		await summarizer.waitForCompletion();
		expect(callCount).toBe(1);
		expect(summarizer.consumeAndReset()?.summary).toBe('first');
	});

	test('start is a no-op when already Completed', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => ({ summary: 'first', toolCallRoundId: 'r1' }));
		await summarizer.waitForCompletion();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Completed);

		// Second start should be ignored because state is Completed
		summarizer.start(async () => ({ summary: 'second', toolCallRoundId: 'r2' }));
		expect(summarizer.state).toBe(BackgroundSummarizationState.Completed);
		expect(summarizer.consumeAndReset()?.summary).toBe('first');
	});

	test('start retries after Failed state', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => {
			throw new Error('fail');
		});
		await summarizer.waitForCompletion();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Failed);

		// Should be allowed to retry
		summarizer.start(async () => ({ summary: 'retry', toolCallRoundId: 'r2' }));
		await summarizer.waitForCompletion();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Completed);
		expect(summarizer.consumeAndReset()?.summary).toBe('retry');
	});

	test('cancel resets state to Idle', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		let resolveFn: () => void;
		const gate = new Promise<void>(resolve => { resolveFn = resolve; });
		summarizer.start(async () => {
			await gate;
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		expect(summarizer.state).toBe(BackgroundSummarizationState.InProgress);

		summarizer.cancel();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
		expect(summarizer.token).toBeUndefined();
		expect(summarizer.error).toBeUndefined();
		resolveFn!();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	});

	test('cancel prevents .then() from setting state to Completed', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		let resolveFn: () => void;
		const gate = new Promise<void>(resolve => { resolveFn = resolve; });

		summarizer.start(async () => {
			await gate;
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		expect(summarizer.state).toBe(BackgroundSummarizationState.InProgress);

		// Cancel before the work completes
		summarizer.cancel();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);

		// Let the work complete — the .then() should NOT overwrite the Idle state.
		// Use setTimeout to yield to the macrotask queue, guaranteeing all
		// microtasks (including the .then() handler) have drained first.
		resolveFn!();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
	});

	test('cancel prevents .catch() from setting state to Failed', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		let rejectFn: (err: Error) => void;
		const gate = new Promise<void>((_, reject) => { rejectFn = reject; });

		summarizer.start(async () => {
			await gate;
			return { summary: 'unreachable', toolCallRoundId: 'r1' };
		});

		summarizer.cancel();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);

		// Let the work fail — the .catch() should NOT overwrite the Idle state.
		// Use setTimeout to yield to the macrotask queue, guaranteeing all
		// microtasks (including the .catch() handler) have drained first.
		rejectFn!(new Error('fail'));
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
		expect(summarizer.error).toBeUndefined();
	});

	test('waitForCompletion is a no-op when nothing started', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		await summarizer.waitForCompletion();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
	});

	test('multiple waitForCompletion calls resolve correctly', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		let resolveFn: () => void;
		const gate = new Promise<void>(resolve => { resolveFn = resolve; });
		summarizer.start(async () => {
			await gate;
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		resolveFn!();
		// Both should resolve without error
		await Promise.all([
			summarizer.waitForCompletion(),
			summarizer.waitForCompletion(),
		]);
		expect(summarizer.state).toBe(BackgroundSummarizationState.Completed);
	});
});
