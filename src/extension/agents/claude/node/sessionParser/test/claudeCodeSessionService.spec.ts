/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { INativeEnvService } from '../../../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../../../platform/filesystem/node/test/mockFileSystemService';
import { TestingServiceCollection } from '../../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../../platform/workspace/common/workspaceService';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../util/common/test/testUtils';
import { CancellationToken, CancellationTokenSource } from '../../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { FolderRepositoryMRUEntry, IFolderRepositoryManager } from '../../../../../chatSessions/common/folderRepositoryManager';
import { createExtensionUnitTestingServices } from '../../../../../test/node/services';
import { ClaudeCodeSessionService } from '../claudeCodeSessionService';

function computeFolderSlug(folderUri: URI): string {
	return folderUri.path
		.replace(/^\/([a-z]):/i, (_, driveLetter) => driveLetter.toUpperCase() + '-')
		.replace(/[\/ .]/g, '-');
}

class MockFolderRepositoryManager implements IFolderRepositoryManager {
	declare _serviceBrand: undefined;
	private _mruEntries: FolderRepositoryMRUEntry[] = [];

	setMRUEntries(entries: FolderRepositoryMRUEntry[]): void {
		this._mruEntries = entries;
	}

	setUntitledSessionFolder(): void { }
	getUntitledSessionFolder(): undefined { return undefined; }
	deleteUntitledSessionFolder(): void { }
	async getFolderRepository(): Promise<any> { return { folder: undefined, repository: undefined, worktree: undefined, worktreeProperties: undefined, trusted: undefined }; }
	async initializeFolderRepository(): Promise<any> { return { folder: undefined, repository: undefined, worktree: undefined, worktreeProperties: undefined, trusted: undefined }; }
	async getRepositoryInfo(): Promise<any> { return { repository: undefined, headBranchName: undefined }; }
	getFolderMRU(): FolderRepositoryMRUEntry[] { return this._mruEntries; }
	async deleteMRUEntry(): Promise<void> { }
	getLastUsedFolderIdInUntitledWorkspace(): undefined { return undefined; }
}

