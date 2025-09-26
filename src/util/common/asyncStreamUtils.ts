/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../vs/base/common/cancellation';
import { CancellationError } from '../vs/base/common/errors';
import { AsyncIterableObject, AsyncIterableSource, CancelableAsyncIterableObject, createCancelableAsyncIterable, timeout } from '../vs/base/common/async';
import { Disposable, IDisposable } from '../vs/base/common/lifecycle';

/**
 * Enhanced async stream abstractions for easier handling of async streams
 * with robust cancellation and error handling support.
 */

/**
 * Options for stream operations
 */
export interface StreamOptions {
	/**
	 * Cancellation token for the operation
	 */
	cancellationToken?: CancellationToken;
	
	/**
	 * Timeout in milliseconds
	 */
	timeout?: number;
	
	/**
	 * Whether to continue processing on individual item errors
	 */
	continueOnError?: boolean;
}

/**
 * Stream utilities for working with async iterables
 */
export class AsyncStreamUtils {

	/**
	 * Creates a buffered stream that collects items into chunks of the specified size
	 */
	static buffer<T>(
		stream: AsyncIterable<T>, 
		bufferSize: number, 
		options?: StreamOptions
	): CancelableAsyncIterableObject<T[]> {
		return createCancelableAsyncIterable(async function* (token) {
			const effectiveToken = options?.cancellationToken ?? token;

			let buffer: T[] = [];
			
			try {
				for await (const item of stream) {
					if (effectiveToken.isCancellationRequested) {
						throw new CancellationError();
					}
					
					buffer.push(item);
					
					if (buffer.length >= bufferSize) {
						yield [...buffer];
						buffer = [];
					}
				}
				
				// Yield remaining items if any
				if (buffer.length > 0) {
					yield [...buffer];
				}
			} catch (error) {
				if (error instanceof CancellationError) {
					throw error;
				}
				if (!options?.continueOnError) {
					throw error;
				}
				// If continuing on error, yield what we have collected
				if (buffer.length > 0) {
					yield [...buffer];
				}
			}
		});
	}

	/**
	 * Creates a throttled stream that limits the rate of item emission
	 */
	static throttle<T>(
		stream: AsyncIterable<T>, 
		intervalMs: number, 
		options?: StreamOptions
	): CancelableAsyncIterableObject<T> {
		return createCancelableAsyncIterable(async function* (token) {
			const effectiveToken = options?.cancellationToken ?? token;

			let lastEmitTime = 0;
			
			try {
				for await (const item of stream) {
					if (effectiveToken.isCancellationRequested) {
						throw new CancellationError();
					}
					
					const now = Date.now();
					const timeSinceLastEmit = now - lastEmitTime;
					
					if (timeSinceLastEmit < intervalMs) {
						await timeout(intervalMs - timeSinceLastEmit);
					}
					
					if (effectiveToken.isCancellationRequested) {
						throw new CancellationError();
					}
					
					yield item;
					lastEmitTime = Date.now();
				}
			} catch (error) {
				if (error instanceof CancellationError) {
					throw error;
				}
				if (!options?.continueOnError) {
					throw error;
				}
			}
		});
	}

	/**
	 * Creates a debounced stream that only emits items after a period of inactivity
	 */
	static debounce<T>(
		stream: AsyncIterable<T>, 
		delayMs: number, 
		options?: StreamOptions
	): CancelableAsyncIterableObject<T> {
		return createCancelableAsyncIterable(async function* (token) {
			const effectiveToken = options?.cancellationToken ?? token;

			let latestItem: T | undefined;
			let hasItem = false;
			let isComplete = false;
			
			const iterator = stream[Symbol.asyncIterator]();
			
			try {
				while (!isComplete && !effectiveToken.isCancellationRequested) {
					// Try to get next item with timeout
					const timeoutPromise = timeout(delayMs).then(() => 'timeout' as const);
					const nextPromise = iterator.next().then(result => ({ type: 'next' as const, result }));
					
					const result = await Promise.race([timeoutPromise, nextPromise]);
					
					if (effectiveToken.isCancellationRequested) {
						throw new CancellationError();
					}
					
					if (result === 'timeout') {
						// Timeout reached, emit latest item if we have one
						if (hasItem && latestItem !== undefined) {
							yield latestItem;
							hasItem = false;
							latestItem = undefined;
						}
					} else {
						// Got new item
						if (result.result.done) {
							isComplete = true;
							// Emit final item if any
							if (hasItem && latestItem !== undefined) {
								yield latestItem;
							}
						} else {
							latestItem = result.result.value;
							hasItem = true;
						}
					}
				}
			} catch (error) {
				if (error instanceof CancellationError) {
					throw error;
				}
				if (!options?.continueOnError) {
					throw error;
				}
			}
		});
	}

