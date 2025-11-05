/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { suite, test } from 'vitest';
import { Location, Position, Range } from '../../../../vscodeTypes';
import { LinkifyLocationAnchor } from '../../common/linkifiedText';
import { assertPartsEqual, createTestLinkifierService, linkify, workspaceFile } from './util';

suite('Model File Path Linkifier', () => {
	test('Should linkify model generated file references with line range', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[src/file.ts](src/file.ts#L10-12)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(9, 0), new Position(11, 0))));
		assertPartsEqual([anchor], [expected]);
	});

	test('Should linkify single line anchors', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[src/file.ts](src/file.ts#L5)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(4, 0), new Position(4, 0))));
		assertPartsEqual([anchor], [expected]);
	});

	test('Should fallback when text does not match base path', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[other](src/file.ts#L2-3)');
		assertPartsEqual(result.parts, ['[other](src/file.ts#L2-3)']);
	});

	test('Should fallback for invalid anchor syntax', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[src/file.ts](src/file.ts#Lines10-12)');
		assertPartsEqual(result.parts, ['[src/file.ts](src/file.ts#Lines10-12)']);
	});
});
