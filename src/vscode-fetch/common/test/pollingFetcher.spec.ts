/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollingFetcher } from '../pollingFetcher';
import { IWindowStateProvider } from '../types';

class MockWindowStateProvider implements IWindowStateProvider {
	private _isActive = true;
	private _listeners: Array<(state: { readonly active: boolean }) => void> = [];

	get isActive(): boolean {
		return this._isActive;
	}

	setActive(active: boolean): void {
		this._isActive = active;
		for (const listener of this._listeners) {
			listener({ active });
		}
	}

	onDidChangeWindowState(listener: (state: { readonly active: boolean }) => void): { dispose(): void } {
		this._listeners.push(listener);
		return {
			dispose: () => {
				this._listeners = this._listeners.filter(l => l !== listener);
			},
		};
	}
}

describe('PollingFetcher', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should fetch immediately on construction', async () => {
		const fetchFn = vi.fn().mockResolvedValue('result-1');
		const poller = new PollingFetcher(fetchFn, { intervalMs: 5000 });

		const result = await poller.getResult();
		expect(result).toBe('result-1');
		expect(fetchFn).toHaveBeenCalledOnce();

		poller.dispose();
	});

	it('should poll on interval', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce('result-1')
			.mockResolvedValueOnce('result-2');
		const poller = new PollingFetcher(fetchFn, { intervalMs: 5000 });

		await poller.getResult();
		expect(fetchFn).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchFn).toHaveBeenCalledTimes(2);

		poller.dispose();
	});

	it('should return latest result via value property', async () => {
		const fetchFn = vi.fn().mockResolvedValue('result-1');
		const poller = new PollingFetcher(fetchFn, { intervalMs: 5000 });

		// Before first fetch completes
		expect(poller.value).toBeUndefined();

		await poller.getResult();
		expect(poller.value).toBe('result-1');

		poller.dispose();
	});

	it('should skip polling when window is inactive', async () => {
		const windowState = new MockWindowStateProvider();
		const fetchFn = vi.fn().mockResolvedValue('result');
		const poller = new PollingFetcher(fetchFn, {
			intervalMs: 5000,
			windowStateProvider: windowState,
		});

		await poller.getResult();
		expect(fetchFn).toHaveBeenCalledOnce();

		// Make window inactive
		windowState.setActive(false);

		// Advance past interval — should skip
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchFn).toHaveBeenCalledOnce();

		poller.dispose();
	});

	it('should resume polling when window becomes active', async () => {
		const windowState = new MockWindowStateProvider();
		const fetchFn = vi.fn()
			.mockResolvedValueOnce('result-1')
			.mockResolvedValueOnce('result-2');
		const poller = new PollingFetcher(fetchFn, {
			intervalMs: 5000,
			windowStateProvider: windowState,
		});

		const r1 = await poller.getResult();
		expect(r1).toBe('result-1');
		// Mark as used so it will re-fetch when active
		void poller.value;

		// Go inactive
		windowState.setActive(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchFn).toHaveBeenCalledOnce();

		// Come back active → should trigger poll
		windowState.setActive(true);
		// Wait for the async poll to complete
		await vi.advanceTimersByTimeAsync(0);

		expect(fetchFn).toHaveBeenCalledTimes(2);

		poller.dispose();
	});

	it('should skip polling when unused and skipWhenUnused is true', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce('result-1')
			.mockResolvedValueOnce('result-2');
		const poller = new PollingFetcher(fetchFn, {
			intervalMs: 5000,
			skipWhenUnused: true,
		});

		// First poll happens automatically
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchFn).toHaveBeenCalledOnce();

		// Don't consume the result — next poll should be skipped
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchFn).toHaveBeenCalledOnce();

		// Now consume the result
		const r = await poller.getResult();
		expect(r).toBe('result-2');
		// getResult triggers a fresh fetch since the skipped poll cleared the result
		expect(fetchFn).toHaveBeenCalledTimes(2);

		poller.dispose();
	});

	it('should clear value on regular fetch error', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce('good-result')
			.mockRejectedValueOnce(new Error('network error'))
			.mockResolvedValueOnce('recovered');
		const logger = { warn: vi.fn(), error: vi.fn() };
		const poller = new PollingFetcher(fetchFn, { intervalMs: 5000 }, logger);

		const r1 = await poller.getResult();
		expect(r1).toBe('good-result');

		// Regular error clears the value (only FetchCallsiteDisabledError preserves it)
		await vi.advanceTimersByTimeAsync(5000);
		expect(logger.warn).toHaveBeenCalledOnce();
		expect(poller.value).toBeUndefined();

		poller.dispose();
	});

	it('should stop polling after dispose', async () => {
		const fetchFn = vi.fn().mockResolvedValue('result');
		const poller = new PollingFetcher(fetchFn, { intervalMs: 5000 });

		await poller.getResult();
		poller.dispose();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it('should force fetch on getResult() when no result available', async () => {
		const windowState = new MockWindowStateProvider();
		windowState.setActive(false);

		const fetchFn = vi.fn().mockResolvedValue('forced-result');
		const poller = new PollingFetcher(fetchFn, {
			intervalMs: 5000,
			windowStateProvider: windowState,
		});

		// Initial poll skipped due to inactive window, but getResult forces it
		const result = await poller.getResult();
		expect(result).toBe('forced-result');
		expect(fetchFn).toHaveBeenCalledOnce();

		poller.dispose();
	});

	it('should throw on getResult() after dispose', async () => {
		const fetchFn = vi.fn().mockResolvedValue('result');
		const poller = new PollingFetcher(fetchFn, { intervalMs: 5000 });

		await poller.getResult();
		poller.dispose();

		await expect(poller.getResult()).rejects.toThrow('cannot get result after dispose');
	});

	// --- Observable / onDidChange ---

	describe('onDidChange', () => {
		it('should fire on initial fetch', async () => {
			const fetchFn = vi.fn<() => Promise<string>>().mockResolvedValue('first');
			const poller = new PollingFetcher(fetchFn, { intervalMs: 5000 });
			const values: string[] = [];
			poller.onDidChange(v => values.push(v));

			await poller.getResult();

			expect(values).toEqual(['first']);

			poller.dispose();
		});

		it('should fire on each poll', async () => {
			const fetchFn = vi.fn<() => Promise<string>>()
				.mockResolvedValueOnce('v1')
				.mockResolvedValueOnce('v2')
				.mockResolvedValueOnce('v3');
			const poller = new PollingFetcher(fetchFn, { intervalMs: 1000 });
			const values: string[] = [];
			poller.onDidChange(v => values.push(v));

			await poller.getResult();
			await vi.advanceTimersByTimeAsync(1000);
			await vi.advanceTimersByTimeAsync(1000);

			expect(values).toEqual(['v1', 'v2', 'v3']);

			poller.dispose();
		});

		it('should not fire after unsubscribe', async () => {
			const fetchFn = vi.fn<() => Promise<string>>()
				.mockResolvedValueOnce('v1')
				.mockResolvedValueOnce('v2');
			const poller = new PollingFetcher(fetchFn, { intervalMs: 1000 });
			const values: string[] = [];
			const sub = poller.onDidChange(v => values.push(v));

			await poller.getResult();
			sub.dispose();

			await vi.advanceTimersByTimeAsync(1000);

			expect(values).toEqual(['v1']);

			poller.dispose();
		});

		it('should not fire after poller dispose', async () => {
			const fetchFn = vi.fn<() => Promise<string>>().mockResolvedValue('v1');
			const poller = new PollingFetcher(fetchFn, { intervalMs: 1000 });
			const values: string[] = [];
			poller.onDidChange(v => values.push(v));

			await poller.getResult();
			poller.dispose();

			// Manually attempt advancing — no fires
			await vi.advanceTimersByTimeAsync(2000);
			expect(values).toEqual(['v1']);
		});

		it('should not fire on fetch error', async () => {
			const fetchFn = vi.fn<() => Promise<string>>()
				.mockResolvedValueOnce('good')
				.mockRejectedValueOnce(new Error('fail'));
			const logger = { warn: vi.fn(), error: vi.fn() };
			const poller = new PollingFetcher(fetchFn, { intervalMs: 1000 }, logger);
			const values: string[] = [];
			poller.onDidChange(v => values.push(v));

			await poller.getResult();
			await vi.advanceTimersByTimeAsync(1000);

			// Only the successful poll should have fired
			expect(values).toEqual(['good']);

			poller.dispose();
		});
	});

	// --- Initial value ---

	describe('initialValue', () => {
		it('should provide initial value synchronously via value property', () => {
			const fetchFn = vi.fn().mockResolvedValue('fetched');
			const poller = new PollingFetcher(fetchFn, {
				intervalMs: 5000,
				initialValue: 'cached',
			});

			// Available immediately without awaiting
			expect(poller.value).toBe('cached');

			poller.dispose();
		});

		it('should return initial value from getResult() before first poll completes', async () => {
			let resolveFetch!: (v: string) => void;
			const fetchFn = vi.fn().mockReturnValue(new Promise<string>(r => { resolveFetch = r; }));
			const poller = new PollingFetcher(fetchFn, {
				intervalMs: 5000,
				initialValue: 'cached',
			});

			// getResult should return the initial value immediately
			const result = await poller.getResult();
			expect(result).toBe('cached');

			// Now resolve the pending fetch
			resolveFetch('fresh');
			await vi.advanceTimersByTimeAsync(0);
			expect(poller.value).toBe('fresh');

			poller.dispose();
		});

		it('should replace initial value after first poll', async () => {
			const fetchFn = vi.fn().mockResolvedValue('fresh');
			const poller = new PollingFetcher(fetchFn, {
				intervalMs: 5000,
				initialValue: 'stale',
			});

			expect(poller.value).toBe('stale');

			await poller.getResult();
			// First poll completes → value updated
			expect(poller.value).toBe('fresh');

			poller.dispose();
		});

		it('should fire onDidChange when initial value is replaced by poll', async () => {
			const fetchFn = vi.fn().mockResolvedValue('polled');
			const poller = new PollingFetcher(fetchFn, {
				intervalMs: 5000,
				initialValue: 'initial',
			});
			const values: string[] = [];
			poller.onDidChange(v => values.push(v));

			await poller.getResult();

			// Should fire with the polled value
			expect(values).toEqual(['polled']);

			poller.dispose();
		});
	});

	// --- FetchCallsiteDisabledError handling ---

	describe('FetchCallsiteDisabledError handling', () => {
		function makeDisabledError(callSite: string): Error {
			const err = new Error(`Fetch requests from callsite '${callSite}' are currently disabled by experiment`);
			err.name = 'FetchCallsiteDisabledError';
			return err;
		}

		it('should preserve current value when fetchFn rejects with FetchCallsiteDisabledError', async () => {
			const fetchFn = vi.fn()
				.mockResolvedValueOnce('good-value')
				.mockRejectedValueOnce(makeDisabledError('test'));
			const poller = new PollingFetcher(fetchFn, { intervalMs: 1000 });

			const result = await poller.getResult();
			expect(result).toBe('good-value');

			await vi.advanceTimersByTimeAsync(1000);
			// Value should be preserved, not cleared
			expect(poller.value).toBe('good-value');

			poller.dispose();
		});

		it('should clear value on regular errors', async () => {
			const fetchFn = vi.fn()
				.mockResolvedValueOnce('good-value')
				.mockRejectedValueOnce(new Error('network error'));
			const logger = { warn: vi.fn(), error: vi.fn() };
			const poller = new PollingFetcher(fetchFn, { intervalMs: 1000 }, logger);

			await poller.getResult();
			expect(poller.value).toBe('good-value');

			await vi.advanceTimersByTimeAsync(1000);
			// Regular errors should still clear the value
			expect(poller.value).toBeUndefined();

			poller.dispose();
		});

		it('should log differently for disabled vs failed polls', async () => {
			const logger = { warn: vi.fn(), error: vi.fn() };
			const fetchFn = vi.fn()
				.mockResolvedValueOnce('v1')
				.mockRejectedValueOnce(makeDisabledError('test'))
				.mockRejectedValueOnce(new Error('network error'));
			const poller = new PollingFetcher(fetchFn, { intervalMs: 1000 }, logger);

			await poller.getResult();

			// Disabled poll
			await vi.advanceTimersByTimeAsync(1000);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('callsite disabled')
			);

			// Regular failure
			await vi.advanceTimersByTimeAsync(1000);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('poll failed')
			);

			poller.dispose();
		});

		it('should continue scheduling polls after disabled rejection', async () => {
			const fetchFn = vi.fn()
				.mockResolvedValueOnce('v1')
				.mockRejectedValueOnce(makeDisabledError('test'))
				.mockResolvedValueOnce('v2');
			const poller = new PollingFetcher(fetchFn, { intervalMs: 1000 });

			await poller.getResult();
			expect(poller.value).toBe('v1');

			// Disabled — value preserved
			await vi.advanceTimersByTimeAsync(1000);
			expect(poller.value).toBe('v1');

			// Re-enabled — new value
			await vi.advanceTimersByTimeAsync(1000);
			expect(poller.value).toBe('v2');

			poller.dispose();
		});
	});
});
