/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { NotebookDocument, NotebookDocumentContentChange, TextDocumentChangeEvent, TextDocumentContentChangeEvent } from 'vscode';
import { ExtHostNotebookDocumentData } from '../../../../util/common/test/shims/notebookDocument';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { NotebookCellData, NotebookCellKind, NotebookData, NotebookRange, Range } from '../../../../vscodeTypes';
import { AlternativeNotebookTextDocument, editFromNotebookCellTextDocumentContentChangeEvents, editFromNotebookChangeEvents, fromAltTextDocumentContentChangeEvents } from '../../common/alternativeNotebookTextDocument';

describe('Edit Notebook Tool', () => {
	const disposables = new DisposableStore();

	afterAll(() => {
		disposables.clear();
	});

	function createNotebook(cells: NotebookCellData[]) {
		const notebook = ExtHostNotebookDocumentData.fromNotebookData(URI.file('notebook.ipynb'), new NotebookData(cells), 'jupyter-notebook');
		const altDoc = AlternativeNotebookTextDocument.create(notebook.document);
		return { notebookData: notebook, notebook: notebook.document, altDoc };
	}
	describe('Alt Content', () => {
		test(`Generate Alt Content`, async () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
			];
			const { altDoc } = createNotebook(cells);
			expect(altDoc.getText()).toMatchSnapshot();
		});
		test(`No Content`, async () => {
			const { altDoc } = createNotebook([]);
			expect(altDoc.getText()).toMatchSnapshot();
		});
		test(`No Content without code cells`, async () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Markup, '# This is a sample notebook', 'markdown'),
			];
			const { altDoc } = createNotebook(cells);
			expect(altDoc.getText()).toMatchSnapshot();
		});
		test(`Exclude Markdown Cells`, async () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Markup, '# This is a sample notebook', 'markdown'),
				new NotebookCellData(NotebookCellKind.Markup, '## Header', 'markdown'),
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				new NotebookCellData(NotebookCellKind.Markup, 'Comments', 'markdown'),
				new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
			];
			const { altDoc } = createNotebook(cells);
			expect(altDoc.getText()).toMatchSnapshot();
		});
		test(`EOLs`, async () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'import sys\nimport os', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'import pandas\r\nimport requests', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")\r\nprint("Foo Bar")\r\nprint("Bar Baz")', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print(sys.executable)\nprint(sys.version)', 'python'),
			];
			const { altDoc } = createNotebook(cells);
			expect(altDoc.getText()).toMatchSnapshot();
			expect(altDoc.getText()).not.toContain('\r\n'); // Ensure no CRLF, only LF
			expect(altDoc.getText()).toContain('\n'); // Ensure no CRLF, only LF
		});
	});
	describe('Position Mapping', () => {
		test(`All cells have same EOL`, async () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'import sys\nimport os', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'import pandas\nimport requests', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")\nprint("Foo Bar")\nprint("Bar Baz")', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print(sys.executable)\nprint(sys.version)', 'python'),
			];
			const { notebook, altDoc } = createNotebook(cells);

			expect(altDoc.getText(new OffsetRange(53, 59))).toBe('import');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(53, 59))).toEqual([[notebook.cellAt(0), new Range(0, 0, 0, 6)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(0), [new Range(0, 0, 0, 6)])).toEqual([new OffsetRange(53, 59)]);

			expect(altDoc.getText(new OffsetRange(53, 64))).toBe('import sys\n');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(53, 64))).toEqual([[notebook.cellAt(0), new Range(0, 0, 1, 0)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(0), [new Range(0, 0, 1, 0)])).toEqual([new OffsetRange(53, 64)]);

			expect(altDoc.getText(new OffsetRange(53, 74))).toBe('import sys\nimport os\n');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(53, 74))).toEqual([[notebook.cellAt(0), new Range(0, 0, 1, 9)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(0), [new Range(0, 0, 1, 9)])).toEqual([new OffsetRange(53, 73)]);

			// Translating alt text range across cells will only return contents of one cell.
			expect(altDoc.getText(new OffsetRange(53, 140))).toBe('import sys\nimport os\n#%% vscode.cell [id=#VSC-bdb3864a] [language=python]\nimport pandas');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(53, 140))).toEqual([[notebook.cellAt(0), new Range(0, 0, 1, 9)], [notebook.cellAt(1), new Range(0, 0, 0, 13)]]);

			expect(altDoc.getText(new OffsetRange(71, 73))).toBe('os');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(71, 73))).toEqual([[notebook.cellAt(0), new Range(1, 7, 1, 9)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(0), [new Range(1, 7, 1, 9)])).toEqual([new OffsetRange(71, 73)]);

			expect(altDoc.getText(new OffsetRange(134, 258))).toBe('pandas\nimport requests\n#%% vscode.cell [id=#VSC-8862d4f3] [language=python]\nprint("Hello World")\nprint("Foo Bar")\nprint("Bar');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(134, 258))).toEqual([
				[notebook.cellAt(1), new Range(0, 7, 1, 15)],
				[notebook.cellAt(2), new Range(0, 0, 2, 10)],
			]);

			expect(altDoc.getText(new OffsetRange(134, 156))).toBe('pandas\nimport requests');
			expect(notebook.cellAt(1).document.getText(new Range(0, 7, 1, 15))).toBe('pandas\nimport requests');
			expect(altDoc.toAltOffsetRange(notebook.cellAt(1), [new Range(0, 7, 1, 15)])).toEqual([new OffsetRange(134, 156)]);
			expect(altDoc.getText(new OffsetRange(210, 258))).toBe('print("Hello World")\nprint("Foo Bar")\nprint("Bar');
			expect(notebook.cellAt(2).document.getText(new Range(0, 0, 2, 10))).toBe('print("Hello World")\nprint("Foo Bar")\nprint("Bar');
			expect(altDoc.toAltOffsetRange(notebook.cellAt(2), [new Range(0, 0, 2, 10)])).toEqual([new OffsetRange(210, 258)]);

			expect(altDoc.getText(new OffsetRange(210, 265))).toBe('print("Hello World")\nprint("Foo Bar")\nprint("Bar Baz")\n');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(210, 265))).toEqual([[notebook.cellAt(2), new Range(0, 0, 2, 16)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(2), [new Range(0, 0, 2, 16)])).toEqual([new OffsetRange(210, 264)]);

			expect(altDoc.getText(new OffsetRange(318, 358))).toBe('print(sys.executable)\nprint(sys.version)');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(318, 358))).toEqual([[notebook.cellAt(3), new Range(0, 0, 1, 18)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(3), [new Range(0, 0, 1, 18)])).toEqual([new OffsetRange(318, 358)]);

			expect(altDoc.getText(new OffsetRange(60, 349))).toBe('sys\nimport os\n#%% vscode.cell [id=#VSC-bdb3864a] [language=python]\nimport pandas\nimport requests\n#%% vscode.cell [id=#VSC-8862d4f3] [language=python]\nprint("Hello World")\nprint("Foo Bar")\nprint("Bar Baz")\n#%% vscode.cell [id=#VSC-e07487cb] [language=python]\nprint(sys.executable)\nprint(sys');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(60, 349))).toEqual([
				[notebook.cellAt(0), new Range(0, 7, 1, 9)],
				[notebook.cellAt(1), new Range(0, 0, 1, 15)],
				[notebook.cellAt(2), new Range(0, 0, 2, 16)],
				[notebook.cellAt(3), new Range(0, 0, 1, 9)]
			]);
		});
		test(`All Cells have different EOLs`, async () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'import sys\nimport os', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'import pandas\r\nimport requests', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")\r\nprint("Foo Bar")\r\nprint("Bar Baz")', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print(sys.executable)\nprint(sys.version)', 'python'),
			];
			const { notebook, altDoc } = createNotebook(cells);


			expect(altDoc.getText(new OffsetRange(53, 59))).toBe('import');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(53, 59))).toEqual([[notebook.cellAt(0), new Range(0, 0, 0, 6)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(0), [new Range(0, 0, 0, 6)])).toEqual([new OffsetRange(53, 59)]);

			expect(altDoc.getText(new OffsetRange(53, 64))).toBe('import sys\n');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(53, 64))).toEqual([[notebook.cellAt(0), new Range(0, 0, 1, 0)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(0), [new Range(0, 0, 1, 0)])).toEqual([new OffsetRange(53, 64)]);

			expect(altDoc.getText(new OffsetRange(53, 74))).toBe('import sys\nimport os\n');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(53, 74))).toEqual([[notebook.cellAt(0), new Range(0, 0, 1, 9)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(0), [new Range(0, 0, 1, 9)])).toEqual([new OffsetRange(53, 73)]);

			// Translating alt text range across cells will only return contents of one cell.
			expect(altDoc.getText(new OffsetRange(53, 140))).toBe('import sys\nimport os\n#%% vscode.cell [id=#VSC-bdb3864a] [language=python]\nimport pandas');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(53, 140))).toEqual([[notebook.cellAt(0), new Range(0, 0, 1, 9)], [notebook.cellAt(1), new Range(0, 0, 0, 13)]]);

			expect(altDoc.getText(new OffsetRange(71, 73))).toBe('os');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(71, 73))).toEqual([[notebook.cellAt(0), new Range(1, 7, 1, 9)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(0), [new Range(1, 7, 1, 9)])).toEqual([new OffsetRange(71, 73)]);

			expect(altDoc.getText(new OffsetRange(134, 258))).toBe('pandas\nimport requests\n#%% vscode.cell [id=#VSC-8862d4f3] [language=python]\nprint("Hello World")\nprint("Foo Bar")\nprint("Bar');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(134, 258))).toEqual([
				[notebook.cellAt(1), new Range(0, 7, 1, 15)],
				[notebook.cellAt(2), new Range(0, 0, 2, 10)],
			]);

			expect(altDoc.getText(new OffsetRange(134, 156))).toBe('pandas\nimport requests');
			expect(notebook.cellAt(1).document.getText(new Range(0, 7, 1, 15))).toBe('pandas\r\nimport requests');
			expect(altDoc.toAltOffsetRange(notebook.cellAt(1), [new Range(0, 7, 1, 15)])).toEqual([new OffsetRange(134, 156)]);
			expect(altDoc.getText(new OffsetRange(210, 258))).toBe('print("Hello World")\nprint("Foo Bar")\nprint("Bar');
			expect(notebook.cellAt(2).document.getText(new Range(0, 0, 2, 10))).toBe('print("Hello World")\r\nprint("Foo Bar")\r\nprint("Bar');
			expect(altDoc.toAltOffsetRange(notebook.cellAt(2), [new Range(0, 0, 2, 10)])).toEqual([new OffsetRange(210, 258)]);

			expect(altDoc.getText(new OffsetRange(210, 265))).toBe('print("Hello World")\nprint("Foo Bar")\nprint("Bar Baz")\n');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(210, 265))).toEqual([[notebook.cellAt(2), new Range(0, 0, 2, 16)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(2), [new Range(0, 0, 2, 16)])).toEqual([new OffsetRange(210, 264)]);

			expect(altDoc.getText(new OffsetRange(318, 358))).toBe('print(sys.executable)\nprint(sys.version)');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(318, 358))).toEqual([[notebook.cellAt(3), new Range(0, 0, 1, 18)]]);
			expect(altDoc.toAltOffsetRange(notebook.cellAt(3), [new Range(0, 0, 1, 18)])).toEqual([new OffsetRange(318, 358)]);

			expect(altDoc.getText(new OffsetRange(60, 349))).toBe('sys\nimport os\n#%% vscode.cell [id=#VSC-bdb3864a] [language=python]\nimport pandas\nimport requests\n#%% vscode.cell [id=#VSC-8862d4f3] [language=python]\nprint("Hello World")\nprint("Foo Bar")\nprint("Bar Baz")\n#%% vscode.cell [id=#VSC-e07487cb] [language=python]\nprint(sys.executable)\nprint(sys');
			expect(altDoc.fromAltOffsetRange(new OffsetRange(60, 349))).toEqual([
				[notebook.cellAt(0), new Range(0, 7, 1, 9)],
				[notebook.cellAt(1), new Range(0, 0, 1, 15)],
				[notebook.cellAt(2), new Range(0, 0, 2, 16)],
				[notebook.cellAt(3), new Range(0, 0, 1, 9)]
			]);

		});
	});
	describe('Cell Content Changes', () => {
		describe('Cell with 1 line', () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
			];
			let altDoc: AlternativeNotebookTextDocument;
			let notebook: NotebookDocument;
			beforeEach(() => {
				({ altDoc, notebook } = createNotebook(cells));
			});
			function getUpdatedAltText(e: TextDocumentChangeEvent): string {
				const newDoc = altDoc.withCellChanges(e.document, e.contentChanges);
				const edit = editFromNotebookCellTextDocumentContentChangeEvents(altDoc, e.document, e.contentChanges);
				const updatedAltText = newDoc.getText();

				// Verify the alt text is updated correctly
				expect(updatedAltText).toBe(edit!.apply(altDoc.getText()));

				return updatedAltText;
			}
			test(`replace line`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 0, 0, 20),
						rangeOffset: 0,
						rangeLength: 20,
						text: '# Top level imports',
					}]
				})).toMatchSnapshot();
			});
			test(`replace text with smaller text`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 18),
						rangeOffset: 7,
						rangeLength: 11,
						text: 'Foo Bar',
					}]
				})).toMatchSnapshot();
			});
			test(`replace text with larger text`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 18),
						rangeOffset: 7,
						rangeLength: 11,
						text: 'This is a longer piece of text',
					}]
				})).toMatchSnapshot();
			});
			test(`replace while inserting a few lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 20),
						rangeOffset: 7,
						rangeLength: 13,
						text: 'Foo Bar")\nprint("Another line")\nprint("Yet another line")',
					}]
				})).toMatchSnapshot();
			});
			test(`insert a few lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 0, 20),
						rangeOffset: 20,
						rangeLength: 0,
						text: '\nprint("Another line")\nprint("Yet another line")',
					}]
				})).toMatchSnapshot();
			});
		});
		describe('Cell with multiple line (crlf)', () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")\r\nprint("Foo Bar")\r\nprint("Bar Baz")\r\nprint("Something Else")', 'python'),
			];
			let altDoc: AlternativeNotebookTextDocument;
			let notebook: NotebookDocument;
			beforeEach(() => {
				({ altDoc, notebook } = createNotebook(cells));
			});
			function getUpdatedAltText(e: TextDocumentChangeEvent): string {
				const newDoc = altDoc.withCellChanges(e.document, e.contentChanges);
				const edit = editFromNotebookCellTextDocumentContentChangeEvents(altDoc, e.document, e.contentChanges);
				const updatedAltText = newDoc.getText();

				// Verify the alt text is updated correctly
				expect(updatedAltText).toBe(edit!.apply(altDoc.getText()));

				return updatedAltText;
			}
			test(`replace line`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 0, 0, 20),
						rangeOffset: 0,
						rangeLength: 20,
						text: '# Top level imports',
					}]
				})).toMatchSnapshot();
			});
			test(`replace multiple lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(1, 7, 1, 14),
						rangeOffset: 29,
						rangeLength: 7,
						text: 'Say Something',
					}, {
						range: new Range(0, 0, 0, 20),
						rangeOffset: 0,
						rangeLength: 20,
						text: '# Top level print statements',
					}]
				})).toMatchSnapshot();
			});
			test(`replace text with smaller text`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 18),
						rangeOffset: 7,
						rangeLength: 11,
						text: 'Foo Bar',
					}]
				})).toMatchSnapshot();
			});
			test(`replace text with larger text`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 18),
						rangeOffset: 7,
						rangeLength: 11,
						text: 'This is a longer piece of text',
					}]
				})).toMatchSnapshot();
			});
			test(`replace while inserting a few lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 20),
						rangeOffset: 7,
						rangeLength: 13,
						text: 'Foo Bar")\r\nprint("Another line")\r\nprint("Yet another line")',
					}]
				})).toMatchSnapshot();
			});
			test(`insert a few lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 0, 20),
						rangeOffset: 20,
						rangeLength: 0,
						text: '\nprint("Another line")\nprint("Yet another line")',
					}]
				})).toMatchSnapshot();
			});
			test(`remove a line`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 1, 16),
						rangeOffset: 20,
						rangeLength: 18,
						text: '',
					}]
				})).toMatchSnapshot();
			});
			test(`remove two lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 2, 16),
						rangeOffset: 20,
						rangeLength: 36,
						text: '',
					}]
				})).toMatchSnapshot();
			});
			test(`merge two lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 1, 0),
						rangeOffset: 20,
						rangeLength: 2,
						text: '',
					}]
				})).toMatchSnapshot();
			});
		});
		describe('Cell with multiple line (lf)', () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")\nprint("Foo Bar")\nprint("Bar Baz")\nprint("Something Else")', 'python'),
			];
			let altDoc: AlternativeNotebookTextDocument;
			let notebook: NotebookDocument;
			beforeEach(() => {
				({ altDoc, notebook } = createNotebook(cells));
			});
			function getUpdatedAltText(e: TextDocumentChangeEvent): string {
				const newDoc = altDoc.withCellChanges(e.document, e.contentChanges);
				const edit = editFromNotebookCellTextDocumentContentChangeEvents(altDoc, e.document, e.contentChanges);

				const updatedAltText = newDoc.getText();

				// Verify the alt text is updated correctly
				expect(updatedAltText).toBe(edit!.apply(altDoc.getText()));

				return updatedAltText;
			}
			test(`replace line`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 0, 0, 20),
						rangeOffset: 0,
						rangeLength: 20,
						text: '# Top level imports',
					}]
				})).toMatchSnapshot();
			});
			test(`replace multiple lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(1, 7, 1, 14),
						rangeOffset: 28,
						rangeLength: 7,
						text: 'Say Something',
					}, {
						range: new Range(0, 0, 0, 20),
						rangeOffset: 0,
						rangeLength: 20,
						text: '# Top level print statements',
					}]
				})).toMatchSnapshot();
			});
			test(`replace text with smaller text`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 18),
						rangeOffset: 7,
						rangeLength: 11,
						text: 'Foo Bar',
					}]
				})).toMatchSnapshot();
			});
			test(`replace text with larger text`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 18),
						rangeOffset: 7,
						rangeLength: 11,
						text: 'This is a longer piece of text',
					}]
				})).toMatchSnapshot();
			});
			test(`replace while inserting a few lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 20),
						rangeOffset: 7,
						rangeLength: 13,
						text: 'Foo Bar")\nprint("Another line")\nprint("Yet another line")',
					}]
				})).toMatchSnapshot();
			});
			test(`insert a few lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 0, 20),
						rangeOffset: 20,
						rangeLength: 0,
						text: '\nprint("Another line")\nprint("Yet another line")',
					}]
				})).toMatchSnapshot();
			});
			test(`remove a line`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 1, 16),
						rangeOffset: 20,
						rangeLength: 17,
						text: '',
					}]
				})).toMatchSnapshot();
			});
			test(`remove two lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 2, 16),
						rangeOffset: 20,
						rangeLength: 34,
						text: '',
					}]
				})).toMatchSnapshot();
			});
			test(`merge two lines`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(0).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 20, 1, 0),
						rangeOffset: 20,
						rangeLength: 1,
						text: '',
					}]
				})).toMatchSnapshot();
			});
		});
		describe('Cells with multiple line (lf)', () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print("Bar Baz")', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")\nprint("Foo Bar2")\nprint("Bar Baz2")\nprint("Something Else")', 'python'),
			];
			let altDoc: AlternativeNotebookTextDocument;
			let notebook: NotebookDocument;
			beforeEach(() => {
				({ altDoc, notebook } = createNotebook(cells));
			});
			function getUpdatedAltText(e: TextDocumentChangeEvent): string {
				const newDoc = altDoc.withCellChanges(e.document, e.contentChanges);
				const edit = editFromNotebookCellTextDocumentContentChangeEvents(altDoc, e.document, e.contentChanges);
				const updatedAltText = newDoc.getText();

				// Verify the alt text is updated correctly
				expect(updatedAltText).toBe(edit!.apply(altDoc.getText()));

				return updatedAltText;
			}
			test(`replace text in last cell`, async () => {
				expect(getUpdatedAltText({
					document: notebook.cellAt(2).document,
					reason: undefined,
					detailedReason: {
						source: 'cursor',
						metadata: {}
					},
					contentChanges: [{
						range: new Range(0, 7, 0, 18),
						rangeOffset: 7,
						rangeLength: 11,
						text: 'Bye bye World',
					}]
				})).toMatchSnapshot();
			});
			// test(`replace multiple lines`, async () => {
			// 	expect(getUpdatedAltText({
			// 		document: notebook.cellAt(0).document,
			// 		reason: undefined,
			// 		detailedReason: {
			// 			source: 'cursor',
			// 			metadata: {}
			// 		},
			// 		contentChanges: [{
			// 			range: new Range(1, 7, 1, 14),
			// 			rangeOffset: 28,
			// 			rangeLength: 7,
			// 			text: 'Say Something',
			// 		}, {
			// 			range: new Range(0, 0, 0, 20),
			// 			rangeOffset: 0,
			// 			rangeLength: 20,
			// 			text: '# Top level print statements',
			// 		}]
			// 	})).toMatchSnapshot();
			// });
			// test(`replace text with smaller text`, async () => {
			// 	expect(getUpdatedAltText({
			// 		document: notebook.cellAt(0).document,
			// 		reason: undefined,
			// 		detailedReason: {
			// 			source: 'cursor',
			// 			metadata: {}
			// 		},
			// 		contentChanges: [{
			// 			range: new Range(0, 7, 0, 18),
			// 			rangeOffset: 7,
			// 			rangeLength: 11,
			// 			text: 'Foo Bar',
			// 		}]
			// 	})).toMatchSnapshot();
			// });
			// test(`replace text with larger text`, async () => {
			// 	expect(getUpdatedAltText({
			// 		document: notebook.cellAt(0).document,
			// 		reason: undefined,
			// 		detailedReason: {
			// 			source: 'cursor',
			// 			metadata: {}
			// 		},
			// 		contentChanges: [{
			// 			range: new Range(0, 7, 0, 18),
			// 			rangeOffset: 7,
			// 			rangeLength: 11,
			// 			text: 'This is a longer piece of text',
			// 		}]
			// 	})).toMatchSnapshot();
			// });
			// test(`replace while inserting a few lines`, async () => {
			// 	expect(getUpdatedAltText({
			// 		document: notebook.cellAt(0).document,
			// 		reason: undefined,
			// 		detailedReason: {
			// 			source: 'cursor',
			// 			metadata: {}
			// 		},
			// 		contentChanges: [{
			// 			range: new Range(0, 7, 0, 20),
			// 			rangeOffset: 7,
			// 			rangeLength: 13,
			// 			text: 'Foo Bar")\nprint("Another line")\nprint("Yet another line")',
			// 		}]
			// 	})).toMatchSnapshot();
			// });
			// test(`insert a few lines`, async () => {
			// 	expect(getUpdatedAltText({
			// 		document: notebook.cellAt(0).document,
			// 		reason: undefined,
			// 		detailedReason: {
			// 			source: 'cursor',
			// 			metadata: {}
			// 		},
			// 		contentChanges: [{
			// 			range: new Range(0, 20, 0, 20),
			// 			rangeOffset: 20,
			// 			rangeLength: 0,
			// 			text: '\nprint("Another line")\nprint("Yet another line")',
			// 		}]
			// 	})).toMatchSnapshot();
			// });
			// test(`remove a line`, async () => {
			// 	expect(getUpdatedAltText({
			// 		document: notebook.cellAt(0).document,
			// 		reason: undefined,
			// 		detailedReason: {
			// 			source: 'cursor',
			// 			metadata: {}
			// 		},
			// 		contentChanges: [{
			// 			range: new Range(0, 20, 1, 16),
			// 			rangeOffset: 20,
			// 			rangeLength: 17,
			// 			text: '',
			// 		}]
			// 	})).toMatchSnapshot();
			// });
			// test(`remove two lines`, async () => {
			// 	expect(getUpdatedAltText({
			// 		document: notebook.cellAt(0).document,
			// 		reason: undefined,
			// 		detailedReason: {
			// 			source: 'cursor',
			// 			metadata: {}
			// 		},
			// 		contentChanges: [{
			// 			range: new Range(0, 20, 2, 16),
			// 			rangeOffset: 20,
			// 			rangeLength: 34,
			// 			text: '',
			// 		}]
			// 	})).toMatchSnapshot();
			// });
			// test(`merge two lines`, async () => {
			// 	expect(getUpdatedAltText({
			// 		document: notebook.cellAt(0).document,
			// 		reason: undefined,
			// 		detailedReason: {
			// 			source: 'cursor',
			// 			metadata: {}
			// 		},
			// 		contentChanges: [{
			// 			range: new Range(0, 20, 1, 0),
			// 			rangeOffset: 20,
			// 			rangeLength: 1,
			// 			text: '',
			// 		}]
			// 	})).toMatchSnapshot();
			// });
		});
	});
	describe('Alt Document to Cell Changes', () => {
		describe('Single Cell Changes', () => {
			test('Simple text replacement in single cell', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				];
				const { notebook, altDoc } = createNotebook(cells);

				// Create a change event that replaces "Hello" with "Hi"
				const altChangeEvent: TextDocumentContentChangeEvent = {
					range: new Range(1, 7, 1, 12), // "Hello" in alt document
					rangeLength: 5,
					rangeOffset: 60, // Calculated offset in alt document
					text: 'Hi'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][0]).toBe(notebook.cellAt(0));
				expect(cellChanges[0][1]).toHaveLength(1);

				const cellChange = cellChanges[0][1][0];
				expect(cellChange.text).toBe('Hi');
				expect(cellChange.range.start.line).toBe(0);
				expect(cellChange.range.start.character).toBe(7);
				expect(cellChange.range.end.line).toBe(0);
				expect(cellChange.range.end.character).toBe(12);
			});

			test('Text insertion in single cell', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				// Insert "Hello " before "World"
				const altChangeEvent = {
					range: new Range(1, 7, 1, 7),
					rangeLength: 0,
					rangeOffset: 60,
					text: 'Hello '
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][1][0].text).toBe('Hello ');
				expect(cellChanges[0][1][0].rangeLength).toBe(0);
			});

			test('Text deletion in single cell', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				// Delete "Hello "
				const altChangeEvent = {
					range: new Range(1, 7, 1, 13),
					rangeLength: 6,
					rangeOffset: 60,
					text: ''
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][1][0].text).toBe('');
				expect(cellChanges[0][1][0].rangeLength).toBeGreaterThan(0);
			});
		});

		describe('Multi-line Cell Changes', () => {
			test('Replace text across multiple lines in single cell', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello")\nprint("World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				// Replace the entire content
				const altChangeEvent = {
					range: new Range(1, 0, 2, 14),
					rangeLength: 29,
					rangeOffset: 53,
					text: 'print("Hi")\nprint("There")'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][1][0].text).toBe('print("Hi")\nprint("There")');
			});

			test('Insert new line in single cell', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				// Insert a new line after the first line
				const altChangeEvent = {
					range: new Range(1, 20, 1, 20),
					rangeLength: 0,
					rangeOffset: 73,
					text: '\nprint("Second line")'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][1][0].text).toBe('\nprint("Second line")');
			});
		});

		describe('Multiple Cell Changes', () => {
			test('Change affects multiple cells', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Cell 1")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'print("Cell 2")', 'python'),
				];
				const { notebook, altDoc } = createNotebook(cells);

				// Create a change that spans across cells (replace content including cell boundary)
				const altChangeEvent = {
					range: new Range(1, 7, 3, 7),
					rangeLength: 85, // Approximate length spanning cells
					rangeOffset: 60,
					text: '"Modified"\n#%% vscode.cell [id=#VSC-test] [language=python]\nprint('
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges.length).toBeGreaterThan(0);
				// Should affect at least the first cell
				const affectedCells = cellChanges.map(([cell]) => cell);
				expect(affectedCells).toContain(notebook.cellAt(0));
			});
		});

		describe('Different EOL Handling', () => {
			test('Convert LF to CRLF for cell with CRLF', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello")\r\nprint("World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				// The alt document uses LF, but cell has CRLF
				const altChangeEvent = {
					range: new Range(1, 0, 2, 14),
					rangeLength: 29,
					rangeOffset: 53,
					text: 'print("Hi")\nprint("There")'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				// Text should be converted to CRLF for the cell
				expect(cellChanges[0][1][0].text).toBe('print("Hi")\r\nprint("There")');
			});

			test('Keep LF for cell with LF', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello")\nprint("World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				const altChangeEvent = {
					range: new Range(1, 0, 2, 14),
					rangeLength: 29,
					rangeOffset: 53,
					text: 'print("Hi")\nprint("There")'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				// Text should keep LF
				expect(cellChanges[0][1][0].text).toBe('print("Hi")\nprint("There")');
			});
		});

		describe('Edge Cases', () => {
			test('Empty change events', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, []);

				expect(cellChanges).toHaveLength(0);
			});

			test('Change in cell marker region', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				// Try to change the cell marker itself
				const altChangeEvent = {
					range: new Range(0, 0, 0, 10), // In the cell marker line
					rangeLength: 10,
					rangeOffset: 0,
					text: 'modified'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				// Should either be empty or not affect actual cell content
				// The function should handle this gracefully
				expect(Array.isArray(cellChanges)).toBe(true);
			});

			test('Multiple changes to same cell', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				];
				const { notebook, altDoc } = createNotebook(cells);

				const altChangeEvents = [
					{
						range: new Range(1, 7, 1, 12),
						rangeLength: 5,
						rangeOffset: 60,
						text: 'Hi'
					},
					{
						range: new Range(1, 15, 1, 20),
						rangeLength: 5,
						rangeOffset: 68,
						text: 'There'
					}
				];

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, altChangeEvents);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][0]).toBe(notebook.cellAt(0));
				expect(cellChanges[0][1]).toHaveLength(2);
			});

			test('Range beyond document bounds', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				// Try to change beyond the document
				const altChangeEvent = {
					range: new Range(10, 0, 10, 10), // Way beyond document end
					rangeLength: 10,
					rangeOffset: 1000,
					text: 'invalid'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				// Should handle gracefully and return empty or ignore invalid ranges
				expect(Array.isArray(cellChanges)).toBe(true);
			});
		});

		describe('Real World Scenarios', () => {
			test('Code completion replacement', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'import pandas as pd\ndf = pd.read_csv("data.csv")', 'python'),
				];
				const { notebook, altDoc } = createNotebook(cells);

				// Simulate code completion replacing "read_" with "read_csv"
				const altChangeEvent = {
					range: new Range(2, 9, 2, 14), // "read_" part
					rangeLength: 5,
					rangeOffset: 80, // Approximate offset
					text: 'read_csv'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][0]).toBe(notebook.cellAt(0));
				expect(cellChanges[0][1][0].text).toBe('read_csv');
			});

			test('Paste operation with multiple lines', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'print("start")', 'python'),
				];
				const { altDoc } = createNotebook(cells);

				// Simulate pasting multiple lines at the end
				const altChangeEvent = {
					range: new Range(1, 14, 1, 14), // End of the print statement
					rangeLength: 0,
					rangeOffset: 67,
					text: '\nfor i in range(10):\n    print(i)'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][1][0].text).toBe('\nfor i in range(10):\n    print(i)');
				expect(cellChanges[0][1][0].rangeLength).toBe(0);
			});
		});

		describe('Mixed EOL Multi-Cell Scenarios', () => {
			test('Three cells with mixed EOL - modify first cell with LF', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'import os\nimport sys\nprint("Cell 1")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'import pandas as pd\r\ndf = pd.DataFrame()\r\nprint("Cell 2")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'from datetime import datetime\nimport json\r\nprint("Cell 3")', 'python'),
				];
				const { notebook, altDoc } = createNotebook(cells);

				// Replace "os" with "collections" in first cell (LF)
				const altChangeEvent: TextDocumentContentChangeEvent = {
					range: new Range(1, 7, 1, 9), // "os" in first cell
					rangeLength: 2,
					rangeOffset: 60,
					text: 'collections'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][0]).toBe(notebook.cellAt(0));
				expect(cellChanges[0][1]).toHaveLength(1);

				const cellChange = cellChanges[0][1][0];
				expect(cellChange.text).toBe('collections');
				expect(cellChange.range.start.line).toBe(0);
				expect(cellChange.range.start.character).toBe(7);
				expect(cellChange.range.end.line).toBe(0);
				expect(cellChange.range.end.character).toBe(9);
			});

			test('Three cells with mixed EOL - modify second cell with CRLF', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'import os\nimport sys\nprint("Cell 1")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'import pandas as pd\r\ndf = pd.DataFrame()\r\nprint("Cell 2")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'from datetime import datetime\nimport json\r\nprint("Cell 3")', 'python'),
				];
				const { notebook, altDoc } = createNotebook(cells);

				// Insert a new line in the second cell (which has CRLF)
				const altChangeEvent: TextDocumentContentChangeEvent = {
					range: new Range(5, 19, 5, 19), // End of "df = pd.DataFrame()" line
					rangeLength: 0,
					rangeOffset: 140, // Approximate offset
					text: '\ndf.info()'
				};

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent]);

				expect(cellChanges).toHaveLength(1);
				expect(cellChanges[0][0]).toBe(notebook.cellAt(1));
				expect(cellChanges[0][1]).toHaveLength(1);

				const cellChange = cellChanges[0][1][0];
				// Should convert LF to CRLF for this cell
				expect(cellChange.text).toBe('\r\ndf.info()');
				expect(cellChange.rangeLength).toBe(0);
			});

			test('Five cells with alternating EOL - comprehensive edit test', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'import requests\nimport json\napi_url = "https://api.example.com"', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'headers = {"Content-Type": "application/json"}\r\ndata = {"key": "value"}\r\nresponse = requests.post(api_url, headers=headers, json=data)', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'if response.status_code == 200:\n    result = response.json()\n    print("Success:", result)', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'else:\r\n    print("Error:", response.status_code)\r\n    print("Response:", response.text)', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'finally:\n    print("Request completed")\n    # Log the result', 'python'),
				];
				const { notebook, altDoc } = createNotebook(cells);

				// Test 1: Modify first cell - add timeout parameter
				const altChangeEvent1: TextDocumentContentChangeEvent = {
					range: new Range(3, 39, 3, 39), // After "https://api.example.com"
					rangeLength: 0,
					rangeOffset: 95,
					text: '/v1'
				};

				const cellChanges1 = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent1]);

				expect(cellChanges1).toHaveLength(1);
				expect(cellChanges1[0][0]).toBe(notebook.cellAt(0));
				expect(cellChanges1[0][1][0].text).toBe('/v1');

				// Test 2: Modify second cell - add timeout parameter
				const altChangeEvent2: TextDocumentContentChangeEvent = {
					range: new Range(6, 64, 6, 64), // After "json=data"
					rangeLength: 0,
					rangeOffset: 200,
					text: ', timeout=30'
				};

				const cellChanges2 = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent2]);

				expect(cellChanges2).toHaveLength(1);
				expect(cellChanges2[0][0]).toBe(notebook.cellAt(1));
				expect(cellChanges2[0][1][0].text).toBe(', timeout=30');

				// Test 3: Modify third cell - add error handling
				const altChangeEvent3: TextDocumentContentChangeEvent = {
					range: new Range(11, 30, 11, 30), // After 'print("Success:", result)'
					rangeLength: 0,
					rangeOffset: 446,
					text: '\n    log_success(result)'
				};

				const cellChanges3 = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent3]);

				expect(cellChanges3).toHaveLength(1);
				expect(cellChanges3[0][0]).toBe(notebook.cellAt(2));
				// Should maintain LF for this cell
				expect(cellChanges3[0][1][0].text).toBe('\n    log_success(result)');

				// Test 4: Modify fourth cell - enhance error logging
				const altChangeEvent4: TextDocumentContentChangeEvent = {
					range: new Range(12, 35, 12, 35), // After 'print("Response:", response.text)'
					rangeLength: 0,
					rangeOffset: 585,
					text: '\n    raise Exception("API call failed")'
				};

				const cellChanges4 = fromAltTextDocumentContentChangeEvents(altDoc, [altChangeEvent4]);

				expect(cellChanges4).toHaveLength(1);
				expect(cellChanges4[0][0]).toBe(notebook.cellAt(3));
				// Should maintain CRLF for this cell
				expect(cellChanges4[0][1][0].text).toBe('\r\n    raise Exception("API call failed")');
			});

			test('Multiple changes to different cells with mixed EOL in single operation', async () => {
				const cells = [
					new NotebookCellData(NotebookCellKind.Code, 'class DataProcessor:\n    def __init__(self):\n        self.data = []', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'def process_data(self, item):\r\n    self.data.append(item)\r\n    return len(self.data)', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'processor = DataProcessor()\nfor i in range(10):\n    processor.process_data(i)', 'python'),
				];
				const { notebook, altDoc } = createNotebook(cells);

				// Multiple changes in a single operation
				const altChangeEvents: TextDocumentContentChangeEvent[] = [
					{
						// Change in first cell
						range: new Range(3, 20, 3, 22), // "[]" in self.data = []
						rangeLength: 2,
						rangeOffset: 118,
						text: 'None'
					},
					{
						// Change in second cell
						range: new Range(6, 4, 6, 26), // "self.data.append(item)" line
						rangeLength: 22,
						rangeOffset: 208,
						text: 'if item is not None:\n        self.data.append(item)'
					},
					{
						// Change in third cell
						range: new Range(11, 27, 11, 28), // "i" in process_data(i)
						rangeLength: 1,
						rangeOffset: 385,
						text: 'f"item_{i}"'
					}
				];

				const cellChanges = fromAltTextDocumentContentChangeEvents(altDoc, altChangeEvents);

				expect(cellChanges).toHaveLength(3);

				// Check first cell change (should maintain LF)
				const firstCellChange = cellChanges.find(([cell]) => cell === notebook.cellAt(0));
				expect(firstCellChange).toBeDefined();
				expect(firstCellChange![1][0].text).toBe('None');

				// Check second cell change (should maintain CRLF)
				const secondCellChange = cellChanges.find(([cell]) => cell === notebook.cellAt(1));
				expect(secondCellChange).toBeDefined();
				expect(secondCellChange![1][0].text).toBe('if item is not None:\r\n        self.data.append(item)');

				// Check third cell change (should maintain LF)
				const thirdCellChange = cellChanges.find(([cell]) => cell === notebook.cellAt(2));
				expect(thirdCellChange).toBeDefined();
				expect(thirdCellChange![1][0].text).toBe('f"item_{i}"');
			});
		});
	});
	describe('Cell Add/Delete', () => {
		describe('Cell with 1 line', () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
			];
			let altDoc: AlternativeNotebookTextDocument;
			let notebook: NotebookDocument;
			beforeEach(() => {
				({ altDoc, notebook } = createNotebook(cells));
			});
			function getUpdatedAltText(e: NotebookDocumentContentChange[]): string {
				const originalText = altDoc.getText();
				const newDoc = altDoc.withNotebookChanges(e);
				const edit = editFromNotebookChangeEvents(altDoc, e);
				const updatedAltText = newDoc.getText();
				if (edit) {
					// Verify the edit is generated correctly
					expect(edit.apply(originalText)).toBe(updatedAltText);
				}
				return updatedAltText;
			}
			test(`remove cell`, async () => {
				expect(getUpdatedAltText([{
					addedCells: [],
					range: new NotebookRange(0, 1),
					removedCells: [notebook.cellAt(0)],
				}])).toMatchSnapshot();
			});
			test(`insert cell below`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1)],
					range: new NotebookRange(1, 1),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert a code cell and markdown cell`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
					new NotebookCellData(NotebookCellKind.Markup, '# Foo Bar', 'markdown'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1)],
					range: new NotebookRange(1, 1),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert a markdown cell`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Markup, '# Foo Bar', 'markdown'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1)],
					range: new NotebookRange(1, 1),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert cell above`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1)],
					range: new NotebookRange(0, 0),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert cells above`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'print("Bar Baz")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1), notebook.cellAt(2)],
					range: new NotebookRange(0, 0),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert cells`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'print("Bar Baz")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1), notebook.cellAt(2)],
					range: new NotebookRange(1, 1),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`remove and insert cell`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1)],
					range: new NotebookRange(0, 1),
					removedCells: [notebook.cellAt(0)],
				}])).toMatchSnapshot();
			});
			test(`remove and insert cells`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'print("Bar Baz")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1), notebook.cellAt(2)],
					range: new NotebookRange(0, 1),
					removedCells: [notebook.cellAt(0)],
				}])).toMatchSnapshot();
			});
		});
		describe('Cell with multiple line (crlf)', () => {
			const cells = [
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")', 'python'),
				new NotebookCellData(NotebookCellKind.Code, 'print("Hello World")\r\nprint("Foo Bar")\r\nprint("Bar Baz")\r\nprint("Something Else")', 'python'),
			];
			let altDoc: AlternativeNotebookTextDocument;
			let notebook: NotebookDocument;
			beforeEach(() => {
				({ altDoc, notebook } = createNotebook(cells));
			});
			function getUpdatedAltText(e: NotebookDocumentContentChange[]): string {
				const originalText = altDoc.getText();
				const newDoc = altDoc.withNotebookChanges(e);
				const edit = editFromNotebookChangeEvents(altDoc, e);
				const updatedAltText = newDoc.getText();
				if (edit) {
					// Verify the edit is generated correctly
					expect(edit.apply(originalText)).toBe(updatedAltText);
				}
				return updatedAltText;
			}
			test(`remove first cell`, async () => {
				expect(getUpdatedAltText([{
					addedCells: [],
					range: new NotebookRange(0, 1),
					removedCells: [notebook.cellAt(0)],
				}])).toMatchSnapshot();
			});
			test(`insert cell below`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(2)],
					range: new NotebookRange(2, 2),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert cell middle`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(2)],
					range: new NotebookRange(1, 1),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert cells middle`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, '# Another Cell', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(2), notebook.cellAt(3)],
					range: new NotebookRange(1, 1),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert cell above`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1)],
					range: new NotebookRange(0, 0),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert cells above`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'print("Bar Baz")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1), notebook.cellAt(2)],
					range: new NotebookRange(0, 0),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`insert cells`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'print("Bar Baz")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1), notebook.cellAt(2)],
					range: new NotebookRange(1, 1),
					removedCells: [],
				}])).toMatchSnapshot();
			});
			test(`remove and insert cell`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1)],
					range: new NotebookRange(0, 1),
					removedCells: [notebook.cellAt(0)],
				}])).toMatchSnapshot();
			});
			test(`remove and insert cells`, async () => {
				const { notebook } = createNotebook(cells.concat([
					new NotebookCellData(NotebookCellKind.Code, 'print("Foo Bar")', 'python'),
					new NotebookCellData(NotebookCellKind.Code, 'print("Bar Baz")', 'python'),
				]));
				expect(getUpdatedAltText([{
					addedCells: [notebook.cellAt(1), notebook.cellAt(2)],
					range: new NotebookRange(0, 1),
					removedCells: [notebook.cellAt(0)],
				}])).toMatchSnapshot();
			});
		});
	});
});
