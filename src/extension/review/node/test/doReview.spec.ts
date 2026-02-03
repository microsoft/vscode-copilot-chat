/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describe, suite, test } from 'vitest';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { combineCancellationTokens } from '../doReview';

suite('doReview', () => {

	describe('combineCancellationTokens', () => {

		test('returns token that is not cancelled when both inputs are not cancelled', () => {
			const source1 = new CancellationTokenSource();
			const source2 = new CancellationTokenSource();
			const combined = combineCancellationTokens(source1.token, source2.token);
			assert.strictEqual(combined.isCancellationRequested, false);
			source1.dispose();
			source2.dispose();
		});

		test('cancels combined token when first token is cancelled after creation', () => {
			const source1 = new CancellationTokenSource();
			const source2 = new CancellationTokenSource();
			const combined = combineCancellationTokens(source1.token, source2.token);
			assert.strictEqual(combined.isCancellationRequested, false);
			source1.cancel();
			assert.strictEqual(combined.isCancellationRequested, true);
			source2.dispose();
		});

		test('cancels combined token when second token is cancelled after creation', () => {
			const source1 = new CancellationTokenSource();
			const source2 = new CancellationTokenSource();
			const combined = combineCancellationTokens(source1.token, source2.token);
			assert.strictEqual(combined.isCancellationRequested, false);
			source2.cancel();
			assert.strictEqual(combined.isCancellationRequested, true);
			source1.dispose();
		});

		test('only cancels combined token once when both tokens are cancelled', () => {
			const source1 = new CancellationTokenSource();
			const source2 = new CancellationTokenSource();
			const combined = combineCancellationTokens(source1.token, source2.token);
			let cancelCount = 0;
			combined.onCancellationRequested(() => cancelCount++);

			source1.cancel();
			source2.cancel();
			// The combined token should only fire once despite both being cancelled
			assert.strictEqual(cancelCount, 1);
		});
	});
});
