/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { CurrentFileOptions, DEFAULT_OPTIONS } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { buildCodeSnippetsUsingPagedClipping, createTaggedCurrentFileContentUsingPagedClipping } from '../../common/promptCrafting';

function nLines(n: number): StringText {
	return new StringText(new Array(n).fill(0).map((_, i) => `${i + 1}`).join('\n'));
}

function computeTokens(s: string) {
	return Math.ceil(s.length / 4);
}

suite('Paged clipping - recently viewed files', () => {

	const id = DocumentId.create('file:///src/first.txt');

	test('can page correctly by lines of 2', () => {

		const { snippets } = buildCodeSnippetsUsingPagedClipping(
			[
				{
					id,
					content: nLines(4),
				}
			],
			computeTokens,
			{
				...DEFAULT_OPTIONS,
				recentlyViewedDocuments: {
					...DEFAULT_OPTIONS.recentlyViewedDocuments,
					maxTokens: 4
				},
				pagedClipping: {
					pageSize: 2,
				}
			}
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

		const { snippets } = buildCodeSnippetsUsingPagedClipping(
			[
				{
					id,
					content: nLines(4),

				}
			],
			computeTokens,
			{
				...DEFAULT_OPTIONS,
				recentlyViewedDocuments: {
					...DEFAULT_OPTIONS.recentlyViewedDocuments,
					maxTokens: 2000
				},
				pagedClipping: {
					pageSize: 2,
				}
			}
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
});


suite('Paged clipping - current file', () => {

	const opts: CurrentFileOptions = DEFAULT_OPTIONS.currentFile;

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

		const { taggedCurrentFileContent } = createTaggedCurrentFileContentUsingPagedClipping(
			docLines.getLines(),
			areaAroundCodeToEdit,
			new OffsetRange(21, 26),
			computeTokens,
			10,
			{ ...opts, maxTokens: 2000 }
		);

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

		const { taggedCurrentFileContent } = createTaggedCurrentFileContentUsingPagedClipping(
			docLines.getLines(),
			areaAroundCodeToEdit,
			new OffsetRange(21, 26),
			computeTokens,
			10,
			{ ...opts, maxTokens: 20 },
		);

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

		const { taggedCurrentFileContent } = createTaggedCurrentFileContentUsingPagedClipping(
			docLines.getLines(),
			areaAroundCodeToEdit,
			new OffsetRange(10, 14),
			computeTokens,
			10,
			{ ...opts, maxTokens: 50 }
		);

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
