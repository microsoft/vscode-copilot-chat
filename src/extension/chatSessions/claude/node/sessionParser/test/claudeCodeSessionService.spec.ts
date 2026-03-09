/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import * as path from 'path';
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { INativeEnvService } from '../../../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../../../platform/filesystem/node/test/mockFileSystemService';
import { ITestingServicesAccessor, TestingServiceCollection } from '../../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../../platform/workspace/common/workspaceService';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../util/common/test/testUtils';
import { CancellationToken, CancellationTokenSource } from '../../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { FolderRepositoryMRUEntry, IFolderRepositoryManager } from '../../../../../chatSessions/common/folderRepositoryManager';
import { createExtensionUnitTestingServices } from '../../../../../test/node/services';
import { IClaudeCodeSdkService } from '../../claudeCodeSdkService';
import { computeFolderSlug } from '../../claudeProjectFolders';
import { MockClaudeCodeSdkService } from '../../test/mockClaudeCodeSdkService';
import { ClaudeCodeSessionService } from '../claudeCodeSessionService';

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
	async getFolderMRU(): Promise<FolderRepositoryMRUEntry[]> { return this._mruEntries; }
	async deleteMRUEntry(): Promise<void> { }
	getLastUsedFolderIdInUntitledWorkspace(): undefined { return undefined; }
}

/**
 * Helper to create a minimal SDKSessionInfo for tests.
 */
function createSessionInfo(overrides: Partial<SDKSessionInfo> & { sessionId: string; summary: string }): SDKSessionInfo {
	return {
		lastModified: Date.now(),
		fileSize: 100,
		...overrides,
	};
}

/**
 * Helper to create a user SessionMessage for tests.
 */
function createUserMessage(uuid: string, sessionId: string, content: string): SessionMessage {
	return {
		type: 'user',
		uuid,
		session_id: sessionId,
		message: { role: 'user', content },
		parent_tool_use_id: null,
	};
}

/**
 * Helper to create an assistant SessionMessage for tests.
 */
function createAssistantMessage(uuid: string, sessionId: string, text: string): SessionMessage {
	return {
		type: 'assistant',
		uuid,
		session_id: sessionId,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text }],
			stop_reason: 'end_turn',
			stop_sequence: null,
		},
		parent_tool_use_id: null,
	};
}

