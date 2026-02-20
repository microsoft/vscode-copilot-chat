/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { RootedEdit } from '../../../../platform/inlineEdits/common/dataTypes/edit';
import { DEFAULT_OPTIONS, IncludeLineNumbersOption, PromptOptions, RecentFileClippingStrategy } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { IXtabHistoryEditEntry, IXtabHistoryVisibleRangesEntry } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { splitLines } from '../../../../util/vs/base/common/strings';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { buildCodeSnippetsUsingPagedClipping, historyEntriesToCodeSnippet } from '../../common/recentFilesForPrompt';

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
	clippingStrategy?: RecentFileClippingStrategy;
}): PromptOptions {
	return {
		...DEFAULT_OPTIONS,
		recentlyViewedDocuments: {
			...DEFAULT_OPTIONS.recentlyViewedDocuments,
			...(overrides.maxTokens !== undefined && { maxTokens: overrides.maxTokens }),
			...(overrides.recentlyViewedFilesIncludeLineNumbers !== undefined && { includeLineNumbers: overrides.recentlyViewedFilesIncludeLineNumbers }),
			...(overrides.includeViewedFiles !== undefined && { includeViewedFiles: overrides.includeViewedFiles }),
			...(overrides.clippingStrategy !== undefined && { clippingStrategy: overrides.clippingStrategy }),
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
		focalRanges?: readonly OffsetRange[];
		editEntryCount?: number;
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
			const focalRanges = [new OffsetRange(24, 30)];

			const { snippets } = buildSnippets(
				[{ id, content, focalRanges }],
				makeOpts({ maxTokens: 15, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 2, clippingStrategy: RecentFileClippingStrategy.AroundEditRange }),
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
			const focalRanges = [new OffsetRange(line10Start, line10Start + lineLength)];

			const { snippets } = buildSnippets(
				[{ id, content, focalRanges }],
				makeOpts({ maxTokens: 50, recentlyViewedFilesIncludeLineNumbers: IncludeLineNumbersOption.WithSpaceAfter, pageSize: 5, clippingStrategy: RecentFileClippingStrategy.AroundEditRange }),
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

	suite('AroundEditRange strategy', () => {

		test('centers snippet on focal range instead of top of file', () => {
			// 100-line file with a "focal range" (edit) near the bottom
			const lines = Array.from({ length: 100 }, (_, i) => `line_${String(i).padStart(3, '0')}`);
			const content = new StringText(lines.join('\n'));
			const lineLen = 'line_000\n'.length;
			// Focal range at line 80
			const focalRanges = [new OffsetRange(80 * lineLen, 81 * lineLen)];

			const { snippets } = buildSnippets(
				[{ id, content, focalRanges }],
				makeOpts({ maxTokens: 30, pageSize: 5, clippingStrategy: RecentFileClippingStrategy.AroundEditRange }),
			);

			// Should include lines around line 80, not from the top
			const snippet = snippets[0];
			expect(snippet).toContain('line_080');
			expect(snippet).not.toContain('line_000');
		});

		test('falls back to top-to-bottom for entries without focal ranges', () => {
			const { snippets } = buildSnippets(
				[{ id, content: nLines(20) }],
				makeOpts({ maxTokens: 10, pageSize: 5, clippingStrategy: RecentFileClippingStrategy.AroundEditRange }),
			);

			// No focal ranges → falls through to clipFullDocument (top-to-bottom)
			const snippet = snippets[0];
			expect(snippet).toContain('1\n2\n3\n4\n5');
		});

		test('clips multiple files around their respective focal ranges', () => {
			const lines1 = Array.from({ length: 50 }, (_, i) => `fileA_${i}`);
			const content1 = new StringText(lines1.join('\n'));
			const lineLen1 = 'fileA_0\n'.length;
			const focalRanges1 = [new OffsetRange(40 * lineLen1, 41 * lineLen1)]; // near bottom

			const lines2 = Array.from({ length: 50 }, (_, i) => `fileB_${i}`);
			const content2 = new StringText(lines2.join('\n'));
			const lineLen2 = 'fileB_0\n'.length;
			const focalRanges2 = [new OffsetRange(10 * lineLen2, 11 * lineLen2)]; // near top

			const { snippets, docsInPrompt } = buildSnippets(
				[
					{ id, content: content1, focalRanges: focalRanges1 },
					{ id: id2, content: content2, focalRanges: focalRanges2 },
				],
				makeOpts({ maxTokens: 100, pageSize: 5, clippingStrategy: RecentFileClippingStrategy.AroundEditRange }),
			);

			expect(docsInPrompt.size).toBe(2);
			// File 1 should contain content near line 40, not line 0
			expect(snippets.find(s => s.includes('fileA_40'))).toBeDefined();
			// File 2 should contain content near line 10
			expect(snippets.find(s => s.includes('fileB_10'))).toBeDefined();
		});
	});

	suite('Proportional strategy', () => {

		test('distributes budget across files instead of greedily consuming', () => {
			// Two files, each 50 lines. With greedy, the first file would consume everything.
			// With proportional, each gets ~half.
			const content1 = new StringText(Array.from({ length: 50 }, (_, i) => `A${i}`).join('\n'));
			const lineLen1 = 'A0\n'.length;
			const content2 = new StringText(Array.from({ length: 50 }, (_, i) => `B${i}`).join('\n'));
			const lineLen2 = 'B0\n'.length;

			const { snippets, docsInPrompt } = buildSnippets(
				[
					{ id, content: content1, focalRanges: [new OffsetRange(0, lineLen1)], editEntryCount: 1 },
					{ id: id2, content: content2, focalRanges: [new OffsetRange(0, lineLen2)], editEntryCount: 1 },
				],
				makeOpts({ maxTokens: 40, pageSize: 5, clippingStrategy: RecentFileClippingStrategy.Proportional }),
			);

			// Both files should be represented in the prompt
			expect(docsInPrompt.size).toBe(2);
			expect(snippets.length).toBe(2);
		});

		test('gives more budget to files with more edit locations', () => {
			// File A has 3 edits, File B has 1 edit. File A should get more content.
			const content = new StringText(Array.from({ length: 40 }, (_, i) => `x${i}`).join('\n'));
			const lineLen = 'x0\n'.length;

			const { snippets } = buildSnippets(
				[
					{ id, content, focalRanges: [new OffsetRange(0, lineLen)], editEntryCount: 3 },
					{ id: id2, content, focalRanges: [new OffsetRange(0, lineLen)], editEntryCount: 1 },
				],
				makeOpts({ maxTokens: 60, pageSize: 5, clippingStrategy: RecentFileClippingStrategy.Proportional }),
			);

			// Both files should appear
			expect(snippets.length).toBe(2);
			// File A (first in order = id, 3 edits) should have more content than File B (id2, 1 edit)
			const fileASnippet = snippets.find(s => s.includes('/src/first.txt'))!;
			const fileBSnippet = snippets.find(s => s.includes('/src/second.txt'))!;
			expect(fileASnippet.length).toBeGreaterThan(fileBSnippet.length);
		});

		test('ensures minimum budget per file', () => {
			// File A has many edits, File B has 1 edit. Even with skewed distribution,
			// File B should still get at least some content.
			const smallContent = new StringText('hello\nworld');

			const { snippets, docsInPrompt } = buildSnippets(
				[
					{ id, content: nLines(50), focalRanges: [new OffsetRange(0, 5)], editEntryCount: 10 },
					{ id: id2, content: smallContent, focalRanges: [new OffsetRange(0, 3)], editEntryCount: 1 },
				],
				makeOpts({ maxTokens: 100, pageSize: 5, clippingStrategy: RecentFileClippingStrategy.Proportional }),
			);

			// Both files should be included even though weights are heavily skewed
			expect(docsInPrompt.size).toBe(2);
			expect(snippets.length).toBe(2);
		});
	});
});

suite('historyEntriesToCodeSnippet', () => {

	const docId = DocumentId.create('file:///src/example.txt');

	/**
	 * Helper to create an edit entry from a base text and a StringEdit.
	 */
	function makeEditEntry(base: string, edit: StringEdit): IXtabHistoryEditEntry {
		return {
			kind: 'edit',
			docId,
			edit: new RootedEdit(new StringText(base), edit),
		};
	}

	/**
	 * Helper to create a visibleRanges entry.
	 */
	function makeVisibleEntry(content: string, visibleRanges: readonly OffsetRange[]): IXtabHistoryVisibleRangesEntry {
		return {
			kind: 'visibleRanges',
			docId,
			documentContent: new StringText(content),
			visibleRanges,
		};
	}

	test('single edit entry returns its new ranges directly', () => {
		// "hello" → insert " world" at offset 5 → "hello world"
		const edit = StringEdit.insert(5, ' world');
		const entry = makeEditEntry('hello', edit);

		const result = historyEntriesToCodeSnippet([entry]);

		expect(result.content.value).toBe('hello world');
		expect(result.focalRanges).toEqual([new OffsetRange(5, 11)]); // " world" occupies [5,11)
		expect(result.editEntryCount).toBe(1);
	});

	test('two edit entries: older ranges are transformed through the newer edit', () => {
		// Start: "AABB"
		// Older edit: replace [0,2) "AA" → "XXX"  ⇒  "XXXBB"
		//   New ranges in older post-edit: [0,3) for "XXX"
		// Newer edit (base = "XXXBB"): insert "YY" at offset 0  ⇒  "YYXXXBB"
		//   New ranges in newer post-edit: [0,2) for "YY"
		//
		// After transformation, the older edit's [0,3) should be shifted by the
		// newer edit's insertion of 2 chars at offset 0 → [2,5) in the final content.
		const olderEdit = StringEdit.replace(new OffsetRange(0, 2), 'XXX');
		const newerEdit = StringEdit.insert(0, 'YY');

		const olderEntry = makeEditEntry('AABB', olderEdit);
		const newerEntry = makeEditEntry('XXXBB', newerEdit);

		// entries[0] = most recent, entries[1] = older
		const result = historyEntriesToCodeSnippet([newerEntry, olderEntry]);

		expect(result.content.value).toBe('YYXXXBB');
		// Newer edit's own range: [0,2) for "YY"
		// Older edit's range transformed forward: [0,3) → applyToOffsetRange via newerEdit → [2,5)
		expect(result.focalRanges).toEqual([
			new OffsetRange(0, 2),  // from newerEntry
			new OffsetRange(2, 5),  // from olderEntry, transformed
		]);
		expect(result.editEntryCount).toBe(2);
	});

	test('three edit entries: ranges chain through two edits', () => {
		// Start: "abcdef"
		// E2 (oldest): delete [0,3) "abc"  ⇒  "def"
		//   New ranges in E2 post-edit: [0,0) (empty, deletion)
		// E1 (middle): insert "XY" at offset 0  ⇒  "XYdef"
		//   E1.base = "def"
		//   New ranges in E1 post-edit: [0,2) for "XY"
		// E0 (newest): insert "Z" at offset 5  ⇒  "XYdefZ"
		//   E0.base = "XYdef"
		//   New ranges in E0 post-edit: [5,6) for "Z"
		const e2 = makeEditEntry('abcdef', StringEdit.delete(new OffsetRange(0, 3)));
		const e1 = makeEditEntry('def', StringEdit.insert(0, 'XY'));
		const e0 = makeEditEntry('XYdef', StringEdit.insert(5, 'Z'));

		const result = historyEntriesToCodeSnippet([e0, e1, e2]);

		expect(result.content.value).toBe('XYdefZ');
		// E0's own range: [5,6)
		// E1's range [0,2) transformed through E0: E0 inserts at 5, so [0,2) stays [0,2)
		// E2's range [0,0) transformed through E1 then E0:
		//   Through E1 (insert 2 chars at 0): [0,0) → [2,2)
		//   Through E0 (insert 1 char at 5): [2,2) → [2,2) (before insertion point)
		expect(result.focalRanges).toEqual([
			new OffsetRange(5, 6),  // E0
			new OffsetRange(0, 2),  // E1, transformed through E0
			new OffsetRange(2, 2),  // E2, transformed through E1 and E0
		]);
		expect(result.editEntryCount).toBe(3);
	});

	test('visibleRanges entries are skipped for focal range collection', () => {
		// Most recent is a visibleRanges entry, followed by an edit entry.
		// Only the edit entry should contribute focal ranges.
		const edit = StringEdit.insert(5, ' world');
		const editEntry = makeEditEntry('hello', edit);
		const visibleEntry = makeVisibleEntry('hello world', [new OffsetRange(0, 5)]);

		// visibleEntry is most recent
		const result = historyEntriesToCodeSnippet([visibleEntry, editEntry]);

		expect(result.content.value).toBe('hello world');
		// Only the edit entry's range should appear; the visibleRanges entry's [0,5) is excluded
		expect(result.focalRanges).toEqual([new OffsetRange(5, 11)]);
		expect(result.editEntryCount).toBe(1);
	});

	test('only visibleRanges entries produce no focal ranges', () => {
		const entry = makeVisibleEntry('hello', [new OffsetRange(0, 3)]);

		const result = historyEntriesToCodeSnippet([entry]);

		expect(result.content.value).toBe('hello');
		expect(result.focalRanges).toBeUndefined();
		expect(result.editEntryCount).toBe(1); // Math.max(0, 1)
	});

	test('edit after deletion: ranges are correctly shifted', () => {
		// Start: "aaa_bbb_ccc"
		// Older edit: delete middle part [3,8) "_bbb_" → "aaaccc"
		//   New ranges: [3,3) (empty, deletion)
		// Newer edit (base = "aaaccc"): replace [0,3) "aaa" → "XX" → "XXccc"
		//   New ranges: [0,2) for "XX"
		//
		// Older's [3,3) through newer: newer replaces [0,3)→"XX" (delta = -1)
		//   offset 3 is at the end of the replaced range → maps to 2
		//   So [3,3) → [2,2)
		const olderEdit = StringEdit.delete(new OffsetRange(3, 8));
		const newerEdit = StringEdit.replace(new OffsetRange(0, 3), 'XX');

		const olderEntry = makeEditEntry('aaa_bbb_ccc', olderEdit);
		const newerEntry = makeEditEntry('aaaccc', newerEdit);

		const result = historyEntriesToCodeSnippet([newerEntry, olderEntry]);

		expect(result.content.value).toBe('XXccc');
		expect(result.focalRanges).toEqual([
			new OffsetRange(0, 2),  // newerEntry's "XX"
			new OffsetRange(2, 2),  // olderEntry's deletion point, shifted
		]);
	});
});
