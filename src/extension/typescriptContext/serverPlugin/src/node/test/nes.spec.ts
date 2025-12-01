/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { beforeAll, suite, test } from 'vitest';

// This is OK since we are running in a Node / CommonJS environment.
import * as fs from 'fs';
import ts from 'typescript';

// These must be type imports since the module is loaded dynamically in the beforeAll hook.
import assert from 'assert';
import path from 'path';
import type * as protocol from '../../common/protocol';
import type * as testing from './testing';

let create: typeof testing.create;
let prepareNesRename: typeof testing.prepareNesRename;
let RenameKind: typeof protocol.RenameKind;

// This is OK since we run tests in node loading a TS version installed in the workspace.
const root = path.join(__dirname, '../../../fixtures/nes');

type NesRenameTestCase = {
	title: string;
	line: number;
	character: number;
	oldName: string;
	newName: string;
	expected: string;
};

type TestAnnotation = {
	title: string;
	oldName: string;
	newName: string;
	expected: string;
	delta?: number;
}

function computeNesRenameTestCases(filePath: string): NesRenameTestCase[] {
	const text = fs.readFileSync(filePath, 'utf8');
	const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest);
	const result: NesRenameTestCase[] = [];
	const regex = /\/\/\/\/\s(\{.*\})/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		try {
			const testCase = JSON.parse(match[1]) as TestAnnotation;
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(match.index);
			result.push({
				title: testCase.title,
				oldName: testCase.oldName,
				newName: testCase.newName,
				expected: testCase.expected,
				line: line + 1,
				character: character + (testCase.delta ?? 0),
			});
		} catch {
			// Ignore
		}
	}
	return result;
}

beforeAll(async function () {
	const TS = await import('../../common/typescript');
	TS.default.install(ts);

	const [protocolModule, testingModule] = await Promise.all([
		import('../../common/protocol'),
		import('./testing'),
	]);
	create = testingModule.create;
	prepareNesRename = testingModule.prepareNesRename;
	RenameKind = protocolModule.RenameKind;
}, 10000);

suite('NES Test Suite', function () {

	let session: testing.TestSession;
	beforeAll(() => {
		session = create(path.join(root, 'p1'));
	});

	const filePath = path.join(root, 'p1', 'source', 'test.ts');
	const testCases = computeNesRenameTestCases(filePath);
	for (const testCase of testCases) {
		test(testCase.title, () => {
			const renameKind = prepareNesRename(
				session,
				filePath,
				{ line: testCase.line, character: testCase.character },
				testCase.oldName,
				testCase.newName,
			);
			assert.strictEqual(renameKind, RenameKind.fromString(testCase.expected));
		});
	}
});