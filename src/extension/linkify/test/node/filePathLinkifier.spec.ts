/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { suite, test } from 'vitest';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { URI } from '../../../../util/vs/base/common/uri';
import { Location, Position, Range } from '../../../../vscodeTypes';
import { LinkifyLocationAnchor } from '../../common/linkifiedText';
import { assertPartsEqual, createTestLinkifierService, linkify, workspaceFile } from './util';


suite('File Path Linkifier', () => {

	test(`Should create file links from Markdown links`, async () => {
		const linkifier = createTestLinkifierService(
			'file.ts',
			'src/file.ts'
		);

		assertPartsEqual(
			(await linkify(linkifier,
				'[file.ts](file.ts) [src/file.ts](src/file.ts)',
			)).parts,
			[
				new LinkifyLocationAnchor(workspaceFile('file.ts')),
				` `,
				new LinkifyLocationAnchor(workspaceFile('src/file.ts'))
			],
		);

		assertPartsEqual(
			(await linkify(linkifier,
				'[`file.ts`](file.ts) [`src/file.ts`](src/file.ts)',
			)).parts,
			[
				new LinkifyLocationAnchor(workspaceFile('file.ts')),
				` `,
				new LinkifyLocationAnchor(workspaceFile('src/file.ts'))
			]
		);
	});

	test(`Should create links for directories`, async () => {
		{
			const linkifier = createTestLinkifierService(
				'dir/'
			);
			assertPartsEqual(
				(await linkify(linkifier,
					'[dir](dir) [dir/](dir/)',
				)).parts,
				[
					new LinkifyLocationAnchor(workspaceFile('dir')),
					` `,
					new LinkifyLocationAnchor(workspaceFile('dir/'))
				]
			);
		}
		{
			const linkifier = createTestLinkifierService(
				'dir1/dir2/'
			);
			assertPartsEqual(
				(await linkify(linkifier,
					'[dir1/dir2](dir1/dir2) [dir1/dir2/](dir1/dir2/)',
				)).parts,
				[
					new LinkifyLocationAnchor(workspaceFile('dir1/dir2')),
					` `,
					new LinkifyLocationAnchor(workspaceFile('dir1/dir2/'))
				]
			);
		}
	});

	test(`Should create file links for file paths as inline code`, async () => {
		const linkifier = createTestLinkifierService(
			'file.ts',
			'src/file.ts',
		);
		assertPartsEqual(
			(await linkify(linkifier,
				'`file.ts` `src/file.ts`',
			)).parts,
			[
				new LinkifyLocationAnchor(workspaceFile('file.ts')),
				` `,
				new LinkifyLocationAnchor(workspaceFile('src/file.ts'))
			]
		);
	});

	test(`Should create file paths printed as plain text `, async () => {
		const linkifier = createTestLinkifierService(
			'file.ts',
			'src/file.ts',
		);
		assertPartsEqual(
			(await linkify(linkifier,
				'file.ts src/file.ts'
			)).parts,
			[
				new LinkifyLocationAnchor(workspaceFile('file.ts')),
				` `,
				new LinkifyLocationAnchor(workspaceFile('src/file.ts'))
			]
		);
	});

	test(`Should de-linkify files that don't exist`, async () => {
		const linkifier = createTestLinkifierService();
		assertPartsEqual(
			(await linkify(linkifier,
				'[noSuchFile.ts](noSuchFile.ts) [src/noSuchFile.ts](src/noSuchFile.ts)',
			)).parts,
			[
				'noSuchFile.ts src/noSuchFile.ts'
			],
		);
	});

	test(`Should de-linkify bare file links that haven't been transformed`, async () => {
		const linkifier = createTestLinkifierService(
			'file.ts',
			'src/file.ts',
		);
		assertPartsEqual(
			(await linkify(linkifier,
				'[text](file.ts) [`symbol` foo](src/file.ts)'
			)).parts,
			[
				'text `symbol` foo',
			]
		);
	});

	test(`Should not create links for https links`, async () => {
		const linkifier = createTestLinkifierService();
		assertPartsEqual(
			(await linkify(linkifier,
				'[http://example.com](http://example.com)',
			)).parts,
			[
				'[http://example.com](http://example.com)',
			],
		);
	});

	test(`Should handle file paths with spaces in the name`, async () => {
		const linkifier = createTestLinkifierService(
			`space file.ts`,
			'sub space/space file.ts',
		);

		const result = await linkify(linkifier, [
			'[space file.ts](space%20file.ts)',
			'[sub space/space file.ts](sub%20space/space%20file.ts)',
			'[no such file.ts](no%20such%20file.ts)',
			'[also not.ts](no%20such%20file.ts)',
		].join('\n')
		);
		assertPartsEqual(
			result.parts,
			[
				new LinkifyLocationAnchor(workspaceFile('space file.ts')),
				`\n`,
				new LinkifyLocationAnchor(workspaceFile('sub space/space file.ts')),
				'\nno such file.ts\nalso not.ts',
			]
		);
	});

	test(`Should handle posix style absolute paths`, async () => {
		const isFile = URI.file(isWindows ? 'c:\\foo\\isfile.ts' : '/foo/isfile.ts');
		const noFile = URI.file(isWindows ? 'c:\\foo\\nofile.ts' : '/foo/nofile.ts');
		const linkifier = createTestLinkifierService(
			isFile
		);

		assertPartsEqual(
			(await linkify(linkifier, [
				`\`${isFile.fsPath}\``,
				`\`${noFile.fsPath}\``,
			].join('\n')
			)).parts,
			[
				new LinkifyLocationAnchor(isFile),
				`\n\`${noFile.fsPath}\``,
			]
		);
	});

	test(`Should not linkify some common ambagious short paths`, async () => {
		const linkifier = createTestLinkifierService();
		assertPartsEqual(
			(await linkify(linkifier, [
				'- `.`',
				'- `..`',
				'- `/.`',
				'- `\\.`',
				'- `/..`',
				'- `\\..`',
				'- `/`',
				'- `\\`',
				'- `/`',
				'- `//`',
				'- `///`',
			].join('\n')
			)).parts,
			[
				[
					'- `.`',
					'- `..`',
					'- `/.`',
					'- `\\.`',
					'- `/..`',
					'- `\\..`',
					'- `/`',
					'- `\\`',
					'- `/`',
					'- `//`',
					'- `///`',
				].join('\n')
			]
		);
	});

	test(`Should find file links in bold elements`, async () => {
		const linkifier = createTestLinkifierService(
			'file.ts',
			'src/file.ts'
		);

		assertPartsEqual(
			(await linkify(linkifier,
				'**file.ts**',
			)).parts,
			[
				`**`,
				new LinkifyLocationAnchor(workspaceFile('file.ts')),
				`**`,
			],
		);

		assertPartsEqual(
			(await linkify(linkifier,
				'**`file.ts`**',
			)).parts,
			[
				`**`,
				new LinkifyLocationAnchor(workspaceFile('file.ts')),
				`**`,
			],
		);
	});

	test(`Should create file link with single line annotation`, async () => {
		const linkifier = createTestLinkifierService(
			'inspectdb.py'
		);

		const result = await linkify(linkifier,
			'inspectdb.py (line 340) - The primary usage.'
		);

		assertPartsEqual(
			result.parts,
			[
				new LinkifyLocationAnchor({ uri: workspaceFile('inspectdb.py'), range: new Range(new Position(339, 0), new Position(339, 0)) } as Location),
				' (line 340) - The primary usage.'
			]
		);
	});

	test(`Should create file link with multi line annotation (range)`, async () => {
		const linkifier = createTestLinkifierService(
			'exampleScript.ts'
		);

		const result = await linkify(linkifier,
			'The return statement in exampleScript.ts is located at lines 77–85.'
		);

		assertPartsEqual(
			result.parts,
			[
				'The return statement in ',
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(76, 0), new Position(76, 0)) } as Location),
				' is located at lines 77–85.'
			]
		);
	});

	test(`Should create file link with multi line annotation using various phrases and dash types`, async () => {
		const linkifier = createTestLinkifierService(
			'exampleScript.ts'
		);

		// Test 'found at' with en-dash
		const result1 = await linkify(linkifier,
			'The return statement for the createScenarioFromLogContext function in exampleScript.ts is found at lines 76–82.'
		);
		assertPartsEqual(
			result1.parts,
			[
				'The return statement for the createScenarioFromLogContext function in ',
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(75, 0), new Position(75, 0)) } as Location),
				' is found at lines 76–82.'
			]
		);

		// Test 'is at' with en-dash
		const result2 = await linkify(linkifier,
			'The return statement for the createScenarioFromLogContext function in exampleScript.ts is at lines 76–82.'
		);
		assertPartsEqual(
			result2.parts,
			[
				'The return statement for the createScenarioFromLogContext function in ',
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(75, 0), new Position(75, 0)) } as Location),
				' is at lines 76–82.'
			]
		);

		// Test 'is at' with hyphen
		const result3 = await linkify(linkifier,
			'The return statement for the createScenarioFromLogContext function in exampleScript.ts is at lines 76-83.'
		);
		assertPartsEqual(
			result3.parts,
			[
				'The return statement for the createScenarioFromLogContext function in ',
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(75, 0), new Position(75, 0)) } as Location),
				' is at lines 76-83.'
			]
		);
	});

	test(`Should create file link with parenthesized multi line annotation variant (lines 10-12)`, async () => {
		const linkifier = createTestLinkifierService(
			'exampleScript.ts'
		);

		const result = await linkify(linkifier,
			'exampleScript.ts (lines 10-12) reference'
		);

		assertPartsEqual(
			result.parts,
			[
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(9, 0), new Position(9, 0)) } as Location),
				' (lines 10-12) reference'
			]
		);
	});

	test(`Should create file link with 'on line' prose variant`, async () => {
		const linkifier = createTestLinkifierService(
			'exampleScript.ts'
		);

		const result = await linkify(linkifier,
			'The init logic in exampleScript.ts on line 45.'
		);

		assertPartsEqual(
			result.parts,
			[
				'The init logic in ',
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(44, 0), new Position(44, 0)) } as Location),
				' on line 45.'
			]
		);
	});

	test(`Should create file link with range connectors ('through' and 'to')`, async () => {
		const linkifier = createTestLinkifierService(
			'exampleScript.ts'
		);

		// Test 'through' connector
		const result1 = await linkify(linkifier,
			'exampleScript.ts is at lines 5 through 9.'
		);
		assertPartsEqual(
			result1.parts,
			[
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(4, 0), new Position(4, 0)) } as Location),
				' is at lines 5 through 9.'
			]
		);

		// Test 'to' connector
		const result2 = await linkify(linkifier,
			'This section in exampleScript.ts spans lines 3 to 7.'
		);
		assertPartsEqual(
			result2.parts,
			[
				'This section in ',
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(2, 0), new Position(2, 0)) } as Location),
				' spans lines 3 to 7.'
			]
		);
	});

	test(`Should create file link with 'Ln' shorthand single line`, async () => {
		const linkifier = createTestLinkifierService(
			'exampleScript.ts'
		);

		const result = await linkify(linkifier,
			'Check exampleScript.ts Ln 22 for setup.'
		);

		assertPartsEqual(
			result.parts,
			[
				'Check ',
				new LinkifyLocationAnchor({ uri: workspaceFile('exampleScript.ts'), range: new Range(new Position(21, 0), new Position(21, 0)) } as Location),
				' Ln 22 for setup.'
			]
		);
	});

	test(`Should not create file link for non-annotation word containing 'line' substring (deadline 30)`, async () => {
		const linkifier = createTestLinkifierService(
			'exampleScript.ts'
		);

		const result = await linkify(linkifier,
			'This exampleScript.ts deadline 30 is informational.'
		);

		assertPartsEqual(
			result.parts,
			[
				'This ',
				new LinkifyLocationAnchor(workspaceFile('exampleScript.ts')),
				' deadline 30 is informational.'
			]
		);
	});
});
