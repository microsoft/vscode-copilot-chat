/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { suite, test } from 'vitest';
import { parseReplay } from './replayParser';

suite('replay file parsing', function () {
	test('full parsing example', async function () {
		const content = fs.readFileSync(path.join(__dirname, 'spec.chatreplay.json'), 'utf8');
		const parsed = parseReplay(content);

		assert.strictEqual(parsed.length, 9, 'should have 9 steps');
		assert.strictEqual(parsed[0].kind, 'userQuery', 'should start with userQuery');
		parsed.forEach(step => {
			assert(step.line > 0, 'should have line value assigned to each step');
		});
	});
});
