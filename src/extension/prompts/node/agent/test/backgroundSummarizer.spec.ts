/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { CancellationTokenSource } from '../../../../../util/vs/base/common/cancellation';
import { BackgroundSummarizer, BackgroundSummarizationState, IBackgroundSummarizationResult } from '../backgroundSummarizer';

describe('BackgroundSummarizer', () => {

	test('initial state is Idle', () => {
		const summarizer = new BackgroundSummarizer(100_000);
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
		expect(summarizer.error).toBeUndefined();
		expect(summarizer.token).toBeUndefined();
	});

	test('start transitions to InProgress', () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => {
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		expect(summarizer.state).toBe(BackgroundSummarizationState.InProgress);
		expect(summarizer.token).toBeDefined();
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

	test('consumeAndReset returns undefined while InProgress', () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => {
			await new Promise(resolve => setTimeout(resolve, 1000));
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		expect(summarizer.consumeAndReset()).toBeUndefined();
		expect(summarizer.state).toBe(BackgroundSummarizationState.InProgress);
		summarizer.cancel();
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
		summarizer.start(async () => {
			callCount++;
			await new Promise(resolve => setTimeout(resolve, 50));
			return { summary: 'first', toolCallRoundId: 'r1' };
		});
		// Second start should be ignored
		summarizer.start(async () => {
			callCount++;
			return { summary: 'second', toolCallRoundId: 'r2' };
		});
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

	test('cancel resets state to Idle', () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => {
			await new Promise(resolve => setTimeout(resolve, 1000));
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		expect(summarizer.state).toBe(BackgroundSummarizationState.InProgress);

		summarizer.cancel();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
		expect(summarizer.token).toBeUndefined();
		expect(summarizer.error).toBeUndefined();
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

		// Let the work complete — the .then() should NOT overwrite the Idle state
		resolveFn!();
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
	});

	test('cancel prevents .then() from setting state to Failed', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		let rejectFn: (err: Error) => void;
		const gate = new Promise<void>((_, reject) => { rejectFn = reject; });

		summarizer.start(async () => {
			await gate;
			return { summary: 'unreachable', toolCallRoundId: 'r1' };
		});

		summarizer.cancel();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);

		// Let the work fail — the .then() should NOT overwrite the Idle state
		rejectFn!(new Error('fail'));
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
		expect(summarizer.error).toBeUndefined();
	});

	describe('linked cancellation token', () => {

		test('work receives a cancellation token', async () => {
			const summarizer = new BackgroundSummarizer(100_000);
			let receivedToken: unknown;
			summarizer.start(async token => {
				receivedToken = token;
				return { summary: 'test', toolCallRoundId: 'r1' };
			});
			await summarizer.waitForCompletion();
			expect(receivedToken).toBeDefined();
			expect(receivedToken).toHaveProperty('isCancellationRequested');
		});

		test('cancel() cancels the token passed to work', async () => {
			const summarizer = new BackgroundSummarizer(100_000);
			let resolveFn: () => void;
			const gate = new Promise<void>(resolve => { resolveFn = resolve; });
			let tokenCancelled = false;

			summarizer.start(async token => {
				token.onCancellationRequested(() => { tokenCancelled = true; });
				await gate;
				return { summary: 'test', toolCallRoundId: 'r1' };
			});

			expect(tokenCancelled).toBe(false);
			summarizer.cancel();
			expect(tokenCancelled).toBe(true);

			resolveFn!();
		});

		test('parent token cancellation propagates to work token', async () => {
			const parentCts = new CancellationTokenSource();
			const summarizer = new BackgroundSummarizer(100_000);
			let resolveFn: () => void;
			const gate = new Promise<void>(resolve => { resolveFn = resolve; });
			let tokenCancelled = false;

			summarizer.start(async token => {
				token.onCancellationRequested(() => { tokenCancelled = true; });
				await gate;
				return { summary: 'test', toolCallRoundId: 'r1' };
			}, parentCts.token);

			expect(tokenCancelled).toBe(false);
			parentCts.cancel();
			expect(tokenCancelled).toBe(true);

			summarizer.cancel();
			resolveFn!();
			parentCts.dispose();
		});

		test('linked token cancels when either parent or own CTS cancels', async () => {
			const parentCts = new CancellationTokenSource();
			const summarizer = new BackgroundSummarizer(100_000);
			let resolveFn: () => void;
			const gate = new Promise<void>(resolve => { resolveFn = resolve; });
			let workTokenCancelled = false;

			summarizer.start(async token => {
				token.onCancellationRequested(() => { workTokenCancelled = true; });
				await gate;
				return { summary: 'test', toolCallRoundId: 'r1' };
			}, parentCts.token);

			// Cancel via the summarizer's own cancel() — should propagate
			summarizer.cancel();
			expect(workTokenCancelled).toBe(true);

			resolveFn!();
			parentCts.dispose();
		});
	});

	test('waitForCompletion is a no-op when nothing started', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		await summarizer.waitForCompletion();
		expect(summarizer.state).toBe(BackgroundSummarizationState.Idle);
	});

	test('multiple waitForCompletion calls resolve correctly', async () => {
		const summarizer = new BackgroundSummarizer(100_000);
		summarizer.start(async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			return { summary: 'test', toolCallRoundId: 'r1' };
		});
		// Both should resolve without error
		await Promise.all([
			summarizer.waitForCompletion(),
			summarizer.waitForCompletion(),
		]);
		expect(summarizer.state).toBe(BackgroundSummarizationState.Completed);
	});
});
