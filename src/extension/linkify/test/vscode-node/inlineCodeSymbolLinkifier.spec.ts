/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { suite, test } from 'vitest';
import { assertPartsEqual, createTestLinkifierService, linkify } from '../node/util';

suite('InlineCodeSymbolLinkifier - Escape Sequences', () => {

	test('Should not linkify escape sequences like \\r', async () => {
		const linkifier = createTestLinkifierService();
		
		const result = await linkify(linkifier, '`\\r`');
		assertPartsEqual(result.parts, ['`\\r`']);
	});

	test('Should not linkify escape sequences like \\r\\n', async () => {
		const linkifier = createTestLinkifierService();
		
		const result = await linkify(linkifier, '`\\r\\n`');
		assertPartsEqual(result.parts, ['`\\r\\n`']);
	});

	test('Should not linkify escape sequences like \\n', async () => {
		const linkifier = createTestLinkifierService();
		
		const result = await linkify(linkifier, '`\\n`');
		assertPartsEqual(result.parts, ['`\\n`']);
	});

	test('Should not linkify escape sequences like \\t', async () => {
		const linkifier = createTestLinkifierService();
		
		const result = await linkify(linkifier, '`\\t`');
		assertPartsEqual(result.parts, ['`\\t`']);
	});

	test('Should not linkify other common escape sequences', async () => {
		const linkifier = createTestLinkifierService();
		
		const escapesToTest = ['`\\0`', '`\\b`', '`\\f`', '`\\v`', '`\\\'`', '`\\"`', '`\\\\`'];
		
		for (const escapeSeq of escapesToTest) {
			const result = await linkify(linkifier, escapeSeq);
			assertPartsEqual(result.parts, [escapeSeq]);
		}
	});

	test('Should not linkify escape sequences in context', async () => {
		const linkifier = createTestLinkifierService();
		
		const result = await linkify(linkifier, 'The line ending is `\\r\\n` on Windows');
		assertPartsEqual(result.parts, ['The line ending is `\\r\\n` on Windows']);
	});
});
