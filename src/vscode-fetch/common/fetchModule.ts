/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CircuitBreakerRegistry, CircuitOpenError } from './circuitBreaker';
import { GitHubThrottlerRegistry, isGitHubUrl } from './githubThrottler';
import { PollingFetcher } from './pollingFetcher';
import { CachedFetchResponse, ResponseCache } from './responseCache';
import { FetchModuleConfig, FetchModuleOptions, FetchModuleResponse, IDisposable, IExperimentation, IFetcher, PollingFetcherConfig } from './types';

export { CircuitOpenError, PollingFetcher };

/**
 * The treatment variable name used to retrieve the list of disabled callsites.
 * The value should be a comma-separated string of callsite identifiers.
 */
const DISABLED_CALLSITES_TREATMENT = 'copilot-fetch-disabled-callsites';

/** Maximum wait time for a Retry-After header, in milliseconds. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Maximum backoff time for exponential backoff on 5xx errors, in milliseconds. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Network error codes that are transient and worth retrying.
 * Non-transient errors (e.g. certificate failures, invalid URLs) are
 * thrown immediately without consuming retries.
 */
const TRANSIENT_ERROR_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ECONNABORTED',
	'EPIPE',
	'ETIMEDOUT',
	'ENETUNREACH',
	'ENETDOWN',
	'EHOSTUNREACH',
	'EAI_AGAIN',       // DNS temporary failure
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET',
]);

/**
 * Error thrown when a fetch request is blocked because its callsite
 * has been disabled via an experiment treatment.
 */
export class FetchCallsiteDisabledError extends Error {
	constructor(readonly callSite: string) {
		super(`Fetch requests from callsite '${callSite}' are currently disabled by experiment`);
		this.name = 'FetchCallsiteDisabledError';
	}
}

/**
 * A self-contained fetch module that wraps an underlying fetcher with
 * comprehensive resilience features:
 *
 * - **Callsite kill-switch**: Experiment-based per-callsite disabling.
 * - **Circuit breaker**: Per-callsite circuit breaker that trips after consecutive
 *   failures and rejects requests until the service recovers (opt-in via config).
 * - **Concurrency limiting**: Per-callsite limit on in-flight requests to prevent
 *   slamming endpoints (opt-in via config).
 * - **Retry with backoff**: Exponential backoff on 5xx errors (1s, 2s, 4s, …, capped
 *   at 30s) and transient network errors (opt-in per request).
 * - **Rate limit handling**: Respects {@link Retry-After} headers on 429 and 503
 *   responses (supports both integer seconds and HTTP-date formats, capped at 60s).
 * - **Response caching**: TTL-based cache for successful responses (opt-in per request).
 * - **Conditional requests**: Sends If-None-Match / If-Modified-Since headers when
 *   cached ETags or Last-Modified values are available, handling 304 responses.
 * - **Request deduplication**: Concurrent identical GET requests share a single
 *   in-flight promise to avoid redundant network calls.
 * - **Cancellation**: Supports {@link AbortSignal} for cancelling requests, retries,
 *   and concurrency waits.
 */
export class FetchModule<TOptions extends FetchModuleOptions = FetchModuleOptions, TResponse extends FetchModuleResponse = FetchModuleResponse> implements IDisposable {
	private readonly _config: FetchModuleConfig | undefined;
	private readonly _circuitBreakers?: CircuitBreakerRegistry;
	private readonly _cache: ResponseCache;
	private readonly _maxConcurrency?: number;
	private readonly _concurrencyTimeoutMs?: number;
	private readonly _concurrencyState = new Map<string, { inFlight: number; queue: Array<{ grant: () => void; reject: (e: Error) => void; timerId?: ReturnType<typeof setTimeout> }> }>();
	private readonly _githubThrottler?: GitHubThrottlerRegistry;
	private readonly _revalidating = new Set<string>();
	/** In-flight GET requests keyed by cache key, used for request deduplication. */
	private readonly _inflight = new Map<string, Promise<TResponse | CachedFetchResponse>>();
	private _disposed = false;

