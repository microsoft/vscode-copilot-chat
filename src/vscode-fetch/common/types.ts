/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal fetch options required by the module.
 * Compatible with the platform's FetchOptions via structural typing.
 */
export interface FetchModuleOptions {
	readonly callSite: string;
	readonly headers?: Record<string, string>;
	readonly body?: string;
	readonly timeout?: number;
	readonly method?: string;
	/**
	 * Optional abort signal to cancel the request.
	 * When aborted, the request is cancelled and any pending retry or
	 * concurrency wait is interrupted immediately.
	 */
	readonly signal?: AbortSignal;
	/** Number of retries on 5xx server errors. Defaults to 0 (no retries). */
	readonly retriesOn5xx?: number;
	/** Number of retries on 429 rate-limit responses. Defaults to 0 (no retries). */
	readonly retriesOnRateLimit?: number;
	/**
	 * Cache successful responses for this duration in milliseconds.
	 *
	 * Caching is only applied for requests where {@link method} is `'GET'` (the default).
	 * For other HTTP methods (e.g. `'POST'` or `'PUT'`), this value is ignored and no
	 * caching will be performed.
	 *
	 * Omit or set to 0 to disable caching for this request.
	 *
	 * When enabled, the response body is consumed and a {@link CachedFetchResponse}
	 * is returned (and stored) in place of the original response. Cached responses
	 * do not preserve response headers; callers MUST NOT rely on headers being present
	 * when reading from the cache.
	 *
	 * By default, cached entries are held in-memory only. To also persist the
	 * entry to the configured {@link ICacheStorage} backend, set
	 * {@link persistCachedResponse} to `true`.
	 *
	 * Note: persisted cache entries include both the response body and the
	 * cache key used to look them up. The cache key contains the full request
	 * URL and a hash of selected headers. If your URLs contain secrets (e.g.
	 * query parameters with tokens), enabling persistence can write those
	 * secrets to disk. Only enable persistence for requests where both the
	 * response and the URL data are safe to persist, or where the configured
	 * {@link ICacheStorage} backend is appropriately protected.
	 */
	readonly cacheTtlMs?: number;
	/**
	 * When `true` **and** {@link cacheTtlMs} is set for a `GET` request, the
	 * cached response body and the associated cache key (including the full URL
	 * and a header fingerprint hash) are written to the persistent
	 * {@link ICacheStorage} backend (if one is configured on the module).
	 * Defaults to `false` so that sensitive data is not accidentally persisted
	 * to disk.
	 *
	 * This option has no effect when caching is disabled (e.g. when
	 * {@link cacheTtlMs} is `0`/`undefined` or when {@link method} is not
	 * `'GET'`).
	 *
	 * Do not enable this for requests whose URLs or headers may contain
	 * credentials or other secrets unless the persistent storage is secured
	 * appropriately.
	 */
	readonly persistCachedResponse?: boolean;
	/**
	 * When `true` **and** {@link cacheTtlMs} is set, non-OK responses (e.g.
	 * 404 Not Found) are also stored in the cache. By default, only
	 * successful (2xx) responses are cached.
	 *
	 * This is useful for endpoints where a non-OK status is a stable,
	 * cacheable signal (e.g. a 404 meaning "user is not a team member")
	 * and repeated fetches are wasteful.
	 */
	readonly cacheNonOkResponses?: boolean;
	/**
	 * When set alongside {@link cacheTtlMs}, expired cache entries are still
	 * returned for this additional duration while a background re-fetch
	 * updates the cache. This avoids blocking callers on a fresh fetch when
	 * slightly-stale data is acceptable.
	 */
	readonly staleWhileRevalidateMs?: number;
}

/**
 * Minimal response headers interface.
 * Compatible with the platform's IHeaders via structural typing.
 */
export interface FetchModuleHeaders {
	get(name: string): string | null;
}

/**
 * Minimal response interface.
 * Compatible with the platform's Response class via structural typing.
 */
export interface FetchModuleResponse {
	readonly status: number;
	readonly ok: boolean;
	readonly headers?: FetchModuleHeaders;
	text(): Promise<string>;
	json(): Promise<unknown>;
}

/**
 * Minimal logging interface for the fetch module.
 * Compatible with ILogService via structural typing.
 */
export interface IFetchLogger {
	warn(message: string): void;
	error(error: string | Error, message?: string): void;
}

/**
 * Minimal interface for a fetch service.
 * Compatible with IFetcherService via structural typing.
 * Generics allow the platform to specialize with its own option/response types.
 */
export interface IFetcher<TOptions extends FetchModuleOptions = FetchModuleOptions, TResponse extends FetchModuleResponse = FetchModuleResponse> {
	fetch(url: string, options: TOptions): Promise<TResponse>;
}

/**
 * Minimal interface for an experimentation service.
 * Compatible with IExperimentationService via structural typing.
 */
export interface IExperimentation {
	getTreatmentVariable<T extends boolean | number | string>(name: string): T | undefined;
}

/** Configuration for per-callsite circuit breakers. */
export interface CircuitBreakerConfig {
	/** Number of consecutive failures before opening the circuit. Default: 5 */
	readonly threshold?: number;
	/** Time in ms before transitioning from open to half-open. Default: 30000 */
	readonly halfOpenAfterMs?: number;
}

