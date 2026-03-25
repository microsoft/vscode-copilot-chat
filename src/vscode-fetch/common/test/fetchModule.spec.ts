/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError, FetchCallsiteDisabledError, FetchModule } from '../fetchModule';
import { ResponseCache } from '../responseCache';
import { FetchModuleConfig, FetchModuleHeaders, FetchModuleOptions, FetchModuleResponse, ICacheStorage, IExperimentation, IFetcher, IFetchLogger } from '../types';

class MockResponse implements FetchModuleResponse {
	readonly ok: boolean;
	constructor(
		readonly status: number,
		readonly headers: FetchModuleHeaders = { get: () => null },
		private readonly _body: string = '',
	) {
		this.ok = status >= 200 && status < 300;
	}
	async text(): Promise<string> { return this._body; }
	async json(): Promise<unknown> { return JSON.parse(this._body || '{}'); }
}

class MockFetcher implements IFetcher {
	readonly fetchFn = vi.fn<(url: string, options: FetchModuleOptions) => Promise<FetchModuleResponse>>();

	fetch(url: string, options: FetchModuleOptions): Promise<FetchModuleResponse> {
		return this.fetchFn(url, options);
	}
}

class MockExperimentation implements IExperimentation {
	treatmentVariables = new Map<string, string>();
	getTreatmentVariable<T extends boolean | number | string>(name: string): T | undefined {
		return this.treatmentVariables.get(name) as T | undefined;
	}
}

class MockLogger implements IFetchLogger {
	readonly warnMessages: string[] = [];
	readonly errorMessages: (string | Error)[] = [];
	warn(message: string): void { this.warnMessages.push(message); }
	error(message: string | Error): void { this.errorMessages.push(message); }
}

function createModule(config?: FetchModuleConfig) {
	const fetcher = new MockFetcher();
	const experimentation = new MockExperimentation();
	const logger = new MockLogger();
	const fetchModule = new FetchModule(fetcher, experimentation, { logger, ...config });
	return { fetcher, experimentation, logger, fetchModule };
}

function createMockStorage(backing = new Map<string, unknown>()): { storage: ICacheStorage; backing: Map<string, unknown> } {
	const storage: ICacheStorage = {
		get<T>(key: string, defaultValue?: T): T | undefined {
			return (backing.get(key) as T) ?? defaultValue;
		},
		update(key: string, value: unknown) { backing.set(key, value); return Promise.resolve(); },
	} as ICacheStorage;
	return { storage, backing };
}

