/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CacheConfig, FetchModuleHeaders, FetchModuleResponse, ICacheStorage } from './types';

const DEFAULT_MAX_ENTRIES = 100;
const STORAGE_KEY = 'vscode-fetch-cache';

/**
 * Fast, deterministic (non-cryptographic) hash for cache-key fingerprinting.
 * Avoids embedding raw secrets (e.g. Authorization header values) in keys.
 */
function simpleHash(str: string): string {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

interface CacheEntry {
	readonly status: number;
	readonly ok: boolean;
	readonly body: string;
	readonly expiresAt: number;
}

/**
 * Serializable form of cached entries for persistence.
 * Headers are intentionally not persisted — they typically contain
 * ephemeral data (request IDs, timestamps) and would grow storage.
 */
interface PersistedCacheData {
	readonly entries: ReadonlyArray<readonly [string, CacheEntry]>;
}

/**
 * A minimal response object reconstructed from cached data.
 * Satisfies the {@link FetchModuleResponse} interface.
 */
export class CachedFetchResponse implements FetchModuleResponse {
	readonly headers: FetchModuleHeaders | undefined = undefined;

	constructor(
		readonly status: number,
		readonly ok: boolean,
		private readonly _body: string,
	) { }

	async text(): Promise<string> {
		return this._body;
	}

	async json(): Promise<unknown> {
		return JSON.parse(this._body);
	}
}

/**
 * TTL-based response cache with a maximum entry limit.
 *
 * Entries are keyed by a caller-defined string (typically method + url + callsite).
 * When the cache exceeds {@link maxEntries}, the oldest entry is evicted.
 *
 * Optionally persists entries to an {@link ICacheStorage} backend (e.g. VS Code's
 * `Memento` workspace/global state) so that cached responses survive across restarts.
 */
export class ResponseCache {
	private readonly _entries = new Map<string, CacheEntry>();
	private readonly _maxEntries: number;
	private readonly _maxPersistBytes?: number;
	private readonly _storage?: ICacheStorage;

	constructor(config?: CacheConfig) {
		this._maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this._maxPersistBytes = config?.maxPersistBytes;
		this._storage = config?.storage;
		this._restoreFromStorage();
	}

	/**
	 * Retrieve a cached response, or undefined if not found or expired.
	 * Expired entries are not deleted here so that {@link getStale} can
	 * still return them for stale-while-revalidate flows.
	 */
	get(key: string): CachedFetchResponse | undefined {
		const entry = this._entries.get(key);
		if (!entry || Date.now() > entry.expiresAt) {
			return undefined;
		}
		return new CachedFetchResponse(entry.status, entry.ok, entry.body);
	}

	/**
	 * Retrieve an expired-but-still-usable entry for stale-while-revalidate.
	 * Returns `undefined` if the entry is fresh, missing, or beyond the
	 * stale window.
	 */
	getStale(key: string, windowMs: number): CachedFetchResponse | undefined {
		const entry = this._entries.get(key);
		if (!entry) {
			return undefined;
		}
		const now = Date.now();
		if (now <= entry.expiresAt) {
			return undefined; // still fresh — use get()
		}
		if (now <= entry.expiresAt + windowMs) {
			return new CachedFetchResponse(entry.status, entry.ok, entry.body);
		}
		// Beyond stale window — clean up
		this._entries.delete(key);
		return undefined;
	}

	/**
	 * Cache a response for the given TTL.
	 * The response body is consumed via {@link FetchModuleResponse.text} during this call.
	 * @param persistable When `true`, the entry is written to persistent storage (if configured).
	 *   When `false` or omitted, the entry is only held in-memory.
	 */
	async set(key: string, response: FetchModuleResponse, ttlMs: number, persistable?: boolean): Promise<CachedFetchResponse> {
		const body = await response.text();
		const entry: CacheEntry = {
			status: response.status,
			ok: response.ok,
			body,
			expiresAt: Date.now() + ttlMs,
		};
		this._entries.set(key, entry);
		this._evictIfNeeded();
		if (persistable) {
			this._persistToStorage();
		}
		return new CachedFetchResponse(entry.status, entry.ok, body);
	}

	/**
	 * Generate a cache key from request parameters.
	 *
	 * This cache is intentionally restricted to safe/idempotent GET requests.
	 * If a non-GET method is provided, an error is thrown to avoid incorrectly
	 * reusing cached responses for requests whose results may vary by headers
	 * or body (e.g. POST with JSON payload, or GET with varying auth headers).
	 *
	 * A minimal fingerprint of selected headers (e.g. Authorization, Accept)
	 * is included in the key so that header-varying GETs do not share cached
	 * responses.
	 */
	static key(method: string | undefined, url: string, callSite: string, headers?: FetchModuleHeaders | Record<string, string>): string {
		const normalizedMethod = (method ?? 'GET').toUpperCase();
		if (normalizedMethod !== 'GET') {
			throw new Error('ResponseCache only supports caching GET requests.');
		}

		const headerFingerprint = ResponseCache._headerFingerprint(headers);
		return `${normalizedMethod}:${url}:${callSite}:${headerFingerprint}`;
	}

	/**
	 * Compute a stable fingerprint for headers that affect cache semantics.
	 *
	 * Only a small, well-defined subset of headers is included to avoid
	 * unbounded key growth while still preventing cache poisoning across
	 * different auth or content negotiation contexts.
	 */
	private static _headerFingerprint(headers: FetchModuleHeaders | Record<string, string> | undefined): string {
		if (!headers) {
			return 'no-vary-headers';
		}

		const varyHeaderNames = ['authorization', 'accept'];
		const parts: string[] = [];

		const hasGet = typeof (headers as FetchModuleHeaders).get === 'function';

		for (const name of varyHeaderNames) {
			let value: string | undefined;
			if (hasGet) {
				value = (headers as FetchModuleHeaders).get(name) ?? undefined;
			} else {
				// Plain object — case-insensitive lookup
				for (const key of Object.keys(headers)) {
					if (key.toLowerCase() === name) {
						value = (headers as Record<string, string>)[key];
						break;
					}
				}
			}
			if (typeof value === 'string' && value.length > 0) {
				parts.push(`${name}=${simpleHash(value)}`);
			}
		}

		return parts.length === 0 ? 'no-vary-headers' : parts.join(';');
	}

	/**
	 * Remove all cached entries and clear persistent storage.
	 */
	clear(): void {
		this._entries.clear();
		this._persistToStorage();
	}

	get size(): number {
		return this._entries.size;
	}

	private _evictIfNeeded(): void {
		while (this._entries.size > this._maxEntries) {
			// Map iterates in insertion order, so first key is oldest
			const oldestKey = this._entries.keys().next().value;
			if (oldestKey !== undefined) {
				this._entries.delete(oldestKey);
			}
		}
	}

	private _restoreFromStorage(): void {
		if (!this._storage) {
			return;
		}
		const data = this._storage.get<PersistedCacheData>(STORAGE_KEY);
		if (!data?.entries) {
			return;
		}
		const now = Date.now();
		for (const [key, entry] of data.entries) {
			// Only restore entries that haven't expired
			if (entry.expiresAt > now) {
				this._entries.set(key, entry);
			}
		}
		this._evictIfNeeded();
	}

	private _persistToStorage(): void {
		if (!this._storage) {
			return;
		}
		let entries = Array.from(this._entries.entries());

		// Enforce byte budget: keep newest entries that fit.
		if (this._maxPersistBytes) {
			let totalBytes = 0;
			const limited: Array<[string, CacheEntry]> = [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const bodyBytes = entries[i][1].body.length;
				if (totalBytes + bodyBytes > this._maxPersistBytes) {
					break;
				}
				totalBytes += bodyBytes;
				limited.unshift(entries[i]);
			}
			entries = limited;
		}

		const data: PersistedCacheData = { entries };
		void Promise.resolve(this._storage.update(STORAGE_KEY, data)).catch(() => {
			// Swallow storage errors to avoid unhandled promise rejections; cache remains in-memory only.
		});
	}
}
