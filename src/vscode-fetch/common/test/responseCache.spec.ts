/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CachedFetchResponse, ResponseCache } from '../responseCache';
import { FetchModuleResponse } from '../types';

function mockResponse(status: number, body: string): FetchModuleResponse {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: () => null },
		text: () => Promise.resolve(body),
		json: () => Promise.resolve(JSON.parse(body || '{}')),
	};
}

class MockStorage {
	private readonly _data = new Map<string, unknown>();

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return (this._data.get(key) as T) ?? defaultValue;
	}

	update(key: string, value: unknown): Promise<void> {
		this._data.set(key, value);
		return Promise.resolve();
	}

	get raw(): Map<string, unknown> {
		return this._data;
	}
}

describe('CachedFetchResponse', () => {
	it('should return status, ok, and body via text()', async () => {
		const r = new CachedFetchResponse(200, true, '{"data":1}');
		expect(r.status).toBe(200);
		expect(r.ok).toBe(true);
		expect(await r.text()).toBe('{"data":1}');
	});

	it('should parse JSON body', async () => {
		const r = new CachedFetchResponse(200, true, '{"data":1}');
		expect(await r.json()).toEqual({ data: 1 });
	});

	it('should have undefined headers', () => {
		const r = new CachedFetchResponse(200, true, '');
		expect(r.headers).toBeUndefined();
	});
});

describe('ResponseCache.key()', () => {
	it('should generate a key for GET requests', () => {
		const key = ResponseCache.key('GET', 'https://example.com', 'test');
		expect(key).toContain('GET');
		expect(key).toContain('https://example.com');
		expect(key).toContain('test');
	});

	it('should default to GET when method is undefined', () => {
		const key = ResponseCache.key(undefined, 'https://example.com', 'test');
		expect(key).toMatch(/^GET:/);
	});

	it('should throw for non-GET methods', () => {
		expect(() => ResponseCache.key('POST', 'https://example.com', 'test')).toThrow('only supports caching GET');
		expect(() => ResponseCache.key('PUT', 'https://example.com', 'test')).toThrow('only supports caching GET');
	});

	it('should produce different keys for different auth headers', () => {
		const key1 = ResponseCache.key('GET', 'https://example.com', 'test', { Authorization: 'token-a' });
		const key2 = ResponseCache.key('GET', 'https://example.com', 'test', { Authorization: 'token-b' });
		expect(key1).not.toBe(key2);
	});

	it('should hash auth header values instead of embedding raw values', () => {
		const secret = 'Bearer ghp_secret_token_12345';
		const key = ResponseCache.key('GET', 'https://example.com', 'test', { Authorization: secret });
		// The raw secret should NOT appear in the key
		expect(key).not.toContain(secret);
		expect(key).not.toContain('ghp_secret_token_12345');
	});

	it('should produce consistent keys for the same headers', () => {
		const headers = { Authorization: 'token-x', Accept: 'application/json' };
		const key1 = ResponseCache.key('GET', 'https://example.com', 'test', headers);
		const key2 = ResponseCache.key('GET', 'https://example.com', 'test', headers);
		expect(key1).toBe(key2);
	});

	it('should use no-vary-headers when headers are omitted', () => {
		const key = ResponseCache.key('GET', 'https://example.com', 'test');
		expect(key).toContain('no-vary-headers');
	});
});