	/**
	 * Merges multiple streams into one, handling cancellation and errors appropriately
	 */
	static merge<T>(
		streams: AsyncIterable<T>[], 
		options?: StreamOptions
	): CancelableAsyncIterableObject<T> {
		return createCancelableAsyncIterable(async function* (token) {
			const effectiveToken = options?.cancellationToken ?? token;

			const promises = streams.map(async (stream, index) => {
				const results: { value: T; index: number }[] = [];
				try {
					for await (const item of stream) {
						if (effectiveToken.isCancellationRequested) {
							throw new CancellationError();
						}
						results.push({ value: item, index });
					}
				} catch (error) {
					if (error instanceof CancellationError) {
						throw error;
					}
					if (!options?.continueOnError) {
						throw error;
					}
				}
				return results;
			});
			
			try {
				const allResults = await Promise.all(promises);
				const flatResults = allResults.flat();
				
				// Sort by original order if needed, or just emit in received order
				for (const result of flatResults) {
					if (effectiveToken.isCancellationRequested) {
						throw new CancellationError();
					}
					yield result.value;
				}
			} catch (error) {
				if (error instanceof CancellationError) {
					throw error;
				}
				if (!options?.continueOnError) {
					throw error;
				}
			}
		});
	}

	/**
	 * Creates a stream with timeout support
	 */
	static withTimeout<T>(
		stream: AsyncIterable<T>, 
		timeoutMs: number, 
		options?: StreamOptions
	): CancelableAsyncIterableObject<T> {
		return createCancelableAsyncIterable(async function* (token) {
			const effectiveToken = options?.cancellationToken ?? token;

			const startTime = Date.now();
			
			try {
				for await (const item of stream) {
					if (effectiveToken.isCancellationRequested) {
						throw new CancellationError();
					}
					
					const elapsed = Date.now() - startTime;
					if (elapsed > timeoutMs) {
						throw new Error(`Stream timeout after ${timeoutMs}ms`);
					}
					
					yield item;
				}
			} catch (error) {
				if (error instanceof CancellationError) {
					throw error;
				}
				if (!options?.continueOnError) {
					throw error;
				}
			}
		});
	}

	/**
	 * Creates a stream that retries on errors
	 */
	static retry<T>(
		streamFactory: () => AsyncIterable<T>, 
		maxRetries: number, 
		options?: StreamOptions & { retryDelayMs?: number }
	): CancelableAsyncIterableObject<T> {
		return createCancelableAsyncIterable(async function* (token) {
			const effectiveToken = options?.cancellationToken ?? token;

			let attempt = 0;
			
			while (attempt <= maxRetries && !effectiveToken.isCancellationRequested) {
				try {
					const stream = streamFactory();
					for await (const item of stream) {
						if (effectiveToken.isCancellationRequested) {
							throw new CancellationError();
						}
						yield item;
					}
					return; // Success, exit retry loop
				} catch (error) {
					if (error instanceof CancellationError) {
						throw error;
					}
					
					attempt++;
					if (attempt > maxRetries) {
						if (!options?.continueOnError) {
							throw error;
						}
						return;
					}
					
					// Wait before retry if specified
					if (options?.retryDelayMs) {
						await timeout(options.retryDelayMs);
					}
				}
			}
		});
	}

	/**
	 * Converts an async stream to a promise that resolves to an array
	 */
	static async toArray<T>(
		stream: AsyncIterable<T>, 
		options?: StreamOptions
	): Promise<T[]> {
		const results: T[] = [];
		const effectiveToken = options?.cancellationToken;
		
		try {
			for await (const item of stream) {
				if (effectiveToken?.isCancellationRequested) {
					throw new CancellationError();
				}
				results.push(item);
			}
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			if (!options?.continueOnError) {
				throw error;
			}
		}
		
		return results;
	}