describe('ClaudeCodeSessionService', () => {
	const workspaceFolderPath = '/project';
	const folderUri = URI.file(workspaceFolderPath);
	const slug = computeFolderSlug(folderUri);

	let mockSdk: MockClaudeCodeSdkService;
	let mockFs: MockFileSystemService;
	let testingServiceCollection: TestingServiceCollection;
	let service: ClaudeCodeSessionService;
	let dirUri: URI;
	let accessor: ITestingServicesAccessor;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	beforeEach(() => {
		mockSdk = new MockClaudeCodeSdkService();
		mockFs = new MockFileSystemService();
		testingServiceCollection = store.add(createExtensionUnitTestingServices(store));
		testingServiceCollection.set(IFileSystemService, mockFs);
		testingServiceCollection.define(IClaudeCodeSdkService, mockSdk);

		const workspaceService = store.add(new TestWorkspaceService([folderUri]));
		testingServiceCollection.set(IWorkspaceService, workspaceService);
		testingServiceCollection.define(IFolderRepositoryManager, new MockFolderRepositoryManager());

		accessor = testingServiceCollection.createTestingAccessor();
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
		it('returns empty array when SDK returns no sessions', async () => {
			mockSdk.sessionsToReturn = [];

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('returns sessions from SDK with correct metadata', async () => {
			mockSdk.sessionsToReturn = [
				createSessionInfo({ sessionId: 'session-1', summary: 'Hello world', lastModified: 1000 }),
				createSessionInfo({ sessionId: 'session-2', summary: 'Second session', lastModified: 2000 }),
			];

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(2);
			expect(sessions[0].id).toBe('session-1');
			expect(sessions[0].label).toBe('Hello world');
			expect(sessions[0].created).toBe(1000);
			expect(sessions[0].lastRequestEnded).toBe(1000);
			expect(sessions[0].folderName).toBe('project');

			expect(sessions[1].id).toBe('session-2');
			expect(sessions[1].label).toBe('Second session');
		});

		it('prefers customTitle over summary', async () => {
			mockSdk.sessionsToReturn = [
				createSessionInfo({ sessionId: 'session-1', summary: 'Auto summary', customTitle: 'My Custom Title' }),
			];

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].label).toBe('My Custom Title');
		});

		it('skips sessions with no label', async () => {
			mockSdk.sessionsToReturn = [
				createSessionInfo({ sessionId: 'session-1', summary: '' }),
				createSessionInfo({ sessionId: 'session-2', summary: 'Valid session' }),
			];

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('session-2');
		});

		it('handles cancellation correctly', async () => {
			mockSdk.sessionsToReturn = [
				createSessionInfo({ sessionId: 'session-1', summary: 'Should not appear' }),
			];

			const tokenSource = new CancellationTokenSource();
			tokenSource.cancel();

			const sessions = await service.getAllSessions(tokenSource.token);

			expect(sessions).toHaveLength(0);
		});

		it('handles SDK errors gracefully', async () => {
			// Override listSessions to throw
			mockSdk.listSessions = async () => { throw new Error('SDK error'); };

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('includes folderName from workspace', async () => {
			mockSdk.sessionsToReturn = [
				createSessionInfo({ sessionId: 'session-1', summary: 'test' }),
			];

			const sessions = await service.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].folderName).toBe('project');
		});
	});

	// ========================================================================
	// getSession
	// ========================================================================

	describe('getSession', () => {
		it('returns undefined when SDK returns no messages', async () => {
			// SDK returns empty array for unknown session
			const sessionResource = URI.from({ scheme: 'claude-code', path: '/non-existent' });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeUndefined();
		});

		it('loads session with messages from SDK', async () => {
			const sessionId = 'test-session';
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-1', sessionId, 'hello world'),
				createAssistantMessage('uuid-2', sessionId, 'Hi there!'),
			]);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.id).toBe(sessionId);
			expect(session?.messages.length).toBe(2);
			expect(session?.messages[0].type).toBe('user');
			expect(session?.messages[1].type).toBe('assistant');
		});

		it('derives label from first user message', async () => {
			const sessionId = 'test-session';
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-1', sessionId, 'implement dark mode'),
				createAssistantMessage('uuid-2', sessionId, 'Sure, I can help.'),
			]);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.label).toBe('implement dark mode');
		});

		it('truncates long labels', async () => {
			const sessionId = 'test-session';
			const longMessage = 'This is a very long message that should be truncated because it exceeds fifty characters';
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-1', sessionId, longMessage),
			]);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session!.label.length).toBeLessThanOrEqual(50);
			expect(session!.label).toContain('...');
		});

		it('does not call listSessions when loading a session', async () => {
			const sessionId = 'test-session';
			let listSessionsCalled = false;
			const origListSessions = mockSdk.listSessions.bind(mockSdk);
			mockSdk.listSessions = async (opts) => {
				listSessionsCalled = true;
				return origListSessions(opts);
			};

			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-1', sessionId, 'hello'),
			]);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(listSessionsCalled).toBe(false);
			expect(typeof session?.created).toBe('number');
			expect(typeof session?.lastRequestEnded).toBe('number');
		});

		it('uses cached timestamps from getAllSessions when available', async () => {
			const sessionId = 'test-session';
			const lastModified = 1700000000000;

			// Populate cache via getAllSessions
			mockSdk.sessionsToReturn = [createSessionInfo({ sessionId, summary: 'Test', lastModified })];
			await service.getAllSessions(CancellationToken.None);

			// Now load the session — should use cached lastModified
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-1', sessionId, 'hello'),
			]);
			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.created).toBe(lastModified);
			expect(session?.lastRequestEnded).toBe(lastModified);
			expect(session?.lastRequestStarted).toBe(lastModified);
		});

		it('falls back to Date.now when cache is empty', async () => {
			const sessionId = 'test-session';
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-1', sessionId, 'hello'),
			]);

			const before = Date.now();
			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);
			const after = Date.now();

			expect(session).toBeDefined();
			expect(session!.created).toBeGreaterThanOrEqual(before);
			expect(session!.created).toBeLessThanOrEqual(after);
			expect(session!.lastRequestStarted).toBeUndefined();
			expect(session!.lastRequestEnded).toBeGreaterThanOrEqual(before);
		});

		it('validates message content using schema validators', async () => {
			const sessionId = 'test-session';
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				// Valid user message
				createUserMessage('uuid-1', sessionId, 'valid message'),
				// Invalid message (missing role)
				{
					type: 'user',
					uuid: 'uuid-bad',
					session_id: sessionId,
					message: { content: 'missing role field' },
					parent_tool_use_id: null,
				},
				// Valid assistant message
				createAssistantMessage('uuid-2', sessionId, 'response'),
			]);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			// Only the 2 valid messages should be included
			expect(session?.messages.length).toBe(2);
			expect(session?.messages[0].uuid).toBe('uuid-1');
			expect(session?.messages[1].uuid).toBe('uuid-2');
		});

		it('returns undefined for sessions with only invalid messages', async () => {
			const sessionId = 'test-session';
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				{
					type: 'user',
					uuid: 'uuid-bad',
					session_id: sessionId,
					message: { content: 'missing role field' },
					parent_tool_use_id: null,
				},
			]);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeUndefined();
		});

		it('handles cancellation correctly', async () => {
			const sessionId = 'test-session';
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-1', sessionId, 'hello'),
			]);

			const tokenSource = new CancellationTokenSource();
			tokenSource.cancel();

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, tokenSource.token);

			expect(session).toBeUndefined();
		});
	});

	// ========================================================================
	// Workspace Scenarios
	// ========================================================================

	describe('no-workspace scenario', () => {
		const mruFolder = URI.file('/recent/project');
		let noWorkspaceService: ClaudeCodeSessionService;
		let noWorkspaceMockSdk: MockClaudeCodeSdkService;
		let noWorkspaceFolderManager: MockFolderRepositoryManager;

		beforeEach(() => {
			noWorkspaceMockSdk = new MockClaudeCodeSdkService();
			noWorkspaceFolderManager = new MockFolderRepositoryManager();
			const noWorkspaceTestingServiceCollection = store.add(createExtensionUnitTestingServices(store));
			noWorkspaceTestingServiceCollection.set(IFileSystemService, new MockFileSystemService());
			noWorkspaceTestingServiceCollection.define(IClaudeCodeSdkService, noWorkspaceMockSdk);

			const emptyWorkspaceService = store.add(new TestWorkspaceService([]));
			noWorkspaceTestingServiceCollection.set(IWorkspaceService, emptyWorkspaceService);
			noWorkspaceTestingServiceCollection.define(IFolderRepositoryManager, noWorkspaceFolderManager);

			noWorkspaceFolderManager.setMRUEntries([
				{ folder: mruFolder, repository: undefined, lastAccessed: Date.now(), isUntitledSessionSelection: false },
			]);

			const accessor = noWorkspaceTestingServiceCollection.createTestingAccessor();
			const instaService = accessor.get(IInstantiationService);
			noWorkspaceService = instaService.createInstance(ClaudeCodeSessionService);
		});

		it('loads sessions from MRU folder directories when there are no workspace folders', async () => {
			noWorkspaceMockSdk.sessionsToReturn = [
				createSessionInfo({ sessionId: 'no-workspace-session', summary: 'session without workspace' }),
			];

			const sessions = await noWorkspaceService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe('no-workspace-session');
			expect(sessions[0].label).toBe('session without workspace');
		});

		it('returns empty array when no MRU entries exist', async () => {
			noWorkspaceFolderManager.setMRUEntries([]);
			const noMruServiceCollection = store.add(createExtensionUnitTestingServices(store));
			noMruServiceCollection.set(IFileSystemService, new MockFileSystemService());
			noMruServiceCollection.define(IClaudeCodeSdkService, new MockClaudeCodeSdkService());
			noMruServiceCollection.set(IWorkspaceService, store.add(new TestWorkspaceService([])));
			noMruServiceCollection.define(IFolderRepositoryManager, noWorkspaceFolderManager);

			const accessor = noMruServiceCollection.createTestingAccessor();
			const noMruService = accessor.get(IInstantiationService).createInstance(ClaudeCodeSessionService);

			const sessions = await noMruService.getAllSessions(CancellationToken.None);
			expect(sessions).toHaveLength(0);
		});

		it('discovers sessions across all MRU folder slugs', async () => {
			const mruFolder2 = URI.file('/another/project');

			noWorkspaceFolderManager.setMRUEntries([
				{ folder: mruFolder, repository: undefined, lastAccessed: Date.now(), isUntitledSessionSelection: false },
				{ folder: mruFolder2, repository: undefined, lastAccessed: Date.now() - 1000, isUntitledSessionSelection: false },
			]);

			const mockSdk2 = new MockClaudeCodeSdkService();
			// listSessions is called per folder, but our mock returns all sessions regardless of dir.
			// To simulate per-folder behavior, we set up the mock to return sessions for both calls.
			let callCount = 0;
			mockSdk2.listSessions = async () => {
				callCount++;
				if (callCount === 1) {
					return [createSessionInfo({ sessionId: 'session-mru1', summary: 'from mru 1' })];
				}
				return [createSessionInfo({ sessionId: 'session-mru2', summary: 'from mru 2' })];
			};

			const serviceCollection2 = store.add(createExtensionUnitTestingServices(store));
			serviceCollection2.set(IFileSystemService, new MockFileSystemService());
			serviceCollection2.define(IClaudeCodeSdkService, mockSdk2);
			serviceCollection2.set(IWorkspaceService, store.add(new TestWorkspaceService([])));
			serviceCollection2.define(IFolderRepositoryManager, noWorkspaceFolderManager);

			const accessor2 = serviceCollection2.createTestingAccessor();
			const service2 = accessor2.get(IInstantiationService).createInstance(ClaudeCodeSessionService);
			const sessions = await service2.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(2);
			const ids = sessions.map(s => s.id);
			expect(ids).toContain('session-mru1');
			expect(ids).toContain('session-mru2');
		});
	});

	describe('multi-root workspace scenario', () => {
		const folder1 = URI.file('/project1');
		const folder2 = URI.file('/project2');
		let multiRootService: ClaudeCodeSessionService;
		let multiRootMockSdk: MockClaudeCodeSdkService;

		beforeEach(() => {
			multiRootMockSdk = new MockClaudeCodeSdkService();
			const multiRootTestingServiceCollection = store.add(createExtensionUnitTestingServices(store));
			multiRootTestingServiceCollection.set(IFileSystemService, new MockFileSystemService());
			multiRootTestingServiceCollection.define(IClaudeCodeSdkService, multiRootMockSdk);

			const multiRootWorkspaceService = store.add(new TestWorkspaceService([folder1, folder2]));
			multiRootTestingServiceCollection.set(IWorkspaceService, multiRootWorkspaceService);
			multiRootTestingServiceCollection.define(IFolderRepositoryManager, new MockFolderRepositoryManager());

			const accessor = multiRootTestingServiceCollection.createTestingAccessor();
			const instaService = accessor.get(IInstantiationService);
			multiRootService = instaService.createInstance(ClaudeCodeSessionService);
		});

		it('loads sessions from all workspace folder directories', async () => {
			multiRootMockSdk.sessionsToReturn = [
				createSessionInfo({ sessionId: 'multi-root-session', summary: 'session in multi-root workspace' }),
			];

			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			// The SDK is called per folder, but our mock returns the same sessions for both
			// In production, the SDK filters by dir.
			expect(sessions.length).toBeGreaterThanOrEqual(1);
			const ids = sessions.map(s => s.id);
			expect(ids).toContain('multi-root-session');
		});

		it('returns empty array when SDK returns no sessions', async () => {
			multiRootMockSdk.sessionsToReturn = [];

			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(0);
		});

		it('discovers sessions across all workspace folder slugs', async () => {
			let callCount = 0;
			multiRootMockSdk.listSessions = async () => {
				callCount++;
				if (callCount === 1) {
					return [createSessionInfo({ sessionId: 'session-from-folder1', summary: 'from folder 1' })];
				}
				return [createSessionInfo({ sessionId: 'session-from-folder2', summary: 'from folder 2' })];
			};

			const sessions = await multiRootService.getAllSessions(CancellationToken.None);

			expect(sessions).toHaveLength(2);
			const ids = sessions.map(s => s.id);
			expect(ids).toContain('session-from-folder1');
			expect(ids).toContain('session-from-folder2');

			const session1 = sessions.find(s => s.id === 'session-from-folder1')!;
			const session2 = sessions.find(s => s.id === 'session-from-folder2')!;
			expect(session1.folderName).toBe('project1');
			expect(session2.folderName).toBe('project2');
		});
	});

	// ========================================================================
	// Subagent Loading
	// ========================================================================

	describe('subagent loading', () => {
		it('loads subagents for a session when subagent directory exists', async () => {
			const sessionId = 'test-session';

			// Set up SDK to return messages for main session
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-main', sessionId, 'main session'),
			]);

			// Subagent file on disk
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
			mockFs.mockDirectory(subagentsDirUri, [['agent-a139fcf.jsonl', FileType.File]]);
			mockFs.mockFile(URI.joinPath(subagentsDirUri, 'agent-a139fcf.jsonl'), subagentContent, 1000);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.subagents).toHaveLength(1);
			expect(session?.subagents[0].agentId).toBe('a139fcf');
		});

		it('returns empty subagents when no subagent directory exists', async () => {
			const sessionId = 'test-session';

			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-main', sessionId, 'main session'),
			]);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.subagents).toHaveLength(0);
		});

		it('loads subagents from real fixture files', async () => {
			const sessionId = '50a7220d-7250-46f3-b38e-b716ce25032e';

			// Set up SDK to return messages for main session
			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-main', sessionId, 'main session'),
			]);

			const subagentFixturePath = path.resolve(__dirname, '../../test/fixtures', sessionId, 'subagents', 'agent-a21e2f5.jsonl');
			const subagentContents = await readFile(subagentFixturePath, 'utf8');

			const subagentsDirUri = URI.joinPath(dirUri, sessionId, 'subagents');
			mockFs.mockDirectory(subagentsDirUri, [['agent-a21e2f5.jsonl', FileType.File]]);
			mockFs.mockFile(URI.joinPath(subagentsDirUri, 'agent-a21e2f5.jsonl'), subagentContents, 1000);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.subagents).toHaveLength(1);
			expect(session?.subagents[0].agentId).toBe('a21e2f5');
			expect(session?.subagents[0].messages.length).toBeGreaterThan(0);
		});

		it('filters non-agent files in subagents directory', async () => {
			const sessionId = 'test-session';

			mockSdk.sessionMessagesToReturn.set(sessionId, [
				createUserMessage('uuid-main', sessionId, 'main session'),
			]);

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
			mockFs.mockDirectory(subagentsDirUri, [
				['agent-abc123.jsonl', FileType.File],
				['not-agent.jsonl', FileType.File],
				['agent-.jsonl', FileType.File], // Empty agent ID
				['readme.txt', FileType.File]
			]);
			mockFs.mockFile(URI.joinPath(subagentsDirUri, 'agent-abc123.jsonl'), validSubagentContent, 1000);

			const sessionResource = URI.from({ scheme: 'claude-code', path: '/' + sessionId });
			const session = await service.getSession(sessionResource, CancellationToken.None);

			expect(session).toBeDefined();
			expect(session?.subagents).toHaveLength(1);
			expect(session?.subagents[0].agentId).toBe('abc123');
		});
	});
});

