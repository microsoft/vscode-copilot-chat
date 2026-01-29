/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
	return folderUri.path
		.replace(/^\/([a-z]):/i, (_, driveLetter) => driveLetter.toUpperCase() + '-')
		.replace(/[\/ .]/g, '-');
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
		mockFs = accessor.get(IFileSystemService) as MockFileSystemService;
		const instaService = accessor.get(IInstantiationService);
		const nativeEnvService = accessor.get(INativeEnvService);
		dirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', slug);
		service = instaService.createInstance(ClaudeCodeSessionService);
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
		// Verify we loaded all messages
		expect(sessions[0].messages).toHaveLength(6000);
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

	it('filters meta user messages and normalizes command content', async () => {
		const fileName = '30530d66-37fb-4f3b-aa5f-d92b6a8afae2.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', fileName);
		const fileContents = await readFile(fixturePath, 'utf8');

		mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
		mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents, 1000);

		const sessions = await service.getAllSessions(CancellationToken.None);

		expect(sessions).toHaveLength(1);

		const session = sessions[0];
		const metaUuid = 'e7f4ab9f-8e19-4262-a430-18d3e48b0c6c';

		expect(session.messages.some(message => message.uuid === metaUuid)).toBe(false);

		const commandUuid = 'a867fb32-ba62-4d51-917c-0fe40fa36067';
		const commandMessage = session.messages.find((message): message is SDKUserMessage => message.uuid === commandUuid && message.type === 'user');
		expect(commandMessage).toBeDefined();
		if (!commandMessage) {
			return;
		}

		const commandContent = commandMessage.message.content;
		expect(typeof commandContent === 'string' ? commandContent : null).toBe('/init is analyzing your codebase…');
		const assistantUuid = '6ed016f4-0df4-4a9f-8c3b-82303b68d29e';
		const assistantMessage = session.messages.find(message => message.uuid === assistantUuid);
		expect((assistantMessage as { readonly parentUuid?: string | null } | undefined)?.parentUuid).toBe(commandUuid);
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

	it('filters out agent-*.jsonl files', async () => {
		const userSessionFile = '553dd2b5-8a53-4fbf-9db2-240632522fe5.jsonl';
		const fixturePath = path.resolve(__dirname, 'fixtures', userSessionFile);
		const fileContents = await readFile(fixturePath, 'utf8');

		// Mock directory with both user session and agent files
		mockFs.mockDirectory(dirUri, [
			[userSessionFile, FileType.File],
			['agent-internal.jsonl', FileType.File],
			['agent-metadata.jsonl', FileType.File]
		]);

		mockFs.mockFile(URI.joinPath(dirUri, userSessionFile), fileContents);
		// Agent files contain internal metadata, not user sessions
		mockFs.mockFile(URI.joinPath(dirUri, 'agent-internal.jsonl'), '{"type":"internal"}');
		mockFs.mockFile(URI.joinPath(dirUri, 'agent-metadata.jsonl'), '{"type":"metadata"}');

		const sessions = await service.getAllSessions(CancellationToken.None);

		// Should only return the user session, not the agent files
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

	it('maintains chain through system messages without message field', async () => {
		// This test verifies that system messages (which don't have a 'message' field)
		// are correctly used for parent chain linking, even though they're filtered from output
		const fileName = 'session-with-system-messages.jsonl';
		const timestamp = new Date().toISOString();

		const fileContents = [
			// First user message (root)
			JSON.stringify({
				parentUuid: null,
				sessionId: 'test-session',
				type: 'user',
				message: { role: 'user', content: 'first message' },
				uuid: 'uuid-user-1',
				timestamp
			}),
			// First assistant message
			JSON.stringify({
				parentUuid: 'uuid-user-1',
				sessionId: 'test-session',
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text: 'first response' }] },
				uuid: 'uuid-assistant-1',
				timestamp
			}),
			// System message WITHOUT 'message' field (this used to break the chain)
			JSON.stringify({
				parentUuid: 'uuid-assistant-1',
				sessionId: 'test-session',
				type: 'system',
				subtype: 'stop_hook_summary',
				hookCount: 1,
				uuid: 'uuid-system-1',
				timestamp
			}),
			// Second user message (child of system message)
			JSON.stringify({
				parentUuid: 'uuid-system-1',
				sessionId: 'test-session',
				type: 'user',
				message: { role: 'user', content: 'second message' },
				uuid: 'uuid-user-2',
				timestamp
			}),
			// Second assistant message
			JSON.stringify({
				parentUuid: 'uuid-user-2',
				sessionId: 'test-session',
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text: 'second response' }] },
				uuid: 'uuid-assistant-2',
				timestamp
			})
		].join('\n');

		mockFs.mockDirectory(dirUri, [[fileName, FileType.File]]);
		mockFs.mockFile(URI.joinPath(dirUri, fileName), fileContents, 1000);

		const sessions = await service.getAllSessions(CancellationToken.None);

		expect(sessions).toHaveLength(1);
		const session = sessions[0];

		// The session should have 4 messages (system message is filtered out as isMeta)
		expect(session.messages).toHaveLength(4);

		// Verify the chain is intact: user1 -> assistant1 -> user2 -> assistant2
		// (system message is used for linking but not included in output)
		expect(session.messages[0].uuid).toBe('uuid-user-1');
		expect(session.messages[1].uuid).toBe('uuid-assistant-1');
		expect(session.messages[2].uuid).toBe('uuid-user-2');
		expect(session.messages[3].uuid).toBe('uuid-assistant-2');

		// Verify message content is preserved
		const userMessage1 = session.messages[0] as SDKUserMessage;
		expect(userMessage1.message.content).toBe('first message');

		const userMessage2 = session.messages[2] as SDKUserMessage;
		expect(userMessage2.message.content).toBe('second message');
	});

	describe('no-workspace scenario', () => {
		let noWorkspaceDirUri: URI;
		let noWorkspaceService: ClaudeCodeSessionService;
		let noWorkspaceMockFs: MockFileSystemService;

		beforeEach(() => {
			noWorkspaceMockFs = new MockFileSystemService();
			const noWorkspaceTestingServiceCollection = store.add(createExtensionUnitTestingServices(store));
			noWorkspaceTestingServiceCollection.set(IFileSystemService, noWorkspaceMockFs);

			// Create mock workspace service with no workspace folders (empty)
			const emptyWorkspaceService = store.add(new TestWorkspaceService([]));
			noWorkspaceTestingServiceCollection.set(IWorkspaceService, emptyWorkspaceService);

			const accessor = noWorkspaceTestingServiceCollection.createTestingAccessor();
			noWorkspaceMockFs = accessor.get(IFileSystemService) as MockFileSystemService;
			const instaService = accessor.get(IInstantiationService);
			const nativeEnvService = accessor.get(INativeEnvService);
			// When there's no workspace, sessions are stored in the '-' directory
			noWorkspaceDirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', '-');
			noWorkspaceService = instaService.createInstance(ClaudeCodeSessionService);
		});

		it('loads sessions from no-project directory when there are no workspace folders', async () => {
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

		it('returns empty array when no-project directory does not exist', async () => {
			// Don't mock any directory - simulate non-existent directory

			const sessions = await noWorkspaceService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});
	});

	describe('multi-root workspace scenario', () => {
		let multiRootDirUri: URI;
		let multiRootService: ClaudeCodeSessionService;
		let multiRootMockFs: MockFileSystemService;

		beforeEach(() => {
			multiRootMockFs = new MockFileSystemService();
			const multiRootTestingServiceCollection = store.add(createExtensionUnitTestingServices(store));
			multiRootTestingServiceCollection.set(IFileSystemService, multiRootMockFs);

			// Create mock workspace service with multiple workspace folders
			const folder1 = URI.file('/project1');
			const folder2 = URI.file('/project2');
			const multiRootWorkspaceService = store.add(new TestWorkspaceService([folder1, folder2]));
			multiRootTestingServiceCollection.set(IWorkspaceService, multiRootWorkspaceService);

			const accessor = multiRootTestingServiceCollection.createTestingAccessor();
			multiRootMockFs = accessor.get(IFileSystemService) as MockFileSystemService;
			const instaService = accessor.get(IInstantiationService);
			const nativeEnvService = accessor.get(INativeEnvService);
			// Multi-root workspaces use the '-' directory (same as no-workspace)
			multiRootDirUri = URI.joinPath(nativeEnvService.userHome, '.claude', 'projects', '-');
			multiRootService = instaService.createInstance(ClaudeCodeSessionService);
		});

		it('loads sessions from no-project directory for multi-root workspaces', async () => {
			const fileName = 'multi-root-session.jsonl';
			const fileContents = JSON.stringify({
				parentUuid: null,
				sessionId: 'multi-root-session',
				type: 'user',
				message: { role: 'user', content: 'session in multi-root workspace' },
				uuid: 'uuid-multi-root',
				timestamp: new Date().toISOString()
			});

			multiRootMockFs.mockDirectory(multiRootDirUri, [[fileName, FileType.File]]);
			multiRootMockFs.mockFile(URI.joinPath(multiRootDirUri, fileName), fileContents, 1000);

			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('multi-root-session');
			expect(sessions[0].label).toBe('session in multi-root workspace');
		});

		it('returns empty array when no-project directory does not exist for multi-root', async () => {
			// Don't mock any directory - simulate non-existent directory

			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('uses dash directory not individual folder slugs for multi-root', async () => {
			// Mock the '-' directory with a session
			const fileName = 'shared-session.jsonl';
			const fileContents = JSON.stringify({
				parentUuid: null,
				sessionId: 'shared-session',
				type: 'user',
				message: { role: 'user', content: 'shared session' },
				uuid: 'uuid-shared',
				timestamp: new Date().toISOString()
			});

			multiRootMockFs.mockDirectory(multiRootDirUri, [[fileName, FileType.File]]);
			multiRootMockFs.mockFile(URI.joinPath(multiRootDirUri, fileName), fileContents, 1000);

			// The session should only come from the '-' directory, not individual folder slugs
			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('shared-session');
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
});