/** Configuration for response caching. */
export interface CacheConfig {
	/** Maximum number of cached entries. Oldest entries are evicted when exceeded. Default: 100 */
	readonly maxEntries?: number;
	/**
	 * Maximum total body size in bytes for persisted cache entries.
	 * When the budget is exceeded, the newest entries are kept and
	 * older entries are dropped from the persisted snapshot.
	 */
	readonly maxPersistBytes?: number;
	/**
	 * Optional persistent storage backend. When provided, cache entries are
	 * persisted and restored across sessions. Compatible with VS Code's
	 * `Memento` interface via structural typing.
	 */
	readonly storage?: ICacheStorage;
}

/**
 * Minimal key-value storage interface for persisting cache entries.
 * Structurally compatible with VS Code's `Memento` API.
 */
export interface ICacheStorage {
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

/**
 * Default values for per-request options.
 * These are applied as fallbacks — per-request values always take precedence.
 */
export interface RequestDefaults {
	/** Default number of retries on 5xx server errors. */
	readonly retriesOn5xx?: number;
	/** Default number of retries on 429 rate-limit responses. */
	readonly retriesOnRateLimit?: number;
	/** Default cache TTL in milliseconds for GET requests. */
	readonly cacheTtlMs?: number;
	/** Default timeout in milliseconds for individual requests. */
	readonly timeout?: number;
}

/** Top-level configuration for the FetchModule. */
export interface FetchModuleConfig {
	readonly logger?: IFetchLogger;
	/** Enable per-callsite circuit breakers. When omitted, circuit breaking is disabled. */
	readonly circuitBreaker?: CircuitBreakerConfig;
	/** Maximum concurrent in-flight requests per callsite. When omitted, concurrency is unlimited. */
	readonly maxConcurrencyPerCallsite?: number;
	/** Timeout in ms for waiting in the concurrency queue. When omitted, waiters block indefinitely. */
	readonly concurrencyTimeoutMs?: number;
	/** Configuration for the response cache. When omitted, caching is still available via cacheTtlMs but uses default settings. */
	readonly cache?: CacheConfig;
	/**
	 * GitHub-specific PID-controller throttling configuration.
	 * When a request URL targets github.com or ghe.com, the module automatically
	 * applies quota-bucket–aware throttling based on response headers.
	 *
	 * - Omit or set to `undefined` to enable with defaults (target = 80%).
	 * - Set to `false` to explicitly disable GitHub throttling.
	 * - Provide `{ target: number }` to override the target quota percentage.
	 */
	readonly githubThrottling?: { readonly target?: number } | false;
	/**
	 * Default values for per-request options. Per-request values always
	 * take precedence over these defaults.
	 */
	readonly requestDefaults?: RequestDefaults;
}

/**
 * Minimal interface for observing window active state.
 * Compatible with IEnvService via structural typing.
 */
export interface IWindowStateProvider {
	readonly isActive: boolean;
	onDidChangeWindowState(listener: (state: { readonly active: boolean }) => void): { dispose(): void };
}

/** Configuration for a {@link PollingFetcher}. */
export interface PollingFetcherConfig<T> {
	/**
	 * Polling interval in milliseconds.
	 * Used as the default interval between polls.
	 */
	readonly intervalMs: number;
	/**
	 * Optional callback to compute a dynamic interval from the latest value.
	 * When provided, the return value overrides {@link intervalMs} for the next
	 * poll cycle. Return `undefined` to fall back to {@link intervalMs}.
	 *
	 * Useful for server-driven refresh schedules (e.g., refresh 5 minutes
	 * before a token's `expires_at`).
	 */
	readonly getNextIntervalMs?: (value: T) => number | undefined;
	/** When provided, polling is skipped while the window is inactive and resumes when it becomes active. */
	readonly windowStateProvider?: IWindowStateProvider;
	/** If true, skip polling when the result hasn't been consumed since the last fetch. Default: false */
	readonly skipWhenUnused?: boolean;
	/**
	 * When `true`, poll errors (other than `FetchCallsiteDisabledError`)
	 * preserve the last known good value instead of clearing it.
	 * Defaults to `false` (errors clear the value).
	 */
	readonly preserveValueOnError?: boolean;
	/**
	 * Optional predicate called when the window becomes active to decide whether
	 * to immediately re-fetch. Receives the current value (or undefined if none).
	 * Return `true` to trigger a fetch, `false` to skip.
	 *
	 * When omitted, the window-resume fetch is gated only by {@link skipWhenUnused}.
	 * Use this to implement "only refresh if expiring soon" logic.
	 */
	readonly shouldResumeOnWindowActive?: (currentValue: T | undefined) => boolean;
	/**
	 * Initial cached value to use before the first poll completes.
	 * When provided, consumers can access `value` synchronously immediately.
	 */
	readonly initialValue?: T;
}

/**
 * Minimal disposable interface.
 * Structurally compatible with VS Code's `IDisposable`.
 */
export interface IDisposable {
	dispose(): void;
}

/**
 * Minimal event interface.
 * Structurally compatible with VS Code's `Event<T>`.
 * Subscribe by calling the event as a function; returns a disposable to unsubscribe.
 */
export interface Event<T> {
	(listener: (e: T) => void): IDisposable;
}
