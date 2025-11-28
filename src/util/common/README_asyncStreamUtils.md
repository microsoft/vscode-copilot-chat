# Async Stream Utilities

This module provides enhanced async stream abstractions for easier handling of async streams with robust cancellation and error handling support.

## Overview

The async stream utilities build on top of the existing `AsyncIterableObject` from VS Code's async utilities, providing high-level abstractions for common streaming patterns.

## Key Features

- **Stream Buffering**: Collect items into chunks of specified size
- **Stream Throttling**: Limit the rate of item emission
- **Stream Debouncing**: Only emit items after periods of inactivity
- **Stream Merging**: Combine multiple streams into one
- **Stream Timeout**: Add timeout support to streams
- **Stream Retry**: Retry failed streams with configurable backoff
- **Error Handling**: Sophisticated error handling with continue-on-error support
- **Cancellation Support**: Full cancellation token support throughout all operations
- **Fluent API**: Chain operations together with a fluent builder pattern

## Basic Usage

### AsyncStreamUtils Class

```typescript
import { AsyncStreamUtils } from './asyncStreamUtils';
import { AsyncIterableObject } from './vs/base/common/async';

// Buffer items into chunks
const items = AsyncIterableObject.fromArray([1, 2, 3, 4, 5, 6, 7]);
const buffered = AsyncStreamUtils.buffer(items, 3);
// Result: [[1, 2, 3], [4, 5, 6], [7]]

// Throttle item emission
const throttled = AsyncStreamUtils.throttle(items, 100); // 100ms between items

// Merge multiple streams
const stream1 = AsyncIterableObject.fromArray([1, 2]);
const stream2 = AsyncIterableObject.fromArray([3, 4]);
const merged = AsyncStreamUtils.merge([stream1, stream2]);

// Convert to array
const result = await AsyncStreamUtils.toArray(merged);
```

### Fluent API with AsyncStreamBuilder

```typescript
import { fromArray, createAsyncStreamBuilder } from './asyncStreamUtils';

// Chain operations together
const result = await fromArray([1, 2, 3, 4, 5, 6])
  .map(x => x * 2)
  .filter(x => x > 4)
  .buffer(2)
  .toArray();
// Result: [[6, 8], [10, 12]]

// Work with promises
const data = fromPromise(Promise.resolve([1, 2, 3, 4, 5]))
  .map(x => x * 3)
  .filter(x => x > 6)
  .toArray();
// Result: [9, 12, 15]
```

## Cancellation Support

All stream operations support cancellation tokens:

```typescript
import { CancellationTokenSource } from './vs/base/common/cancellation';

const tokenSource = new CancellationTokenSource();

const buffered = AsyncStreamUtils.buffer(stream, 10, {
  cancellationToken: tokenSource.token
});

// Cancel the operation
tokenSource.cancel();

// The stream will throw a CancellationError
```

## Error Handling

Configure error handling behavior:

```typescript
// Continue processing on individual item errors
const mapped = AsyncStreamUtils.mapWithErrorHandling(
  stream,
  item => processItem(item),
  {
    continueOnError: true,
    onError: (error, item) => {
      console.error('Error processing item:', item, error);
      return null; // Return fallback value
    }
  }
);
```

## Stream Operations

### Buffer
Groups items into arrays of specified size.

```typescript
const buffered = AsyncStreamUtils.buffer(stream, 5);
```

### Throttle
Limits the rate of item emission.

```typescript
const throttled = AsyncStreamUtils.throttle(stream, 1000); // Max 1 item per second
```

### Debounce
Only emits items after periods of inactivity.

```typescript
const debounced = AsyncStreamUtils.debounce(stream, 500); // Wait 500ms of inactivity
```

### Merge
Combines multiple streams into one.

```typescript
const merged = AsyncStreamUtils.merge([stream1, stream2, stream3]);
```

### Timeout
Adds timeout support to streams.

```typescript
const withTimeout = AsyncStreamUtils.withTimeout(stream, 5000); // 5 second timeout
```

### Retry
Retries failed streams with configurable attempts and delay.

```typescript
const retried = AsyncStreamUtils.retry(
  () => createFailingStream(),
  3, // Max 3 retries
  { retryDelayMs: 1000 } // 1 second delay between retries
);
```

## Real-World Example

Here's an example of processing API responses with retry logic, error handling, and throttling:

```typescript
async function processApiData() {
  const apiCalls = async function* () {
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`/api/data?page=${page}`);
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const data = await response.json();
      yield* data.items;
    }
  };

  const processed = await createAsyncStreamBuilder(apiCalls())
    .map(item => ({
      ...item,
      processed: true,
      timestamp: Date.now()
    }), {
      continueOnError: true,
      onError: (error, item) => {
        console.error('Failed to process item:', item, error);
        return { ...item, error: true };
      }
    })
    .filter(item => !item.error)
    .throttle(100) // Limit to 10 items per second
    .buffer(5) // Process in batches of 5
    .toArray();

  return processed;
}
```

## Implementation Notes

- All utilities are built on top of the existing `AsyncIterableObject` and `CancelableAsyncIterableObject` classes
- Cancellation is handled consistently throughout all operations
- Error handling supports both fail-fast and continue-on-error patterns
- The fluent API makes it easy to chain operations together
- All operations are lazy and only execute when consumed

## Performance Considerations

- Stream operations are lazy and only execute when consumed
- Cancellation tokens should be properly disposed to avoid memory leaks
- Large buffers may consume significant memory
- Throttling and debouncing operations add timing overhead