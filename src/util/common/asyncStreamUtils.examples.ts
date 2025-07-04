/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Example usage of the Async Stream Utilities
 * This file demonstrates the key features and usage patterns.
 */

import { AsyncStreamUtils, createAsyncStreamBuilder, fromArray, fromPromise } from './asyncStreamUtils';
import { CancellationTokenSource } from '../vs/base/common/cancellation';
import { AsyncIterableObject } from '../vs/base/common/async';

// Example 1: Basic buffering
async function basicBufferingExample() {
	console.log('=== Basic Buffering Example ===');
	
	const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	const stream = AsyncIterableObject.fromArray(items);
	const buffered = AsyncStreamUtils.buffer(stream, 3);

	console.log('Original items:', items);
	console.log('Buffered chunks:');
	for await (const chunk of buffered) {
		console.log('  Chunk:', chunk);
	}
}

// Example 2: Fluent API chaining
async function fluentApiExample() {
	console.log('\n=== Fluent API Example ===');
	
	const result = await fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
		.map(x => x * 2)
		.filter(x => x > 8)
		.buffer(3)
		.toArray();

	console.log('Result:', result);
	// Expected: [[10, 12, 14], [16, 18, 20]]
}

// Example 3: Error handling with recovery
async function errorHandlingExample() {
	console.log('\n=== Error Handling Example ===');
	
	const items = [1, 2, 3, 4, 5];
	const stream = AsyncIterableObject.fromArray(items);
	
	const processed = AsyncStreamUtils.mapWithErrorHandling(
		stream,
		(item) => {
			if (item === 3) {
				throw new Error(`Error processing item ${item}`);
			}
			return item * 10;
		},
		{
			onError: (error, item) => {
				console.log(`  Recovered from error on item ${item}: ${error.message}`);
				return item * -1; // Return negative value as fallback
			}
		}
	);

	console.log('Processed items:');
	for await (const item of processed) {
		console.log('  Item:', item);
	}
	// Expected: 10, 20, -3, 40, 50
}

// Example 4: Stream merging
async function streamMergingExample() {
	console.log('\n=== Stream Merging Example ===');
	
	const stream1 = AsyncIterableObject.fromArray(['A', 'B', 'C']);
	const stream2 = AsyncIterableObject.fromArray(['1', '2']);
	const stream3 = AsyncIterableObject.fromArray(['X', 'Y', 'Z']);
	
	const merged = AsyncStreamUtils.merge([stream1, stream2, stream3]);
	
	const result = await AsyncStreamUtils.toArray(merged);
	console.log('Merged result:', result);
	// Note: Order may vary since streams are processed concurrently
}

// Example 5: Retry with backoff
async function retryExample() {
	console.log('\n=== Retry Example ===');
	
	let attemptCount = 0;
	const unreliableStreamFactory = () => {
		attemptCount++;
		console.log(`  Attempt ${attemptCount}`);
		
		if (attemptCount < 3) {
			throw new Error('Simulated failure');
		}
		
		return AsyncIterableObject.fromArray(['Success!', 'Data', 'Retrieved']);
	};

	const retried = AsyncStreamUtils.retry(
		unreliableStreamFactory,
		3, // Max retries
		{ retryDelayMs: 100 }
	);

	console.log('Retry result:');
	for await (const item of retried) {
		console.log('  Item:', item);
	}
}

// Example 6: Cancellation support
async function cancellationExample() {
	console.log('\n=== Cancellation Example ===');
	
	const tokenSource = new CancellationTokenSource();
	
	// Create a slow stream that emits items with delay
	const slowStream = async function* () {
		for (let i = 1; i <= 10; i++) {
			console.log(`  Emitting item ${i}`);
			yield i;
			// Simulate some processing time
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	};

	const throttled = AsyncStreamUtils.throttle(slowStream(), 50, {
		cancellationToken: tokenSource.token
	});

	// Cancel after 250ms
	setTimeout(() => {
		console.log('  Cancelling stream...');
		tokenSource.cancel();
	}, 250);

	try {
		for await (const item of throttled) {
			console.log('  Received:', item);
		}
	} catch (error) {
		console.log('  Stream cancelled:', error.message);
	} finally {
		tokenSource.dispose();
	}
}

// Example 7: Real-world scenario - Processing API data
async function realWorldExample() {
	console.log('\n=== Real-World Example: API Data Processing ===');
	
	// Simulate API responses
	const apiResponses = [
		{ id: 1, data: 'User data 1', valid: true },
		{ id: 2, data: 'User data 2', valid: false }, // Invalid data
		{ id: 3, data: 'User data 3', valid: true },
		{ id: 4, data: 'User data 4', valid: true },
		{ id: 5, data: 'User data 5', valid: true },
		{ id: 6, data: 'User data 6', valid: false }, // Invalid data
		{ id: 7, data: 'User data 7', valid: true },
	];

	const processed = await fromArray(apiResponses)
		.filter(response => response.valid)
		.map(response => ({
			...response,
			processed: true,
			timestamp: Date.now()
		}), {
			continueOnError: true,
			onError: (error, item) => {
				console.log(`  Error processing ${item.id}: ${error.message}`);
				return { ...item, error: true };
			}
		})
		.buffer(3) // Process in batches of 3
		.toArray();

	console.log('Processed batches:');
	processed.forEach((batch, index) => {
		console.log(`  Batch ${index + 1}:`, batch.map(item => `ID:${item.id}`));
	});
}

// Run all examples
async function runAllExamples() {
	try {
		await basicBufferingExample();
		await fluentApiExample();
		await errorHandlingExample();
		await streamMergingExample();
		await retryExample();
		await cancellationExample();
		await realWorldExample();
		
		console.log('\n=== All Examples Completed ===');
	} catch (error) {
		console.error('Example failed:', error);
	}
}

// Export for potential use in tests or other files
export {
	basicBufferingExample,
	fluentApiExample,
	errorHandlingExample,
	streamMergingExample,
	retryExample,
	cancellationExample,
	realWorldExample,
	runAllExamples
};

// Run examples if this file is executed directly
if (require.main === module) {
	runAllExamples();
}