describe('ClaudeCodeSessionService', () => {
	const workspaceFolderPath = '/project';
	const folderUri = URI.file(workspaceFolderPath);
	const slug = computeFolderSlug(folderUri);
	let dirUri: URI;

	let mockFs: MockFileSystemService;
	let testingServiceCollection: TestingServiceCollection;
	let service: ClaudeCodeSessionService;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		mockFs = new MockFileSystemService();
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));
		testingServiceCollection.set(IFileSystemService, mockFs);

		// Create mock workspace service with the test workspace folder
		const workspaceService = store.add(new TestWorkspaceService([folderUri]));
		testingServiceCollection.set(IWorkspaceService, workspaceService);
		testingServiceCollection.define(IFolderRepositoryManager, new MockFolderRepositoryManager());

		const accessor = testingServiceCollection.createTestingAccessor();
		mockFs = accessor.get(IFileSystemService) as MockFileSystemService;
		const instaService = accessor.get(IInstantiationService);
		const nativeEnvService = accessor.get(INativeEnvService);
		dirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', slug);
		service = instaService.createInstance(ClaudeCodeSessionService);
	});

	// ========================================================================
	// getAllSessions
	// ========================================================================

	describe('getAllSessions', () => {
		it('handles empty directory correctly', async () => {
			mockFs.mockDirectory(dirUri, []);

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('filters out non-jsonl files', async () => {
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const fileContents = await readFile(fixturePath, 'utf8');

			mockFs.mockDirectory(dirUri, [
				[fileName, FileType.File],
				['invalid.txt', FileType.File],
				['another-dir', FileType.Directory]
			]);

			mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents);

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('553dd2b5-8a53-4fbf-9db2-240632522fe5');
		});

		it('loads sessions from real fixture files', async () => {
			const fileName1 = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fileName2 = 'b02ed4d8-1f00-45cc-949f-3ea63b2dbde2.jsonl';

			const fixturePath1 = path.resolve(__dirname, '../../test/fixtures', fileName1);
			const fixturePath2 = path.resolve(__dirname, '../../test/fixtures', fileName2);

			const fileContents1 = await readFile(fixturePath1, 'utf8');
			const fileContents2 = await readFile(fixturePath2, 'utf8');

			mockFs.mockDirectory(dirUri, [
				[fileName1, FileType.File],
				[fileName2, FileType.File],
			]);

			mockFs.mockFile(URI.joinPath(dirUri, fileName1), fileContents1, 1000);
			mockFs.mockFile(URI.joinPath(dirUri, fileName2), fileContents2, 2000);

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(2);

			const sessionIds = sessions.map(s => s.id).sort();
			expect(sessionIds).toEqual([
				'553dd2b5-8a53-4fbf-9db2-240632522fe5',
				'b02ed4d8-1f00-45cc-949f-3ea63b2dbde2'
			]);

			// All sessions should have the workspace folder name
			for (const session of sessions) {
				expect(session.folderName).toBe('project');
			}
		});

		it('skips files that fail to read', async () => {
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const fileContents = await readFile(fixturePath, 'utf8');

			mockFs.mockDirectory(dirUri, [
				[fileName, FileType.File],
				['broken.jsonl', FileType.File]
			]);

			mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents);
			mockFs.mockError(URI.joinPath(dirUri, 'broken.jsonl'), new Error('File read error'));

			const sessions = await service.getAllSessions(CancellationToken.None);

			// Should only return the working session
			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('553dd2b5-8a53-4fbf-9db2-240632522fe5');
		});

		it('handles cancellation correctly', async () => {
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const fileContents = await readFile(fixturePath, 'utf8');

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents);

			const tokenSource = new CancellationTokenSource();
			tokenSource.cancel(); // Cancel the token

			const sessions = await service.getAllSessions(tokenSource.token);

			expect(sessions).toHaveLength(0);
		});

		it('handles large session files (>5MB) correctly', async () => {
			// Create a large session file by repeating a valid message entry
			const fileName = 'large-session.jsonl';
			const timestamp = new Date().toISOString();

			// Create a base message entry
			const baseMessage = JSON.stringify({
				parentUuid: null,
				sessionId: 'large-session',
				type: 'user',
				message: { role: 'user', content: 'x'.repeat(1000) }, // 1KB per message
				uuid: 'uuid-1',
				timestamp
			});

			// Repeat the message 6000 times to create ~6MB file
			const lines: string[] = [];
			for (let i = 0; i < 6000; i++) {
				const message = JSON.parse(baseMessage);
				message.uuid = `uuid-${i}`;
				if (i > 0) {
					message.parentUuid = `uuid-${i - 1}`;
				}
				lines.push(JSON.stringify(message));
			}

			const largeFileContents = lines.join('\n');
			const fileSizeInMB = Math.round(largeFileContents.length / (1024 * 1024));

			// Verify the file is actually large enough (>5MB)
			expect(fileSizeInMB).toBeGreaterThan(5);

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), largeFileContents, 1000);

			// Should not throw an error for large files
			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('large-session');
		});

		it('handles malformed jsonl content gracefully', async () => {
			mockFs.mockDirectory(dirUri, [['malformed.jsonl', FileType.File]]);

			// Only invalid JSON lines - no valid messages at all
			const malformedContent = [
				'{invalid json}', // Invalid JSON
				'{"random": "object"}', // Valid JSON but not a session entry
				'just some text' // Not JSON at all
			].join('\n');

			mockFs.mockFile(URI.joinPath(dirUri, 'malformed.jsonl'), malformedContent);

			// Should not throw an error, even with malformed content
			const sessions = await service.getAllSessions(CancellationToken.None);

			// No valid sessions should be created from invalid content
			expect(sessions).toHaveLength(0);
		});
	});

	// ========================================================================
	// getSession
	// ========================================================================

	describe('getSession', () => {
		it('returns undefined for non-existent session', async () => {
			mockFs.mockDirectory(dirUri, []);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/non-existent' });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeUndefined();
		});

		it('loads full session with messages', async () => {
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const fileContents = await readFile(fixturePath, 'utf8');

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents, 1000);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/553dd2b5-8a53-4fbf-9db2-240632522fe5' });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.id).toBe('553dd2b5-8a53-4fbf-9db2-240632522fe5');
			expect(session?.messages.length).toBeGreaterThan(0);
			expect(session?.label).toBe('hello session 2');
		});

		it('caches loaded sessions', async () => {
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const fileContents = await readFile(fixturePath, 'utf8');

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents, 1000);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/553dd2b5-8a53-4fbf-9db2-240632522fe5' });

			// First call
			const session1 = await service.getSession(sessionResource, CancellationToken.None);
			expect(session1).toBeDefined();

			// Second call - should use cache (with one stat call for mtime freshness check)
			mockFs.resetStatCallCount();
			const session2 = await service.getSession(sessionResource, CancellationToken.None);

			expect(session2).toBeDefined();
			expect(session2?.id).toBe(session1?.id);
			// Should make exactly one stat call to verify the cached file hasn't changed
			expect(mockFs.getStatCallCount()).toBe(1);
		});
	});

	// ========================================================================
	// Caching
	// ========================================================================

	describe('caching', () => {
		it('caches sessions and uses cache when files are unchanged', async () => {
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const fileContents = await readFile(fixturePath, 'utf8');

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents, 1000);

			// First call - should read from disk
			mockFs.resetStatCallCount();
			const sessions1 = await service.getAllSessions(CancellationToken.None);
			const firstCallStatCount = mockFs.getStatCallCount();

			expect(sessions1).toHaveLength(1);
			expect(sessions1[0].id).toBe('553dd2b5-8a53-4fbf-9db2-240632522fe5');
			expect(sessions1[0].label).toBe('hello session 2');
			expect(firstCallStatCount).toBeGreaterThan(0);

			// Second call - should use cache (no file changes)
			mockFs.resetStatCallCount();
			const sessions2 = await service.getAllSessions(CancellationToken.None);
			const secondCallStatCount = mockFs.getStatCallCount();

			expect(sessions2).toHaveLength(1);
			expect(sessions2[0].id).toBe(sessions1[0].id);
			expect(sessions2[0].label).toBe(sessions1[0].label);
			// Should have made some stat calls to check mtimes for cache validation
			expect(secondCallStatCount).toBeGreaterThan(0);
		});

		it('invalidates cache when file is modified', async () => {
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const originalContents = await readFile(fixturePath, 'utf8');

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), originalContents, 1000);

			// First call
			const sessions1 = await service.getAllSessions(CancellationToken.None);
			expect(sessions1).toHaveLength(1);
			expect(sessions1[0].label).toBe('hello session 2');

			// Modify file by changing the user message content (simulate file modification)
			const modifiedContents = originalContents.replace(
				'hello session 2',
				'modified session message'
			);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), modifiedContents, 2000); // Higher mtime

			// Second call - should detect change and reload
			const sessions2 = await service.getAllSessions(CancellationToken.None);
			expect(sessions2).toHaveLength(1);
			expect(sessions2[0].label).toBe('modified session message');
			expect(sessions2[0].id).toBe('553dd2b5-8a53-4fbf-9db2-240632522fe5'); // Same session ID
		});

		it('invalidates cache when file is deleted', async () => {
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const fileContents = await readFile(fixturePath, 'utf8');

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents, 1000);

			// First call
			const sessions1 = await service.getAllSessions(CancellationToken.None);
			expect(sessions1).toHaveLength(1);

			// Simulate file deletion by updating directory to be empty
			mockFs.mockDirectory(dirUri, []); // Empty directory - file is gone

			// Second call - should detect deletion and return empty array
			const sessions2 = await service.getAllSessions(CancellationToken.None);
			expect(sessions2).toHaveLength(0);
		});

		it('invalidates cache when new file is added', async () => {
			const fileName1 = 'session1.jsonl';
			const fileContents1 = JSON.stringify({
				parentUuid: null,
				sessionId: 'session1',
				type: 'user',
				message: { role: 'user', content: 'first session' },
				uuid: 'uuid1',
				timestamp: new Date().toISOString()
			});

			mockFs.mockDirectory(dirUri, [[fileName1, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName1), fileContents1, 1000);

			// First call - one session
			const sessions1 = await service.getAllSessions(CancellationToken.None);
			expect(sessions1).toHaveLength(1);

			// Add a new file
			const fileName2 = 'session2.jsonl';
			const fileContents2 = JSON.stringify({
				parentUuid: null,
				sessionId: 'session2',
				type: 'user',
				message: { role: 'user', content: 'second session' },
				uuid: 'uuid2',
				timestamp: new Date().toISOString()
			});

			mockFs.mockDirectory(dirUri, [
				[fileName1, FileType.File],
				[fileName2, FileType.File]
			]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName2), fileContents2, 2000);

			// Second call - should detect new file and return both sessions
			const sessions2 = await service.getAllSessions(CancellationToken.None);
			expect(sessions2).toHaveLength(2);

			const sessionIds = sessions2.map(s => s.id).sort();
			expect(sessionIds).toEqual(['session1', 'session2']);
		});
	});

	// ========================================================================
	// Directory Error Handling
	// ========================================================================

	describe('directory read error handling', () => {
		function createErrorWithCode(code: string): Error {
			const error = new Error(`Directory error: ${code}`);
			(error as Error & { code: string }).code = code;
			return error;
		}

		it('returns empty sessions when directory throws ENOENT error', async () => {
			mockFs.mockError(dirUri, createErrorWithCode('ENOENT'));

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('returns empty sessions when directory throws FileNotFound error', async () => {
			mockFs.mockError(dirUri, createErrorWithCode('FileNotFound'));

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('returns empty sessions when directory throws DirectoryNotFound error', async () => {
			mockFs.mockError(dirUri, createErrorWithCode('DirectoryNotFound'));

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('returns empty sessions and logs error for unexpected directory errors', async () => {
			mockFs.mockError(dirUri, createErrorWithCode('EACCES'));

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});
	});

	// ========================================================================
	// Workspace Scenarios
	// ========================================================================

	describe('no-workspace scenario', () => {
		const mruFolder = URI.file('/recent/project');
		const mruSlug = computeFolderSlug(mruFolder);
		let noWorkspaceDirUri: URI;
		let noWorkspaceService: ClaudeCodeSessionService;
		let noWorkspaceMockFs: MockFileSystemService;
		let noWorkspaceFolderManager: MockFolderRepositoryManager;

		beforeEach(() => {
			noWorkspaceMockFs = new MockFileSystemService();
			noWorkspaceFolderManager = new MockFolderRepositoryManager();
			const noWorkspaceTestingServiceCollection = store.add(createExtensionUnitTestingServices(store));
			noWorkspaceTestingServiceCollection.set(IFileSystemService, noWorkspaceMockFs);

			// Create mock workspace service with no workspace folders (empty)
			const emptyWorkspaceService = store.add(new TestWorkspaceService([]));
			noWorkspaceTestingServiceCollection.set(IWorkspaceService, emptyWorkspaceService);
			noWorkspaceTestingServiceCollection.define(IFolderRepositoryManager, noWorkspaceFolderManager);

			// Set up MRU entries so the service can discover sessions
			noWorkspaceFolderManager.setMRUEntries([
				{ folder: mruFolder, repository: undefined, lastAccessed: Date.now(), isUntitledSessionSelection: false },
			]);

			const accessor = noWorkspaceTestingServiceCollection.createTestingAccessor();
			noWorkspaceMockFs = accessor.get(IFileSystemService) as MockFileSystemService;
			const instaService = accessor.get(IInstantiationService);
			const nativeEnvService = accessor.get(INativeEnvService);
			noWorkspaceDirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', mruSlug);
			noWorkspaceService = instaService.createInstance(ClaudeCodeSessionService);
		});

		it('loads sessions from MRU folder directories when there are no workspace folders', async () => {
			const fileName = 'no-workspace-session.jsonl';
			const fileContents = JSON.stringify({
				parentUuid: null,
				sessionId: 'no-workspace-session',
				type: 'user',
				message: { role: 'user', content: 'session without workspace' },
				uuid: 'uuid-no-ws',
				timestamp: new Date().toISOString()
			});

			noWorkspaceMockFs.mockDirectory(noWorkspaceDirUri, [[fileName, FileType.File]]);
			noWorkspaceMockFs.mockFile(URI.joinPath(noWorkspaceDirUri, fileName), fileContents, 1000);

			const sessions = await noWorkspaceService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('no-workspace-session');
			expect(sessions[0].label).toBe('session without workspace');
		});

		it('returns empty array when no MRU entries exist', async () => {
			noWorkspaceFolderManager.setMRUEntries([]);
			const noMruServiceCollection = store.add(createExtensionUnitTestingServices(store));
			noMruServiceCollection.set(IFileSystemService, new MockFileSystemService());
			noMruServiceCollection.set(IWorkspaceService, store.add(new TestWorkspaceService([])));
			noMruServiceCollection.define(IFolderRepositoryManager, noWorkspaceFolderManager);

			const accessor = noMruServiceCollection.createTestingAccessor();
			const noMruService = accessor.get(IInstantiationService).createInstance(ClaudeCodeSessionService);

			const sessions = await noMruService.getAllSessions(CancellationToken.None);
			expect(sessions).toHaveLength(0);
		});

		it('discovers sessions across all MRU folder slugs', async () => {
			const mruFolder2 = URI.file('/another/project');
			const mruSlug2 = computeFolderSlug(mruFolder2);

			noWorkspaceFolderManager.setMRUEntries([
				{ folder: mruFolder, repository: undefined, lastAccessed: Date.now(), isUntitledSessionSelection: false },
				{ folder: mruFolder2, repository: undefined, lastAccessed: Date.now() - 1000, isUntitledSessionSelection: false },
			]);

			const noWorkspaceTestingServiceCollection2 = store.add(createExtensionUnitTestingServices(store));
			const mockFs2 = new MockFileSystemService();
			noWorkspaceTestingServiceCollection2.set(IFileSystemService, mockFs2);
			noWorkspaceTestingServiceCollection2.set(IWorkspaceService, store.add(new TestWorkspaceService([])));
			noWorkspaceTestingServiceCollection2.define(IFolderRepositoryManager, noWorkspaceFolderManager);

			const accessor2 = noWorkspaceTestingServiceCollection2.createTestingAccessor();
			const mockFs2Actual = accessor2.get(IFileSystemService) as MockFileSystemService;
			const nativeEnv2 = accessor2.get(INativeEnvService);
			const dir1 = URI.joinPath(nativeEnv2.userHome, '.claude', 'projects', mruSlug);
			const dir2 = URI.joinPath(nativeEnv2.userHome, '.claude', 'projects', mruSlug2);

			const fileName1 = 'session-mru1.jsonl';
			const fileName2 = 'session-mru2.jsonl';
			mockFs2Actual.mockDirectory(dir1, [[fileName1, FileType.File]]);
			mockFs2Actual.mockFile(URI.joinPath(dir1, fileName1), JSON.stringify({
				parentUuid: null, sessionId: 'session-mru1', type: 'user',
				message: { role: 'user', content: 'from mru 1' }, uuid: 'u1', timestamp: new Date().toISOString()
			}), 1000);
			mockFs2Actual.mockDirectory(dir2, [[fileName2, FileType.File]]);
			mockFs2Actual.mockFile(URI.joinPath(dir2, fileName2), JSON.stringify({
				parentUuid: null, sessionId: 'session-mru2', type: 'user',
				message: { role: 'user', content: 'from mru 2' }, uuid: 'u2', timestamp: new Date().toISOString()
			}), 1000);

			const service2 = accessor2.get(IInstantiationService).createInstance(ClaudeCodeSessionService);
			const sessions = await service2.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(2);
			const ids = sessions.map(s => s.id);
			expect(ids).toContain('session-mru1');
			expect(ids).toContain('session-mru2');

			// Each session should have its respective MRU folder name
			const session1 = sessions.find(s => s.id === 'session-mru1')!;
			const session2 = sessions.find(s => s.id === 'session-mru2')!;
			expect(session1.folderName).toBe('project');
			expect(session2.folderName).toBe('project');
		});
	});

	describe('multi-root workspace scenario', () => {
		const folder1 = URI.file('/project1');
		const folder2 = URI.file('/project2');
		const folder1Slug = computeFolderSlug(folder1);
		const folder2Slug = computeFolderSlug(folder2);
		let folder1DirUri: URI;
		let folder2DirUri: URI;
		let multiRootService: ClaudeCodeSessionService;
		let multiRootMockFs: MockFileSystemService;

		beforeEach(() => {
			multiRootMockFs = new MockFileSystemService();
			const multiRootTestingServiceCollection = store.add(createExtensionUnitTestingServices(store));
			multiRootTestingServiceCollection.set(IFileSystemService, multiRootMockFs);

			// Create mock workspace service with multiple workspace folders
			const multiRootWorkspaceService = store.add(new TestWorkspaceService([folder1, folder2]));
			multiRootTestingServiceCollection.set(IWorkspaceService, multiRootWorkspaceService);
			multiRootTestingServiceCollection.define(IFolderRepositoryManager, new MockFolderRepositoryManager());

			const accessor = multiRootTestingServiceCollection.createTestingAccessor();
			multiRootMockFs = accessor.get(IFileSystemService) as MockFileSystemService;
			const instaService = accessor.get(IInstantiationService);
			const nativeEnvService = accessor.get(INativeEnvService);
			// Multi-root workspaces scan all workspace folder slugs
			folder1DirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', folder1Slug);
			folder2DirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', folder2Slug);
			multiRootService = instaService.createInstance(ClaudeCodeSessionService);
		});

		it('loads sessions from all workspace folder directories for multi-root workspaces', async () => {
			const fileName = 'multi-root-session.jsonl';
			const fileContents = JSON.stringify({
				parentUuid: null,
				sessionId: 'multi-root-session',
				type: 'user',
				message: { role: 'user', content: 'session in multi-root workspace' },
				uuid: 'uuid-multi-root',
				timestamp: new Date().toISOString()
			});

			multiRootMockFs.mockDirectory(folder1DirUri, [[fileName, FileType.File]]);
			multiRootMockFs.mockFile(URI.joinPath(folder1DirUri, fileName), fileContents, 1000);

			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('multi-root-session');
			expect(sessions[0].label).toBe('session in multi-root workspace');
		});

		it('returns empty array when no workspace folder directories exist for multi-root', async () => {
			// Don't mock any directory - simulate non-existent directories

			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('discovers sessions across all workspace folder slugs for multi-root', async () => {
			// Mock sessions in both folder directories
			const fileName1 = 'session-from-folder1.jsonl';
			const fileContents1 = JSON.stringify({
				parentUuid: null,
				sessionId: 'session-from-folder1',
				type: 'user',
				message: { role: 'user', content: 'from folder 1' },
				uuid: 'uuid-folder1',
				timestamp: new Date().toISOString()
			});

			const fileName2 = 'session-from-folder2.jsonl';
			const fileContents2 = JSON.stringify({
				parentUuid: null,
				sessionId: 'session-from-folder2',
				type: 'user',
				message: { role: 'user', content: 'from folder 2' },
				uuid: 'uuid-folder2',
				timestamp: new Date().toISOString()
			});

			multiRootMockFs.mockDirectory(folder1DirUri, [[fileName1, FileType.File]]);
			multiRootMockFs.mockFile(URI.joinPath(folder1DirUri, fileName1), fileContents1, 1000);

			multiRootMockFs.mockDirectory(folder2DirUri, [[fileName2, FileType.File]]);
			multiRootMockFs.mockFile(URI.joinPath(folder2DirUri, fileName2), fileContents2, 1000);

			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(2);
			const ids = sessions.map(s => s.id);
			expect(ids).toContain('session-from-folder1');
			expect(ids).toContain('session-from-folder2');

			// Each session should have its respective folder name
			const session1 = sessions.find(s => s.id === 'session-from-folder1')!;
			const session2 = sessions.find(s => s.id === 'session-from-folder2')!;
			expect(session1.folderName).toBe('project1');
			expect(session2.folderName).toBe('project2');
		});
	});

	describe('workspace with spaces in path', () => {
		const spaceFolderPath = '/Users/test/my project';
		const spaceFolderUri = URI.file(spaceFolderPath);
		const spaceSlug = computeFolderSlug(spaceFolderUri);
		let spaceDirUri: URI;
		let spaceService: ClaudeCodeSessionService;
		let spaceMockFs: MockFileSystemService;

		beforeEach(() => {
			spaceMockFs = new MockFileSystemService();
			const spaceTestingServiceCollection = store.add(createExtensionUnitTestingServices(store));
			spaceTestingServiceCollection.set(IFileSystemService, spaceMockFs);

			const spaceWorkspaceService = store.add(new TestWorkspaceService([spaceFolderUri]));
			spaceTestingServiceCollection.set(IWorkspaceService, spaceWorkspaceService);
			spaceTestingServiceCollection.define(IFolderRepositoryManager, new MockFolderRepositoryManager());

			const accessor = spaceTestingServiceCollection.createTestingAccessor();
			spaceMockFs = accessor.get(IFileSystemService) as MockFileSystemService;
			const instaService = accessor.get(IInstantiationService);
			const nativeEnvService = accessor.get(INativeEnvService);
			spaceDirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', spaceSlug);
			spaceService = instaService.createInstance(ClaudeCodeSessionService);
		});

		it('loads sessions from directory with spaces normalized to dashes', async () => {
			const fileName = 'space-session.jsonl';
			const fileContents = JSON.stringify({
				parentUuid: null,
				sessionId: 'space-session',
				type: 'user',
				message: { role: 'user', content: 'session in space folder' },
				uuid: 'uuid-space',
				timestamp: new Date().toISOString()
			});

			spaceMockFs.mockDirectory(spaceDirUri, [[fileName, FileType.File]]);
			spaceMockFs.mockFile(URI.joinPath(spaceDirUri, fileName), fileContents, 1000);

			const sessions = await spaceService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('space-session');
			// Verify the slug used for the directory has spaces converted to dashes
			expect(spaceSlug).toBe('-Users-test-my-project');
		});
	});

	// ========================================================================
	// Subagent Loading
	// ========================================================================

	describe('subagent loading', () => {
		it('loads subagents for a session when subagent directory exists', async () => {
			const sessionId = 'test-session';
			const fileName = `${sessionId}.jsonl`;

			// Main session file
			const sessionContent = JSON.stringify({
				parentUuid: null,
				sessionId,
				type: 'user',
				message: { role: 'user', content: 'main session' },
				uuid: 'uuid-main',
				timestamp: new Date().toISOString()
			});

			// Subagent file
			const subagentContent = JSON.stringify({
				parentUuid: null,
				sessionId: 'subagent-session',
				type: 'user',
				message: { role: 'user', content: 'subagent task' },
				uuid: 'uuid-subagent',
				timestamp: new Date().toISOString(),
				agentId: 'a139fcf'
			});

			const subagentsDirUri = URI.joinPath(dirUri, sessionId, 'subagents');

			// Mock the directory structure
			mockFs.mockDirectory(dirUri, [
				[fileName, FileType.File],
				[sessionId, FileType.Directory]
			]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), sessionContent, 1000);
			mockFs.mockDirectory(subagentsDirUri, [['agent-a139fcf.jsonl', FileType.File]]);
			mockFs.mockFile(URI.joinPath(subagentsDirUri, 'agent-a139fcf.jsonl'), subagentContent, 1000);

			// First load sessions to populate sessionDirs
			await service.getAllSessions(CancellationToken.None);

			// Then load full session
			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.subagents).toHaveLength(1);
			expect(session?.subagents[0].agentId).toBe('a139fcf');
		});

		it('handles empty subagents directory', async () => {
			const sessionId = 'test-session';
			const fileName = `${sessionId}.jsonl`;

			const sessionContent = JSON.stringify({
				parentUuid: null,
				sessionId,
				type: 'user',
				message: { role: 'user', content: 'main session' },
				uuid: 'uuid-main',
				timestamp: new Date().toISOString()
			});

			const subagentsDirUri = URI.joinPath(dirUri, sessionId, 'subagents');

			mockFs.mockDirectory(dirUri, [
				[fileName, FileType.File],
				[sessionId, FileType.Directory]
			]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), sessionContent, 1000);
			mockFs.mockDirectory(subagentsDirUri, []); // Empty subagents directory

			// First load sessions
			await service.getAllSessions(CancellationToken.None);

			// Then load full session
			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.subagents).toHaveLength(0);
		});

		it('loads subagents from real fixture files', async () => {
			const sessionId = '50a7220d-7250-46f3-b38e-b716ce25032e';
			const fileName = `${sessionId}.jsonl`;
			const fixturePath = path.resolve(__dirname, '../../test/fixtures', fileName);
			const fileContents = await readFile(fixturePath, 'utf8');

			const subagentFixturePath = path.resolve(__dirname, '../../test/fixtures', sessionId, 'subagents', 'agent-a21e2f5.jsonl');
			const subagentContents = await readFile(subagentFixturePath, 'utf8');

			const subagentsDirUri = URI.joinPath(dirUri, sessionId, 'subagents');

			// Mock the directory structure with real fixture data
			mockFs.mockDirectory(dirUri, [
				[fileName, FileType.File],
				[sessionId, FileType.Directory]
			]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents, 1000);
			mockFs.mockDirectory(subagentsDirUri, [['agent-a21e2f5.jsonl', FileType.File]]);
			mockFs.mockFile(URI.joinPath(subagentsDirUri, 'agent-a21e2f5.jsonl'), subagentContents, 1000);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.id).toBe(sessionId);
			expect(session?.messages.length).toBeGreaterThan(0);
			expect(session?.subagents).toHaveLength(1);
			expect(session?.subagents[0].agentId).toBe('a21e2f5');
			expect(session?.subagents[0].messages.length).toBeGreaterThan(0);
		});

		it('filters non-agent files in subagents directory', async () => {
			const sessionId = 'test-session';
			const fileName = `${sessionId}.jsonl`;

			const sessionContent = JSON.stringify({
				parentUuid: null,
				sessionId,
				type: 'user',
				message: { role: 'user', content: 'main session' },
				uuid: 'uuid-main',
				timestamp: new Date().toISOString()
			});

			const validSubagentContent = JSON.stringify({
				parentUuid: null,
				sessionId: 'subagent-session',
				type: 'user',
				message: { role: 'user', content: 'subagent task' },
				uuid: 'uuid-subagent',
				timestamp: new Date().toISOString(),
				agentId: 'abc123'
			});

			const subagentsDirUri = URI.joinPath(dirUri, sessionId, 'subagents');

			mockFs.mockDirectory(dirUri, [
				[fileName, FileType.File],
				[sessionId, FileType.Directory]
			]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), sessionContent, 1000);
			mockFs.mockDirectory(subagentsDirUri, [
				['agent-abc123.jsonl', FileType.File],
				['not-agent.jsonl', FileType.File],
				['agent-.jsonl', FileType.File], // Empty agent ID
				['readme.txt', FileType.File]
			]);
			mockFs.mockFile(URI.joinPath(subagentsDirUri, 'agent-abc123.jsonl'), validSubagentContent, 1000);

			// First load sessions
			await service.getAllSessions(CancellationToken.None);

			// Then load full session
			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.subagents).toHaveLength(1);
			expect(session?.subagents[0].agentId).toBe('abc123');
		});
	});

	// ========================================================================
	// Parse Errors and Stats
	// ========================================================================

	describe('parse errors and stats', () => {
		it('exposes parse errors after loading a session', async () => {
			const sessionId = 'test-session';
			const fileName = `${sessionId}.jsonl`;

			// Content with some valid and some invalid lines
			const content = [
				'{"invalid json',
				JSON.stringify({
					parentUuid: null,
					sessionId,
					type: 'user',
					message: { role: 'user', content: 'valid message' },
					uuid: 'uuid-valid',
					timestamp: new Date().toISOString()
				})
			].join('\n');

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), content, 1000);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			await service.getSession(sessionResource, CancellationToken.None);

			const errors = service.getLastParseErrors();
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0].message).toContain('JSON parse error');
		});

		it('exposes parse stats after loading a session', async () => {
			const sessionId = 'test-session';
			const fileName = `${sessionId}.jsonl`;

			const content = [
				JSON.stringify({
					parentUuid: null,
					sessionId,
					type: 'user',
					message: { role: 'user', content: 'hello' },
					uuid: 'uuid-1',
					timestamp: new Date().toISOString()
				}),
				JSON.stringify({
					parentUuid: 'uuid-1',
					sessionId,
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', stop_sequence: null },
					uuid: 'uuid-2',
					timestamp: new Date().toISOString()
				})
			].join('\n');

			mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
			mockFs.mockFile(URI.joinPath(dirUri, fileName), content, 1000);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			await service.getSession(sessionResource, CancellationToken.None);

			const stats = service.getLastParseStats();
			expect(stats).toBeDefined();
			expect(stats?.chainNodes).toBe(2);
			expect(stats?.totalLines).toBe(2);
		});
	});
});
