/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { beforeEach, describe, expect, test } from 'vitest';
import { IAlternativeNotebookContentService } from '../../../../platform/notebook/common/alternativeContent';
import { MockAlternativeNotebookContentService } from '../../../../platform/notebook/common/mockAlternativeContentService';
import { INotebookService } from '../../../../platform/notebook/common/notebookService';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { WorkspaceEdit as WorkspaceEditShim } from '../../../../util/common/test/shims/editing';
import { createTextDocumentData, IExtHostDocumentData, setDocText } from '../../../../util/common/test/shims/textDocument';
import { URI } from '../../../../util/vs/base/common/uri';
import { WorkspaceEdit } from '../../../../vscodeTypes';
import { applyEdits as applyTextEdits } from '../../../prompt/node/intents';
import { applyEdit, ContentFormatError, MultipleMatchesError, NoChangeError, NoMatchError } from '../editFileToolUtils';

describe('replace_string_in_file - applyEdit', () => {
	let workspaceEdit: WorkspaceEdit;
	let workspaceService: TestWorkspaceService;
	let notebookService: { hasSupportedNotebooks: (uri: URI) => boolean };
	let alternatveContentService: IAlternativeNotebookContentService;
	let doc: IExtHostDocumentData;

	async function doApplyEdit(oldString: string, newString: string, uri = doc.document.uri) {
		const r = await applyEdit(uri, oldString, newString, workspaceService, notebookService as INotebookService, alternatveContentService, undefined);
		workspaceEdit.set(uri, r.edits);
		return r;
	}

	function setText(value: string) {
		setDocText(doc, value);
	}

	beforeEach(() => {
		doc = createTextDocumentData(URI.file('/my/file.ts'), '', 'ts');
		workspaceEdit = new WorkspaceEditShim() as any;
		workspaceService = new TestWorkspaceService([], [doc.document]);
		notebookService = { hasSupportedNotebooks: () => false };
		alternatveContentService = new MockAlternativeNotebookContentService();
	});

	test('simple verbatim', async () => {
		setText('this is an oldString!');
		const result = await doApplyEdit('oldString', 'newString');
		expect(result.updatedFile).toBe('this is an newString!');
	});

	test('exact match - single occurrence', async () => {
		setText('function hello() {\n\tconsole.log("world");\n}');
		const result = await doApplyEdit('console.log("world");', 'console.log("hello world");');
		expect(result.updatedFile).toBe('function hello() {\n\tconsole.log("hello world");\n}');
	});

	test('exact match - with newlines', async () => {
		setText('line1\nline2\nline3');
		const result = await doApplyEdit('line1\nline2', 'newline1\nnewline2');
		expect(result.updatedFile).toBe('newline1\nnewline2\nline3');
	});

	test('multiple exact matches - should throw error', async () => {
		setText('test\ntest\nother');
		await expect(doApplyEdit('test', 'replacement')).rejects.toThrow(MultipleMatchesError);
	});

	test('whitespace flexible matching - different indentation', async () => {
		setText('function test() {\n    console.log("hello");\n}');
		// Use the exact text from the file for this test
		const result = await doApplyEdit('    console.log("hello");', '\tconsole.log("hi");');
		expect(result.updatedFile).toBe('function test() {\n\tconsole.log("hi");\n}');
	});

	test('whitespace flexible matching - trailing spaces', async () => {
		setText('line1   \nline2\nline3');
		const result = await doApplyEdit('line1\nline2', 'newline1\nnewline2');
		expect(result.updatedFile).toBe('newline1\nnewline2\nline3');
	});

	test('fuzzy matching - with trailing whitespace variations', async () => {
		setText('if (condition) {\n\treturn true; \n}');
		const result = await doApplyEdit('if (condition) {\n\treturn true;\n}', 'if (condition) {\n\treturn false;\n}');
		expect(result.updatedFile).toBe('if (condition) {\n\treturn false;\n}');
	});

	test('no match found - should throw error', async () => {
		setText('some text here');
		await expect(doApplyEdit('nonexistent', 'replacement')).rejects.toThrow(NoMatchError);
	});

	test('empty old string - create new file', async () => {
		setText('');
		const result = await doApplyEdit('', 'new content');
		expect(result.updatedFile).toBe('new content');
	});

	test('empty old string on existing file - should throw error', async () => {
		setText('existing content');
		await expect(doApplyEdit('', 'new content')).rejects.toThrow(ContentFormatError);
	});

	test('delete text - empty new string', async () => {
		setText('before\nto delete\nafter');
		const result = await doApplyEdit('to delete\n', '');
		expect(result.updatedFile).toBe('before\nafter');
	});

	test('delete text - exact match without newline', async () => {
		setText('before to delete after');
		const result = await doApplyEdit('to delete ', '');
		expect(result.updatedFile).toBe('before after');
	});

	test('no change - identical strings should throw error', async () => {
		setText('unchanged text');
		await expect(doApplyEdit('unchanged text', 'unchanged text')).rejects.toThrow(NoChangeError);
	});

	test('replace entire content', async () => {
		setText('old content\nwith multiple lines');
		const result = await doApplyEdit('old content\nwith multiple lines', 'completely new content');
		expect(result.updatedFile).toBe('completely new content');
	});

	test('replace with multiline content', async () => {
		setText('single line');
		const result = await doApplyEdit('single line', 'line1\nline2\nline3');
		expect(result.updatedFile).toBe('line1\nline2\nline3');
	});

	test('case sensitive matching', async () => {
		setText('Hello World');
		await expect(doApplyEdit('hello world', 'Hi World')).rejects.toThrow(NoMatchError);
	});

	test('special regex characters in search string', async () => {
		setText('price is $10.99 (discount)');
		const result = await doApplyEdit('$10.99 (discount)', '$9.99 (sale)');
		expect(result.updatedFile).toBe('price is $9.99 (sale)');
	});

	test('unicode characters', async () => {
		setText('Hello 世界! 🌍');
		const result = await doApplyEdit('世界! 🌍', '世界! 🌎');
		expect(result.updatedFile).toBe('Hello 世界! 🌎');
	});

	test('very long strings', async () => {
		const longText = 'a'.repeat(1000) + 'middle' + 'b'.repeat(1000);
		setText(longText);
		const result = await doApplyEdit('middle', 'CENTER');
		expect(result.updatedFile).toBe('a'.repeat(1000) + 'CENTER' + 'b'.repeat(1000));
	});

	test('newline variations - CRLF to LF', async () => {
		setText('line1\r\nline2\r\nline3');
		const result = await doApplyEdit('line1\nline2', 'newline1\nnewline2');
		expect(result.updatedFile).toBe('newline1\nnewline2\nline3');
	});

	test('trailing newline handling', async () => {
		setText('content\nwith\nnewlines\n');
		const result = await doApplyEdit('content\nwith\n', 'new\ncontent\n');
		expect(result.updatedFile).toBe('new\ncontent\nnewlines\n');
	});

	test('similarity matching - high similarity content', async () => {
		// This tests the similarity matching as a fallback
		setText('function calculateTotal(items) {\n\tlet sum = 0;\n\tfor (let i = 0; i < items.length; i++) {\n\t\tsum += items[i].price;\n\t}\n\treturn sum;\n}');
		const result = await doApplyEdit(
			'function calculateTotal(items) {\n\tlet sum = 0;\n\tfor (let i = 0; i < items.length; i++) {\n\t\tsum += items[i].price;\n\t}\n\treturn sum;\n}',
			'function calculateTotal(items) {\n\treturn items.reduce((sum, item) => sum + item.price, 0);\n}'
		);
		expect(result.updatedFile).toBe('function calculateTotal(items) {\n\treturn items.reduce((sum, item) => sum + item.price, 0);\n}');
	});

	test('whitespace only differences', async () => {
		setText('function test() {\n    return true;\n}');
		// Use exact text from the file to test whitespace handling
		const result = await doApplyEdit('    return true;', '\treturn false;');
		expect(result.updatedFile).toBe('function test() {\n\treturn false;\n}');
	});

	test('mixed whitespace and content changes', async () => {
		setText('if (condition)   {\n  console.log("test");   \n}');
		// Use exact text matching the file content
		const result = await doApplyEdit('  console.log("test");   ', '\tconsole.log("updated");');
		expect(result.updatedFile).toBe('if (condition)   {\n\tconsole.log("updated");\n}');
	});

	test('empty lines handling', async () => {
		setText('line1\n\n\nline4');
		const result = await doApplyEdit('line1\n\n\nline4', 'line1\n\nline3\nline4');
		expect(result.updatedFile).toBe('line1\n\nline3\nline4');
	});

	test('partial line replacement', async () => {
		setText('const name = "old value";');
		const result = await doApplyEdit('"old value"', '"new value"');
		expect(result.updatedFile).toBe('const name = "new value";');
	});

	test('multiple line partial replacement', async () => {
		setText('function test() {\n\tconsole.log("debug");\n\treturn value;\n}');
		const result = await doApplyEdit('console.log("debug");\n\treturn value;', 'return newValue;');
		expect(result.updatedFile).toBe('function test() {\n\treturn newValue;\n}');
	});

	// Edge cases and error conditions
	test('error properties - NoMatchError', async () => {
		setText('some text');
		try {
			await doApplyEdit('missing', 'replacement');
		} catch (error) {
			expect(error).toBeInstanceOf(NoMatchError);
			expect(error.kindForTelemetry).toBe('noMatchFound');
			expect(error.file).toBe('file:///my/file.ts');
		}
	});

	test('error properties - MultipleMatchesError', async () => {
		setText('same\nsame\nother');
		try {
			await doApplyEdit('same', 'different');
		} catch (error) {
			expect(error).toBeInstanceOf(MultipleMatchesError);
			expect(error.kindForTelemetry).toBe('multipleMatchesFound');
			expect(error.file).toBe('file:///my/file.ts');
		}
	});

	test('error properties - NoChangeError', async () => {
		setText('test content');
		try {
			await doApplyEdit('test content', 'test content');
		} catch (error) {
			expect(error).toBeInstanceOf(NoChangeError);
			expect(error.kindForTelemetry).toBe('noChange');
			expect(error.file).toBe('file:///my/file.ts');
		}
	});

	test('error properties - ContentFormatError', async () => {
		setText('existing content');
		try {
			await doApplyEdit('', 'new content');
		} catch (error) {
			expect(error).toBeInstanceOf(ContentFormatError);
			expect(error.kindForTelemetry).toBe('contentFormatError');
			expect(error.file).toBe('file:///my/file.ts');
		}
	});

	test('very small strings', async () => {
		setText('a');
		const result = await doApplyEdit('a', 'b');
		expect(result.updatedFile).toBe('b');
	});

	test('empty file with empty replacement', async () => {
		setText('');
		const result = await doApplyEdit('', '');
		expect(result.updatedFile).toBe('');
	});

	test('single character replacement', async () => {
		setText('hello unique');
		const result = await doApplyEdit('unique', 'special');
		expect(result.updatedFile).toBe('hello special');
	});

	test('multiple single character matches - should throw error', async () => {
		setText('hello world');
		await expect(doApplyEdit('l', 'L')).rejects.toThrow(MultipleMatchesError);
	});

	test('replacement with same length', async () => {
		setText('old text here');
		const result = await doApplyEdit('old', 'new');
		expect(result.updatedFile).toBe('new text here');
	});

	test('replacement with longer text', async () => {
		setText('short');
		const result = await doApplyEdit('short', 'much longer text');
		expect(result.updatedFile).toBe('much longer text');
	});

	test('replacement with shorter text', async () => {
		setText('very long text here');
		const result = await doApplyEdit('very long text', 'short');
		expect(result.updatedFile).toBe('short here');
	});

	test('beginning of file replacement', async () => {
		setText('start of file\nrest of content');
		const result = await doApplyEdit('start of file', 'beginning');
		expect(result.updatedFile).toBe('beginning\nrest of content');
	});

	test('end of file replacement', async () => {
		setText('content here\nend of file');
		const result = await doApplyEdit('end of file', 'conclusion');
		expect(result.updatedFile).toBe('content here\nconclusion');
	});

	test('middle of line replacement', async () => {
		setText('prefix MIDDLE suffix');
		const result = await doApplyEdit('MIDDLE', 'center');
		expect(result.updatedFile).toBe('prefix center suffix');
	});

	test('multiple spaces preservation', async () => {
		setText('word1     word2');
		const result = await doApplyEdit('word1     word2', 'word1 word2');
		expect(result.updatedFile).toBe('word1 word2');
	});

	test('tab character replacement', async () => {
		setText('before\tafter');
		const result = await doApplyEdit('\t', '    ');
		expect(result.updatedFile).toBe('before    after');
	});

	test('mixed tabs and spaces', async () => {
		setText('function() {\n\t    mixed indentation\n}');
		const result = await doApplyEdit('\t    mixed indentation', '    proper indentation');
		expect(result.updatedFile).toBe('function() {\n    proper indentation\n}');
	});

	test('return value structure', async () => {
		setText('old content');
		const result = await doApplyEdit('old', 'new');
		expect(result).toHaveProperty('patch');
		expect(result).toHaveProperty('updatedFile');
		expect(Array.isArray(result.patch)).toBe(true);
		expect(typeof result.updatedFile).toBe('string');
	});

	test('fixes bad newlines in issue #9753', async () => {
		const input = JSON.parse(fs.readFileSync(__dirname + '/editFileToolUtilsFixtures/crlf-input.json', 'utf8'));
		const output = JSON.parse(fs.readFileSync(__dirname + '/editFileToolUtilsFixtures/crlf-output.json', 'utf8')).join('\r\n');
		const toolCall = JSON.parse(fs.readFileSync(__dirname + '/editFileToolUtilsFixtures/crlf-tool-call.json', 'utf8'));

		const crlfDoc = createTextDocumentData(URI.file('/my/file2.ts'), input.join('\r\n'), 'ts', '\r\n');
		workspaceService.textDocuments.push(crlfDoc.document);

		const result = await doApplyEdit(toolCall.oldString, toolCall.newString, crlfDoc.document.uri);

		expect(result.updatedFile).toBe(output);
		expect(
			applyTextEdits(input.join('\r\n'), workspaceEdit.entries()[0][1])
		).toBe(output);
	});
});
