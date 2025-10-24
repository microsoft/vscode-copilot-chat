/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { CopilotContentExclusionManager } from '../contentExclusion/contentExclusionManager';
import { Context } from '../context';
import { FileReader } from '../fileReader';
import { FileSystem } from '../fileSystem';
import { TextDocumentManager } from '../textDocumentManager';
import { createLibTestingContext } from './context';
import { FakeFileSystem } from './filesystem';
import { AlwaysBlockingCopilotContentRestrictions } from './testContentExclusion';
import { TestTextDocumentManager } from './textDocument';

suite('File Reader', function () {
	let sandbox: sinon.SinonSandbox;
	let ctx: Context;

	setup(function () {
		sandbox = sinon.createSandbox();
		ctx = createLibTestingContext();
		ctx.forceSet(
			FileSystem,
			new FakeFileSystem({
				'/test.ts': FakeFileSystem.file('const foo', { ctime: 0, mtime: 0, size: 0.1 * 1024 * 1024 }), // .1MB
				'/empty.ts': '',
				'/large.ts': FakeFileSystem.file('very large file', { ctime: 0, mtime: 0, size: 1.1 * 1024 * 1024 }), // 1.1MB
			})
		);
	});

	teardown(function () {
		sandbox.restore();
	});

	test('reads file from text document manager', async function () {
		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		tdm.setTextDocument('file:///test.js', 'javascript', 'const abc =');
		const reader = new FileReader(ctx);

		const docResult = await reader.getOrReadTextDocument({ uri: 'file:///test.js' });

		assert.deepStrictEqual(docResult.status, 'valid');
		assert.deepStrictEqual(docResult.document?.getText(), 'const abc =');
		assert.deepStrictEqual(docResult.document?.detectedLanguageId, 'javascript');
	});

	test('reads file from file system', async function () {
		const reader = new FileReader(ctx);

		const docResult = await reader.getOrReadTextDocument({ uri: 'file:///test.ts' });

		assert.deepStrictEqual(docResult.status, 'valid');
		assert.deepStrictEqual(docResult.document?.getText(), 'const foo');
		assert.deepStrictEqual(docResult.document?.detectedLanguageId, 'typescript');
	});

	test('reads notfound from non existing file', async function () {
		const reader = new FileReader(ctx);

		const docResult = await reader.getOrReadTextDocument({ uri: 'file:///UNKNOWN.ts' });

		assert.deepStrictEqual(docResult.status, 'notfound');
		assert.deepStrictEqual(docResult.message, 'File not found');
	});

	test('reads notfound for file too large', async function () {
		const reader = new FileReader(ctx);

		const docResult = await reader.getOrReadTextDocument({ uri: 'file:///large.ts' });

		assert.deepStrictEqual(docResult.status, 'notfound');
		assert.deepStrictEqual(docResult.message, 'File too large');
	});

	test('reads invalid from blocked file', async function () {
		ctx.forceSet(CopilotContentExclusionManager, new AlwaysBlockingCopilotContentRestrictions(ctx));
		const reader = new FileReader(ctx);

		const docResult = await reader.getOrReadTextDocument({ uri: 'file:///test.ts' });

		assert.deepStrictEqual(docResult.status, 'invalid');
		assert.deepStrictEqual(docResult.reason, 'Document is blocked by repository policy');
	});

	test('reads empty files', async function () {
		const reader = new FileReader(ctx);

		const docResult = await reader.getOrReadTextDocument({ uri: 'file:///empty.ts' });

		assert.deepStrictEqual(docResult.status, 'valid');
		assert.deepStrictEqual(docResult.document.getText(), '');
	});

	test('empty files can be blocked', async function () {
		ctx.forceSet(CopilotContentExclusionManager, new AlwaysBlockingCopilotContentRestrictions(ctx));
		const reader = new FileReader(ctx);

		const docResult = await reader.getOrReadTextDocument({ uri: 'file:///empty.ts' });

		assert.deepStrictEqual(docResult.status, 'invalid');
		assert.deepStrictEqual(docResult.reason, 'Document is blocked by repository policy');
	});
});
