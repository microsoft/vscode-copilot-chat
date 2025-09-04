/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DisposableStore, MutableDisposable } from '../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../util/vs/base/common/path';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IGitExtensionService } from '../../../git/common/gitExtensionService';
import { NullGitExtensionService } from '../../../git/common/nullGitExtensionService';
import { createPlatformServices } from '../../../test/node/services';
import { SelectionPoint } from '../../common/heatmapService';
import { HeatmapServiceImpl } from '../../vscode/heatmapServiceImpl';
import { IFileSystemService } from '../../../filesystem/common/fileSystemService';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { NodeFileSystemService } from '../../../filesystem/node/fileSystemServiceImpl';


suite('HeatmapServiceImpl', () => {

	const scheme = 'heat-test';
	const uri1 = vscode.Uri.from({ scheme, path: '/test1.ts' });
	const uri2 = vscode.Uri.from({ scheme, path: '/test2.ts' });
	const uri3 = vscode.Uri.from({ scheme, path: '/test3.ts' });

	const store = new DisposableStore();
	const fs = new MutableDisposable();
	let instaService: IInstantiationService;

	setup(function () {
		const services = createPlatformServices();
		services.define(IGitExtensionService, new NullGitExtensionService());
		services.define(IFileSystemService, new SyncDescriptor(NodeFileSystemService));
		const accessor = services.createTestingAccessor();

		const memFs = new MemFS();
		fs.value = vscode.workspace.registerFileSystemProvider(scheme, memFs);
		memFs.writeFile(uri1, Buffer.from('Hello\nWorld'), { create: true, overwrite: true });
		memFs.writeFile(uri2, Buffer.from('Sample Text'), { create: true, overwrite: true });
		memFs.writeFile(uri3, Buffer.from('abc'.repeat(100)), { create: true, overwrite: true });

		instaService = accessor.get(IInstantiationService);
		store.add(instaService);
	});

	teardown(async function () {
		store.clear();
		fs.clear();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	async function select(editor: vscode.TextEditor, selection: vscode.Selection) {
		if (editor.selection.isEqual(selection)) {
			return;
		}
		const update = new Promise<void>((resolve) => vscode.window.onDidChangeTextEditorSelection(e => {
			if (e.textEditor === editor) {
				resolve();
			}
		}));
		editor.selection = selection;
		await update;
	}

	function assertOffsets(entries: Map<vscode.TextDocument, SelectionPoint[]>, doc: vscode.TextDocument, expected: number[]) {
		assert.deepStrictEqual(entries.get(doc)?.map(a => a.offset), expected);
	}

	test('basic', async function () {
		const service = instaService.createInstance(HeatmapServiceImpl);
		const entries = await service.getEntries();
		assert.strictEqual(entries.size, 0);
		service.dispose();
	});

	test('selection', async function () {

		const doc = await vscode.workspace.openTextDocument(uri1);
		const edit = await vscode.window.showTextDocument(doc);

		const service = instaService.createInstance(HeatmapServiceImpl);

		await select(edit, new vscode.Selection(1, 0, 1, 0));

		const entries = await service.getEntries();

		assert.strictEqual(entries.size, 1);
		assert.ok(entries.has(doc));
		assert.deepStrictEqual(entries.get(doc)?.map(a => a.offset), [6]);

		service.dispose();
	});

	test('selection contains start and end', async function () {

		const doc = await vscode.workspace.openTextDocument(uri1);
		const edit = await vscode.window.showTextDocument(doc);

		const service = instaService.createInstance(HeatmapServiceImpl);

		await select(edit, new vscode.Selection(1, 0, 1, 4));

		const entries = await service.getEntries();

		assert.strictEqual(entries.size, 1);
		assert.ok(entries.has(doc));
		assert.deepStrictEqual(entries.get(doc)?.map(a => a.offset), [6, 10]);
		service.dispose();
	});

	test('entries are grouped by document', async function () {

		const doc1 = await vscode.workspace.openTextDocument(uri1);
		const editor1 = await vscode.window.showTextDocument(doc1, vscode.ViewColumn.One);

		const doc2 = await vscode.workspace.openTextDocument(uri2);
		const editor2 = await vscode.window.showTextDocument(doc2, vscode.ViewColumn.Two);

		const service = instaService.createInstance(HeatmapServiceImpl);

		await select(editor1, new vscode.Selection(1, 0, 1, 0));
		await select(editor2, new vscode.Selection(1, 4, 1, 5));

		const entries = await service.getEntries();

		assert.strictEqual(entries.size, 2);

		assert.ok(entries.has(doc1));
		assert.ok(entries.has(doc2));

		service.dispose();
	});

	test('selection is capped', async function () {

		const doc = await vscode.workspace.openTextDocument(uri3);
		const editor = await vscode.window.showTextDocument(doc);

		const service = instaService.createInstance(HeatmapServiceImpl);

		for (let i = 0; i < 101; i++) {
			await select(editor, new vscode.Selection(0, 1 + i, 0, 1 + i));
		}

		const entries = await service.getEntries();
		assert.strictEqual(entries.size, 1);
		assert.strictEqual(entries.get(doc)!.length, 68);

		service.dispose();
	});

	test('edits', async function () {

		const service = instaService.createInstance(HeatmapServiceImpl);

		const doc = await vscode.workspace.openTextDocument(uri1);
		const editor = await vscode.window.showTextDocument(doc);


		await select(editor, new vscode.Selection(1, 0, 1, 0));

		const entries = await service.getEntries();
		assert.strictEqual(entries.size, 1);
		assertOffsets(entries, doc, [0, 6]);

		await editor.edit(builder => {
			builder.insert(new vscode.Position(0, 0), 'foo');
		});

		const entries2 = await service.getEntries();
		assert.strictEqual(entries2.size, 1);
		assertOffsets(entries2, doc, [0, 9]);

		await editor.edit(builder => {
			builder.insert(new vscode.Position(1, 4), 'bar');
		});
		const entries3 = await service.getEntries();
		assert.strictEqual(entries3.size, 1);
		assertOffsets(entries3, doc, [0, 9]);

		await select(editor, new vscode.Selection(0, 0, 0, 2));
		assertOffsets(entries3, doc, [0, 9, 0, 2]);

		service.dispose();
	});
});


//#region --- MEM_FS


class File implements vscode.FileStat {

	type: vscode.FileType;
	ctime: number;
	mtime: number;
	size: number;

	name: string;
	data?: Uint8Array;

	constructor(name: string) {
		this.type = vscode.FileType.File;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
	}
}

class Directory implements vscode.FileStat {

	type: vscode.FileType;
	ctime: number;
	mtime: number;
	size: number;

	name: string;
	entries: Map<string, File | Directory>;

	constructor(name: string) {
		this.type = vscode.FileType.Directory;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.entries = new Map();
	}
}

export type Entry = File | Directory;

class MemFS implements vscode.FileSystemProvider {

	root = new Directory('');

	// --- manage file metadata

	stat(uri: vscode.Uri): vscode.FileStat {
		return this._lookup(uri, false);
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		const entry = this._lookupAsDirectory(uri, false);
		const result: [string, vscode.FileType][] = [];
		for (const [name, child] of entry.entries) {
			result.push([name, child.type]);
		}
		return result;
	}

	// --- manage file contents

	readFile(uri: vscode.Uri): Uint8Array {
		const data = this._lookupAsFile(uri, false).data;
		if (data) {
			return data;
		}
		throw vscode.FileSystemError.FileNotFound();
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
		const basename = path.posix.basename(uri.path);
		const parent = this._lookupParentDirectory(uri);
		let entry = parent.entries.get(basename);
		if (entry instanceof Directory) {
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (!entry && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (entry && options.create && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		if (!entry) {
			entry = new File(basename);
			parent.entries.set(basename, entry);
			this._fireSoon({ type: vscode.FileChangeType.Created, uri });
		}
		entry.mtime = Date.now();
		entry.size = content.byteLength;
		entry.data = content;

		this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
	}

	// --- manage files/folders

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {

		if (!options.overwrite && this._lookup(newUri, true)) {
			throw vscode.FileSystemError.FileExists(newUri);
		}

		const entry = this._lookup(oldUri, false);
		const oldParent = this._lookupParentDirectory(oldUri);

		const newParent = this._lookupParentDirectory(newUri);
		const newName = path.posix.basename(newUri.path);

		oldParent.entries.delete(entry.name);
		entry.name = newName;
		newParent.entries.set(newName, entry);

		this._fireSoon(
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri }
		);
	}

	delete(uri: vscode.Uri): void {
		const dirname = uri.with({ path: path.posix.dirname(uri.path) });
		const basename = path.posix.basename(uri.path);
		const parent = this._lookupAsDirectory(dirname, false);
		if (!parent.entries.has(basename)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		parent.entries.delete(basename);
		parent.mtime = Date.now();
		parent.size -= 1;
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted });
	}

	createDirectory(uri: vscode.Uri): void {
		const basename = path.posix.basename(uri.path);
		const dirname = uri.with({ path: path.posix.dirname(uri.path) });
		const parent = this._lookupAsDirectory(dirname, false);

		const entry = new Directory(basename);
		parent.entries.set(entry.name, entry);
		parent.mtime = Date.now();
		parent.size += 1;
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { type: vscode.FileChangeType.Created, uri });
	}

	// --- lookup

	private _lookup(uri: vscode.Uri, silent: false): Entry;
	private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined;
	private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined {
		const parts = uri.path.split('/');
		let entry: Entry = this.root;
		for (const part of parts) {
			if (!part) {
				continue;
			}
			let child: Entry | undefined;
			if (entry instanceof Directory) {
				child = entry.entries.get(part);
			}
			if (!child) {
				if (!silent) {
					throw vscode.FileSystemError.FileNotFound(uri);
				} else {
					return undefined;
				}
			}
			entry = child;
		}
		return entry;
	}

	private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory {
		const entry = this._lookup(uri, silent);
		if (entry instanceof Directory) {
			return entry;
		}
		throw vscode.FileSystemError.FileNotADirectory(uri);
	}

	private _lookupAsFile(uri: vscode.Uri, silent: boolean): File {
		const entry = this._lookup(uri, silent);
		if (entry instanceof File) {
			return entry;
		}
		throw vscode.FileSystemError.FileIsADirectory(uri);
	}

	private _lookupParentDirectory(uri: vscode.Uri): Directory {
		const dirname = uri.with({ path: path.posix.dirname(uri.path) });
		return this._lookupAsDirectory(dirname, false);
	}

	// --- manage file events

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private _bufferedEvents: vscode.FileChangeEvent[] = [];
	private _fireSoonHandle?: TimeoutHandle;

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	watch(_resource: vscode.Uri): vscode.Disposable {
		// ignore, fires for all changes...
		return new vscode.Disposable(() => { });
	}

	private _fireSoon(...events: vscode.FileChangeEvent[]): void {
		this._bufferedEvents.push(...events);

		if (this._fireSoonHandle) {
			clearTimeout(this._fireSoonHandle);
		}

		this._fireSoonHandle = setTimeout(() => {
			this._emitter.fire(this._bufferedEvents);
			this._bufferedEvents.length = 0;
		}, 5);
	}
}