	/**
	 * Creates a stream that applies a transformation to each item with error handling
	 */
	static mapWithErrorHandling<T, R>(
		stream: AsyncIterable<T>, 
		mapper: (item: T) => R | Promise<R>, 
		options?: StreamOptions & { onError?: (error: Error, item: T) => R | undefined }
	): CancelableAsyncIterableObject<R> {
		return createCancelableAsyncIterable(async function* (token) {
			const effectiveToken = options?.cancellationToken ?? token;

			try {
				for await (const item of stream) {
					if (effectiveToken.isCancellationRequested) {
						throw new CancellationError();
					}
					
					try {
						const result = await mapper(item);
						yield result;
					} catch (error) {
						if (error instanceof CancellationError) {
							throw error;
						}
						
						if (options?.onError) {
							const errorResult = options.onError(error, item);
							if (errorResult !== undefined) {
								yield errorResult;
							}
						} else if (!options?.continueOnError) {
							throw error;
						}
					}
				}
			} catch (error) {
				if (error instanceof CancellationError) {
					throw error;
				}
				if (!options?.continueOnError) {
					throw error;
				}
			}
		});
	}
}

/**
 * Stream builder for fluent API usage
 */
export class AsyncStreamBuilder<T> {
	constructor(private stream: AsyncIterable<T>) {}

	/**
	 * Maps each item in the stream
	 */
	map<R>(mapper: (item: T) => R | Promise<R>, options?: StreamOptions): AsyncStreamBuilder<R> {
		const mapped = AsyncStreamUtils.mapWithErrorHandling(this.stream, mapper, options);
		return new AsyncStreamBuilder(mapped);
	}

	/**
	 * Filters items in the stream
	 */
	filter(predicate: (item: T) => boolean | Promise<boolean>, options?: StreamOptions): AsyncStreamBuilder<T> {
		const filtered = createCancelableAsyncIterable(async function* (token) {
			const effectiveToken = options?.cancellationToken ?? token;

			try {
				for await (const item of this.stream) {
					if (effectiveToken.isCancellationRequested) {
						throw new CancellationError();
					}
					
					try {
						const shouldInclude = await predicate(item);
						if (shouldInclude) {
							yield item;
						}
					} catch (error) {
						if (error instanceof CancellationError) {
							throw error;
						}
						if (!options?.continueOnError) {
							throw error;
						}
					}
				}
			} catch (error) {
				if (error instanceof CancellationError) {
					throw error;
				}
				if (!options?.continueOnError) {
					throw error;
				}
			}
		}.bind(this));
		
		return new AsyncStreamBuilder(filtered);
	}

	/**
	 * Buffers items into chunks
	 */
	buffer(size: number, options?: StreamOptions): AsyncStreamBuilder<T[]> {
		const buffered = AsyncStreamUtils.buffer(this.stream, size, options);
		return new AsyncStreamBuilder(buffered);
	}

	/**
	 * Throttles the stream
	 */
	throttle(intervalMs: number, options?: StreamOptions): AsyncStreamBuilder<T> {
		const throttled = AsyncStreamUtils.throttle(this.stream, intervalMs, options);
		return new AsyncStreamBuilder(throttled);
	}

	/**
	 * Debounces the stream
	 */
	debounce(delayMs: number, options?: StreamOptions): AsyncStreamBuilder<T> {
		const debounced = AsyncStreamUtils.debounce(this.stream, delayMs, options);
		return new AsyncStreamBuilder(debounced);
	}

	/**
	 * Adds timeout to the stream
	 */
	withTimeout(timeoutMs: number, options?: StreamOptions): AsyncStreamBuilder<T> {
		const withTimeout = AsyncStreamUtils.withTimeout(this.stream, timeoutMs, options);
		return new AsyncStreamBuilder(withTimeout);
	}

	/**
	 * Converts to array
	 */
	toArray(options?: StreamOptions): Promise<T[]> {
		return AsyncStreamUtils.toArray(this.stream, options);
	}

	/**
	 * Gets the underlying async iterable
	 */
	toAsyncIterable(): AsyncIterable<T> {
		return this.stream;
	}
}

/**
 * Creates a new async stream builder from an async iterable
 */
export function createAsyncStreamBuilder<T>(stream: AsyncIterable<T>): AsyncStreamBuilder<T> {
	return new AsyncStreamBuilder(stream);
}

/**
 * Creates a new async stream builder from an array
 */
export function fromArray<T>(items: T[]): AsyncStreamBuilder<T> {
	return new AsyncStreamBuilder(AsyncIterableObject.fromArray(items));
}

/**
 * Creates a new async stream builder from a promise
 */
export function fromPromise<T>(promise: Promise<T[]>): AsyncStreamBuilder<T> {
	return new AsyncStreamBuilder(AsyncIterableObject.fromPromise(promise));
}