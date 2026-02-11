/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, describe, it } from 'vitest';
import { extractSessionId } from '../claudeLanguageModelServer';

const NONCE = 'vscode-lm-test-nonce';

describe('extractSessionId', () => {
	describe('x-api-key header', () => {
		it('extracts session ID from nonce.sessionId format', () => {
			const result = extractSessionId({ 'x-api-key': `${NONCE}.my-session-123` }, NONCE);
			assert.strictEqual(result, 'my-session-123');
		});

		it('returns empty string for legacy format without session ID', () => {
			const result = extractSessionId({ 'x-api-key': NONCE }, NONCE);
			assert.strictEqual(result, '');
		});

		it('returns undefined for invalid nonce', () => {
			const result = extractSessionId({ 'x-api-key': 'wrong-nonce.session-1' }, NONCE);
			assert.strictEqual(result, undefined);
		});

		it('returns undefined for invalid legacy nonce', () => {
			const result = extractSessionId({ 'x-api-key': 'wrong-nonce' }, NONCE);
			assert.strictEqual(result, undefined);
		});

		it('handles session ID containing dots', () => {
			const result = extractSessionId({ 'x-api-key': `${NONCE}.session.with.dots` }, NONCE);
			assert.strictEqual(result, 'session.with.dots');
		});
	});

	describe('Authorization Bearer header', () => {
		it('extracts session ID from Bearer token with nonce.sessionId format', () => {
			const result = extractSessionId({ 'authorization': `Bearer ${NONCE}.my-session` }, NONCE);
			assert.strictEqual(result, 'my-session');
		});

		it('returns empty string for legacy Bearer format', () => {
			const result = extractSessionId({ 'authorization': `Bearer ${NONCE}` }, NONCE);
			assert.strictEqual(result, '');
		});

		it('returns undefined for invalid Bearer nonce', () => {
			const result = extractSessionId({ 'authorization': 'Bearer wrong-nonce.session' }, NONCE);
			assert.strictEqual(result, undefined);
		});
	});

	describe('header priority', () => {
		it('prefers x-api-key over Authorization header', () => {
			const result = extractSessionId({
				'x-api-key': `${NONCE}.from-api-key`,
				'authorization': `Bearer ${NONCE}.from-bearer`,
			}, NONCE);
			assert.strictEqual(result, 'from-api-key');
		});
	});

	describe('missing headers', () => {
		it('returns undefined when no auth headers are present', () => {
			const result = extractSessionId({}, NONCE);
			assert.strictEqual(result, undefined);
		});

		it('returns undefined for non-Bearer Authorization header', () => {
			const result = extractSessionId({ 'authorization': `Basic ${NONCE}.session` }, NONCE);
			assert.strictEqual(result, undefined);
		});

		it('returns undefined for non-string x-api-key', () => {
			const result = extractSessionId({ 'x-api-key': ['array-value'] }, NONCE);
			assert.strictEqual(result, undefined);
		});
	});
});
