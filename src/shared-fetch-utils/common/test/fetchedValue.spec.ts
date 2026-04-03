/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { FetchedValue, FetchedValueOptions } from '../fetchedValue';

interface TestToken {
	value: string;
	expiresAt: number;
}

describe('FetchedValue', () => {
	let fetchCount: number;
	let nextToken: TestToken;
	let fetchedValue: FetchedValue<TestToken>;

	function createFetchedValue(overrides?: Partial<FetchedValueOptions<TestToken>>): FetchedValue<TestToken> {
		return new FetchedValue({
			fetch: async () => {
				fetchCount++;
				return nextToken;
			},
			isStale: token => token.expiresAt < Date.now(),
			...overrides,
		});
	}

	beforeEach(() => {
		fetchCount = 0;
		nextToken = { value: 'token-1', expiresAt: Date.now() + 60_000 };
		fetchedValue = createFetchedValue();
	});

	it('value is undefined before first resolve', () => {
		expect(fetchedValue.value).toBeUndefined();
	});

	it('resolve fetches and caches the value', async () => {
		const result = await fetchedValue.resolve();
		expect(result).toBe(nextToken);
		expect(fetchedValue.value).toBe(nextToken);
		expect(fetchCount).toBe(1);
	});

	it('resolve returns cached value when not stale', async () => {
		await fetchedValue.resolve();
		nextToken = { value: 'token-2', expiresAt: Date.now() + 60_000 };
		const result = await fetchedValue.resolve();
		expect(result.value).toBe('token-1');
		expect(fetchCount).toBe(1);
	});

	it('resolve re-fetches when value is stale', async () => {
		nextToken = { value: 'token-1', expiresAt: Date.now() - 1 };
		await fetchedValue.resolve();
		expect(fetchCount).toBe(1);

		nextToken = { value: 'token-2', expiresAt: Date.now() + 60_000 };
		const result = await fetchedValue.resolve();
		expect(result.value).toBe('token-2');
		expect(fetchCount).toBe(2);
	});

	it('resolve with force bypasses staleness check', async () => {
		await fetchedValue.resolve();
		nextToken = { value: 'token-2', expiresAt: Date.now() + 60_000 };

		const result = await fetchedValue.resolve(true);
		expect(result.value).toBe('token-2');
		expect(fetchCount).toBe(2);
	});

	it('concurrent resolves coalesce into a single fetch', async () => {
		const [a, b, c] = await Promise.all([
			fetchedValue.resolve(),
			fetchedValue.resolve(),
			fetchedValue.resolve(),
		]);
		expect(fetchCount).toBe(1);
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it('fetch error propagates and does not cache', async () => {
		const fv = createFetchedValue({
			fetch: async () => { throw new Error('network failure'); },
		});

		await expect(fv.resolve()).rejects.toThrow('network failure');
		expect(fv.value).toBeUndefined();
	});

	it('dispose prevents further resolves', async () => {
		fetchedValue.dispose();
		await expect(fetchedValue.resolve()).rejects.toThrow('disposed');
	});
});