describe('ResponseCache', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	// --- get / set ---

	describe('get and set', () => {
		it('should return undefined for missing key', () => {
			const cache = new ResponseCache();
			expect(cache.get('missing')).toBeUndefined();
		});

		it('should store and retrieve an entry', async () => {
			const cache = new ResponseCache();
			await cache.set('k', mockResponse(200, '"hello"'), 5000);
			const result = cache.get('k');
			expect(result).toBeDefined();
			expect(await result!.json()).toBe('hello');
		});

		it('should return undefined for expired entry without deleting it', async () => {
			const cache = new ResponseCache();
			await cache.set('k', mockResponse(200, '"val"'), 1000);

			vi.setSystemTime(Date.now() + 1001);

			expect(cache.get('k')).toBeUndefined();
			// Entry still in map for stale-while-revalidate
			expect(cache.size).toBe(1);
		});
	});

	// --- getStale ---

	describe('getStale', () => {
		it('should return undefined for missing key', () => {
			const cache = new ResponseCache();
			expect(cache.getStale('missing', 5000)).toBeUndefined();
		});

		it('should return undefined for fresh entry', async () => {
			const cache = new ResponseCache();
			await cache.set('k', mockResponse(200, '"fresh"'), 5000);
			expect(cache.getStale('k', 5000)).toBeUndefined();
		});

		it('should return stale entry within window', async () => {
			const cache = new ResponseCache();
			await cache.set('k', mockResponse(200, '"data"'), 1000);

			// Advance past TTL but within stale window
			vi.setSystemTime(Date.now() + 1500);

			const stale = cache.getStale('k', 2000);
			expect(stale).toBeDefined();
			expect(await stale!.text()).toBe('"data"');
		});

		it('should delete entry beyond stale window', async () => {
			const cache = new ResponseCache();
			await cache.set('k', mockResponse(200, '"old"'), 1000);

			// Advance past TTL + stale window
			vi.setSystemTime(Date.now() + 5000);

			expect(cache.getStale('k', 2000)).toBeUndefined();
			expect(cache.size).toBe(0);
		});
	});

	// --- Eviction ---

	describe('eviction', () => {
		it('should evict oldest entries when maxEntries exceeded', async () => {
			const cache = new ResponseCache({ maxEntries: 2 });
			await cache.set('a', mockResponse(200, '"a"'), 60_000);
			await cache.set('b', mockResponse(200, '"b"'), 60_000);
			await cache.set('c', mockResponse(200, '"c"'), 60_000);

			expect(cache.size).toBe(2);
			expect(cache.get('a')).toBeUndefined(); // evicted
			expect(cache.get('b')).toBeDefined();
			expect(cache.get('c')).toBeDefined();
		});
	});

	// --- Persistence ---

	describe('persistence', () => {
		it('should persist entries to storage when persistable', async () => {
			const storage = new MockStorage();
			const cache = new ResponseCache({ storage });

			await cache.set('k', mockResponse(200, '{"p":true}'), 60_000, true);

			const data = storage.get<{ entries: Array<[string, unknown]> }>('vscode-fetch-cache');
			expect(data).toBeDefined();
			expect(data!.entries).toHaveLength(1);
		});

		it('should restore valid entries from storage on construction', () => {
			const now = Date.now();
			const storage = new MockStorage();
			storage.update('vscode-fetch-cache', {
				entries: [['key1', { status: 200, ok: true, body: '"restored"', expiresAt: now + 60_000 }]],
			});

			const cache = new ResponseCache({ storage });
			const entry = cache.get('key1');
			expect(entry).toBeDefined();
		});

		it('should not restore expired entries from storage', () => {
			const now = Date.now();
			const storage = new MockStorage();
			storage.update('vscode-fetch-cache', {
				entries: [['key1', { status: 200, ok: true, body: '"old"', expiresAt: now - 1000 }]],
			});

			const cache = new ResponseCache({ storage });
			expect(cache.size).toBe(0);
		});

		it('should enforce maxPersistBytes by keeping newest entries', async () => {
			const storage = new MockStorage();
			// Each body is ~10 chars. Set budget to fit only 1 entry.
			const cache = new ResponseCache({ storage, maxPersistBytes: 15 });

			await cache.set('a', mockResponse(200, '"body-aaa"'), 60_000, true);
			await cache.set('b', mockResponse(200, '"body-bbb"'), 60_000, true);

			const data = storage.get<{ entries: Array<[string, unknown]> }>('vscode-fetch-cache');
			expect(data).toBeDefined();
			// Only the newest entry should fit within the budget
			expect(data!.entries).toHaveLength(1);
			expect(data!.entries[0][0]).toBe('b');
		});
	});

	// --- clear ---

	describe('clear', () => {
		it('should remove all entries', async () => {
			const cache = new ResponseCache();
			await cache.set('a', mockResponse(200, '"a"'), 60_000);
			await cache.set('b', mockResponse(200, '"b"'), 60_000);

			cache.clear();
			expect(cache.size).toBe(0);
		});
	});
});
