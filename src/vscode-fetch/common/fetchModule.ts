/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { abortableSleep, throwIfAborted } from './abortableSleep';
import { CircuitBreakerRegistry, CircuitOpenError } from './circuitBreaker';
import { GitHubThrottlerRegistry, tryParseGitHubUrl } from './githubThrottler';
import { PollingFetcher } from './pollingFetcher';
import { CachedFetchResponse, ResponseCache } from './responseCache';
import { FetchModuleConfig, FetchModuleOptions, FetchModuleResponse, IDisposable, IExperimentation, IFetcher, PollingFetcherConfig, RequestDefaults } from './types';

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

/** Maximum number of characters from an error response body to include in error messages. */
const MAX_ERROR_BODY_LENGTH = 200;

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

interface ConcurrencyWaiter {
	grant: () => void;
	reject: (e: Error) => void;
	timerId?: ReturnType<typeof setTimeout>;
}

interface ConcurrencyState {
	inFlight: number;
	queue: ConcurrencyWaiter[];
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
	private readonly _concurrencyState = new Map<string, ConcurrencyState>();
	private readonly _githubThrottler?: GitHubThrottlerRegistry;
	private readonly _revalidating = new Set<string>();
	/** In-flight GET requests keyed by cache key, used for request deduplication. */
	private readonly _inflight = new Map<string, Promise<TResponse | CachedFetchResponse>>();
	private readonly _requestDefaults?: RequestDefaults;
	private _disabledCallsitesCache?: { raw: string; set: Set<string> };
	private _disposed = false;

