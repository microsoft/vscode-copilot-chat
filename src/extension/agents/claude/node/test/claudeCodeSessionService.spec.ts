/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { INativeEnvService } from '../../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { TestingServiceCollection } from '../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { CancellationToken, CancellationTokenSource } from '../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ClaudeCodeSessionService } from '../claudeCodeSessionService';

function computeFolderSlug(folderUri: URI): string {
	return folderUri.path.replace(/\//g, '-');
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

		const accessor = testingServiceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		const nativeEnvService = accessor.get(INativeEnvService);
		dirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', slug);
		service = instaService.createInstance(ClaudeCodeSessionService);
	});

	it('loads 2 sessions from 3 real fixture files', async () => {
		// Setup mock with all 3 real fixture files
		const fileName1 = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fileName2 = 'b02ed4d8-1f00-45cc-949f-3ea63b2dbde2.jsonl';
		const fileName3 = 'c8bcb3a7-8728-4d76-9aae-1cbaf2350114.jsonl';

		const fixturePath1 = path.resolve(__dirname, 'fixtures', fileName1);
		const fixturePath2 = path.resolve(__dirname, 'fixtures', fileName2);
		const fixturePath3 = path.resolve(__dirname, 'fixtures', fileName3);

		const fileContents1 = await readFile(fixturePath1, 'utf8');
		const fileContents2 = await readFile(fixturePath2, 'utf8');
		const fileContents3 = await readFile(fixturePath3, 'utf8');

		mockFs.mockDirectory(dirUri, [
			[fileName1, FileType.File],
			[fileName2, FileType.File],
			[fileName3, FileType.File]
		]);

		mockFs.mockFile(URI.joinPath(dirUri, fileName1), fileContents1, 1000);
		mockFs.mockFile(URI.joinPath(dirUri, fileName2), fileContents2, 2000);
		mockFs.mockFile(URI.joinPath(dirUri, fileName3), fileContents3, 3000);

		const sessions = await service.getAllSessions(CancellationToken.None);

		expect(sessions).toHaveLength(2);

		expect(sessions.map(s => ({
			id: s.id,
			messages: s.messages.map(m => {
				if (m.type === 'user' || m.type === 'assistant') {
					if (typeof m.message.content === 'string') {
						return m.message.content;
					} else {
						return m.message.content.map(c => c.type === 'text' ? c.text : `<${c.type}>`).join('');
					}
				}
			}),
			label: s.label,
			timestamp: s.timestamp.toISOString()
		}))).toMatchInlineSnapshot(`
			[
			  {
			    "id": "553dd2b5-8a53-4fbf-9db2-240632522fe5",
			    "label": "hello session 2",
			    "messages": [
			      "hello session 2",
			      "Hello! I'm ready to help you with your coding tasks in the vscode-copilot-chat project.",
			    ],
			    "timestamp": "2025-08-29T21:42:37.329Z",
			  },
			  {
			    "id": "b02ed4d8-1f00-45cc-949f-3ea63b2dbde2",
			    "label": "VS Code Copilot Chat: Initial Project Setup",
			    "messages": [
			      "hello session 1",
			      "Hello! How can I help you with your VS Code Copilot Chat project today?",
			      "hello session 1 continued",
			      "Hi! I'm ready to continue helping with your VS Code Copilot Chat project. What would you like to work on?",
			      "hello session 1 resumed",
			      "Hello! I see you have the \`claudeCodeSessionLoader.ts\` file open. How can I help you with your VS Code Copilot Chat project?",
			    ],
			    "timestamp": "2025-08-29T21:42:28.431Z",
			  },
			]
		`);
	});

	it('handles empty directory correctly', async () => {
		mockFs.mockDirectory(dirUri, []);

		const sessions = await service.getAllSessions(CancellationToken.None);

		expect(sessions).toHaveLength(0);
	});

	it('filters out non-jsonl files', async () => {
		const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
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

	it('skips files that fail to read', async () => {
		const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
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
		const sessions = await service.getAllSessions(CancellationToken.None);

		// Should handle partial parsing gracefully - no sessions because no valid SDK messages with UUIDs
		expect(sessions).toHaveLength(0);
	});

	it('handles cancellation correctly', async () => {
		const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
		const fileContents = await readFile(fixturePath, 'utf8');

		mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
		mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents);

		const tokenSource = new CancellationTokenSource();
		tokenSource.cancel(); // Cancel the token

		const sessions = await service.getAllSessions(tokenSource.token);

		expect(sessions).toHaveLength(0);
	});

	describe('caching', () => {
		it('caches sessions and uses cache when files are unchanged', async () => {
			// Setup mock with real fixture file
			const fileName = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
			const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
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
			const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
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
			const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
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
});
