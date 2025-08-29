/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../../platform/filesystem/common/fileTypes';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { CancellationToken, CancellationTokenSource } from '../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ClaudeCodeSessionLoader } from '../claudeCodeSessionLoader';

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

describe('ClaudeCodeSessionLoader', () => {
	const workspaceFolderPath = '/project';
	const folderUri = URI.file(workspaceFolderPath);
	const slug = computeFolderSlug(folderUri);
	const home = os.homedir();
	const dirUri = URI.joinPath(URI.file(home), '.claude', 'projects', slug);

	let mockFs: MockFsService;
	let testingServiceCollection: ReturnType<typeof createExtensionUnitTestingServices>;
	let loader: ClaudeCodeSessionLoader;

	beforeEach(() => {
		mockFs = new MockFsService();
		testingServiceCollection = createExtensionUnitTestingServices();
		testingServiceCollection.set(IFileSystemService, mockFs as any);

		// Create mock workspace service with the test workspace folder
		const workspaceService = new TestWorkspaceService([folderUri]);
		testingServiceCollection.set(IWorkspaceService, workspaceService);

		const accessor = testingServiceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		loader = instaService.createInstance(ClaudeCodeSessionLoader);
	});

	it('loads 2 sessions from 3 real fixture files', async () => {
		// Setup mock with all 3 real fixture files
		const fileName1 = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fileName2 = 'b02ed4d8-1f00-45cc-949f-3ea63b2dbde2.jsonl';
		const fileName3 = 'c8bcb3a7-8728-4d76-9aae-1cbaf2350114.jsonl';

		const fixturePath1 = path.resolve(__dirname, 'fixtures', fileName1);
		const fixturePath2 = path.resolve(__dirname, 'fixtures', fileName2);
		const fixturePath3 = path.resolve(__dirname, 'fixtures', fileName3);

		const fileContents1 = readFileSync(fixturePath1, 'utf8');
		const fileContents2 = readFileSync(fixturePath2, 'utf8');
		const fileContents3 = readFileSync(fixturePath3, 'utf8');

		mockFs.mockDirectory(dirUri, [
			[fileName1, FileType.File],
			[fileName2, FileType.File],
			[fileName3, FileType.File]
		]);

		mockFs.mockFile(URI.joinPath(dirUri, fileName1), fileContents1, 1000);
		mockFs.mockFile(URI.joinPath(dirUri, fileName2), fileContents2, 2000);
		mockFs.mockFile(URI.joinPath(dirUri, fileName3), fileContents3, 3000);

		const sessions = await loader.getAllSessions(CancellationToken.None);

		expect(sessions).toHaveLength(2);

		expect(sessions.map(s => ({
			id: s.id,
			messages: `${s.messages.length} messages`,
			label: s.label,
			timestamp: s.timestamp.toISOString()
		}))).toMatchInlineSnapshot(`
			[
			  {
			    "id": "553dd2b5-8a53-4fbf-9db2-240632522fe5",
			    "label": "hello session 2",
			    "messages": "2 messages",
			    "timestamp": "2025-08-29T21:42:37.329Z",
			  },
			  {
			    "id": "b02ed4d8-1f00-45cc-949f-3ea63b2dbde2",
			    "label": "VS Code Copilot Chat: Initial Project Setup",
			    "messages": "6 messages",
			    "timestamp": "2025-08-29T21:42:28.431Z",
			  },
			]
		`);
	});

	it('handles empty directory correctly', async () => {
		mockFs.mockDirectory(dirUri, []);

		const sessions = await loader.getAllSessions(CancellationToken.None);

		expect(sessions).toHaveLength(0);
	});

	it('filters out non-jsonl files', async () => {
		const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
		const fileContents = readFileSync(fixturePath, 'utf8');

		mockFs.mockDirectory(dirUri, [
			[fileName, FileType.File],
			['invalid.txt', FileType.File],
			['another-dir', FileType.Directory]
		]);

		mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents);

		const sessions = await loader.getAllSessions(CancellationToken.None);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe('553dd2b5-8a53-4fbf-9db2-240632522fe5');
	});

	it('skips files that fail to read', async () => {
		const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
		const fileContents = readFileSync(fixturePath, 'utf8');

		mockFs.mockDirectory(dirUri, [
			[fileName, FileType.File],
			['broken.jsonl', FileType.File]
		]);

		mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents);
		mockFs.mockError(URI.joinPath(dirUri, 'broken.jsonl'), new Error('File read error'));

		const sessions = await loader.getAllSessions(CancellationToken.None);

		// Should only return the working session
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe('553dd2b5-8a53-4fbf-9db2-240632522fe5');
	});

	it('handles malformed jsonl content gracefully', async () => {
		mockFs.mockDirectory(dirUri, [['malformed.jsonl', FileType.File]]);

		// Mix of valid and invalid JSON lines, but no valid SDK messages with UUIDs
		const malformedContent = [
			'{"type": "summary", "summary": "Test"}', // Valid JSON but not an SDK message
			'{invalid json}', // Invalid JSON
			'{"type": "user", "message": {"role": "user", "content": "test"}}' // Valid JSON but missing uuid
		].join('\n');

		mockFs.mockFile(URI.joinPath(dirUri, 'malformed.jsonl'), malformedContent);

		// Should not throw an error, even with malformed content
		const sessions = await loader.getAllSessions(CancellationToken.None);

		// Should handle partial parsing gracefully - no sessions because no valid SDK messages with UUIDs
		expect(sessions).toHaveLength(0);
	});

	it('handles cancellation correctly', async () => {
		const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
		const fileContents = readFileSync(fixturePath, 'utf8');

		mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
		mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents);

		const tokenSource = new CancellationTokenSource();
		tokenSource.cancel(); // Cancel the token

		const sessions = await loader.getAllSessions(tokenSource.token);

		expect(sessions).toHaveLength(0);
	});
});