	constructor(
		private readonly _fetcher: IFetcher<TOptions, TResponse>,
		private readonly _experimentation: IExperimentation,
		config?: FetchModuleConfig,
	) {
		this._config = config;
		if (config?.circuitBreaker) {
			this._circuitBreakers = new CircuitBreakerRegistry(config.circuitBreaker, config.logger);
		}
		this._cache = new ResponseCache(config?.cache);
		this._maxConcurrency = config?.maxConcurrencyPerCallsite;
		this._concurrencyTimeoutMs = config?.concurrencyTimeoutMs;
		if (config?.githubThrottling !== false) {
			this._githubThrottler = new GitHubThrottlerRegistry(
				config?.githubThrottling?.target,
				config?.logger,
			);
		}
	}

	/**
	 * Dispose all internal state (circuit breakers, cache, pending concurrency queues).
	 */
	dispose(): void {
		this._disposed = true;
		this._circuitBreakers?.dispose();
		this._cache.clear();
		// Reject queued concurrency waiters so they fail fast instead of hanging
		const disposeError = new Error('FetchModule disposed while waiting for concurrency slot');
		for (const state of this._concurrencyState.values()) {
			for (const waiter of state.queue) {
				if (waiter.timerId !== undefined) {
					clearTimeout(waiter.timerId);
				}
				waiter.reject(disposeError);
			}
		}
		this._concurrencyState.clear();
		this._githubThrottler?.clear();
		this._revalidating.clear();
		this._inflight.clear();
	}

	/**
	 * The response cache used by this module.
	 * Can be used directly for manual cache management.
	 */
	get cache(): ResponseCache {
		return this._cache;
	}

	/**
	 * Creates a background polling utility that periodically invokes the given
	 * function and exposes the latest result as an observable value.
	 *
	 * The logger configured on this module is automatically forwarded to the
	 * poller. The returned {@link PollingFetcher} is disposable and must be
	 * cleaned up by the caller.
	 */
	createPollingFetcher<T>(fetchFn: () => Promise<T>, options: PollingFetcherConfig<T>): PollingFetcher<T> {
		return new PollingFetcher(fetchFn, options, this._config?.logger);
	}

	/**
	 * Performs a fetch request with all configured protections:
	 *
	 * 1. Callsite kill-switch check
	 * 2. Cache lookup (if {@link FetchModuleOptions.cacheTtlMs} is set)
	 * 3. Circuit breaker check
	 * 4. Concurrency gating
	 * 5. GitHub quota throttling (for github.com / ghe.com URLs)
	 * 6. Fetch with retry logic
	 * 7. Circuit breaker recording
	 * 8. Cache storage (if {@link FetchModuleOptions.cacheTtlMs} is set and response is ok)
	 *
	 * @throws {FetchCallsiteDisabledError} if the callsite is disabled by experiment.
	 * @throws {CircuitOpenError} if the callsite's circuit breaker is open.
	 */
	async fetch(url: string, options: TOptions): Promise<TResponse | CachedFetchResponse> {
		if (this._disposed) {
			throw new Error('FetchModule has been disposed');
		}

		options.signal?.throwIfAborted();

		if (this.isCallsiteDisabled(options.callSite)) {
			throw new FetchCallsiteDisabledError(options.callSite);
		}

		// Check cache — caching is restricted to GET requests
		const cacheTtl = options.cacheTtlMs;
		const isCacheable = cacheTtl && cacheTtl > 0 && (options.method ?? 'GET').toUpperCase() === 'GET';
		let cacheKey: string | undefined;
		if (isCacheable) {
			cacheKey = ResponseCache.key(options.method, url, options.callSite, options.headers);
			if (!options._skipCacheRead) {
				const cached = this._cache.get(cacheKey);
				if (cached) {
					return cached;
				}

				// Stale-while-revalidate: return stale entry and background-refresh
				if (options.staleWhileRevalidateMs && options.staleWhileRevalidateMs > 0) {
					const stale = this._cache.getStale(cacheKey, options.staleWhileRevalidateMs);
					if (stale) {
						if (!this._revalidating.has(cacheKey)) {
							this._revalidating.add(cacheKey);
							this._revalidateInBackground(url, options, cacheKey, cacheTtl);
						}
						return stale;
					}
				}

				// Request deduplication: if an identical GET is already in-flight,
				// piggyback on that promise instead of issuing a new request.
				const inflight = this._inflight.get(cacheKey);
				if (inflight) {
					return inflight;
				}
			}
		}

		const promise = this._fetchInner(url, options, isCacheable, cacheKey, cacheTtl);

		// Register the in-flight promise for deduplication (GET only, not skip-cache)
		if (isCacheable && cacheKey && !options._skipCacheRead) {
			this._inflight.set(cacheKey, promise);
			void promise.finally(() => this._inflight.delete(cacheKey));
		}

		return promise;
	}

