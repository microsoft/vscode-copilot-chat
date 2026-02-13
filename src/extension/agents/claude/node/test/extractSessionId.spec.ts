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
			assert.deepStrictEqual(result, { valid: true, sessionId: 'my-session-123' });
		});

		it('returns valid with no session ID for legacy format', () => {
			const result = extractSessionId({ 'x-api-key': NONCE }, NONCE);
			assert.deepStrictEqual(result, { valid: true, sessionId: undefined });
		});

		it('returns invalid for wrong nonce with session ID', () => {
			const result = extractSessionId({ 'x-api-key': 'wrong-nonce.session-1' }, NONCE);
			assert.deepStrictEqual(result, { valid: false, sessionId: undefined });
		});

		it('returns invalid for wrong legacy nonce', () => {
			const result = extractSessionId({ 'x-api-key': 'wrong-nonce' }, NONCE);
			assert.deepStrictEqual(result, { valid: false, sessionId: undefined });
		});

		it('handles session ID containing dots', () => {
			const result = extractSessionId({ 'x-api-key': `${NONCE}.session.with.dots` }, NONCE);
			assert.deepStrictEqual(result, { valid: true, sessionId: 'session.with.dots' });
		});
	});

	describe('Authorization Bearer header', () => {
		it('extracts session ID from Bearer token with nonce.sessionId format', () => {
			const result = extractSessionId({ 'authorization': `Bearer ${NONCE}.my-session` }, NONCE);
			assert.deepStrictEqual(result, { valid: true, sessionId: 'my-session' });
		});

		it('returns valid with no session ID for legacy Bearer format', () => {
			const result = extractSessionId({ 'authorization': `Bearer ${NONCE}` }, NONCE);
			assert.deepStrictEqual(result, { valid: true, sessionId: undefined });
		});

		it('returns invalid for wrong Bearer nonce', () => {
			const result = extractSessionId({ 'authorization': 'Bearer wrong-nonce.session' }, NONCE);
			assert.deepStrictEqual(result, { valid: false, sessionId: undefined });
		});
	});

	describe('header priority', () => {
		it('prefers x-api-key over Authorization header', () => {
			const result = extractSessionId({
				'x-api-key': `${NONCE}.from-api-key`,
				'authorization': `Bearer ${NONCE}.from-bearer`,
			}, NONCE);
			assert.deepStrictEqual(result, { valid: true, sessionId: 'from-api-key' });
		});
	});

	describe('missing headers', () => {
		it('returns invalid when no auth headers are present', () => {
			const result = extractSessionId({}, NONCE);
			assert.deepStrictEqual(result, { valid: false, sessionId: undefined });
		});

		it('returns invalid for non-Bearer Authorization header', () => {
			const result = extractSessionId({ 'authorization': `Basic ${NONCE}.session` }, NONCE);
			assert.deepStrictEqual(result, { valid: false, sessionId: undefined });
		});

		it('returns invalid for non-string x-api-key', () => {
			const result = extractSessionId({ 'x-api-key': ['array-value'] }, NONCE);
			assert.deepStrictEqual(result, { valid: false, sessionId: undefined });
		});
	});
});
