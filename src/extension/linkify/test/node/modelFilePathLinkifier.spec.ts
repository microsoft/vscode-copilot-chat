/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { NullEnvService } from '../../../../platform/env/common/nullEnvService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { Location, Position, Range } from '../../../../vscodeTypes';
import { LinkifyLocationAnchor } from '../../common/linkifiedText';
import { LinkifyService } from '../../common/linkifyService';
import { ModelFilePathLinkifier } from '../../common/modelFilePathLinkifier';
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
		// With an invalid anchor, the display text is extracted and the FilePathLinkifier
		// resolves it to a proper link (without the broken anchor range)
		const expected = new LinkifyLocationAnchor(workspaceFile('src/file.ts'));
		assertPartsEqual(result.parts, [expected]);
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

	test('Should handle absolute paths with forward slashes on Windows', async () => {
		const absolutePath = workspaceFile('src/file.ts').fsPath;
		const service = createTestLinkifierService('src/file.ts');
		// Simulate model-generated path with forward slashes (e.g., c:/Repos/...)
		const pathWithForwardSlashes = absolutePath.replace(/\\/g, '/');
		const result = await linkify(service, `[line 67](${pathWithForwardSlashes}#L67)`);
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(66, 0), new Position(66, 0))));
		expect(anchor.title).toBe('src/file.ts#L67');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should NOT linkify when display text looks like filename but does not match target filename', async () => {
		// This tests the case where model hallucinates a link like [nonexistent.ts](existing.ts#L10)
		// The display text "nonexistent.ts" looks like a filename but doesn't match "existing.ts"
		const service = createTestLinkifierService('src/existing.ts');
		const result = await linkify(service, '[nonexistent.ts](src/existing.ts#L10)');
		// Should NOT create a link to the wrong file - just return the display text
		assertPartsEqual(result.parts, ['nonexistent.ts']);
	});

	test('Should linkify when display text filename matches target filename with anchor', async () => {
		// Display text is just the filename, target is full path - should work
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[file.ts](src/file.ts#L10)');
		const anchor = result.parts[0] as LinkifyLocationAnchor;
		const expected = new LinkifyLocationAnchor(new Location(workspaceFile('src/file.ts'), new Range(new Position(9, 0), new Position(9, 0))));
		expect(anchor.title).toBe('src/file.ts#L10');
		assertPartsEqual([anchor], [expected]);
	});

	test('Should return display text instead of broken link for unresolvable Windows backslash paths', async () => {
		// When model generates a link with a Windows-style path that can't be resolved,
		// the display text should be shown instead of a broken markdown link
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[chatWidget.ts:2845](c:\\src\\vscode\\src\\vs\\workbench\\contrib\\chat\\browser\\chatWidget.ts#L2845)');
		// The file doesn't exist in the mock workspace, so resolveTarget returns undefined.
		// The fallback should return just the display text, not the full markdown link.
		assertPartsEqual(result.parts, ['chatWidget.ts:2845']);
	});

	test('Should return display text with backticks for unresolvable Windows paths', async () => {
		const service = createTestLinkifierService('src/file.ts');
		const result = await linkify(service, '[`chatWidget.ts`](c:\\src\\vscode\\src\\vs\\workbench\\contrib\\chat\\browser\\chatWidget.ts#L2845)');
		assertPartsEqual(result.parts, ['`chatWidget.ts`']);
	});
});

suite('Model File Path Linkifier Remote Workspace', () => {
	function createRemoteService(root: URI, files: readonly URI[]): LinkifyService {
		class MockFs implements IFileSystemService {
			readonly _serviceBrand: undefined;
			async stat(resource: URI) {
				if (resource.toString() === root.toString()) {
					return { ctime: 0, mtime: 0, size: 0, type: FileType.Directory };
				}
				const found = files.find(f => f.toString() === resource.toString());
				if (!found) {
					throw new Error('File not found: ' + resource.toString());
				}
				return { ctime: 0, mtime: 0, size: 0, type: found.path.endsWith('/') ? FileType.Directory : FileType.File };
			}
			readDirectory(): Promise<[string, FileType][]> { throw new Error('Not implemented'); }
			createDirectory(): Promise<void> { throw new Error('Not implemented'); }
			readFile(): Promise<Uint8Array> { throw new Error('Not implemented'); }
			writeFile(): Promise<void> { throw new Error('Not implemented'); }
			delete(): Promise<void> { throw new Error('Not implemented'); }
			rename(): Promise<void> { throw new Error('Not implemented'); }
			copy(): Promise<void> { throw new Error('Not implemented'); }
			isWritableFileSystem(): boolean | undefined { return true; }
			createFileSystemWatcher(): any { throw new Error('Not implemented'); }
		}
		const fs = new MockFs();
		const workspaceService = new NullWorkspaceService([root]);
		const service = new LinkifyService(fs, workspaceService, NullEnvService.Instance);
		service.registerGlobalLinkifier({ create: () => new ModelFilePathLinkifier(fs, workspaceService) });
		return service;
	}

	async function remoteLinkify(service: LinkifyService, text: string) {
		const linkifier = service.createLinkifier({ requestId: undefined, references: [] }, []);
		const initial = await linkifier.append(text, CancellationToken.None);
		const flushed = await linkifier.flush(CancellationToken.None);
		return flushed ? [...initial.parts, ...flushed.parts] : initial.parts;
	}

	const remoteRoot = URI.from({ scheme: 'test', authority: 'auth', path: '/home/user/project' });
	const remoteFile = URI.from({ scheme: 'test', authority: 'auth', path: '/home/user/project/src/remote.ts' });

	test('Should map absolute remote path preserving scheme', async () => {
		const service = createRemoteService(remoteRoot, [remoteFile]);
		const parts = await remoteLinkify(service, '[/home/user/project/src/remote.ts](/home/user/project/src/remote.ts)');
		expect(parts.length).toBe(1);
		const anchor = parts[0] as LinkifyLocationAnchor;
		expect(anchor.value.toString()).toBe(remoteFile.toString());
		expect(anchor.title).toBe('src/remote.ts');
	});

	test('Should parse line range anchor on remote absolute path', async () => {
		const service = createRemoteService(remoteRoot, [remoteFile]);
		const parts = await remoteLinkify(service, '[/home/user/project/src/remote.ts](/home/user/project/src/remote.ts#L3-5)');
		expect(parts.length).toBe(1);
		const anchor = parts[0] as LinkifyLocationAnchor;
		// Anchor value is a Location when an anchor is present.
		const location = anchor.value as Location;
		expect(location.uri.toString()).toBe(remoteFile.toString());
		const range = location.range;
		expect(range.start.line).toBe(2);
		expect(range.end.line).toBe(4);
		expect(anchor.title).toBe('src/remote.ts#L3-L5');
	});
});
