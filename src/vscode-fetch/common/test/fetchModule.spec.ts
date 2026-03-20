/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError, FetchCallsiteDisabledError, FetchModule } from '../fetchModule';
import { FetchModuleConfig, FetchModuleHeaders, FetchModuleOptions, FetchModuleResponse, IExperimentation, IFetcher, IFetchLogger } from '../types';

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

			// Advance past timeout
			await vi.advanceTimersByTimeAsync(501);

			await expect(p2).rejects.toThrow('Concurrency timeout');

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
			const storage = new Map<string, unknown>();
			const mockStorage = {
				get: <T>(key: string, defaultValue?: T) => (storage.get(key) as T) ?? defaultValue,
				update: (key: string, value: unknown) => { storage.set(key, value); return Promise.resolve(); },
			};
			const { fetcher, fetchModule } = createModule({ cache: { storage: mockStorage } });
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200, { get: () => null }, '{"persisted":true}'));

			await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000, persistCachedResponse: true });

			// Storage should have been written
			expect(storage.has('vscode-fetch-cache')).toBe(true);
			const data = storage.get('vscode-fetch-cache') as { entries: Array<[string, unknown]> };
			expect(data.entries).toHaveLength(1);
		});

		it('should restore cache entries from storage on construction', async () => {
			const now = Date.now();
			const storage = new Map<string, unknown>();
			storage.set('vscode-fetch-cache', {
				entries: [['GET:https://example.com:test:no-vary-headers', { status: 200, ok: true, body: '{"restored":true}', expiresAt: now + 60_000 }]],
			});
			const mockStorage = {
				get: <T>(key: string, defaultValue?: T) => (storage.get(key) as T) ?? defaultValue,
				update: (key: string, value: unknown) => { storage.set(key, value); return Promise.resolve(); },
			};

			const { fetcher, fetchModule } = createModule({ cache: { storage: mockStorage } });
			fetcher.fetchFn.mockResolvedValue(new MockResponse(200));

			// Should return cached response without fetching
			const response = await fetchModule.fetch('https://example.com', { callSite: 'test', cacheTtlMs: 60_000 });
			expect(await response.json()).toEqual({ restored: true });
			expect(fetcher.fetchFn).not.toHaveBeenCalled();
		});

		it('should not restore expired entries from storage', async () => {
			const now = Date.now();
			const storage = new Map<string, unknown>();
			storage.set('vscode-fetch-cache', {
				entries: [['GET:https://example.com:test:no-vary-headers', { status: 200, ok: true, body: '"old"', expiresAt: now - 1000 }]],
			});
			const mockStorage = {
				get: <T>(key: string, defaultValue?: T) => (storage.get(key) as T) ?? defaultValue,
				update: (key: string, value: unknown) => { storage.set(key, value); return Promise.resolve(); },
			};

			const { fetcher, fetchModule } = createModule({ cache: { storage: mockStorage } });
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
});