	constructor(
		private readonly _fetcher: IFetcher<TOptions, TResponse>,
		private readonly _experimentation: IExperimentation | undefined,
		config?: FetchModuleConfig,
	) {
		this._config = config;
		if (config?.circuitBreaker) {
			this._circuitBreakers = new CircuitBreakerRegistry(config.circuitBreaker, config.logger);
		}
		this._cache = new ResponseCache(config?.cache);
		this._maxConcurrency = config?.maxConcurrencyPerCallsite;
		this._concurrencyTimeoutMs = config?.concurrencyTimeoutMs;
		this._requestDefaults = config?.requestDefaults;
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
	 * Creates a background polling utility that periodically fetches a URL
	 * through the full {@link FetchModule} pipeline (retries, circuit breaking,
	 * caching, conditional requests / ETags, concurrency limiting, etc.) and
	 * exposes the parsed result as an observable value.
	 *
	 * Use this instead of {@link createPollingFetcher} when the polled data
	 * comes from an HTTP endpoint so all resilience features are applied
	 * automatically.
	 *
	 * @param buildRequest  Called on each poll to produce the URL and fetch
	 *   options. Use a function (rather than static values) when headers or
	 *   the URL need to be recomputed per-request (e.g. rotating auth tokens).
	 * @param parseResponse Converts the raw response into the value exposed
	 *   by the poller. Called only for responses — 304 Not Modified is handled
	 *   internally when caching is enabled.
	 * @param pollingConfig Polling interval, window-state awareness, and other
	 *   {@link PollingFetcherConfig} options.
	 */
	createPollingFetch<T>(
		buildRequest: () => { url: string; options: TOptions } | Promise<{ url: string; options: TOptions }>,
		parseResponse: (response: TResponse | CachedFetchResponse) => T | Promise<T>,
		pollingConfig: PollingFetcherConfig<T>,
	): PollingFetcher<T> {
		const fetchFn = async (): Promise<T> => {
			const { url, options } = await buildRequest();
			const response = await this.fetch(url, options);
			return parseResponse(response);
		};
		return new PollingFetcher(fetchFn, pollingConfig, this._config?.logger);
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
	 * 8. Cache storage (if {@link FetchModuleOptions.cacheTtlMs} is set and response is cacheable)
	 *
	 * @throws {FetchCallsiteDisabledError} if the callsite is disabled by experiment.
	 * @throws {CircuitOpenError} if the callsite's circuit breaker is open.
	 */
	async fetch(url: string, options: TOptions): Promise<TResponse | CachedFetchResponse> {
		if (this._disposed) {
			throw new Error('FetchModule has been disposed');
		}

		// Apply request defaults (per-request values always win)
		if (this._requestDefaults) {
			options = this._applyDefaults(options);
		}

		throwIfAborted(options.signal);

		if (this.isCallsiteDisabled(options.callSite)) {
			throw new FetchCallsiteDisabledError(options.callSite);
		}

		// Check cache — caching is restricted to GET requests
		const cacheTtl = options.cacheTtlMs;
		const normalizedMethod = (options.method ?? 'GET').toUpperCase();
		const isCacheable = cacheTtl && cacheTtl > 0 && normalizedMethod === 'GET';
		let cacheKey: string | undefined;
		if (isCacheable) {
			cacheKey = ResponseCache.key(normalizedMethod, url, options.callSite, options.headers);

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
			// _fetchInner always returns a CachedFetchResponse for cacheable
			// requests (both OK and non-OK), so every caller receives an
			// independent, re-readable response object.
			const inflight = this._inflight.get(cacheKey);
			if (inflight) {
				return inflight;
			}
		}

		const promise = this._fetchInner(url, options, isCacheable, cacheKey, cacheTtl);

		// Register the in-flight promise for deduplication (GET only)
		if (isCacheable && cacheKey) {
			const key = cacheKey;
			this._inflight.set(key, promise);
			// Suppress the rejection on the cleanup chain — the caller handles
			// the rejection via the returned `promise` reference.
			void promise.finally(() => this._inflight.delete(key)).catch(() => { });
		}

		return promise;
	}

	/**
	 * Convenience method that fetches a URL and parses the response as JSON.
	 *
	 * Uses the same full protection pipeline as {@link fetch} (kill-switch,
	 * circuit breaker, concurrency, retry, caching, etc.).
	 *
	 * @throws if the response is not OK (status outside 200-299).
	 */
	async fetchJson<T = unknown>(url: string, options: TOptions): Promise<T> {
		const response = await this.fetch(url, options);
		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(`fetchJson '${options.callSite}': HTTP ${response.status}${body ? ` — ${body.slice(0, MAX_ERROR_BODY_LENGTH)}` : ''}`);
		}
		return response.json() as Promise<T>;
	}

	/**
	 * Merges {@link _requestDefaults} into the given options.
	 * Per-request values always take precedence.
	 */
	private _applyDefaults(options: TOptions): TOptions {
		const d = this._requestDefaults;
		if (!d) {
			return options;
		}
		return {
			...options,
			retriesOn5xx: options.retriesOn5xx ?? d.retriesOn5xx,
			retriesOnRateLimit: options.retriesOnRateLimit ?? d.retriesOnRateLimit,
			cacheTtlMs: options.cacheTtlMs ?? d.cacheTtlMs,
			timeout: options.timeout ?? d.timeout,
		} as TOptions;
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
			throwIfAborted(options.signal);

			// GitHub quota throttling — parse URL once for both check and throttler
			const parsedGitHubUrl = this._githubThrottler ? tryParseGitHubUrl(url) : undefined;
			ghSlot = parsedGitHubUrl
				? await this._githubThrottler!.acquireSlot(options.method, url, options.signal)
				: undefined;

			// Recheck circuit breaker in case it tripped during waits
			if (this._circuitBreakers?.isOpen(options.callSite)) {
				throw new CircuitOpenError(options.callSite);
			}

			throwIfAborted(options.signal);

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
			if (ghSlot && this._githubThrottler && parsedGitHubUrl) {
				this._githubThrottler.recordResponse(options.method, url, response);
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

			// Cache responses: always for OK, optionally for non-OK when cacheNonOkResponses is set
			if (isCacheable && cacheKey && cacheTtl && (response.ok || options.cacheNonOkResponses)) {
				const cachedResponse = await this._cache.set(cacheKey, response, cacheTtl, options.persistCachedResponse);
				return cachedResponse;
			}

			// For cacheable (deduplicated) requests with non-OK responses,
			// materialize the body into a CachedFetchResponse so that
			// concurrent callers each get a re-readable response object
			// instead of sharing a single-consumption stream.
			if (isCacheable && cacheKey) {
				const body = await response.text().catch(() => '');
				return new CachedFetchResponse(response.status, response.ok, body);
			}

			return response;
		} catch (e) {
			// Don't count circuit-open errors (already tracked) or
			// abort/cancellation errors (caller-initiated, not endpoint failures).
			if (!(e instanceof CircuitOpenError) && !isAbortError(e)) {
				this._circuitBreakers?.recordFailure(options.callSite);
			} else if (isAbortError(e)) {
				// Release half-open probe slot so the breaker isn't stuck
				// rejecting all requests when a probe is cancelled.
				this._circuitBreakers?.releaseHalfOpenProbe(options.callSite);
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
		const raw = this._experimentation?.getTreatmentVariable<string>(DISABLED_CALLSITES_TREATMENT);
		if (!raw) {
			return false;
		}
		if (!this._disabledCallsitesCache || this._disabledCallsitesCache.raw !== raw) {
			this._disabledCallsitesCache = { raw, set: new Set(raw.split(',').map(s => s.trim())) };
		}
		return this._disabledCallsitesCache.set.has(callSite);
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
				return this._logAndRetry(url, options, backoffMs,
					`network error, retrying in ${Math.round(backoffMs)}ms (${retriesOn5xxRemaining - 1} retries remaining)`,
					retriesOn5xxRemaining - 1, retriesOnRateLimitRemaining);
			}
			throw e;
		}

		if (response.ok || response.status === 304) {
			return response;
		}

		// Handle 429 rate limiting
		if (response.status === 429 && retriesOnRateLimitRemaining > 0) {
			const delayMs = Math.min(parseRetryAfterMs(response.headers) ?? 1000, MAX_RETRY_AFTER_MS);
			return this._logAndRetry(url, options, delayMs,
				`429 rate limited, waiting ${Math.round(delayMs / 1000)}s (${retriesOnRateLimitRemaining - 1} retries remaining)`,
				retriesOn5xxRemaining, retriesOnRateLimitRemaining - 1);
		}

		// Handle 5xx server errors — prefer Retry-After on 503, otherwise exponential backoff
		if (response.status >= 500 && response.status < 600 && retriesOn5xxRemaining > 0) {
			const retryAfterMs = response.status === 503 ? parseRetryAfterMs(response.headers) : undefined;
			const delayMs = retryAfterMs !== undefined
				? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
				: getBackoffMs(options.retriesOn5xx ?? 0, retriesOn5xxRemaining);
			const reason = retryAfterMs !== undefined
				? `503 with Retry-After, waiting ${Math.round(delayMs / 1000)}s`
				: `${response.status} server error, retrying in ${Math.round(delayMs)}ms`;
			return this._logAndRetry(url, options, delayMs,
				`${reason} (${retriesOn5xxRemaining - 1} retries remaining)`,
				retriesOn5xxRemaining - 1, retriesOnRateLimitRemaining);
		}

		return response;
	}

	private async _logAndRetry(
		url: string,
		options: TOptions,
		delayMs: number,
		reason: string,
		retriesOn5xxRemaining: number,
		retriesOnRateLimitRemaining: number,
	): Promise<TResponse> {
		this._config?.logger?.warn(`Fetch '${options.callSite}': ${reason}`);
		await abortableSleep(delayMs, options.signal);
		return this._fetchWithRetries(url, options, retriesOn5xxRemaining, retriesOnRateLimitRemaining);
	}

	// --- Concurrency limiting ---

	private async _acquireConcurrency(callSite: string, signal?: AbortSignal): Promise<void> {
		if (!this._maxConcurrency) {
			return;
		}
		// Check if signal is already aborted before enqueuing
		throwIfAborted(signal);
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
		const s = state;
		return new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				const idx = s.queue.indexOf(waiter);
				if (idx >= 0) {
					s.queue.splice(idx, 1);
				}
				if (waiter.timerId !== undefined) {
					clearTimeout(waiter.timerId);
				}
				abortDisposable?.dispose();
			};

			const waiter: ConcurrencyWaiter = {
				grant: () => {
					cleanup();
					s.inFlight++;
					resolve();
				},
				reject: e => {
					cleanup();
					reject(e);
				},
			};
			s.queue.push(waiter);

			if (timeoutMs && timeoutMs > 0) {
				waiter.timerId = setTimeout(() => {
					const err = new Error(`Concurrency timeout for callsite '${callSite}' after ${timeoutMs}ms`);
					err.name = 'ConcurrencyTimeout';
					waiter.reject(err);
				}, timeoutMs);
			}

			// Listen for abort signal to cancel the wait
			let abortDisposable: { dispose: () => void } | undefined;
			if (signal) {
				const onAbort = () => {
					const reason = signal.reason;
					const normalized = reason instanceof Error
						? reason
						: new DOMException(
							typeof reason === 'string' ? reason : 'The operation was aborted.',
							'AbortError',
						);
					waiter.reject(normalized);
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
		} else if (state.inFlight === 0) {
			// No waiters and no in-flight requests — remove the entry to
			// prevent unbounded growth when many distinct callsites are used.
			this._concurrencyState.delete(callSite);
		}
	}

	// --- Stale-while-revalidate ---

	/**
	 * Best-effort background refetch for stale-while-revalidate. Calls
	 * {@link _fetchInner} directly (skipping the cache-read step) to avoid
	 * re-entering the stale logic. The original caller's abort signal is
	 * stripped so background revalidation is not tied to caller lifecycle.
	 */
	private _revalidateInBackground(url: string, options: TOptions, cacheKey: string, cacheTtl: number): void {
		const revalidate = async () => {
			if (this._disposed) {
				return;
			}
			if (this.isCallsiteDisabled(options.callSite)) {
				return;
			}
			// Strip the original signal — background revalidation should not be
			// cancelled by the caller's abort controller.
			const bgOptions = { ...options, signal: undefined } as TOptions;
			await this._fetchInner(url, bgOptions, true, cacheKey, cacheTtl);
		};
		void revalidate()
			.finally(() => this._revalidating.delete(cacheKey))
			.catch(() => { /* best-effort */ });
	}
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
	const value = headers?.get('Retry-After') ?? headers?.get('retry-after');
	if (!value) {
		return undefined;
	}

	// Try integer seconds first (most common). RFC 7231 allows 1*DIGIT, including leading zeros.
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number.parseInt(trimmed, 10);
		if (!Number.isNaN(seconds)) {
			return Math.max(seconds, 0) * 1000;
		}
	}

	// Try HTTP-date format
	const date = new Date(value);
	if (!Number.isNaN(date.getTime())) {
		return Math.max(date.getTime() - Date.now(), 0);
	}

	return undefined;
}

/**
 * Determines whether an error is an abort/cancellation error.
 * These are caller-initiated and should not count as endpoint failures.
 */
function isAbortError(e: unknown): boolean {
	return e instanceof Error && (e.name === 'AbortError' || e.name === 'ConcurrencyTimeout');
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
	// No code → assume transient (generic network errors).
	// Known code → transient only if in the allow-list; otherwise permanent.
	const code = (e as { code?: string }).code;
	return !code || TRANSIENT_ERROR_CODES.has(code);
}