	/**
	 * Inner fetch logic separated from the public `fetch()` to support
	 * request deduplication — the dedup map wraps this promise.
	 */
	private async _fetchInner(
		url: string,
		options: TOptions,
		isCacheable: boolean | 0 | undefined,
		cacheKey: string | undefined,
		cacheTtl: number | undefined,
	): Promise<TResponse | CachedFetchResponse> {
		// Circuit breaker (fast check before acquiring resources)
		this._circuitBreakers?.checkCallsite(options.callSite);

		// Concurrency gate
		await this._acquireConcurrency(options.callSite, options.signal);

		let ghSlot: { release: () => void } | undefined;

		try {
			options.signal?.throwIfAborted();

			// GitHub quota throttling
			ghSlot = this._githubThrottler && isGitHubUrl(url)
				? await this._githubThrottler.acquireSlot(options.method, url)
				: undefined;

			// Recheck circuit breaker in case it tripped during waits
			if (this._circuitBreakers?.isOpen(options.callSite)) {
				throw new CircuitOpenError(options.callSite);
			}

			options.signal?.throwIfAborted();

			// Inject conditional request headers when we have cached validators
			let effectiveOptions = options;
			if (isCacheable && cacheKey) {
				const conditionalHeaders = this._cache.getConditionalHeaders(cacheKey);
				if (conditionalHeaders) {
					effectiveOptions = {
						...options,
						headers: { ...options.headers, ...conditionalHeaders },
					} as TOptions;
				}
			}

			const response = await this._fetchWithRetries(
				url,
				effectiveOptions,
				options.retriesOn5xx ?? 0,
				options.retriesOnRateLimit ?? 0,
			);

			// Record quota usage for GitHub APIs
			if (ghSlot) {
				this._githubThrottler!.recordResponse(options.method, url, response);
			}

			// Handle 304 Not Modified — refresh the cached entry's TTL
			if (response.status === 304 && isCacheable && cacheKey && cacheTtl) {
				const refreshed = this._cache.refreshTtl(cacheKey, cacheTtl);
				if (refreshed) {
					this._circuitBreakers?.recordSuccess(options.callSite);
					return refreshed;
				}
			}

			// Record success/failure in circuit breaker.
			// 5xx after retries exhausted = failure. Everything else (including 4xx) = success.
			if (response.status >= 500 && response.status < 600) {
				this._circuitBreakers?.recordFailure(options.callSite);
			} else {
				this._circuitBreakers?.recordSuccess(options.callSite);
			}

			// Cache successful responses
			if (isCacheable && cacheKey && cacheTtl && response.ok) {
				const cachedResponse = await this._cache.set(cacheKey, response, cacheTtl, options.persistCachedResponse);
				return cachedResponse;
			}

			return response;
		} catch (e) {
			// Don't double-count circuit breaker failures from the recheck
			if (!(e instanceof CircuitOpenError)) {
				this._circuitBreakers?.recordFailure(options.callSite);
			}
			throw e;
		} finally {
			ghSlot?.release();
			this._releaseConcurrency(options.callSite);
		}
	}

	/**
	 * Checks whether a given callsite is currently disabled via experiment.
	 */
	isCallsiteDisabled(callSite: string): boolean {
		const disabledCallsites = this._experimentation.getTreatmentVariable<string>(DISABLED_CALLSITES_TREATMENT);
		if (!disabledCallsites) {
			return false;
		}
		return disabledCallsites.split(',').some(s => s.trim() === callSite);
	}

	// --- Retry logic ---

