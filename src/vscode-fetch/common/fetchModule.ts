/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CircuitBreakerRegistry, CircuitOpenError } from './circuitBreaker';
import { GitHubThrottlerRegistry, isGitHubUrl } from './githubThrottler';
import { PollingFetcher } from './pollingFetcher';
import { ResponseCache } from './responseCache';
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
	private readonly _concurrencyState = new Map<string, { inFlight: number; queue: Array<() => void> }>();
	private readonly _githubThrottler?: GitHubThrottlerRegistry;

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
		this._circuitBreakers?.dispose();
		this._cache.clear();
		this._concurrencyState.clear();
		this._githubThrottler?.clear();
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
	async fetch(url: string, options: TOptions): Promise<TResponse> {
		if (this.isCallsiteDisabled(options.callSite)) {
			throw new FetchCallsiteDisabledError(options.callSite);
		}

		// Check cache
		const cacheTtl = options.cacheTtlMs;
		if (cacheTtl && cacheTtl > 0) {
			const cacheKey = ResponseCache.key(options.method, url, options.callSite);
			const cached = this._cache.get(cacheKey);
			if (cached) {
				return cached as unknown as TResponse;
			}
		}

		// Circuit breaker
		this._circuitBreakers?.checkCallsite(options.callSite);

		// Concurrency gate
		await this._acquireConcurrency(options.callSite);

		// GitHub quota throttling
		const ghSlot = this._githubThrottler && isGitHubUrl(url)
			? await this._githubThrottler.acquireSlot(options.method, url)
			: undefined;

		try {
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
				const cacheKey = ResponseCache.key(options.method, url, options.callSite);
				const cached = await this._cache.set(cacheKey, response, cacheTtl);
				return cached as unknown as TResponse;
			}

			return response;
		} catch (e) {
			// Network errors after retries exhausted → circuit breaker failure
			this._circuitBreakers?.recordFailure(options.callSite);
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

		// Handle 429 rate limiting with Retry-After header
		if (response.status === 429 && retriesOnRateLimitRemaining > 0) {
			const retryAfterHeader = response.headers?.get('Retry-After');
			if (retryAfterHeader) {
				const waitSeconds = parseInt(retryAfterHeader, 10) || 1;
				const waitMs = Math.min(waitSeconds * 1000, MAX_RETRY_AFTER_MS);
				this._config?.logger?.warn(`Fetch '${options.callSite}': 429 rate limited, waiting ${waitSeconds}s (${retriesOnRateLimitRemaining - 1} retries remaining)`);
				await sleep(waitMs);
				return this._fetchWithRetries(url, options, retriesOn5xxRemaining, retriesOnRateLimitRemaining - 1);
			}
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
		return new Promise<void>(resolve => {
			state!.queue.push(() => {
				state!.inFlight++;
				resolve();
			});
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
			next();
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Computes exponential backoff delay for a retry attempt.
 * @param totalRetries The total number of configured retries.
 * @param retriesRemaining The number of retries still available.
 * @returns Delay in milliseconds, capped at {@link MAX_BACKOFF_MS}.
 */
function getBackoffMs(totalRetries: number, retriesRemaining: number): number {
	const attempt = totalRetries - retriesRemaining;
	return Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
}