describe('FetchModule', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// --- Callsite kill-switch ---

	describe('callsite kill-switch', () => {
		it('should pass through requests when callsite is not disabled', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});

		it('should throw FetchCallsiteDisabledError when callsite is disabled', async () => {
			const { fetcher, experimentation, fetchModule } = createModule();
			experimentation.treatmentVariables.set('copilot-fetch-disabled-callsites', 'test,other');

			await expect(fetchModule.fetch('https://example.com', { callSite: 'test' }))
				.rejects.toThrow(FetchCallsiteDisabledError);
			expect(fetcher.fetchFn).not.toHaveBeenCalled();
		});

		it('should not block callsites not in the disabled list', async () => {
			const { fetcher, experimentation, fetchModule } = createModule();
			experimentation.treatmentVariables.set('copilot-fetch-disabled-callsites', 'other-site');
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});
	});

	// --- Retry logic ---

	describe('5xx retry with exponential backoff', () => {
		it('should not retry 5xx when retriesOn5xx is 0', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.status).toBe(500);
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});

		it('should retry 5xx and succeed on subsequent attempt', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn
				.mockResolvedValueOnce(new MockResponse(503))
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 2 });
			await vi.advanceTimersByTimeAsync(1000);

			const response = await promise;
			expect(response.status).toBe(200);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should exhaust retries and return last error response', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn
				.mockResolvedValueOnce(new MockResponse(500))
				.mockResolvedValueOnce(new MockResponse(502))
				.mockResolvedValueOnce(new MockResponse(503));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 2 });
			await vi.advanceTimersByTimeAsync(1000);
			await vi.advanceTimersByTimeAsync(2000);

			const response = await promise;
			expect(response.status).toBe(503);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(3);
		});
	});

	describe('429 rate limiting', () => {
		it('should retry 429 after Retry-After delay', async () => {
			const { fetcher, fetchModule } = createModule();
			const rateLimitResponse = new MockResponse(429, {
				get: name => name === 'Retry-After' ? '2' : null,
			});
			fetcher.fetchFn
				.mockResolvedValueOnce(rateLimitResponse)
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOnRateLimit: 3 });
			await vi.advanceTimersByTimeAsync(2000);

			const response = await promise;
			expect(response.status).toBe(200);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should retry 429 without Retry-After using default 1s delay', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn
				.mockResolvedValueOnce(new MockResponse(429, { get: () => null }))
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOnRateLimit: 3 });
			await vi.advanceTimersByTimeAsync(1000);

			const response = await promise;
			expect(response.status).toBe(200);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should not retry 429 when retriesOnRateLimit is 0', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(429, { get: () => null }));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.status).toBe(429);
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});
	});

	describe('network error retry', () => {
		it('should retry on network errors using 5xx budget', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn
				.mockRejectedValueOnce(new Error('ECONNREFUSED'))
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 1 });
			await vi.advanceTimersByTimeAsync(1000);

			const response = await promise;
			expect(response.status).toBe(200);
		});

		it('should throw network error when no retries remain', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));

			await expect(fetchModule.fetch('https://example.com', { callSite: 'test' }))
				.rejects.toThrow('ECONNREFUSED');
		});
	});

	// --- Circuit breaker ---

	describe('circuit breaker', () => {
		const cbConfig: FetchModuleConfig = {
			circuitBreaker: { threshold: 3, halfOpenAfterMs: 10_000 },
		};

		it('should allow requests when circuit is closed', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});

		it('should trip open after threshold consecutive 5xx failures', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			// 3 failures to trip the circuit
			for (let i = 0; i < 3; i++) {
				await fetchModule.fetch('https://example.com', { callSite: 'test' });
			}

			// 4th request should be rejected by circuit breaker
			await expect(fetchModule.fetch('https://example.com', { callSite: 'test' }))
				.rejects.toThrow(CircuitOpenError);
			// Should not have made a 4th network call
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(3);
		});

		it('should trip open after threshold consecutive network errors', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn.mockRejectedValue(new Error('network down'));

			for (let i = 0; i < 3; i++) {
				await fetchModule.fetch('https://example.com', { callSite: 'test' }).catch(() => { });
			}

			await expect(fetchModule.fetch('https://example.com', { callSite: 'test' }))
				.rejects.toThrow(CircuitOpenError);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(3);
		});

		it('should reset failure count on success', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn
				.mockResolvedValueOnce(new MockResponse(500))
				.mockResolvedValueOnce(new MockResponse(500))
				.mockResolvedValueOnce(new MockResponse(200)) // success resets counter
				.mockResolvedValueOnce(new MockResponse(500))
				.mockResolvedValueOnce(new MockResponse(500));

			for (let i = 0; i < 5; i++) {
				await fetchModule.fetch('https://example.com', { callSite: 'test' });
			}

			// Should not trip because success reset the counter
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});

		it('should allow a probe request after half-open period', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			// Trip the circuit
			for (let i = 0; i < 3; i++) {
				await fetchModule.fetch('https://example.com', { callSite: 'test' });
			}

			// Advance past half-open period
			vi.setSystemTime(Date.now() + 10_001);

			// Probe request should go through
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});

		it('should return to open if half-open probe fails', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			// Trip the circuit
			for (let i = 0; i < 3; i++) {
				await fetchModule.fetch('https://example.com', { callSite: 'test' });
			}

			// Advance past half-open period
			vi.setSystemTime(Date.now() + 10_001);

			// Probe fails (still 500)
			await fetchModule.fetch('https://example.com', { callSite: 'test' });

			// Should be open again
			await expect(fetchModule.fetch('https://example.com', { callSite: 'test' }))
				.rejects.toThrow(CircuitOpenError);
		});

		it('should maintain independent circuits per callsite', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			// Trip circuit for 'site-a'
			for (let i = 0; i < 3; i++) {
				await fetchModule.fetch('https://example.com', { callSite: 'site-a' });
			}

			// 'site-a' is open
			await expect(fetchModule.fetch('https://example.com', { callSite: 'site-a' }))
				.rejects.toThrow(CircuitOpenError);

			// 'site-b' should still work
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));
			const response = await fetchModule.fetch('https://example.com', { callSite: 'site-b' });
			expect(response.ok).toBe(true);
		});

		it('should not treat 4xx as failures', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn.mockResolvedValue(new MockResponse(404));

			// 4xx responses should not trip the circuit
			for (let i = 0; i < 5; i++) {
				await fetchModule.fetch('https://example.com', { callSite: 'test' });
			}

			// Circuit should still be closed
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});

		it('should handle concurrent requests exhausting retries and tripping the circuit', async () => {
			const { fetcher, fetchModule } = createModule({
				circuitBreaker: { threshold: 3, halfOpenAfterMs: 60_000 },
			});
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			// Launch 3 concurrent requests with retries
			const promises = Array.from({ length: 3 }, () =>
				fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 1 })
			);

			// Advance timers to allow all retries
			await vi.advanceTimersByTimeAsync(2000);

			// All should resolve with 500 (retries exhausted)
			const results = await Promise.all(promises);
			for (const r of results) {
				expect(r.status).toBe(500);
			}

			// Circuit should now be open (3 failures >= threshold of 3)
			await expect(fetchModule.fetch('https://example.com', { callSite: 'test' }))
				.rejects.toThrow(CircuitOpenError);
		});

		it('should not get stuck when half-open probe is aborted', async () => {
			const { fetcher, fetchModule } = createModule(cbConfig);
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			// Trip the circuit
			for (let i = 0; i < 3; i++) {
				await fetchModule.fetch('https://example.com', { callSite: 'test' });
			}

			// Advance past half-open period
			vi.setSystemTime(Date.now() + 10_001);

			// Probe request is aborted
			const abortError = new Error('aborted');
			abortError.name = 'AbortError';
			fetcher.fetchFn.mockRejectedValueOnce(abortError);
			await expect(fetchModule.fetch('https://example.com', { callSite: 'test' }))
				.rejects.toThrow('aborted');

			// Advance past half-open period again
			vi.setSystemTime(Date.now() + 10_001);

			// A new probe should be allowed (not stuck)
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});
	});

	// --- Concurrency limiting ---

	describe('concurrency limiting', () => {
		it('should allow requests up to the concurrency limit', async () => {
			const { fetcher, fetchModule } = createModule({ maxConcurrencyPerCallsite: 2 });
			let resolveFirst!: (v: FetchModuleResponse) => void;
			let resolveSecond!: (v: FetchModuleResponse) => void;
			fetcher.fetchFn
				.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }))
				.mockReturnValueOnce(new Promise(r => { resolveSecond = r; }))
				.mockResolvedValue(new MockResponse(200));

			const p1 = fetchModule.fetch('https://example.com', { callSite: 'test' });
			const p2 = fetchModule.fetch('https://example.com', { callSite: 'test' });
			// Third request should be queued (only 2 allowed)
			const p3 = fetchModule.fetch('https://example.com', { callSite: 'test' });

			// Let microtasks settle so fetch calls are dispatched
			await vi.advanceTimersByTimeAsync(0);

			// Only 2 fetch calls should have been made so far
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);

			// Resolve first request → should dequeue third
			resolveFirst(new MockResponse(200));
			await p1;
			await vi.advanceTimersByTimeAsync(0);

			// Now the third should be in-flight
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(3);

			resolveSecond(new MockResponse(200));
			await p2;
			await p3;
		});

		it('should maintain independent limits per callsite', async () => {
			const { fetcher, fetchModule } = createModule({ maxConcurrencyPerCallsite: 1 });
			let resolveA!: (v: FetchModuleResponse) => void;
			fetcher.fetchFn
				.mockReturnValueOnce(new Promise(r => { resolveA = r; }))
				.mockResolvedValue(new MockResponse(200));

			// site-a is at capacity
			const pA = fetchModule.fetch('https://example.com', { callSite: 'site-a' });
			// site-b should not be blocked
			const pB = fetchModule.fetch('https://example.com', { callSite: 'site-b' });

			// Let microtasks settle
			await vi.advanceTimersByTimeAsync(0);

			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);

			resolveA(new MockResponse(200));
			await pA;
			await pB;
		});

		it('should release slot on error', async () => {
			const { fetcher, fetchModule } = createModule({ maxConcurrencyPerCallsite: 1 });
			fetcher.fetchFn
				.mockRejectedValueOnce(new Error('fail'))
				.mockResolvedValue(new MockResponse(200));

			await fetchModule.fetch('https://example.com', { callSite: 'test' }).catch(() => { });

			// Slot should be released, next request should proceed
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});

		it('should reject queued waiters after concurrency timeout', async () => {
			const { fetcher, fetchModule } = createModule({
				maxConcurrencyPerCallsite: 1,
				concurrencyTimeoutMs: 500,
			});
			// Hold the first request in-flight
			let resolveFirst!: (v: FetchModuleResponse) => void;
			fetcher.fetchFn.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }));

			const p1 = fetchModule.fetch('https://example.com', { callSite: 'test' });
			const p2 = fetchModule.fetch('https://example.com', { callSite: 'test' });

			// Capture the rejection expectation before advancing timers
			// so the rejection is not unhandled when the timeout fires.
			const p2Rejection = expect(p2).rejects.toThrow('Concurrency timeout');

			// Advance past timeout
			await vi.advanceTimersByTimeAsync(501);

			await p2Rejection;

			resolveFirst(new MockResponse(200));
			await p1;
		});
	});

	// --- Response caching ---

	describe('response caching', () => {
		it('should cache successful responses and return from cache on second call', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '{"data":1}'));

			const r1 = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });
			const r2 = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });

			expect(await r1.json()).toEqual({ data: 1 });
			expect(await r2.json()).toEqual({ data: 1 });
			// Only one actual fetch
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});

		it('should not cache error responses', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn
				.mockResolvedValueOnce(new MockResponse(500, { get: () => null }, ''))
				.mockResolvedValueOnce(new MockResponse(200, { get: () => null }, 'ok'));

			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });
			const r2 = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });

			expect(await r2.text()).toBe('ok');
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should cache 404 responses by default', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(404, { get: () => null }, 'not found'));

			const r1 = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });
			const r2 = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });

			expect(r1.status).toBe(404);
			expect(r1.ok).toBe(false);
			expect(await r1.text()).toBe('not found');
			expect(await r2.text()).toBe('not found');
			// Only one actual fetch — second hit the cache
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});

		it('should persist cached non-OK responses across instances', async () => {
			const backing = new Map<string, unknown>();
			const { storage: s1 } = createMockStorage(backing);
			const { fetcher: f1, fetchModule: fm1 } = createModule({ cache: { storage: s1 } });
			f1.fetchFn.mockResolvedValue(new MockResponse(404, { get: () => null }, 'not found'));

			await fm1.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000, persistCachedResponse: true });

			// Verify storage was written before creating new instance
			expect(backing.has('vscode-fetch-cache')).toBe(true);

			// New instance restores from the same backing storage
			const { storage: s2 } = createMockStorage(backing);
			const { fetcher: f2, fetchModule: fm2 } = createModule({ cache: { storage: s2 } });
			f2.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, 'ok'));

			const r = await fm2.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000, persistCachedResponse: true });
			expect(r.status).toBe(404);
			expect(await r.text()).toBe('not found');
			// Should not have fetched — served from persisted cache
			expect(f2.fetchFn).not.toHaveBeenCalled();
			fm2.dispose();
		});

		it('should evict expired cache entries', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, 'fresh'));

			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });

			// Advance past TTL
			vi.setSystemTime(Date.now() + 1001);

			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, 'new'));
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });

			expect(await response.text()).toBe('new');
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should not cache when cacheTtlMs is 0 or omitted', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			await fetchModule.fetch('https://example.com', { callSite: 'test' });
			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 0 });

			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should use different cache keys for different urls', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, 'a'));

			await fetchModule.fetch('https://a.com', { callSite: 'test', cacheTtlMs: 5000 });

			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, 'b'));
			await fetchModule.fetch('https://b.com', { callSite: 'test', cacheTtlMs: 5000 });

			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should bypass cache and hit circuit breaker when cache misses', async () => {
			const { fetcher, fetchModule } = createModule({
				circuitBreaker: { threshold: 1, halfOpenAfterMs: 60_000 },
			});
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			// First call: cache miss → fetch → 500 → trips circuit
			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });

			// Second call: cache miss (500 not cached) → circuit open
			await expect(fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 }))
				.rejects.toThrow(CircuitOpenError);
		});
	});

	// --- Stale-while-revalidate ---

	describe('stale-while-revalidate', () => {
		it('should return stale cached entry and trigger background refetch', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"v1"'));

			// Prime the cache
			await fetchModule.fetch('https://example.com', {
				callSite: 'test', cacheTtlMs: 1000, staleWhileRevalidateMs: 5000,
			});

			// Expire the cache entry
			vi.setSystemTime(Date.now() + 1500);

			// Set up fresh response for background refetch
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"v2"'));

			// Should return the stale value immediately
			const staleResponse = await fetchModule.fetch('https://example.com', {
				callSite: 'test', cacheTtlMs: 1000, staleWhileRevalidateMs: 5000,
			});
			expect(await staleResponse.json()).toBe('v1');

			// Let the background refetch complete
			await vi.advanceTimersByTimeAsync(0);

			// Now the fresh value should be cached
			const freshResponse = await fetchModule.fetch('https://example.com', {
				callSite: 'test', cacheTtlMs: 1000, staleWhileRevalidateMs: 5000,
			});
			expect(await freshResponse.json()).toBe('v2');
		});

		it('should not trigger duplicate background refetches for the same key', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"v1"'));

			await fetchModule.fetch('https://example.com', {
				callSite: 'test', cacheTtlMs: 1000, staleWhileRevalidateMs: 5000,
			});

			vi.setSystemTime(Date.now() + 1500);

			let resolveRefetch!: (v: FetchModuleResponse) => void;
			fetcher.fetchFn.mockReturnValueOnce(new Promise(r => { resolveRefetch = r; }));

			// Two requests while stale
			await fetchModule.fetch('https://example.com', {
				callSite: 'test', cacheTtlMs: 1000, staleWhileRevalidateMs: 5000,
			});
			await fetchModule.fetch('https://example.com', {
				callSite: 'test', cacheTtlMs: 1000, staleWhileRevalidateMs: 5000,
			});

			// The fetcher should only have been called twice: once for prime, once for background refetch
			// (not a third time for the second stale request)
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);

			resolveRefetch(new MockResponse(200, { get: () => null }, '"v2"'));
			await vi.advanceTimersByTimeAsync(0);
		});
	});

	// --- No config ---

	describe('no config', () => {
		it('should work without any config', async () => {
			const fetcher = new MockFetcher();
			const experimentation = new MockExperimentation();
			const fetchModule = new FetchModule(fetcher, experimentation);
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});
	});

	// --- Dispose ---

	describe('dispose', () => {
		it('should clear cache and circuit breaker state on dispose', async () => {
			const { fetcher, fetchModule } = createModule({
				circuitBreaker: { threshold: 1, halfOpenAfterMs: 60_000 },
			});
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, 'body'));

			// Populate cache
			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000 });
			expect(fetchModule.cache.size).toBe(1);

			fetchModule.dispose();
			expect(fetchModule.cache.size).toBe(0);
		});
	});

	// --- Persistent cache ---

	describe('persistent cache', () => {
		it('should persist cache entries to storage', async () => {
			const { storage, backing } = createMockStorage();
			const { fetcher, fetchModule } = createModule({ cache: { storage } });
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '{"persisted":true}'));

			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000, persistCachedResponse: true });

			// Storage should have been written
			expect(backing.has('vscode-fetch-cache')).toBe(true);
			const data = backing.get('vscode-fetch-cache') as { entries: Array<[string, unknown]> };
			expect(data.entries).toHaveLength(1);
		});

		it('should restore cache entries from storage on construction', async () => {
			const now = Date.now();
			const backing = new Map<string, unknown>();
			backing.set('vscode-fetch-cache', {
				entries: [['GET:https://example.com:test:no-vary-headers', { status: 200, ok: true, body: '{"restored":true}', expiresAt: now + 60_000 }]],
			});
			const { storage } = createMockStorage(backing);

			const { fetcher, fetchModule } = createModule({ cache: { storage } });
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			// Should return cached response without fetching
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000 });
			expect(await response.json()).toEqual({ restored: true });
			expect(fetcher.fetchFn).not.toHaveBeenCalled();
		});

		it('should not restore expired entries from storage', async () => {
			const now = Date.now();
			const backing = new Map<string, unknown>();
			backing.set('vscode-fetch-cache', {
				entries: [['GET:https://example.com:test:no-vary-headers', { status: 200, ok: true, body: '"old"', expiresAt: now - 1000 }]],
			});
			const { storage } = createMockStorage(backing);

			const { fetcher, fetchModule } = createModule({ cache: { storage } });
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"fresh"'));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000 });
			expect(await response.json()).toBe('fresh');
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});
	});

	// --- GitHub throttling ---

	describe('github throttling', () => {
		it('should record and use quota headers for GitHub URLs', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, {
				get: (name: string) => {
					if (name === 'x-github-quota-bucket-name') { return 'search-api'; }
					if (name === 'x-github-total-quota-used') { return '50'; }
					return null;
				},
			}));

			const response = await fetchModule.fetch('https://api.github.com/repos', { callSite: 'test' });
			expect(response.ok).toBe(true);
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});

		it('should not apply GitHub throttling for non-GitHub URLs', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});

		it('should not apply GitHub throttling when disabled', async () => {
			const { fetcher, fetchModule } = createModule({ githubThrottling: false });
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, {
				get: (name: string) => {
					if (name === 'x-github-quota-bucket-name') { return 'bucket'; }
					if (name === 'x-github-total-quota-used') { return '90'; }
					return null;
				},
			}));

			// Should not throttle even at high quota usage since throttling is disabled
			const response = await fetchModule.fetch('https://api.github.com/repos', { callSite: 'test' });
			expect(response.ok).toBe(true);
		});
	});

	// --- Polling fetcher ---

	describe('createPollingFetcher', () => {
		it('should create a poller that fetches values', async () => {
			const { fetchModule } = createModule();

			const fetchFn = vi.fn().mockResolvedValue('result');
			const poller = fetchModule.createPollingFetcher(fetchFn, {
				intervalMs: 5000,
			});

			await poller.getResult();
			expect(fetchFn).toHaveBeenCalledOnce();
			expect(poller.value).toBe('result');

			poller.dispose();
		});

		it('should preserve value when fetchFn throws FetchCallsiteDisabledError', async () => {
			const { fetchModule } = createModule();

			const fetchFn = vi.fn().mockResolvedValue('good-value');
			const poller = fetchModule.createPollingFetcher(fetchFn, {
				intervalMs: 5000,
			});

			await poller.getResult();
			expect(poller.value).toBe('good-value');

			// Simulate the inner fetch throwing FetchCallsiteDisabledError
			fetchFn.mockRejectedValue(new FetchCallsiteDisabledError('some-callsite'));

			// Poll triggers, error is caught, value is preserved
			await vi.advanceTimersByTimeAsync(5000);
			expect(poller.value).toBe('good-value');

			poller.dispose();
		});
	});

	// --- Polling fetch (URL-based) ---

	describe('createPollingFetch', () => {
		it('should poll through the FetchModule pipeline', async () => {
			const { fetchModule, fetcher } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '{"value":1}'));

			const poller = fetchModule.createPollingFetch(
				() => ({ url: 'https://api.example.com/data', options: { callSite: 'poll-test' } }),
				async response => (await response.json() as { value: number }).value,
				{ intervalMs: 5000 },
			);

			const result = await poller.getResult();
			expect(result).toBe(1);
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
			expect(fetcher.fetchFn).toHaveBeenCalledWith(
				'https://api.example.com/data',
				expect.objectContaining({ callSite: 'poll-test' }),
			);

			poller.dispose();
		});

		it('should apply caching and conditional requests (ETags/304)', async () => {
			const { fetchModule, fetcher } = createModule();

			// First response — returns an ETag
			const etagHeaders: FetchModuleHeaders = {
				get: (name: string) => name.toLowerCase() === 'etag' ? '"abc123"' : null,
			};
			fetcher.fetchFn.mockResolvedValueOnce(new MockResponse(200, etagHeaders, '{"v":1}'));

			const poller = fetchModule.createPollingFetch(
				() => ({
					url: 'https://api.example.com/data',
					options: { callSite: 'etag-test', cacheTtlMs: 1 }, // very short TTL so it expires before next poll
				}),
				async response => (await response.json() as { v: number }).v,
				{ intervalMs: 5000 },
			);

			const r1 = await poller.getResult();
			expect(r1).toBe(1);

			// Second poll — cache expired, should send If-None-Match and get 304
			fetcher.fetchFn.mockResolvedValueOnce(new MockResponse(304));
			await vi.advanceTimersByTimeAsync(5000);

			// The poller should have used the cached value via 304
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
			const secondCallOpts = fetcher.fetchFn.mock.calls[1][1];
			expect(secondCallOpts.headers?.['If-None-Match']).toBe('"abc123"');

			poller.dispose();
		});

		it('should support async buildRequest for dynamic headers', async () => {
			const { fetchModule, fetcher } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"ok"'));

			let tokenCounter = 0;
			const poller = fetchModule.createPollingFetch(
				async () => {
					const token = `token-${++tokenCounter}`;
					return {
						url: 'https://api.example.com/data',
						options: {
							callSite: 'dynamic-test',
							headers: { 'Authorization': `Bearer ${token}` },
						},
					};
				},
				async response => response.json() as Promise<string>,
				{ intervalMs: 5000 },
			);

			await poller.getResult();
			expect(fetcher.fetchFn.mock.calls[0][1].headers?.['Authorization']).toBe('Bearer token-1');

			await vi.advanceTimersByTimeAsync(5000);
			expect(fetcher.fetchFn.mock.calls[1][1].headers?.['Authorization']).toBe('Bearer token-2');

			poller.dispose();
		});

		it('should benefit from retries configured in fetch options', async () => {
			const { fetchModule, fetcher } = createModule();

			// First call: 500 → retried → 200
			fetcher.fetchFn
				.mockResolvedValueOnce(new MockResponse(500))
				.mockResolvedValueOnce(new MockResponse(200, { get: () => null }, '"recovered"'));

			const poller = fetchModule.createPollingFetch(
				() => ({
					url: 'https://api.example.com/data',
					options: { callSite: 'retry-test', retriesOn5xx: 1 },
				}),
				async response => response.json() as Promise<string>,
				{ intervalMs: 5000 },
			);

			// Advance timers to allow the retry backoff sleep to complete
			const resultPromise = poller.getResult();
			await vi.advanceTimersByTimeAsync(5000);
			const result = await resultPromise;
			expect(result).toBe('recovered');
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);

			poller.dispose();
		});
	});

	// --- AbortSignal / Cancellation ---

	describe('abort signal', () => {
		it('should throw immediately when signal is already aborted', async () => {
			const { fetchModule } = createModule();
			const controller = new AbortController();
			controller.abort();

			await expect(fetchModule.fetch('https://example.com', { callSite: 'test', signal: controller.signal }))
				.rejects.toThrow();
		});

		it('should abort during retry backoff sleep', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(500));

			const controller = new AbortController();
			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 3, signal: controller.signal });

			// Let the first fetch complete and start the backoff sleep
			await vi.advanceTimersByTimeAsync(0);

			// Attach rejection handler before aborting to prevent unhandled rejection
			const rejected = expect(promise).rejects.toThrow();

			// Abort mid-sleep
			controller.abort();
			await vi.advanceTimersByTimeAsync(0);

			await rejected;
			// Only one actual fetch call — retry was aborted
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});

		it('should abort while waiting in concurrency queue', async () => {
			const { fetcher, fetchModule } = createModule({ maxConcurrencyPerCallsite: 1 });
			let resolveFirst!: (v: FetchModuleResponse) => void;
			fetcher.fetchFn.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }));

			// First request holds the slot
			const p1 = fetchModule.fetch('https://example.com', { callSite: 'test' });

			// Second request waits in queue with abort signal
			const controller = new AbortController();
			const p2 = fetchModule.fetch('https://example.com', { callSite: 'test', signal: controller.signal });

			await vi.advanceTimersByTimeAsync(0);

			// Abort the queued request
			controller.abort();
			await expect(p2).rejects.toThrow();

			// First request should still work
			resolveFirst(new MockResponse(200));
			const r1 = await p1;
			expect(r1.ok).toBe(true);
		});

		it('should not retry AbortError from fetch', async () => {
			const { fetcher, fetchModule } = createModule();
			const abortError = new DOMException('The operation was aborted.', 'AbortError');
			fetcher.fetchFn.mockRejectedValue(abortError);

			await expect(fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 3 }))
				.rejects.toThrow('The operation was aborted.');
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});
	});

	// --- Request deduplication ---

	describe('request deduplication', () => {
		it('should coalesce concurrent identical GET requests', async () => {
			const { fetcher, fetchModule } = createModule();
			let resolveRequest!: (v: FetchModuleResponse) => void;
			fetcher.fetchFn.mockReturnValueOnce(new Promise(r => { resolveRequest = r; }));

			const opts = { callSite: 'test', cacheTtlMs: 5000 };
			const p1 = fetchModule.fetch('https://example.com', opts);
			const p2 = fetchModule.fetch('https://example.com', opts);
			const p3 = fetchModule.fetch('https://example.com', opts);

			// Only one fetch call should have been made
			await vi.advanceTimersByTimeAsync(0);
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();

			resolveRequest(new MockResponse(200, { get: () => null }, '"shared"'));

			const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
			expect(await r1.json()).toBe('shared');
			expect(await r2.json()).toBe('shared');
			expect(await r3.json()).toBe('shared');
		});

		it('should not deduplicate requests with different URLs', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"ok"'));

			const opts = { callSite: 'test', cacheTtlMs: 5000 };
			await Promise.all([
				fetchModule.fetch('https://a.com', opts),
				fetchModule.fetch('https://b.com', opts),
			]);

			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should not deduplicate non-cacheable requests', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			// No cacheTtlMs = no dedup
			await Promise.all([
				fetchModule.fetch('https://example.com', { callSite: 'test' }),
				fetchModule.fetch('https://example.com', { callSite: 'test' }),
			]);

			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should return independent re-readable responses for non-OK deduped requests', async () => {
			const { fetcher, fetchModule } = createModule();
			let resolveRequest!: (v: FetchModuleResponse) => void;
			fetcher.fetchFn.mockReturnValueOnce(new Promise(r => { resolveRequest = r; }));

			const opts = { callSite: 'test', cacheTtlMs: 5000 };
			const p1 = fetchModule.fetch('https://example.com', opts);
			const p2 = fetchModule.fetch('https://example.com', opts);

			await vi.advanceTimersByTimeAsync(0);
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();

			resolveRequest(new MockResponse(404, { get: () => null }, '{"error":"not found"}'));

			const [r1, r2] = await Promise.all([p1, p2]);
			// Both callers should be able to independently read the body
			expect(r1.status).toBe(404);
			expect(r2.status).toBe(404);
			expect(await r1.text()).toBe('{"error":"not found"}');
			expect(await r2.text()).toBe('{"error":"not found"}');
		});

		it('should clean up inflight map after request completes', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"ok"'));

			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });

			// After completion, subsequent request should be served from cache
			// (not dedup — proving the inflight entry was cleaned up)
			const r2 = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 5000 });
			expect(await r2.json()).toBe('ok');
			expect(fetcher.fetchFn).toHaveBeenCalledOnce(); // served from cache
		});
	});

	// --- 503 Retry-After ---

	describe('503 with Retry-After', () => {
		it('should respect Retry-After header on 503', async () => {
			const { fetcher, fetchModule } = createModule();
			const retryResponse = new MockResponse(503, {
				get: name => name === 'Retry-After' ? '3' : null,
			});
			fetcher.fetchFn
				.mockResolvedValueOnce(retryResponse)
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 2 });
			await vi.advanceTimersByTimeAsync(3000);

			const response = await promise;
			expect(response.status).toBe(200);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should fall back to exponential backoff on 503 without Retry-After', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn
				.mockResolvedValueOnce(new MockResponse(503, { get: () => null }))
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 2 });
			// Exponential backoff starts at ~1s for first attempt
			await vi.advanceTimersByTimeAsync(1000);

			const response = await promise;
			expect(response.status).toBe(200);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});
	});

	// --- Retry-After date format ---

	describe('Retry-After HTTP-date format', () => {
		it('should parse HTTP-date format in Retry-After header', async () => {
			const { fetcher, fetchModule } = createModule();
			// Set a Retry-After date 5 seconds in the future
			const futureDate = new Date(Date.now() + 5000).toUTCString();
			const rateLimitResponse = new MockResponse(429, {
				get: name => name === 'Retry-After' ? futureDate : null,
			});
			fetcher.fetchFn
				.mockResolvedValueOnce(rateLimitResponse)
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOnRateLimit: 1 });
			await vi.advanceTimersByTimeAsync(5000);

			const response = await promise;
			expect(response.status).toBe(200);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});
	});

	// --- Conditional requests (ETag / If-None-Match) ---

	describe('conditional requests', () => {
		it('should send If-None-Match when cached entry has ETag', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValueOnce(new MockResponse(200, {
				get: name => {
					if (name === 'etag') { return '"abc123"'; }
					return null;
				},
			}, '{"data":"v1"}'));

			// Prime the cache
			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });

			// Expire the cache
			vi.setSystemTime(Date.now() + 1500);

			// Next request should include If-None-Match
			fetcher.fetchFn.mockResolvedValueOnce(new MockResponse(304, { get: () => null }));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });
			expect(await response.json()).toEqual({ data: 'v1' });

			// Check that the second fetch was called with If-None-Match header
			const secondCallOptions = fetcher.fetchFn.mock.calls[1][1];
			expect(secondCallOptions.headers?.['If-None-Match']).toBe('"abc123"');
		});

		it('should send If-Modified-Since when cached entry has Last-Modified', async () => {
			const { fetcher, fetchModule } = createModule();
			const lastMod = 'Thu, 01 Jan 2026 00:00:00 GMT';
			fetcher.fetchFn.mockResolvedValueOnce(new MockResponse(200, {
				get: name => {
					if (name === 'last-modified') { return lastMod; }
					return null;
				},
			}, '{"data":"v1"}'));

			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });
			vi.setSystemTime(Date.now() + 1500);

			fetcher.fetchFn.mockResolvedValueOnce(new MockResponse(304, { get: () => null }));
			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });

			const secondCallOptions = fetcher.fetchFn.mock.calls[1][1];
			expect(secondCallOptions.headers?.['If-Modified-Since']).toBe(lastMod);
		});

		it('should refresh TTL and return cached body on 304', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValueOnce(new MockResponse(200, {
				get: name => name === 'etag' ? '"v1"' : null,
			}, '"original"'));

			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });

			// Expire cache
			vi.setSystemTime(Date.now() + 1500);

			fetcher.fetchFn.mockResolvedValueOnce(new MockResponse(304, { get: () => null }));

			const response = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });
			expect(await response.json()).toBe('original');

			// Verify TTL was refreshed — should serve from cache without network
			const response2 = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 1000 });
			expect(await response2.json()).toBe('original');
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2); // original + 304, then cache hit
		});
	});

	// --- Transient error classification ---

	describe('transient network error classification', () => {
		it('should retry transient network errors (ECONNRESET)', async () => {
			const { fetcher, fetchModule } = createModule();
			const transientError = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
			fetcher.fetchFn
				.mockRejectedValueOnce(transientError)
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 1 });
			await vi.advanceTimersByTimeAsync(1000);

			const response = await promise;
			expect(response.status).toBe(200);
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});

		it('should retry transient network errors (ETIMEDOUT)', async () => {
			const { fetcher, fetchModule } = createModule();
			const transientError = Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' });
			fetcher.fetchFn
				.mockRejectedValueOnce(transientError)
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 1 });
			await vi.advanceTimersByTimeAsync(1000);

			const response = await promise;
			expect(response.status).toBe(200);
		});

		it('should not retry non-transient errors (ERR_TLS_CERT_ALTNAME_INVALID)', async () => {
			const { fetcher, fetchModule } = createModule();
			const permanentError = Object.assign(new Error('Certificate error'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
			fetcher.fetchFn.mockRejectedValue(permanentError);

			await expect(fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 3 }))
				.rejects.toThrow('Certificate error');
			// Should not have retried — only one call
			expect(fetcher.fetchFn).toHaveBeenCalledOnce();
		});

		it('should retry errors with no code (generic network errors)', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn
				.mockRejectedValueOnce(new Error('fetch failed'))
				.mockResolvedValueOnce(new MockResponse(200));

			const promise = fetchModule.fetch('https://example.com', { callSite: 'test', retriesOn5xx: 1 });
			await vi.advanceTimersByTimeAsync(1000);

			const response = await promise;
			expect(response.status).toBe(200);
		});
	});

	// --- Cache invalidation ---

	describe('cache invalidation', () => {
		it('should delete a specific cache entry', async () => {
			const { fetcher, fetchModule } = createModule();
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"cached"'));

			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000 });
			expect(fetchModule.cache.size).toBe(1);

			const key = ResponseCache.key('GET', 'https://example.com', 'test');
			expect(fetchModule.cache.delete(key)).toBe(true);
			expect(fetchModule.cache.size).toBe(0);

			// Next fetch should go to network
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '"fresh"'));
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000 });
			expect(await response.json()).toBe('fresh');
			expect(fetcher.fetchFn).toHaveBeenCalledTimes(2);
		});
	});
});
