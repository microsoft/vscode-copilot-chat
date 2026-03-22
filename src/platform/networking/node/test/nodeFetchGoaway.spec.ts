/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isGracefulGoawayError } from '../nodeFetchFetcher';

describe('isGracefulGoawayError', () => {
	it('detects GOAWAY with code 0 in message', () => {
		const err = new Error('"GOAWAY" frame received with code 0');
		expect(isGracefulGoawayError(err)).toBe(true);
	});

	it('detects GOAWAY with code 0 in cause message', () => {
		const cause = new Error('"GOAWAY" frame received with code 0');
		const err = new Error('fetch failed', { cause });
		expect(isGracefulGoawayError(err)).toBe(true);
	});

	it('does not match GOAWAY with non-zero error codes', () => {
		const err = new Error('"GOAWAY" frame received with code 2');
		expect(isGracefulGoawayError(err)).toBe(false);
	});

	it('does not match non-GOAWAY errors', () => {
		const err = new Error('ECONNRESET');
		expect(isGracefulGoawayError(err)).toBe(false);
	});

	it('does not match null/undefined', () => {
		expect(isGracefulGoawayError(null)).toBe(false);
		expect(isGracefulGoawayError(undefined)).toBe(false);
	});

	it('does not match error with code 0 but no GOAWAY', () => {
		const err = new Error('connection reset with code 0');
		expect(isGracefulGoawayError(err)).toBe(false);
	});

	it('handles HTTP/2 prefixed GOAWAY message', () => {
		const err = new Error('HTTP/2: "GOAWAY" frame received with code 0');
		expect(isGracefulGoawayError(err)).toBe(true);
	});
});
