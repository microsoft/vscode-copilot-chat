/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { beforeAll, suite, test } from 'vitest';

// This is OK since we are running in a Node / CommonJS environment.
import ts from 'typescript';

// These must be type imports since the module is loaded dynamically in the beforeAll hook.
import path from 'path';
import type * as testing from './testing';

let create: typeof testing.create;

// This is OK since we run tests in node loading a TS version installed in the workspace.
const root = path.join(__dirname, '../../../fixtures/nes');

beforeAll(async function () {
	const TS = await import('../../common/typescript');
	TS.default.install(ts);

	const [protocolModule, testingModule] = await Promise.all([
		import('../../common/protocol'),
		import('./testing'),
	]);
	create = testingModule.create;
}, 10000);

suite('NES Test Suite', function () {
	let session: testing.TestSession;

	beforeAll(() => {
		session = create(path.join(root, 'p1'));
	});

	test('Enum - no rename', () => {

	});
});