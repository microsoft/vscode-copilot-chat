/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AsyncStreamUtils, createAsyncStreamBuilder, fromArray, fromPromise } from '../asyncStreamUtils';
import { CancellationTokenSource } from '../../vs/base/common/cancellation';
import { CancellationError } from '../../vs/base/common/errors';
import { AsyncIterableObject, AsyncIterableSource } from '../../vs/base/common/async';

describe('AsyncStreamUtils', () => {
	let cancellationTokenSource: CancellationTokenSource;

	beforeEach(() => {
		cancellationTokenSource = new CancellationTokenSource();
	});

	afterEach(() => {
		cancellationTokenSource.dispose();
	});

	describe('buffer', () => {
		it('should buffer items into chunks of specified size', async () => {
			const items = [1, 2, 3, 4, 5, 6, 7];
			const stream = AsyncIterableObject.fromArray(items);
			const buffered = AsyncStreamUtils.buffer(stream, 3);

			const result: number[][] = [];
			for await (const chunk of buffered) {
				result.push(chunk);
			}

			expect(result).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
		});

		it('should handle empty streams', async () => {
			const stream = AsyncIterableObject.fromArray([]);
			const buffered = AsyncStreamUtils.buffer(stream, 3);

			const result: any[][] = [];
			for await (const chunk of buffered) {
				result.push(chunk);
			}

			expect(result).toEqual([]);
		});

		it('should handle single item', async () => {
			const stream = AsyncIterableObject.fromArray([42]);
			const buffered = AsyncStreamUtils.buffer(stream, 3);

			const result: number[][] = [];
			for await (const chunk of buffered) {
				result.push(chunk);
			}

			expect(result).toEqual([[42]]);
		});
	});

	describe('throttle', () => {
		it('should throttle item emission', async () => {
			const items = [1, 2, 3];
			const stream = AsyncIterableObject.fromArray(items);
			const throttleIntervalMs = 50;
			const throttled = AsyncStreamUtils.throttle(stream, throttleIntervalMs);

			const startTime = Date.now();
			const result: number[] = [];
			
			for await (const item of throttled) {
				result.push(item);
			}
			
			const endTime = Date.now();
			const elapsed = endTime - startTime;

			expect(result).toEqual([1, 2, 3]);
			// Should take at least 2 * throttleIntervalMs (between 2nd and 3rd item)
			expect(elapsed).toBeGreaterThanOrEqual(2 * throttleIntervalMs - 10); // Allow some tolerance
		});
	});

	describe('merge', () => {
		it('should merge multiple streams', async () => {
			const stream1 = AsyncIterableObject.fromArray([1, 2]);
			const stream2 = AsyncIterableObject.fromArray([3, 4]);
			const stream3 = AsyncIterableObject.fromArray([5, 6]);
			
			const merged = AsyncStreamUtils.merge([stream1, stream2, stream3]);

			const result: number[] = [];
			for await (const item of merged) {
				result.push(item);
			}

			expect(result.sort()).toEqual([1, 2, 3, 4, 5, 6]);
		});

		it('should handle empty streams in merge', async () => {
			const stream1 = AsyncIterableObject.fromArray([1, 2]);
			const stream2 = AsyncIterableObject.fromArray([]);
			const stream3 = AsyncIterableObject.fromArray([3]);
			
			const merged = AsyncStreamUtils.merge([stream1, stream2, stream3]);

			const result: number[] = [];
			for await (const item of merged) {
				result.push(item);
			}

			expect(result.sort()).toEqual([1, 2, 3]);
		});
	});

	describe('withTimeout', () => {
		it('should complete normally if within timeout', async () => {
			const items = [1, 2, 3];
			const stream = AsyncIterableObject.fromArray(items);
			const withTimeout = AsyncStreamUtils.withTimeout(stream, 1000);

			const result: number[] = [];
			for await (const item of withTimeout) {
				result.push(item);
			}

			expect(result).toEqual([1, 2, 3]);
		});
	});

	describe('retry', () => {
		it('should retry on failures', async () => {
			let attemptCount = 0;
			const streamFactory = () => {
				attemptCount++;
				if (attemptCount < 3) {
					throw new Error('Simulated failure');
				}
				return AsyncIterableObject.fromArray([1, 2, 3]);
			};

			const retried = AsyncStreamUtils.retry(streamFactory, 3);

			const result: number[] = [];
			for await (const item of retried) {
				result.push(item);
			}

			expect(result).toEqual([1, 2, 3]);
			expect(attemptCount).toBe(3);
		});

		it('should fail after max retries', async () => {
			let attemptCount = 0;
			const streamFactory = () => {
				attemptCount++;
				throw new Error('Always fails');
			};

			const retried = AsyncStreamUtils.retry(streamFactory, 2);

			await expect(async () => {
				for await (const item of retried) {
					// Should throw error
				}
			}).rejects.toThrow('Always fails');

			expect(attemptCount).toBe(3); // Initial + 2 retries
		});
	});

	describe('toArray', () => {
		it('should convert stream to array', async () => {
			const items = [1, 2, 3, 4, 5];
			const stream = AsyncIterableObject.fromArray(items);
			
			const result = await AsyncStreamUtils.toArray(stream);
			expect(result).toEqual(items);
		});
	});

	describe('mapWithErrorHandling', () => {
		it('should map items successfully', async () => {
			const items = [1, 2, 3];
			const stream = AsyncIterableObject.fromArray(items);
			const mapped = AsyncStreamUtils.mapWithErrorHandling(stream, x => x * 2);

			const result: number[] = [];
			for await (const item of mapped) {
				result.push(item);
			}

			expect(result).toEqual([2, 4, 6]);
		});

		it('should handle errors with custom error handler', async () => {
			const items = [1, 2, 3, 4];
			const stream = AsyncIterableObject.fromArray(items);
			const mapped = AsyncStreamUtils.mapWithErrorHandling(
				stream, 
				x => {
					if (x === 3) throw new Error('Error on 3');
					return x * 2;
				},
				{
					onError: (error, item) => item * -1 // Return negative on error
				}
			);

			const result: number[] = [];
			for await (const item of mapped) {
				result.push(item);
			}

			expect(result).toEqual([2, 4, -3, 8]); // 3 becomes -3 due to error handling
		});

		it('should continue on error when configured', async () => {
			const items = [1, 2, 3, 4];
			const stream = AsyncIterableObject.fromArray(items);
			const mapped = AsyncStreamUtils.mapWithErrorHandling(
				stream, 
				x => {
					if (x === 2) throw new Error('Error on 2');
					return x * 2;
				},
				{
					continueOnError: true
				}
			);

			const result: number[] = [];
			for await (const item of mapped) {
				result.push(item);
			}

			expect(result).toEqual([2, 6, 8]); // 2 is skipped due to error
		});
	});
});

