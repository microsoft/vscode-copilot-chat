/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, describe, expect, it, suite, test } from 'vitest';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { CurrentFileOptions, DEFAULT_OPTIONS, IncludeLineNumbersOption, PromptOptions } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { Result } from '../../../../util/common/result';
import { splitLines } from '../../../../util/vs/base/common/strings';
import { Position } from '../../../../util/vs/editor/common/core/position';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { buildCodeSnippetsUsingPagedClipping, constructTaggedFile, createTaggedCurrentFileContentUsingPagedClipping, expandRangeToPageRange } from '../../common/promptCrafting';
import { CurrentDocument } from '../../common/xtabCurrentDocument';

function nLines(n: number): StringText {
	return new StringText(new Array(n).fill(0).map((_, i) => `${i + 1}`).join('\n'));
}

function computeTokens(s: string) {
	return Math.ceil(s.length / 4);
}

/**
 * Helper to create PromptOptions with partial overrides.
 * Supports nested partial updates for recentlyViewedDocuments and pagedClipping.
 */
function makeOpts(overrides: {
	maxTokens?: number;
	recentlyViewedFilesIncludeLineNumbers?: IncludeLineNumbersOption;
	includeViewedFiles?: boolean;
	pageSize?: number;
}): PromptOptions {
	return {
		...DEFAULT_OPTIONS,
		recentlyViewedDocuments: {
			...DEFAULT_OPTIONS.recentlyViewedDocuments,
			...(overrides.maxTokens !== undefined && { maxTokens: overrides.maxTokens }),
			...(overrides.recentlyViewedFilesIncludeLineNumbers !== undefined && { includeLineNumbers: overrides.recentlyViewedFilesIncludeLineNumbers }),
			...(overrides.includeViewedFiles !== undefined && { includeViewedFiles: overrides.includeViewedFiles }),
		},
		pagedClipping: {
			pageSize: overrides.pageSize ?? DEFAULT_OPTIONS.pagedClipping.pageSize,
		},
	};
}