	private async _fetchWithRetries(
		url: string,
		options: TOptions,
		retriesOn5xxRemaining: number,
		retriesOnRateLimitRemaining: number,
	): Promise<TResponse> {
		let response: TResponse;
		try {
			response = await this._fetcher.fetch(url, options);
		} catch (e) {
			// Abort errors are never retried
			if (e instanceof Error && e.name === 'AbortError') {
				throw e;
			}

			// Only retry transient network errors
			if (retriesOn5xxRemaining > 0 && isTransientNetworkError(e)) {
				const backoffMs = getBackoffMs(options.retriesOn5xx ?? 0, retriesOn5xxRemaining);
				this._config?.logger?.warn(`Fetch '${options.callSite}': network error, retrying in ${backoffMs}ms (${retriesOn5xxRemaining - 1} retries remaining)`);
				await abortableSleep(backoffMs, options.signal);
				return this._fetchWithRetries(url, options, retriesOn5xxRemaining - 1, retriesOnRateLimitRemaining);
			}
			throw e;
		}

		if (response.ok || response.status === 304) {
			return response;
		}

		// Handle 429 rate limiting
		if (response.status === 429 && retriesOnRateLimitRemaining > 0) {
			const waitMs = parseRetryAfterMs(response.headers) ?? 1000;
			const effectiveWaitMs = Math.min(waitMs, MAX_RETRY_AFTER_MS);
			this._config?.logger?.warn(`Fetch '${options.callSite}': 429 rate limited, waiting ${Math.round(effectiveWaitMs / 1000)}s (${retriesOnRateLimitRemaining - 1} retries remaining)`);
			await abortableSleep(effectiveWaitMs, options.signal);
			return this._fetchWithRetries(url, options, retriesOn5xxRemaining, retriesOnRateLimitRemaining - 1);
		}

		// Handle 503 with Retry-After header — use the server-provided delay
		if (response.status === 503 && retriesOn5xxRemaining > 0) {
			const retryAfterMs = parseRetryAfterMs(response.headers);
			if (retryAfterMs !== undefined) {
				const effectiveWaitMs = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
				this._config?.logger?.warn(`Fetch '${options.callSite}': 503 with Retry-After, waiting ${Math.round(effectiveWaitMs / 1000)}s (${retriesOn5xxRemaining - 1} retries remaining)`);
				await abortableSleep(effectiveWaitMs, options.signal);
				return this._fetchWithRetries(url, options, retriesOn5xxRemaining - 1, retriesOnRateLimitRemaining);
			}
		}

		// Handle 5xx server errors with exponential backoff
		if (response.status >= 500 && response.status < 600 && retriesOn5xxRemaining > 0) {
			const backoffMs = getBackoffMs(options.retriesOn5xx ?? 0, retriesOn5xxRemaining);
			this._config?.logger?.warn(`Fetch '${options.callSite}': ${response.status} server error, retrying in ${backoffMs}ms (${retriesOn5xxRemaining - 1} retries remaining)`);
			await abortableSleep(backoffMs, options.signal);
			return this._fetchWithRetries(url, options, retriesOn5xxRemaining - 1, retriesOnRateLimitRemaining);
		}

		return response;
	}

	// --- Concurrency limiting ---

	private async _acquireConcurrency(callSite: string, signal?: AbortSignal): Promise<void> {
		if (!this._maxConcurrency) {
			return;
		}
		let state = this._concurrencyState.get(callSite);
		if (!state) {
			state = { inFlight: 0, queue: [] };
			this._concurrencyState.set(callSite, state);
		}
		if (state.inFlight < this._maxConcurrency) {
			state.inFlight++;
			return;
		}
		const timeoutMs = this._concurrencyTimeoutMs;
		return new Promise<void>((resolve, reject) => {
			const waiter: { grant: () => void; reject: (e: Error) => void; timerId?: ReturnType<typeof setTimeout> } = {
				grant: () => {
					if (waiter.timerId !== undefined) {
						clearTimeout(waiter.timerId);
					}
					abortDisposable?.dispose();
					state!.inFlight++;
					resolve();
				},
				reject: e => {
					if (waiter.timerId !== undefined) {
						clearTimeout(waiter.timerId);
					}
					abortDisposable?.dispose();
					reject(e);
				},
			};
			state!.queue.push(waiter);

			if (timeoutMs && timeoutMs > 0) {
				waiter.timerId = setTimeout(() => {
					const idx = state!.queue.indexOf(waiter);
					if (idx >= 0) {
						state!.queue.splice(idx, 1);
						reject(new Error(`Concurrency timeout for callsite '${callSite}' after ${timeoutMs}ms`));
					}
				}, timeoutMs);
			}

			// Listen for abort signal to cancel the wait
			let abortDisposable: { dispose: () => void } | undefined;
			if (signal) {
				const onAbort = () => {
					const idx = state!.queue.indexOf(waiter);
					if (idx >= 0) {
						state!.queue.splice(idx, 1);
						if (waiter.timerId !== undefined) {
							clearTimeout(waiter.timerId);
						}
						reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
					}
				};
				signal.addEventListener('abort', onAbort, { once: true });
				abortDisposable = { dispose: () => signal.removeEventListener('abort', onAbort) };
			}
		});
	}

