/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ClaudeChatSessionItemProvider } from '../claudeChatSessionItemProvider';

class MockFsService implements Partial<IFileSystemService> {
	private mockDirs = new Map<string, [string, FileType][]>();
	private mockFiles = new Map<string, string>();
	private mockErrors = new Map<string, Error>();
	private mockMtimes = new Map<string, number>();

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

	async stat(uri: URI): Promise<vscode.FileStat> {
		const uriString = uri.toString();
		if (this.mockErrors.has(uriString)) {
			throw this.mockErrors.get(uriString);
		}
		if (this.mockFiles.has(uriString)) {
			const contents = this.mockFiles.get(uriString)!;
			const mtime = this.mockMtimes.get(uriString) ?? Date.now();
			return { type: FileType.File as unknown as vscode.FileType, ctime: Date.now() - 1000, mtime, size: contents.length };
		}
		throw new Error('ENOENT');
	}

	// Required interface methods
	isWritableFileSystem(): boolean | undefined { return true; }
	createFileSystemWatcher(): vscode.FileSystemWatcher { throw new Error('not implemented'); }
}

function computeFolderSlug(folderUri: URI): string {
	return folderUri.path.replace(/\//g, '-');
}

describe('ClaudeChatSessionItemProvider', () => {
	const workspaceFolderPath = '/Users/roblou/code/vscode-copilot-chat';
	const folderUri = URI.file(workspaceFolderPath);
	const slug = computeFolderSlug(folderUri);
	const home = os.homedir();
	const dirUri = URI.joinPath(URI.file(home), '.claude', 'projects', slug);

	let mockFs: MockFsService;
	let testingServiceCollection: ReturnType<typeof createExtensionUnitTestingServices>;
	let provider: ClaudeChatSessionItemProvider;

	beforeEach(() => {
		mockFs = new MockFsService();
		testingServiceCollection = createExtensionUnitTestingServices();
		testingServiceCollection.set(IFileSystemService, mockFs as any);

		// Create mock workspace service with the test workspace folder
		const workspaceService = new TestWorkspaceService([folderUri]);
		testingServiceCollection.set(IWorkspaceService, workspaceService);

		const accessor = testingServiceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		provider = instaService.createInstance(ClaudeChatSessionItemProvider);
	});

	it('lists sessions with summaries from real fixture data', async () => {
		// Setup mock with real fixture data
		const fileName = '123-456.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
		const fileContents = readFileSync(fixturePath, 'utf8');

		mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
		mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents);

		const items = await provider.provideChatSessionItems(CancellationToken.None);

		expect(items).toMatchInlineSnapshot(`
			[
			  {
			    "description": "vscode-copilot-chat",
			    "iconPath": {
			      "id": "star",
			    },
			    "id": "123-456.jsonl",
			    "label": "Vitest Spec Conversion for Repo Test Structure",
			    "tooltip": "Claude Code session",
			  },
			]
		`);
	});

	it('derives label from first user message when no summary available', async () => {
		const errorFileName = 'just-error.jsonl';
		const errorFixturePath = path.resolve(__dirname, 'fixtures', errorFileName);
		const errorFileContents = readFileSync(errorFixturePath, 'utf8');

		mockFs.mockDirectory(dirUri, [[errorFileName, FileType.File]]);
		mockFs.mockFile(URI.joinPath(dirUri, errorFileName), errorFileContents);

		const items = await provider.provideChatSessionItems(CancellationToken.None);

		expect(items).toMatchInlineSnapshot(`
			[
			  {
			    "description": "vscode-copilot-chat",
			    "iconPath": {
			      "id": "star",
			    },
			    "id": "just-error.jsonl",
			    "label": "hey",
			    "tooltip": "Claude Code session",
			  },
			]
		`);
	});

	it('handles multiple sessions correctly', async () => {
		const fileName1 = '123-456.jsonl';
		const fileName2 = 'just-error.jsonl';
		const fixturePath1 = path.resolve(__dirname, 'fixtures', fileName1);
		const fixturePath2 = path.resolve(__dirname, 'fixtures', fileName2);
		const fileContents1 = readFileSync(fixturePath1, 'utf8');
		const fileContents2 = readFileSync(fixturePath2, 'utf8');

		mockFs.mockDirectory(dirUri, [
			[fileName1, FileType.File],
			[fileName2, FileType.File]
		]);
		// Make fileName1 newer (higher mtime) so it appears first in the sorted results
		mockFs.mockFile(URI.joinPath(dirUri, fileName1), fileContents1, 2000);
		mockFs.mockFile(URI.joinPath(dirUri, fileName2), fileContents2, 1000);

		const items = await provider.provideChatSessionItems(CancellationToken.None);

		expect(items).toMatchInlineSnapshot(`
			[
			  {
			    "description": "vscode-copilot-chat",
			    "iconPath": {
			      "id": "star",
			    },
			    "id": "123-456.jsonl",
			    "label": "Vitest Spec Conversion for Repo Test Structure",
			    "tooltip": "Claude Code session",
			  },
			  {
			    "description": "vscode-copilot-chat",
			    "iconPath": {
			      "id": "star",
			    },
			    "id": "just-error.jsonl",
			    "label": "hey",
			    "tooltip": "Claude Code session",
			  },
			]
		`);
	});

	it('filters out sessions that fail to load and logs errors', async () => {
		mockFs.mockDirectory(dirUri, [
			['working.jsonl', FileType.File],
			['broken.jsonl', FileType.File]
		]);

		// Mock one working session
		const workingContents = '{"type":"summary","summary":"Working Session","leafUuid":"working-uuid"}';
		mockFs.mockFile(URI.joinPath(dirUri, 'working.jsonl'), workingContents);

		// Mock one broken session that will fail to read
		mockFs.mockError(URI.joinPath(dirUri, 'broken.jsonl'), new Error('File read error'));

		const items = await provider.provideChatSessionItems(CancellationToken.None);

		// Should only return the working session
		expect(items).toMatchInlineSnapshot(`
			[
			  {
			    "description": "vscode-copilot-chat",
			    "iconPath": {
			      "id": "star",
			    },
			    "id": "working.jsonl",
			    "label": "Working Session",
			    "tooltip": "Claude Code session",
			  },
			]
		`);
	});

	it('throws error when all session loads fail', async () => {
		mockFs.mockDirectory(dirUri, [
			['broken1.jsonl', FileType.File],
			['broken2.jsonl', FileType.File]
		]);

		// Mock all sessions to fail
		mockFs.mockError(URI.joinPath(dirUri, 'broken1.jsonl'), new Error('File read error 1'));
		mockFs.mockError(URI.joinPath(dirUri, 'broken2.jsonl'), new Error('File read error 2'));

		await expect(provider.provideChatSessionItems(CancellationToken.None))
			.rejects.toThrow('[ClaudeChatSessionItemProvider] All session files failed to load in:');
	});

	it('returns empty array when no sessions exist', async () => {
		mockFs.mockDirectory(dirUri, []);

		const items = await provider.provideChatSessionItems(CancellationToken.None);

		expect(items).toMatchInlineSnapshot(`[]`);
	});
});
