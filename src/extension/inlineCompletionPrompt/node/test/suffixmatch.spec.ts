/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { findEditDistanceScore } from '../../common/suffixMatchCriteria';

suite('EditDistanceScore Test Suite', function () {
	test('findEditDistanceScore computes correct score of two number[]', function () {
		assert.strictEqual(findEditDistanceScore([], [])?.score, 0);
		assert.strictEqual(findEditDistanceScore([1], [1])?.score, 0);
		assert.strictEqual(findEditDistanceScore([1], [2])?.score, 1);
		assert.strictEqual(findEditDistanceScore([1], [])?.score, 1);
		assert.strictEqual(findEditDistanceScore([], [1])?.score, 1);
		assert.strictEqual(findEditDistanceScore([1, 2, 3], [3, 2, 1])?.score, 2);
	});
});