suite('Paged clipping - recently viewed files', () => {

	type FileEntry = {
		id: DocumentId;
		content: StringText;
		visibleRanges?: readonly OffsetRange[];
	};

	/**
		 * Helper to build code snippets with less boilerplate.
		 */
	function buildSnippets(
		files: FileEntry[],
		opts: PromptOptions,
	): { snippets: string[]; docsInPrompt: Set<DocumentId> } {
		return buildCodeSnippetsUsingPagedClipping(files, computeTokens, opts);
	}

	const id = DocumentId.create('file:///src/first.txt');
	const id2 = DocumentId.create('file:///src/second.txt');

	test('can page correctly by lines of 2', () => {
		const { snippets } = buildSnippets(
			[{ id, content: nLines(4) }],
			makeOpts({ maxTokens: 4, pageSize: 2 }),
		);

		expect(snippets).toMatchInlineSnapshot(`
			[
			  "<|recently_viewed_code_snippet|>
			code_snippet_file_path: /src/first.txt (truncated)
			1
			2
			<|/recently_viewed_code_snippet|>",
			]
		`);
	});

	test('can page correctly by lines of 4', () => {
		const { snippets } = buildSnippets(
			[{ id, content: nLines(4) }],
			makeOpts({ maxTokens: 2000, pageSize: 2 }),
		);

		expect(snippets).toMatchInlineSnapshot(`
			[
			  "<|recently_viewed_code_snippet|>
			code_snippet_file_path: /src/first.txt
			1
			2
			3
			4
			<|/recently_viewed_code_snippet|>",
			]
		`);
	});

	suite('includeLineNumbers', () => {

		test('includes line numbers starting from 0 when enabled and not truncated', () => {
			const { snippets } = buildSnippets(
				[{ id, content: nLines(4) }],
				makeOpts({ maxTokens: 2000, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 2 }),
			);

			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt
				0| 1
				1| 2
				2| 3
				3| 4
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});

		test('includes line numbers starting from 0 when truncated from beginning', () => {
			const { snippets } = buildSnippets(
				[{ id, content: nLines(10) }],
				makeOpts({ maxTokens: 4, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 2 }),
			);

			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt (truncated)
				0| 1
				1| 2
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});

		test('includes line numbers with correct offset when using visible ranges', () => {
			// Create content: line0\nline1\n...\nline9 (each line is 6 chars including newline)
			const content = new StringText('line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9');
			// line4 starts at offset 24 (4 lines * 6 chars each)
			const visibleRanges = [new OffsetRange(24, 30)];

			const { snippets } = buildSnippets(
				[{ id, content, visibleRanges }],
				makeOpts({ maxTokens: 15, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 2 }),
			);

			// Line numbers start from 4 (not 0) because lines 0-3 are truncated
			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt (truncated)
				4| line4
				5| line5
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});

		test('includes line numbers with offset when visible range is in middle of file', () => {
			const lines = Array.from({ length: 20 }, (_, i) => `content_line_${i}`);
			const content = new StringText(lines.join('\n'));
			const lineLength = 'content_line_0\n'.length;
			const line10Start = 10 * lineLength;
			const visibleRanges = [new OffsetRange(line10Start, line10Start + lineLength)];

			const { snippets } = buildSnippets(
				[{ id, content, visibleRanges }],
				makeOpts({ maxTokens: 50, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 5 }),
			);

			// Line numbers start from 10 (page containing line 10)
			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt (truncated)
				10| content_line_10
				11| content_line_11
				12| content_line_12
				13| content_line_13
				14| content_line_14
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});

		test('does not include line numbers when disabled', () => {
			const { snippets } = buildSnippets(
				[{ id, content: nLines(4) }],
				makeOpts({ maxTokens: 2000, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.None, pageSize: 2 }),
			);

			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt
				1
				2
				3
				4
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});

		test('includes line numbers for multiple files', () => {
			const { snippets } = buildSnippets(
				[
					{ id, content: nLines(3) },
					{ id: id2, content: nLines(3) },
				],
				makeOpts({ maxTokens: 2000, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 10 }),
			);

			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/second.txt
				0| 1
				1| 2
				2| 3
				<|/recently_viewed_code_snippet|>",
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt
				0| 1
				1| 2
				2| 3
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});

		test('includes line numbers with partial truncation for first file only', () => {
			const { snippets } = buildSnippets(
				[
					{ id, content: nLines(6) },
					{ id: id2, content: nLines(4) },
				],
				makeOpts({ maxTokens: 10, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 2 }),
			);

			// First file gets truncated, second file doesn't fit in budget
			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt (truncated)
				0| 1
				1| 2
				2| 3
				3| 4
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});

		test('handles empty content gracefully with line numbers enabled', () => {
			const { snippets } = buildSnippets(
				[{ id, content: new StringText('') }],
				makeOpts({ maxTokens: 2000, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 2 }),
			);

			// Empty string content produces a single empty line
			expect(snippets.map(splitLines)).toMatchInlineSnapshot(`
				[
				  [
				    "<|recently_viewed_code_snippet|>",
				    "code_snippet_file_path: /src/first.txt",
				    "0| ",
				    "<|/recently_viewed_code_snippet|>",
				  ],
				]
			`);
		});

		test('handles single line content with line numbers', () => {
			const { snippets } = buildSnippets(
				[{ id, content: new StringText('single line') }],
				makeOpts({ maxTokens: 2000, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 2 }),
			);

			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt
				0| single line
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});

		test('line numbers are formatted correctly for double-digit line numbers', () => {
			const { snippets } = buildSnippets(
				[{ id, content: nLines(15) }],
				makeOpts({ maxTokens: 2000, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 20 }),
			);

			expect(snippets).toMatchInlineSnapshot(`
				[
				  "<|recently_viewed_code_snippet|>
				code_snippet_file_path: /src/first.txt
				0| 1
				1| 2
				2| 3
				3| 4
				4| 5
				5| 6
				6| 7
				7| 8
				8| 9
				9| 10
				10| 11
				11| 12
				12| 13
				13| 14
				14| 15
				<|/recently_viewed_code_snippet|>",
				]
			`);
		});
	});
});