	private _releaseConcurrency(callSite: string): void {
		if (!this._maxConcurrency) {
			return;
		}
		const state = this._concurrencyState.get(callSite);
		if (!state) {
			return;
		}
		state.inFlight--;
		const next = state.queue.shift();
		if (next) {
			next.grant();
		}
	}

	// --- Stale-while-revalidate ---

	/**
	 * Best-effort background refetch for stale-while-revalidate. Uses the
	 * normal fetch pipeline (with circuit breaker, concurrency, throttling,
	 * and retry) but skips the cache-read step to avoid re-entering the
	 * stale logic.
	 */
	private _revalidateInBackground(url: string, options: TOptions, cacheKey: string, _cacheTtl: number): void {
		const revalidate = async () => {
			if (this._disposed) {
				return;
			}
			// Re-enter the full pipeline but skip the cache-read to avoid
			// returning the stale entry again. The pipeline will write the
			// fresh response into the cache on success.
			await this.fetch(url, { ...options, _skipCacheRead: true } as TOptions);
		};
		void revalidate()
			.finally(() => this._revalidating.delete(cacheKey))
			.catch(() => { /* best-effort */ });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sleep that also respects an optional AbortSignal.
 * If the signal is already aborted, rejects immediately.
 * If the signal is aborted during the sleep, rejects with the abort reason.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		return sleep(ms);
	}
	signal.throwIfAborted();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Computes exponential backoff delay with jitter for a retry attempt.
 * Jitter prevents thundering-herd retries when many clients fail at the
 * same time. The returned delay is in the range [base*0.5, base) ms.
 * @param totalRetries The total number of configured retries.
 * @param retriesRemaining The number of retries still available.
 * @returns Delay in milliseconds, capped at {@link MAX_BACKOFF_MS}.
 */
function getBackoffMs(totalRetries: number, retriesRemaining: number): number {
	const attempt = totalRetries - retriesRemaining;
	const base = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
	return base * (0.5 + Math.random() * 0.5);
}

/**
 * Parse a Retry-After header value to milliseconds.
 * Supports both integer seconds and HTTP-date formats per RFC 7231 §7.1.3.
 * Returns `undefined` if the header is missing or unparseable.
 */
function parseRetryAfterMs(headers: { get(name: string): string | null } | undefined): number | undefined {
	const value = headers?.get('Retry-After');
	if (!value) {
		return undefined;
	}

	// Try integer seconds first (most common)
	const seconds = Number.parseInt(value, 10);
	if (!Number.isNaN(seconds) && String(seconds) === value.trim()) {
		return Math.max(seconds, 0) * 1000;
	}

	// Try HTTP-date format
	const date = new Date(value);
	if (!Number.isNaN(date.getTime())) {
		return Math.max(date.getTime() - Date.now(), 0);
	}

	return undefined;
}

/**
 * Determines whether a thrown error represents a transient network condition
 * that is worth retrying. Non-transient errors such as TLS certificate
 * failures or bad URLs are returned immediately without consuming retries.
 */
function isTransientNetworkError(e: unknown): boolean {
	if (!(e instanceof Error)) {
		return true; // Unknown error types are treated as transient
	}

	// Check for known error codes on the error object
	const code = (e as { code?: string }).code;
	if (code && TRANSIENT_ERROR_CODES.has(code)) {
		return true;
	}

	// If there's no code at all, assume transient (generic network errors)
	if (!code) {
		return true;
	}

	// Known code but not in the transient set → permanent error
	return false;
}
