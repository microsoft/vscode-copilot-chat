/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';

import Parser from 'web-tree-sitter';
import * as parse from '../parse';

suite('Tree-sitter Parsing Tests', function () {
	test('language wasm loading', async function () {
		await Parser.init();
		await parse.getLanguage('python');
		await parse.getLanguage('javascript');
		await parse.getLanguage('go');
		// todo@dbaeumer
		// await parse.getLanguage('php');
		await parse.getLanguage('c');
		await parse.getLanguage('cpp');
		try {
			await parse.getLanguage('xxx');
			assert.fail('Expected an error for unsupported language');
		} catch (e) {
		}
	});

	suite('getBlockCloseToken', function () {
		test('all', function () {
			assert.strictEqual(parse.getBlockCloseToken('javascript'), '}');
			assert.strictEqual(parse.getBlockCloseToken('typescript'), '}');
			assert.strictEqual(parse.getBlockCloseToken('python'), null);
			assert.strictEqual(parse.getBlockCloseToken('ruby'), 'end');
			assert.strictEqual(parse.getBlockCloseToken('go'), '}');
		});
	});
});
