/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { Location, Position, Range } from '../../../../vscodeTypes';
import { LinkifyLocationAnchor } from '../../common/linkifiedText';
import { assertPartsEqual, createTestLinkifierService, linkify, workspaceFile } from './util';

suite('Model File Path Linkifier', () => {
	test('Should linkify model generated file references with line range', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[src/file.ts](src/file.ts#L10-12)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(9, 0), new Position(11, 0))));
		expect(anchor.title).toBe('src/file.ts#L10-L12');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should linkify single line anchors', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[src/file.ts](src/file.ts#L5)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(4, 0), new Position(4, 0))));
		expect(anchor.title).toBe('src/file.ts#L5');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should linkify absolute file paths', async () => {
		const absolutePath = workspaceFile('src/file.ts').fsPath;
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, `[src/file.ts](${absolutePath}#L2)`);
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(1, 0), new Position(1, 0))));
		expect(anchor.title).toBe('src/file.ts#L2');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should decode percent-encoded targets', async () => {
		const service = createTestLinkifierService('space file.ts');
		const result = await linkify(service, '[space file.ts](space%20file.ts#L1)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('space file.ts'), new Range(new Position(0, 0), new Position(0, 0))));
		assertPartsEqual([anchor], [expected]);
	});

	test('Should fallback when text does not match base path and no anchor', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[other](src/file.ts)');
		assertPartsEqual(result.parts, ['other']);
	});

	test('Should linkify descriptive text with anchor', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[Await chat view](src/file.ts#L54)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(53, 0), new Position(53, 0))));
		expect(anchor.title).toBe('src/file.ts#L54');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should fallback for invalid anchor syntax', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[src/file.ts](src/file.ts#Lines10-12)');
		assertPartsEqual(result.parts, ['src/file.ts']);
	});

	test('Should handle backticks in link text', async () => {
		const service = createTestLinkifierService('file.ts');
		const result = await linkify(service, '[`file.ts`](file.ts)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(workspaceFile('file.ts'));
		assertPartsEqual([anchor], [expected]);
	});

	test('Should handle backticks in link text with line anchor', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[`src/file.ts`](src/file.ts#L42)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(41, 0), new Position(41, 0))));
		expect(anchor.title).toBe('src/file.ts#L42');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should handle L123-L456 anchor format with L prefix on end line', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[src/file.ts](src/file.ts#L10-L15)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(9, 0), new Position(14, 0))));
		expect(anchor.title).toBe('src/file.ts#L10-L15');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should handle descriptive text with L123-L456 anchor format', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[Some descriptive text](src/file.ts#L20-L25)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(19, 0), new Position(24, 0))));
		expect(anchor.title).toBe('src/file.ts#L20-L25');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should normalize non-standard L123-456 format to standard L123-L456', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[src/file.ts](src/file.ts#L20-25)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(19, 0), new Position(24, 0))));
		expect(anchor.title).toBe('src/file.ts#L20-L25');
		assertPartsEqual([anchor], [expected]);
	});
});
