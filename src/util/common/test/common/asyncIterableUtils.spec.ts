/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { AsyncIterUtils } from '../../asyncIterableUtils';

describe('AsyncIterableUtils', () => {

	describe('map', () => {
		it('should map items using the provided function', async () => {
			const input = AsyncIterUtils.fromArray([1, 2, 3]);
			const mapped = AsyncIterUtils.map(input, x => x * 2);
			const result = await AsyncIterUtils.toArray(mapped);
			expect(result).toEqual([2, 4, 6]);
		});

		it('should handle empty iterable', async () => {
			const input = AsyncIterUtils.fromArray<number>([]);
			const mapped = AsyncIterUtils.map(input, x => x * 2);
			const result = await AsyncIterUtils.toArray(mapped);
			expect(result).toEqual([]);
		});

		it('should transform item types', async () => {
			const input = AsyncIterUtils.fromArray([1, 2, 3]);
			const mapped = AsyncIterUtils.map(input, x => x.toString());
			const result = await AsyncIterUtils.toArray(mapped);
			expect(result).toEqual(['1', '2', '3']);
		});
	});

	describe('mapWithReturn', () => {
		it('should map items and return value', async () => {
			const input = AsyncIterUtils.fromArrayWithReturn([1, 2, 3], 'done');
			const mapped = AsyncIterUtils.mapWithReturn(
				input,
				x => x * 2,
				ret => ret.toUpperCase()
			);
			const [items, returnValue] = await AsyncIterUtils.toArrayWithReturn(mapped);
			expect(items).toEqual([2, 4, 6]);
			expect(returnValue).toBe('DONE');
		});

		it('should handle empty iterable with return value', async () => {
			const input = AsyncIterUtils.fromArrayWithReturn<number, string>([], 'empty');
			const mapped = AsyncIterUtils.mapWithReturn(
				input,
				x => x * 2,
				ret => ret.toUpperCase()
			);
			const [items, returnValue] = await AsyncIterUtils.toArrayWithReturn(mapped);
			expect(items).toEqual([]);
			expect(returnValue).toBe('EMPTY');
		});
	});

	describe('filter', () => {
		it('should filter items using the provided predicate', async () => {
			const input = AsyncIterUtils.fromArray([1, 2, 3, 4, 5]);
			const filtered = AsyncIterUtils.filter(input, x => x % 2 === 0);
			const result = await AsyncIterUtils.toArray(filtered);
			expect(result).toEqual([2, 4]);
		});

		it('should handle empty iterable', async () => {
			const input = AsyncIterUtils.fromArray<number>([]);
			const filtered = AsyncIterUtils.filter(input, x => x % 2 === 0);
			const result = await AsyncIterUtils.toArray(filtered);
			expect(result).toEqual([]);
		});

		it('should return empty when no items match', async () => {
			const input = AsyncIterUtils.fromArray([1, 3, 5]);
			const filtered = AsyncIterUtils.filter(input, x => x % 2 === 0);
			const result = await AsyncIterUtils.toArray(filtered);
			expect(result).toEqual([]);
		});

		it('should return all items when all match', async () => {
			const input = AsyncIterUtils.fromArray([2, 4, 6]);
			const filtered = AsyncIterUtils.filter(input, x => x % 2 === 0);
			const result = await AsyncIterUtils.toArray(filtered);
			expect(result).toEqual([2, 4, 6]);
		});
	});

	describe('toArray', () => {
		it('should collect all items into an array', async () => {
			const input = AsyncIterUtils.fromArray([1, 2, 3]);
			const result = await AsyncIterUtils.toArray(input);
			expect(result).toEqual([1, 2, 3]);
		});

		it('should return empty array for empty iterable', async () => {
			const input = AsyncIterUtils.fromArray<number>([]);
			const result = await AsyncIterUtils.toArray(input);
			expect(result).toEqual([]);
		});

		it('should preserve item order', async () => {
			const input = AsyncIterUtils.fromArray(['a', 'b', 'c', 'd']);
			const result = await AsyncIterUtils.toArray(input);
			expect(result).toEqual(['a', 'b', 'c', 'd']);
		});
	});

	describe('toArrayWithReturn', () => {
		it('should collect items and capture return value', async () => {
			const input = AsyncIterUtils.fromArrayWithReturn([1, 2, 3], 'finished');
			const [items, returnValue] = await AsyncIterUtils.toArrayWithReturn(input);
			expect(items).toEqual([1, 2, 3]);
			expect(returnValue).toBe('finished');
		});

		it('should handle empty iterable with return value', async () => {
			const input = AsyncIterUtils.fromArrayWithReturn<number, string>([], 'empty result');
			const [items, returnValue] = await AsyncIterUtils.toArrayWithReturn(input);
			expect(items).toEqual([]);
			expect(returnValue).toBe('empty result');
		});

		it('should handle complex return types', async () => {
			const returnObj = { status: 'complete', count: 3 };
			const input = AsyncIterUtils.fromArrayWithReturn([1, 2, 3], returnObj);
			const [items, returnValue] = await AsyncIterUtils.toArrayWithReturn(input);
			expect(items).toEqual([1, 2, 3]);
			expect(returnValue).toBe(returnObj);
		});
	});
});
