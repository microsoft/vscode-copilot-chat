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
 *   at 30s) and network errors (opt-in per request).
 * - **Rate limit handling**: Respects {@link Retry-After} headers on 429 responses
 *   (capped at 60s, opt-in per request).
 * - **Response caching**: TTL-based cache for successful responses (opt-in per request).
 */
export class FetchModule<TOptions extends FetchModuleOptions = FetchModuleOptions, TResponse extends FetchModuleResponse = FetchModuleResponse> implements IDisposable {
	private readonly _config: FetchModuleConfig | undefined;
	private readonly _circuitBreakers?: CircuitBreakerRegistry;
	private readonly _cache: ResponseCache;
	private readonly _maxConcurrency?: number;
	private readonly _concurrencyTimeoutMs?: number;
	private readonly _concurrencyState = new Map<string, { inFlight: number; queue: Array<{ grant: () => void; reject: (e: Error) => void }> }>();
	private readonly _githubThrottler?: GitHubThrottlerRegistry;
	private readonly _revalidating = new Set<string>();
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
				waiter.reject(disposeError);
			}
		}
		this._concurrencyState.clear();
		this._githubThrottler?.clear();
		this._revalidating.clear();
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

		if (this.isCallsiteDisabled(options.callSite)) {
			throw new FetchCallsiteDisabledError(options.callSite);
		}

		// Check cache
		const cacheTtl = options.cacheTtlMs;
		if (cacheTtl && cacheTtl > 0) {
			const cacheKey = ResponseCache.key(options.method, url, options.callSite, options.headers);
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
		}

		// Circuit breaker (fast check before acquiring resources)
		this._circuitBreakers?.checkCallsite(options.callSite);

		// Concurrency gate
		await this._acquireConcurrency(options.callSite);

		let ghSlot: { release: () => void } | undefined;

		try {
			// GitHub quota throttling
			ghSlot = this._githubThrottler && isGitHubUrl(url)
				? await this._githubThrottler.acquireSlot(options.method, url)
				: undefined;

			// Recheck circuit breaker in case it tripped during waits
			if (this._circuitBreakers?.isOpen(options.callSite)) {
				throw new CircuitOpenError(options.callSite);
			}

			const response = await this._fetchWithRetries(
				url,
				options,
				options.retriesOn5xx ?? 0,
				options.retriesOnRateLimit ?? 0,
			);

			// Record quota usage for GitHub APIs
			if (ghSlot) {
				this._githubThrottler!.recordResponse(options.method, url, response);
			}

			// Record success/failure in circuit breaker.
			// 5xx after retries exhausted = failure. Everything else (including 4xx) = success.
			if (response.status >= 500 && response.status < 600) {
				this._circuitBreakers?.recordFailure(options.callSite);
			} else {
				this._circuitBreakers?.recordSuccess(options.callSite);
			}

			// Cache successful responses
			if (cacheTtl && cacheTtl > 0 && response.ok) {
				const cacheKey = ResponseCache.key(options.method, url, options.callSite, options.headers);
				return this._cache.set(cacheKey, response, cacheTtl, options.persistCachedResponse);
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
			// On network errors, retry using the 5xx retry budget with backoff
			if (retriesOn5xxRemaining > 0) {
				const backoffMs = getBackoffMs(options.retriesOn5xx ?? 0, retriesOn5xxRemaining);
				this._config?.logger?.warn(`Fetch '${options.callSite}': network error, retrying in ${backoffMs}ms (${retriesOn5xxRemaining - 1} retries remaining)`);
				await sleep(backoffMs);
				return this._fetchWithRetries(url, options, retriesOn5xxRemaining - 1, retriesOnRateLimitRemaining);
			}
			throw e;
		}

		if (response.ok) {
			return response;
		}

		// Handle 429 rate limiting
		if (response.status === 429 && retriesOnRateLimitRemaining > 0) {
			const retryAfterHeader = response.headers?.get('Retry-After');
			const parsedWaitSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
			const waitSeconds = Number.isNaN(parsedWaitSeconds) ? 1 : Math.max(parsedWaitSeconds, 0);
			const waitMs = Math.min(waitSeconds * 1000, MAX_RETRY_AFTER_MS);
			const effectiveWaitSeconds = Math.round(waitMs / 1000);
			this._config?.logger?.warn(`Fetch '${options.callSite}': 429 rate limited, waiting ${effectiveWaitSeconds}s (${retriesOnRateLimitRemaining - 1} retries remaining)`);
			await sleep(waitMs);
			return this._fetchWithRetries(url, options, retriesOn5xxRemaining, retriesOnRateLimitRemaining - 1);
		}

		// Handle 5xx server errors with exponential backoff
		if (response.status >= 500 && response.status < 600 && retriesOn5xxRemaining > 0) {
			const backoffMs = getBackoffMs(options.retriesOn5xx ?? 0, retriesOn5xxRemaining);
			this._config?.logger?.warn(`Fetch '${options.callSite}': ${response.status} server error, retrying in ${backoffMs}ms (${retriesOn5xxRemaining - 1} retries remaining)`);
			await sleep(backoffMs);
			return this._fetchWithRetries(url, options, retriesOn5xxRemaining - 1, retriesOnRateLimitRemaining);
		}

		return response;
	}

	// --- Concurrency limiting ---

	private async _acquireConcurrency(callSite: string): Promise<void> {
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
			const waiter = {
				grant: () => { state!.inFlight++; resolve(); },
				reject,
			};
			state!.queue.push(waiter);

			if (timeoutMs && timeoutMs > 0) {
				setTimeout(() => {
					const idx = state!.queue.indexOf(waiter);
					if (idx >= 0) {
						state!.queue.splice(idx, 1);
						reject(new Error(`Concurrency timeout for callsite '${callSite}' after ${timeoutMs}ms`));
					}
				}, timeoutMs);
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
	 * Best-effort background refetch for stale-while-revalidate. Calls the
	 * underlying fetcher directly (bypassing the full pipeline) so that the
	 * recursive fetch doesn't re-enter the stale logic.
	 */
	private _revalidateInBackground(url: string, options: TOptions, cacheKey: string, cacheTtl: number): void {
		const revalidate = async () => {
			if (this._disposed || this.isCallsiteDisabled(options.callSite)) {
				return;
			}
			const response = await this._fetcher.fetch(url, options);
			if (response.ok) {
				await this._cache.set(cacheKey, response, cacheTtl, options.persistCachedResponse);
			}
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
