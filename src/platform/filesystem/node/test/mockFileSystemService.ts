/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FileStat, FileSystemWatcher } from 'vscode';
import { URI } from '../../../../util/vs/base/common/uri';
import { IFileSystemService } from '../../common/fileSystemService';
import { FileType } from '../../common/fileTypes';

export class MockFileSystemService implements IFileSystemService {
	_serviceBrand: undefined;

	private mockDirs = new Map<string, [string, FileType][]>();
	private mockFiles = new Map<string, string>();
	private mockErrors = new Map<string, Error>();
	private mockMtimes = new Map<string, number>();
	private statCalls = 0;

	mockDirectory(uri: URI | string, entries: [string, FileType][]) {
		const uriString = typeof uri === 'string' ? uri : uri.toString();
		this.mockDirs.set(uriString, entries);
	}

	mockFile(uri: URI | string, contents: string, mtime?: number) {
		const uriString = typeof uri === 'string' ? uri : uri.toString();
		this.mockFiles.set(uriString, contents);
		if (mtime !== undefined) {
			this.mockMtimes.set(uriString, mtime);
		}
	}

	mockError(uri: URI | string, error: Error) {
		const uriString = typeof uri === 'string' ? uri : uri.toString();
		this.mockErrors.set(uriString, error);
	}

	getStatCallCount(): number {
		return this.statCalls;
	}

	resetStatCallCount(): void {
		this.statCalls = 0;
	}

	async readDirectory(uri: URI): Promise<[string, FileType][]> {
		const uriString = uri.toString();
		if (this.mockErrors.has(uriString)) {
			throw this.mockErrors.get(uriString);
		}
		return this.mockDirs.get(uriString) || [];
	}

	async readFile(uri: URI): Promise<Uint8Array> {
		const uriString = uri.toString();
		if (this.mockErrors.has(uriString)) {
			throw this.mockErrors.get(uriString);
		}
		const contents = this.mockFiles.get(uriString);
		if (contents === undefined) {
			throw new Error('ENOENT');
		}
		return new TextEncoder().encode(contents);
	}

	async stat(uri: URI): Promise<FileStat> {
		this.statCalls++; // Track stat calls to verify caching
		const uriString = uri.toString();
		if (this.mockErrors.has(uriString)) {
			throw this.mockErrors.get(uriString);
		}
		if (this.mockFiles.has(uriString)) {
			const contents = this.mockFiles.get(uriString)!;
			const mtime = this.mockMtimes.get(uriString) ?? Date.now();
			return { type: FileType.File as unknown as FileType, ctime: Date.now() - 1000, mtime, size: contents.length };
		}
		throw new Error('ENOENT');
	}

	// Required interface methods
	isWritableFileSystem(): boolean | undefined { return true; }
	createFileSystemWatcher(): FileSystemWatcher { throw new Error('not implemented'); }

	createDirectory(uri: URI): Promise<void> {
		throw new Error('Method not implemented.');
	}
	writeFile(uri: URI, content: Uint8Array): Promise<void> {
		throw new Error('Method not implemented.');
	}
	delete(uri: URI, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
		throw new Error('Method not implemented.');
	}
	rename(oldURI: URI, newURI: URI, options?: { overwrite?: boolean }): Promise<void> {
		throw new Error('Method not implemented.');
	}
	copy(source: URI, destination: URI, options?: { overwrite?: boolean }): Promise<void> {
		throw new Error('Method not implemented.');
	}
}