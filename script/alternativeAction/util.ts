/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const DEBUG = true;

export function log(...args: any[]) {
	if (DEBUG) {
		console.log(...args);
	}
}

export function binarySearch<T>(
	array: readonly T[],
	compare: (element: T) => number
): number {
	let left = 0;
	let right = array.length - 1;
	let lastLess = -1;

	while (left <= right) {
		const mid = Math.floor((left + right) / 2);
		const cmp = compare(array[mid]);

		if (cmp === 0) {
			return mid;
		} else if (cmp < 0) {
			lastLess = mid;
			left = mid + 1;
		} else {
			right = mid - 1;
		}
	}

	return lastLess;
}