describe('expandRangeToPageRange', () => {

	const PAGE_SIZE = 10;
	const UNLIM_BUDGET = 10000;
	const computeTokens = (s: string) => 0; // pay 0 tokens per line (1 token for newline)

	it('expands correctly when budget is only for two touched pages', () => {

		const nDocLines = 47;
		const docLines = nLines(nDocLines).getLines();
		const r = expandRangeToPageRange(
			docLines,
			new OffsetRange(11, 22),
			PAGE_SIZE,
			2 * PAGE_SIZE, // budget for 2 pages
			computeTokens, // pay 1 token per line (1 token for newline)
			false
		);

		expect(r).toMatchInlineSnapshot(`
			{
			  "budgetLeft": 0,
			  "firstPageIdx": 1,
			  "lastPageIdxIncl": 2,
			}
		`);
	});

	it('expands correctly to the whole document', () => {

		const nDocLines = 47;
		const docLines = nLines(nDocLines).getLines();
		const r = expandRangeToPageRange(
			docLines,
			new OffsetRange(11, 22),
			PAGE_SIZE,
			UNLIM_BUDGET,
			computeTokens,
			false
		);

		expect(r).toMatchInlineSnapshot(`
			{
			  "budgetLeft": 4973,
			  "firstPageIdx": 0,
			  "lastPageIdxIncl": 4,
			}
		`);
	});
});


suite('Paged clipping - current file', () => {

	const opts: CurrentFileOptions = DEFAULT_OPTIONS.currentFile;

	function createTaggedFile(
		currentDocLines: string[],
		areaAroundCodeToEdit: string,
		areaAroundEditWindowLinesRange: OffsetRange,
		computeTokens: (s: string) => number,
		pageSize: number,
		opts: CurrentFileOptions,
	): Result<string, 'outOfBudget'> {

		return createTaggedCurrentFileContentUsingPagedClipping(
			currentDocLines,
			areaAroundCodeToEdit.split('\n'),
			areaAroundEditWindowLinesRange,
			computeTokens,
			pageSize,
			opts
		).map(taggedCurrentFileContent => taggedCurrentFileContent.lines.join('\n'));
	}

	test('unlim budget - includes whole context', () => {

		const docLines = nLines(40);

		const areaAroundCodeToEdit = `
<area_around_code_to_edit>
22
23
<code_to_edit>
24
25
<code_to_edit>
26
</area_around_code_to_edit>
`.trim();

		const result = createTaggedFile(
			docLines.getLines(),
			areaAroundCodeToEdit,
			new OffsetRange(21, 26),
			computeTokens,
			10,
			{ ...opts, maxTokens: 2000 }
		);
		assert(result.isOk());
		const taggedCurrentFileContent = result.val;

		expect(taggedCurrentFileContent).toMatchInlineSnapshot(`
			"1
			2
			3
			4
			5
			6
			7
			8
			9
			10
			11
			12
			13
			14
			15
			16
			17
			18
			19
			20
			21
			<area_around_code_to_edit>
			22
			23
			<code_to_edit>
			24
			25
			<code_to_edit>
			26
			</area_around_code_to_edit>
			27
			28
			29
			30
			31
			32
			33
			34
			35
			36
			37
			38
			39
			40"
		`);
	});


	test('budget of 20', () => {

		const docLines = nLines(40);

		const areaAroundCodeToEdit = `
<area_around_code_to_edit>
22
23
<code_to_edit>
24
25
<code_to_edit>
26
</area_around_code_to_edit>
`.trim();

		const result = createTaggedFile(
			docLines.getLines(),
			areaAroundCodeToEdit,
			new OffsetRange(21, 26),
			computeTokens,
			10,
			{ ...opts, maxTokens: 20 },
		);
		assert(result.isOk());
		const taggedCurrentFileContent = result.val;
		expect(taggedCurrentFileContent).toMatchInlineSnapshot(`
			"21
			<area_around_code_to_edit>
			22
			23
			<code_to_edit>
			24
			25
			<code_to_edit>
			26
			</area_around_code_to_edit>
			27
			28
			29
			30"
		`);
	});


	test('context above and below get same # of tokens', () => {

		const docLines = nLines(40);

		const areaAroundCodeToEdit = `
<a>
11
12
<b>
13
</b>
14
</a>
`.trim();

		const result = createTaggedFile(
			docLines.getLines(),
			areaAroundCodeToEdit,
			new OffsetRange(10, 14),
			computeTokens,
			10,
			{ ...opts, maxTokens: 50 }
		);
		assert(result.isOk());
		const taggedCurrentFileContent = result.val;

		expect(taggedCurrentFileContent).toMatchInlineSnapshot(`
			"<a>
			11
			12
			<b>
			13
			</b>
			14
			</a>
			15
			16
			17
			18
			19
			20"
		`);
	});

});

