/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { suite, test } from 'vitest';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { URI } from '../../../../util/vs/base/common/uri';
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
				'`.`',
				'`..`',
				'`/.`',
				'`\\.`',
				'`/..`',
				'`\\..`',
				'`/`',
				'`\\`',
			].join('\n')
			)).parts,
			[
				[
					'`.`',
					'`..`',
					'`/.`',
					'`\\.`',
					'`/..`',
					'`\\..`',
					'`/`',
					'`\\`',
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
});
