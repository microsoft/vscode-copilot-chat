/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INativeEnvService } from '../../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { TestingServiceCollection } from '../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { FolderRepositoryMRUEntry, IFolderRepositoryManager } from '../../../../chatSessions/common/folderRepositoryManager';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { computeFolderSlug } from '../claudeProjectFolders';
import { ClaudeSessionTitleService } from '../claudeSessionTitleService';

vi.mock('fs/promises', () => ({
	appendFile: vi.fn().mockResolvedValue(undefined),
}));

// #region MockFolderRepositoryManager

class MockFolderRepositoryManager implements IFolderRepositoryManager {
	declare _serviceBrand: undefined;
	private _mruEntries: FolderRepositoryMRUEntry[] = [];

	setMRUEntries(entries: FolderRepositoryMRUEntry[]): void {
		this._mruEntries = entries;
	}

	setUntitledSessionFolder(): void { }
	getUntitledSessionFolder(): undefined { return undefined; }
	deleteUntitledSessionFolder(): void { }
	async getFolderRepository(): Promise<any> { return undefined; }
	async initializeFolderRepository(): Promise<any> { return undefined; }
	async getRepositoryInfo(): Promise<any> { return undefined; }
	getFolderMRU(): FolderRepositoryMRUEntry[] { return this._mruEntries; }
	async deleteMRUEntry(): Promise<void> { }
	getLastUsedFolderIdInUntitledWorkspace(): undefined { return undefined; }
}

// #endregion

describe('ClaudeSessionTitleService', () => {
	const workspaceFolderPath = '/project';
	const folderUri = URI.file(workspaceFolderPath);
	const slug = computeFolderSlug(folderUri);

	let mockFs: MockFileSystemService;
	let testingServiceCollection: TestingServiceCollection;
	let service: ClaudeSessionTitleService;
	let projectDirUri: URI;

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const mockAppendFile = vi.mocked(appendFile);

	beforeEach(() => {
		mockFs = new MockFileSystemService();
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));
		testingServiceCollection.set(IFileSystemService, mockFs);

		const workspaceService = store.add(new TestWorkspaceService([folderUri]));
		testingServiceCollection.set(IWorkspaceService, workspaceService);
		testingServiceCollection.define(IFolderRepositoryManager, new MockFolderRepositoryManager());

		const accessor = testingServiceCollection.createTestingAccessor();
		mockFs = accessor.get(IFileSystemService) as MockFileSystemService;
		const nativeEnvService = accessor.get(INativeEnvService);
		projectDirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', slug);
		service = accessor.get(IInstantiationService).createInstance(ClaudeSessionTitleService);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// #region setTitle

	it('appends a custom-title entry to the session JSONL file', async () => {
		const sessionId = 'abc-session-123';
		const sessionFileUri = URI.joinPath(projectDirUri, `${sessionId}.jsonl`);
		mockFs.mockFile(sessionFileUri, '');

		await service.setTitle(sessionId, 'My New Title');

		const expectedEntry = JSON.stringify({
			type: 'custom-title',
			customTitle: 'My New Title',
			sessionId,
		});
		expect(mockAppendFile).toHaveBeenCalledOnce();
		expect(mockAppendFile).toHaveBeenCalledWith(
			sessionFileUri.fsPath,
			'\n' + expectedEntry,
			{ encoding: 'utf8' }
		);
	});

	it('does not call appendFile when the session file is not found', async () => {
		// No file registered in mockFs — stat will throw ENOENT
		await service.setTitle('nonexistent-session', 'Some Title');

		expect(mockAppendFile).not.toHaveBeenCalled();
	});

	it('handles appendFile errors without throwing', async () => {
		const sessionId = 'error-session';
		const sessionFileUri = URI.joinPath(projectDirUri, `${sessionId}.jsonl`);
		mockFs.mockFile(sessionFileUri, '');
		mockAppendFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));

		// Should not throw
		await expect(service.setTitle(sessionId, 'Title')).resolves.toBeUndefined();
	});

	it('searches all workspace folders in a multi-root workspace', async () => {
		const folderA = URI.file('/project-a');
		const folderB = URI.file('/project-b');
		const slugA = computeFolderSlug(folderA);
		const slugB = computeFolderSlug(folderB);

		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));
		testingServiceCollection.set(IFileSystemService, mockFs);

		const multiRootWorkspace = store.add(new TestWorkspaceService([folderA, folderB]));
		testingServiceCollection.set(IWorkspaceService, multiRootWorkspace);
		testingServiceCollection.define(IFolderRepositoryManager, new MockFolderRepositoryManager());

		const accessor = testingServiceCollection.createTestingAccessor();
		const nativeEnvService = accessor.get(INativeEnvService);
		const multiRootService = accessor.get(IInstantiationService).createInstance(ClaudeSessionTitleService);

		// Session lives in folder B only
		const sessionId = 'multi-root-session';
		const dirBUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', slugB);
		const sessionFileUri = URI.joinPath(dirBUri, `${sessionId}.jsonl`);
		mockFs.mockFile(sessionFileUri, '');

		// Folder A's project dir has no matching session file
		const dirAUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', slugA);
		mockFs.mockError(URI.joinPath(dirAUri, `${sessionId}.jsonl`), Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

		await multiRootService.setTitle(sessionId, 'Multi-Root Title');

		expect(mockAppendFile).toHaveBeenCalledOnce();
		expect(mockAppendFile).toHaveBeenCalledWith(
			sessionFileUri.fsPath,
			expect.stringContaining('"customTitle":"Multi-Root Title"'),
			{ encoding: 'utf8' }
		);
	});

	it('uses the first matching project folder when the session exists in multiple', async () => {
		// Session with the same ID exists in both workspace folders
		const folderA = URI.file('/project-a');
		const folderB = URI.file('/project-b');
		const slugA = computeFolderSlug(folderA);
		const slugB = computeFolderSlug(folderB);

		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));
		testingServiceCollection.set(IFileSystemService, mockFs);

		const multiRootWorkspace = store.add(new TestWorkspaceService([folderA, folderB]));
		testingServiceCollection.set(IWorkspaceService, multiRootWorkspace);
		testingServiceCollection.define(IFolderRepositoryManager, new MockFolderRepositoryManager());

		const accessor = testingServiceCollection.createTestingAccessor();
		const nativeEnvService = accessor.get(INativeEnvService);
		const multiRootService = accessor.get(IInstantiationService).createInstance(ClaudeSessionTitleService);

		const sessionId = 'duplicate-session';
		const dirAUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', slugA);
		const dirBUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', slugB);
		mockFs.mockFile(URI.joinPath(dirAUri, `${sessionId}.jsonl`), '');
		mockFs.mockFile(URI.joinPath(dirBUri, `${sessionId}.jsonl`), '');

		await multiRootService.setTitle(sessionId, 'First Match Title');

		// Should use the first folder (A) and only call appendFile once
		expect(mockAppendFile).toHaveBeenCalledOnce();
		expect(mockAppendFile).toHaveBeenCalledWith(
			URI.joinPath(dirAUri, `${sessionId}.jsonl`).fsPath,
			expect.any(String),
			{ encoding: 'utf8' }
		);
	});

	// #endregion
});