suite('constructTaggedFile', () => {

	function createDocument(content: string, cursorLine: number, cursorColumn: number): CurrentDocument {
		return new CurrentDocument(
			new StringText(content),
			new Position(cursorLine, cursorColumn)
		);
	}

	const defaultPromptOptions: PromptOptions = {
		...DEFAULT_OPTIONS,
		currentFile: {
			...DEFAULT_OPTIONS.currentFile,
			maxTokens: 10000, // large budget to avoid clipping
		}
	};

	suite('includeCursorTag option', () => {

		test('cursor tag appears in current file content when includeCursorTag is true', () => {
			const content = 'line1\nline2\nline3\nline4\nline5';
			const doc = createDocument(content, 3, 3); // cursor at line 3, column 3

			const result = constructTaggedFile(
				doc,
				new OffsetRange(1, 4), // edit window: lines 2-4 (0-indexed)
				new OffsetRange(0, 5), // area around: all lines
				{
					...defaultPromptOptions,
					currentFile: { ...defaultPromptOptions.currentFile, includeCursorTag: true, includeTags: false }
				},
				computeTokens,
				{ includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.None } }
			);

			assert(result.isOk());
			const { clippedTaggedCurrentDoc, areaAroundCodeToEdit } = result.val;

			// Current file content should contain cursor tag
			expect(clippedTaggedCurrentDoc.lines.join('\n')).toMatchInlineSnapshot(`
				"line1
				line2
				li<|cursor|>ne3
				line4
				line5"
			`);

			// Area around should always contain cursor tag
			expect(areaAroundCodeToEdit).toMatchInlineSnapshot(`
				"<|area_around_code_to_edit|>
				line1
				<|code_to_edit|>
				line2
				li<|cursor|>ne3
				line4
				<|/code_to_edit|>
				line5
				<|/area_around_code_to_edit|>"
			`);
		});

		test('cursor tag does NOT appear in current file content when includeCursorTag is false', () => {
			const content = 'line1\nline2\nline3\nline4\nline5';
			const doc = createDocument(content, 3, 3); // cursor at line 3, column 3

			const result = constructTaggedFile(
				doc,
				new OffsetRange(1, 4), // edit window: lines 2-4 (0-indexed)
				new OffsetRange(0, 5), // area around: all lines
				{
					...defaultPromptOptions,
					currentFile: { ...defaultPromptOptions.currentFile, includeCursorTag: false, includeTags: false }
				},
				computeTokens,
				{ includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.None } }
			);

			assert(result.isOk());
			const { clippedTaggedCurrentDoc, areaAroundCodeToEdit } = result.val;

			// Current file content should NOT contain cursor tag
			expect(clippedTaggedCurrentDoc.lines.join('\n')).toMatchInlineSnapshot(`
				"line1
				line2
				line3
				line4
				line5"
			`);

			// Area around should still contain cursor tag (preserves old behavior)
			expect(areaAroundCodeToEdit).toMatchInlineSnapshot(`
				"<|area_around_code_to_edit|>
				line1
				<|code_to_edit|>
				line2
				li<|cursor|>ne3
				line4
				<|/code_to_edit|>
				line5
				<|/area_around_code_to_edit|>"
			`);
		});

		test('cursor tag appears correctly when cursor is at end of line', () => {
			const content = 'line1\nline2\nline3';
			const doc = createDocument(content, 2, 6); // cursor at end of line 2 (after "line2")

			const result = constructTaggedFile(
				doc,
				new OffsetRange(0, 3),
				new OffsetRange(0, 3),
				{
					...defaultPromptOptions,
					currentFile: { ...defaultPromptOptions.currentFile, includeCursorTag: true, includeTags: false }
				},
				computeTokens,
				{ includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.None } }
			);

			assert(result.isOk());
			expect(result.val.clippedTaggedCurrentDoc.lines.join('\n')).toMatchInlineSnapshot(`
				"line1
				line2<|cursor|>
				line3"
			`);
		});
	});

	suite('includeLineNumbers option for currentFileContent', () => {

		test('includes line numbers with space when WithSpaceAfter', () => {
			const content = 'line1\nline2\nline3';
			const doc = createDocument(content, 2, 1);

			const result = constructTaggedFile(
				doc,
				new OffsetRange(0, 3),
				new OffsetRange(0, 3),
				{
					...defaultPromptOptions,
					currentFile: { ...defaultPromptOptions.currentFile, includeCursorTag: false, includeTags: false }
				},
				computeTokens,
				{ includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.WithSpaceAfter } }
			);

			assert(result.isOk());
			expect(result.val.clippedTaggedCurrentDoc.lines.join('\n')).toMatchInlineSnapshot(`
				"0| line1
				1| line2
				2| line3"
			`);
		});

		test('includes line numbers without space when WithoutSpace', () => {
			const content = 'line1\nline2\nline3';
			const doc = createDocument(content, 2, 1);

			const result = constructTaggedFile(
				doc,
				new OffsetRange(0, 3),
				new OffsetRange(0, 3),
				{
					...defaultPromptOptions,
					currentFile: { ...defaultPromptOptions.currentFile, includeCursorTag: false, includeTags: false }
				},
				computeTokens,
				{ includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.WithoutSpace } }
			);

			assert(result.isOk());
			expect(result.val.clippedTaggedCurrentDoc.lines.join('\n')).toMatchInlineSnapshot(`
				"0|line1
				1|line2
				2|line3"
			`);
		});

		test('no line numbers when None', () => {
			const content = 'line1\nline2\nline3';
			const doc = createDocument(content, 2, 1);

			const result = constructTaggedFile(
				doc,
				new OffsetRange(0, 3),
				new OffsetRange(0, 3),
				{
					...defaultPromptOptions,
					currentFile: { ...defaultPromptOptions.currentFile, includeCursorTag: false, includeTags: false }
				},
				computeTokens,
				{ includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.None } }
			);

			assert(result.isOk());
			expect(result.val.clippedTaggedCurrentDoc.lines.join('\n')).toMatchInlineSnapshot(`
				"line1
				line2
				line3"
			`);
		});
	});

	suite('combined options', () => {

		test('line numbers and cursor tag together', () => {
			const content = 'foo\nbar\nbaz';
			const doc = createDocument(content, 2, 2); // cursor in "bar"

			const result = constructTaggedFile(
				doc,
				new OffsetRange(0, 3),
				new OffsetRange(0, 3),
				{
					...defaultPromptOptions,
					currentFile: { ...defaultPromptOptions.currentFile, includeCursorTag: true, includeTags: false }
				},
				computeTokens,
				{ includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.WithSpaceAfter } }
			);

			assert(result.isOk());
			expect(result.val.clippedTaggedCurrentDoc.lines.join('\n')).toMatchInlineSnapshot(`
				"0| foo
				1| b<|cursor|>ar
				2| baz"
			`);
		});

		test('different line number options for areaAround vs currentFile', () => {
			const content = 'line1\nline2\nline3\nline4\nline5';
			const doc = createDocument(content, 3, 1);

			const result = constructTaggedFile(
				doc,
				new OffsetRange(1, 4),
				new OffsetRange(0, 5),
				{
					...defaultPromptOptions,
					currentFile: { ...defaultPromptOptions.currentFile, includeCursorTag: false, includeTags: false }
				},
				computeTokens,
				{
					includeLineNumbers: {
						areaAroundCodeToEdit: IncludeLineNumbersOption.WithSpaceAfter,
						currentFileContent: IncludeLineNumbersOption.WithoutSpace
					}
				}
			);

			assert(result.isOk());

			// Area around uses WithSpaceAfter
			expect(result.val.areaAroundCodeToEdit).toMatchInlineSnapshot(`
				"<|area_around_code_to_edit|>
				0| line1
				<|code_to_edit|>
				1| line2
				2| <|cursor|>line3
				3| line4
				<|/code_to_edit|>
				4| line5
				<|/area_around_code_to_edit|>"
			`);

			// Current file uses WithoutSpace
			expect(result.val.clippedTaggedCurrentDoc.lines.join('\n')).toMatchInlineSnapshot(`
				"0|line1
				1|line2
				2|line3
				3|line4
				4|line5"
			`);
		});
	});
});