describe('AsyncStreamBuilder', () => {
	it('should support fluent API for stream operations', async () => {
		const result = await fromArray([1, 2, 3, 4, 5, 6])
			.map(x => x * 2)
			.filter(x => x > 4)
			.buffer(2)
			.toArray();

		expect(result).toEqual([[6, 8], [10, 12]]);
	});

	it('should handle complex chaining with error handling', async () => {
		const result = await fromArray([1, 2, 3, 4, 5])
			.map(x => x * 2, { continueOnError: true })
			.filter(x => x > 2)
			.toArray();

		expect(result).toEqual([4, 6, 8, 10]);
	});

	it('should work with promises', async () => {
		const promise = Promise.resolve([1, 2, 3, 4, 5]);
		const result = await fromPromise(promise)
			.map(x => x * 3)
			.filter(x => x > 6)
			.toArray();

		expect(result).toEqual([9, 12, 15]);
	});

	it('should support timeout in chain', async () => {
		const items = [1, 2, 3];
		
		const result = await fromArray(items)
			.withTimeout(1000) // Large timeout, should not trigger
			.map(x => x * 2)
			.toArray();

		expect(result).toEqual([2, 4, 6]);
	});
});

describe('Integration tests', () => {
	it('should handle complex real-world scenario', async () => {
		// Simulate a scenario like processing API responses with retries, throttling, and error handling
		let apiCallCount = 0;
		const simulateApiCalls = async function* () {
			for (let i = 1; i <= 10; i++) {
				apiCallCount++;
				if (i === 3 && apiCallCount < 5) {
					throw new Error('API temporarily unavailable');
				}
				yield { id: i, data: `item-${i}` };
			}
		};

		const processed = await createAsyncStreamBuilder(simulateApiCalls())
			.map(item => ({ ...item, processed: true }), {
				continueOnError: true
			})
			.filter(item => item.id % 2 === 0) // Only even IDs
			.buffer(2)
			.toArray();

		expect(processed.length).toBeGreaterThan(0);
		expect(processed[0]).toHaveLength(2); // First buffer should have 2 items
		expect(processed.flat().every(item => item.processed)).toBe(true);
		expect(processed.flat().every(item => item.id % 2 === 0)).toBe(true);
	});
});