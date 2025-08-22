/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, beforeAll, suite, test } from 'vitest';
import { initializeTokenizers } from '../../../inlineCompletionPrompt/node/tokenization/tokenizer';
import { fixtureFromFile } from './fixture';

suite('Prompt integration tests', () => {
	beforeAll(async () => {
		await initializeTokenizers;
	});

	test('Read fixture', () => {
		const fixture = fixtureFromFile(`integration-test-001.fixture.yml`);
		assert.ok(fixture, 'Fixture should be loaded successfully');
		assert.strictEqual(fixture.name, 'small current file, no open files, cursor near beginning', 'Fixture name should match');
		assert.strictEqual(fixture.state.openFiles.length, 0);
		assert.strictEqual(fixture.state.currentFile.language, 'typescript');
	});
}, 10000);