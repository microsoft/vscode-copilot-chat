/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IGitService, RepoContext } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { LanguageModelTextPart, LanguageModelToolResult2 } from '../../../../vscodeTypes';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { ICopilotCLISessionService } from '../../../agents/copilotcli/node/copilotcliSessionService';
import { MockChatResponseStream } from '../../../test/node/testHelpers';
import type { IToolsService } from '../../../tools/common/toolsService';
import { IChatSessionWorkspaceFolderService } from '../../common/chatSessionWorkspaceFolderService';
import { ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../../common/chatSessionWorktreeService';
import { IFolderRepositoryManager } from '../../common/folderRepositoryManager';
import { CopilotCLIFolderRepositoryManager } from '../folderRepositoryManagerImpl';

/**
 * Fake implementation of IChatSessionWorktreeService for testing.
 */
class FakeChatSessionWorktreeService extends mock<IChatSessionWorktreeService>() {
	private _worktreeProperties = new Map<string, ChatSessionWorktreeProperties>();

	override createWorktree = vi.fn(async (_repositoryPath: vscode.Uri, _stream?: vscode.ChatResponseStream, _baseBranch?: string): Promise<ChatSessionWorktreeProperties | undefined> => {
		return undefined;
	});

	override getWorktreeProperties = vi.fn((sessionId: string | vscode.Uri): ChatSessionWorktreeProperties | undefined => {
		return this._worktreeProperties.get(typeof sessionId === 'string' ? sessionId : sessionId.fsPath);
	});

	override setWorktreeProperties = vi.fn(async (sessionId: string, properties: string | ChatSessionWorktreeProperties): Promise<void> => {
		if (typeof properties === 'string') {
			return;
		}
		this._worktreeProperties.set(sessionId, properties);
	});

	override getWorktreePath = vi.fn((sessionId: string): vscode.Uri | undefined => {
		const props = this._worktreeProperties.get(sessionId);
		return props ? vscode.Uri.file(props.worktreePath) : undefined;
	});

	setTestWorktreeProperties(sessionId: string, properties: ChatSessionWorktreeProperties): void {
		this._worktreeProperties.set(sessionId, properties);
	}
}

/**
 * Fake implementation of IChatSessionWorkspaceFolderService for testing.
 */
class FakeChatSessionWorkspaceFolderService extends mock<IChatSessionWorkspaceFolderService>() {
	private _sessionWorkspaceFolders = new Map<string, vscode.Uri>();
	private _recentFolders: { folder: vscode.Uri; lastAccessTime: number }[] = [];

	override trackSessionWorkspaceFolder = vi.fn(async (sessionId: string, workspaceFolderUri: string): Promise<void> => {
		this._sessionWorkspaceFolders.set(sessionId, vscode.Uri.file(workspaceFolderUri));
	});

	override deleteTrackedWorkspaceFolder = vi.fn(async (sessionId: string): Promise<void> => {
		this._sessionWorkspaceFolders.delete(sessionId);
	});

	override deleteRecentFolder = vi.fn(async (folder: vscode.Uri): Promise<void> => {
		this._recentFolders = this._recentFolders.filter(entry => entry.folder.fsPath !== folder.fsPath);
	});

	override getSessionWorkspaceFolder = vi.fn((sessionId: string): vscode.Uri | undefined => {
		return this._sessionWorkspaceFolders.get(sessionId);
	});

	override getRecentFolders = vi.fn((): { folder: vscode.Uri; lastAccessTime: number }[] => {
		return this._recentFolders;
	});

	setTestRecentFolders(folders: { folder: vscode.Uri; lastAccessTime: number }[]): void {
		this._recentFolders = folders;
	}

	setTestSessionWorkspaceFolder(sessionId: string, folder: vscode.Uri): void {
		this._sessionWorkspaceFolders.set(sessionId, folder);
	}
}

/**
 * Fake implementation of ICopilotCLISessionService for testing.
 */
class FakeCopilotCLISessionService extends mock<ICopilotCLISessionService>() {
	private _sessionWorkingDirs = new Map<string, vscode.Uri>();

	override getSessionWorkingDirectory = vi.fn((sessionId: string): vscode.Uri | undefined => {
		return this._sessionWorkingDirs.get(sessionId);
	});

	setTestSessionWorkingDirectory(sessionId: string, uri: vscode.Uri): void {
		this._sessionWorkingDirs.set(sessionId, uri);
	}
}

/**
 * Fake implementation of IGitService for testing.
 */
class FakeGitService extends mock<IGitService>() {
	private _repositories = new Map<string, RepoContext>();
	private _recentRepositories: { rootUri: vscode.Uri; lastAccessTime: number }[] = [];
	private _activeRepo: RepoContext | undefined;

	override activeRepository = {
		get: () => this._activeRepo
	} as unknown as IGitService['activeRepository'];

	override repositories: RepoContext[] = [];

	override async getRepository(uri: vscode.Uri, _forceOpen?: boolean): Promise<RepoContext | undefined> {
		return this._repositories.get(uri.fsPath);
	}

	override getRecentRepositories = vi.fn((): { rootUri: vscode.Uri; lastAccessTime: number }[] => {
		return this._recentRepositories;
	});

	setTestRepository(uri: vscode.Uri, repo: RepoContext): void {
		this._repositories.set(uri.fsPath, repo);
	}

	setTestRecentRepositories(repos: { rootUri: vscode.Uri; lastAccessTime: number }[]): void {
		this._recentRepositories = repos;
	}

	setTestActiveRepository(repo: RepoContext | undefined): void {
		this._activeRepo = repo;
	}
}

/**
 * Mock workspace service that tracks trust requests.
 */
/**
 * Fake implementation of IToolsService for testing.
 */
class FakeToolsService extends mock<IToolsService>() {
	nextConfirmationButton: string | undefined = undefined;
	override invokeTool = vi.fn(async (name: string, _options: unknown, _token: unknown) => {
		if (name === 'vscode_get_confirmation_with_options') {
			const button = this.nextConfirmationButton;
			if (button !== undefined) {
				return new LanguageModelToolResult2([new LanguageModelTextPart(button)]);
			}
			return new LanguageModelToolResult2([]);
		}
		return new LanguageModelToolResult2([]);
	});
}

/**
 * Mock workspace service that tracks trust requests.
 */
class MockWorkspaceService extends NullWorkspaceService {
	public trustRequests: vscode.Uri[] = [];
	public trustResponse = true;

	constructor(folders: vscode.Uri[] = []) {
		super(folders);
	}

	override async requestResourceTrust(options: { uri: vscode.Uri; message: string }): Promise<boolean> {
		this.trustRequests.push(options.uri);
		return this.trustResponse;
	}
}

/**
 * FakeFolderRepositoryManager for use in other tests.
 * Provides a configurable mock of IFolderRepositoryManager.
 */
export class FakeFolderRepositoryManager extends mock<IFolderRepositoryManager>() {
	private _untitledSessionFolders = new Map<string, vscode.Uri>();
	private _folderRepoInfo = new Map<string, {
		folder: vscode.Uri | undefined;
		repository: vscode.Uri | undefined;
		worktree: vscode.Uri | undefined;
		trusted: boolean | undefined;
		worktreeProperties: ChatSessionWorktreeProperties | undefined;
	}>();

	override setUntitledSessionFolder = vi.fn((sessionId: string, folderUri: vscode.Uri): void => {
		if (!sessionId.startsWith('untitled:') && !sessionId.startsWith('untitled-')) {
			throw new Error(`Cannot set folder for non-untitled session: ${sessionId}`);
		}
		this._untitledSessionFolders.set(sessionId, folderUri);
	});

	override getUntitledSessionFolder = vi.fn((sessionId: string): vscode.Uri | undefined => {
		return this._untitledSessionFolders.get(sessionId);
	});

	override getFolderRepository = vi.fn(async (
		sessionId: string,
		_options: { promptForTrust: true; stream: vscode.ChatResponseStream } | undefined,
		_token: vscode.CancellationToken
	) => {
		const info = this._folderRepoInfo.get(sessionId);
		return info ?? { folder: undefined, repository: undefined, worktree: undefined, trusted: undefined, worktreeProperties: undefined };
	});

	override initializeFolderRepository = vi.fn(async (
		sessionId: string | undefined,
		_options: { stream: vscode.ChatResponseStream; toolInvocationToken: vscode.ChatParticipantToolToken },
		_token: vscode.CancellationToken
	) => {
		const info = sessionId ? this._folderRepoInfo.get(sessionId) : undefined;
		return {
			folder: info?.folder,
			repository: info?.repository,
			worktree: info?.worktree,
			trusted: info?.trusted ?? true,
			worktreeProperties: info?.worktreeProperties
		};
	});

	override getFolderMRU = vi.fn(() => {
		return [];
	});

	override deleteUntitledSessionFolder = vi.fn((sessionId: string): void => {
		this._untitledSessionFolders.delete(sessionId);
	});

	override getRepositoryInfo = vi.fn(async (
		_folder: vscode.Uri,
		_token: vscode.CancellationToken
	) => {
		return { repository: undefined, headBranchName: undefined };
	});

	override getLastUsedFolderIdInUntitledWorkspace = vi.fn((): string | undefined => {
		return undefined;
	});

	setTestFolderRepositoryInfo(sessionId: string, info: {
		folder: vscode.Uri | undefined;
		repository: vscode.Uri | undefined;
		worktree: vscode.Uri | undefined;
		trusted: boolean | undefined;
		worktreeProperties: ChatSessionWorktreeProperties | undefined;
	}): void {
		this._folderRepoInfo.set(sessionId, info);
	}
}

describe('CopilotCLIFolderRepositoryManager', () => {
	const disposables = new DisposableStore();
	let manager: CopilotCLIFolderRepositoryManager;
	let worktreeService: FakeChatSessionWorktreeService;
	let workspaceFolderService: FakeChatSessionWorkspaceFolderService;
	let sessionService: FakeCopilotCLISessionService;
	let gitService: FakeGitService;
	let workspaceService: MockWorkspaceService;
	let logService: ILogService;
	let toolsService: FakeToolsService;
	let fileSystem: MockFileSystemService;

	beforeEach(() => {
		worktreeService = new FakeChatSessionWorktreeService();
		workspaceFolderService = new FakeChatSessionWorkspaceFolderService();
		sessionService = new FakeCopilotCLISessionService();
		gitService = new FakeGitService();
		workspaceService = new MockWorkspaceService([URI.file('/workspace')]);
		logService = new class extends mock<ILogService>() {
			override trace = vi.fn();
			override info = vi.fn();
			override warn = vi.fn();
			override error = vi.fn();
		}();
		toolsService = new FakeToolsService();
		fileSystem = new MockFileSystemService();

		manager = new CopilotCLIFolderRepositoryManager(
			worktreeService,
			workspaceFolderService,
			sessionService,
			gitService,
			workspaceService,
			logService,
			toolsService,
			fileSystem
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		disposables.clear();
	});

	describe('setUntitledSessionFolder', () => {
		it('stores folder for untitled session', () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/my/folder');

			manager.setUntitledSessionFolder(sessionId, folderUri);

			// Should store in memory only - workspace folder tracking happens in initializeFolderRepository
			expect(manager.getUntitledSessionFolder(sessionId)?.fsPath).toBe(vscode.Uri.file('/my/folder').fsPath);
		});

		it('throws error for non-untitled session ID', () => {
			const sessionId = 'cli-123';
			const folderUri = vscode.Uri.file('/my/folder');

			expect(() => manager.setUntitledSessionFolder(sessionId, folderUri))
				.toThrow('Cannot set folder for non-untitled session: cli-123');
		});

		it('accepts session ID starting with untitled-', () => {
			const sessionId = 'untitled-test-456';
			const folderUri = vscode.Uri.file('/another/folder');

			manager.setUntitledSessionFolder(sessionId, folderUri);

			expect(manager.getUntitledSessionFolder(sessionId)?.fsPath).toBe(vscode.Uri.file('/another/folder').fsPath);
		});
	});

	describe('getFolderRepository', () => {
		it('returns folder info from memory for untitled sessions', async () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/my/folder');
			const token = disposables.add(new CancellationTokenSource()).token;

			manager.setUntitledSessionFolder(sessionId, folderUri);

			const result = await manager.getFolderRepository(sessionId, undefined, token);

			expect(result.folder?.fsPath).toBe(vscode.Uri.file('/my/folder').fsPath);
			expect(result.repository).toBeUndefined();
			expect(result.worktree).toBeUndefined();
			expect(result.trusted).toBeUndefined();
		});

		it('returns worktree info for sessions with worktrees', async () => {
			const sessionId = 'cli-123';
			const token = disposables.add(new CancellationTokenSource()).token;

			worktreeService.setTestWorktreeProperties(sessionId, {
				autoCommit: true,
				baseCommit: 'abc123',
				branchName: 'copilot-worktree',
				repositoryPath: '/repo',
				worktreePath: '/repo-worktree',
				version: 1
			});

			const result = await manager.getFolderRepository(sessionId, undefined, token);

			expect(result.folder?.fsPath).toBe(vscode.Uri.file('/repo').fsPath);
			expect(result.repository?.fsPath).toBe(vscode.Uri.file('/repo').fsPath);
			expect(result.worktree?.fsPath).toBe(vscode.Uri.file('/repo-worktree').fsPath);
		});

		it('returns workspace folder for sessions without worktrees', async () => {
			const sessionId = 'cli-456';
			const token = disposables.add(new CancellationTokenSource()).token;
			const folderUri = vscode.Uri.file('/workspace/project');

			workspaceFolderService.setTestSessionWorkspaceFolder(sessionId, folderUri);

			const result = await manager.getFolderRepository(sessionId, undefined, token);

			expect(result.folder?.fsPath).toBe(vscode.Uri.file('/workspace/project').fsPath);
			expect(result.repository).toBeUndefined();
			expect(result.worktree).toBeUndefined();
		});

		it('falls back to CLI session working directory', async () => {
			const sessionId = 'cli-789';
			const token = disposables.add(new CancellationTokenSource()).token;
			const cwdUri = vscode.Uri.file('/terminal/cwd');

			sessionService.setTestSessionWorkingDirectory(sessionId, cwdUri);
			await fileSystem.createDirectory(URI.file('/terminal/cwd'));

			const result = await manager.getFolderRepository(sessionId, undefined, token);

			expect(result.folder?.fsPath).toBe(vscode.Uri.file('/terminal/cwd').fsPath);
		});

		it('prompts for trust when option is set', async () => {
			const sessionId = 'cli-123';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();

			worktreeService.setTestWorktreeProperties(sessionId, {
				autoCommit: true,
				baseCommit: 'abc123',
				branchName: 'copilot-worktree',
				repositoryPath: '/repo',
				worktreePath: '/repo-worktree',
				version: 1
			});

			const result = await manager.getFolderRepository(
				sessionId,
				{ promptForTrust: true, stream },
				token
			);

			expect(result.trusted).toBe(true);
			expect(workspaceService.trustRequests.length).toBe(1);
		});

		it('returns trusted: false when trust denied', async () => {
			const sessionId = 'cli-123';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			workspaceService.trustResponse = false;

			worktreeService.setTestWorktreeProperties(sessionId, {
				autoCommit: true,
				baseCommit: 'abc123',
				branchName: 'copilot-worktree',
				repositoryPath: '/repo',
				worktreePath: '/repo-worktree',
				version: 1
			});

			const result = await manager.getFolderRepository(
				sessionId,
				{ promptForTrust: true, stream },
				token
			);

			expect(result.trusted).toBe(false);
		});

		it('checks trust on repository path, not worktree path', async () => {
			const sessionId = 'cli-123';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();

			worktreeService.setTestWorktreeProperties(sessionId, {
				autoCommit: true,
				baseCommit: 'abc123',
				branchName: 'copilot-worktree',
				repositoryPath: '/original-repo',
				worktreePath: '/worktree-path',
				version: 1
			});

			await manager.getFolderRepository(
				sessionId,
				{ promptForTrust: true, stream },
				token
			);

			// Trust should be checked on repository path, not worktree path
			expect(workspaceService.trustRequests[0].fsPath).toBe(vscode.Uri.file('/original-repo').fsPath);
		});
	});

	describe('initializeFolderRepository', () => {
		const mockToolInvocationToken = {} as vscode.ChatParticipantToolToken;

		it('creates worktree when git repo selected', async () => {
			const sessionId = 'untitled:test-123';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			const folderUri = vscode.Uri.file('/my/repo');

			manager.setUntitledSessionFolder(sessionId, folderUri);
			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository'
			} as RepoContext);

			(worktreeService.createWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
				autoCommit: true,
				baseCommit: 'abc123',
				branchName: 'copilot-worktree',
				repositoryPath: '/my/repo',
				worktreePath: '/my/repo-worktree',
				version: 1
			} satisfies ChatSessionWorktreeProperties);

			const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

			expect(result.worktree?.fsPath).toBe(vscode.Uri.file('/my/repo-worktree').fsPath);
			expect(result.repository?.fsPath).toBe(vscode.Uri.file('/my/repo').fsPath);
			expect(result.trusted).toBe(true);
		});

		it('falls back to folder when worktree creation fails', async () => {
			const sessionId = 'untitled:test-123';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			const folderUri = vscode.Uri.file('/my/repo');

			manager.setUntitledSessionFolder(sessionId, folderUri);
			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository'
			} as RepoContext);

			(worktreeService.createWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

			expect(result.worktree).toBeUndefined();
			expect(result.repository?.fsPath).toBe(vscode.Uri.file('/my/repo').fsPath);
			expect(stream.output.some(o => /failed to create worktree/i.test(o))).toBe(true);
		});

		it('handles workspace folder without git repo', async () => {
			const sessionId = 'untitled:test-123';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			const folderUri = vscode.Uri.file('/plain/folder');

			manager.setUntitledSessionFolder(sessionId, folderUri);
			// No git repo set for this folder

			const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

			expect(result.folder?.fsPath).toBe(vscode.Uri.file('/plain/folder').fsPath);
			expect(result.repository).toBeUndefined();
			expect(result.worktree).toBeUndefined();
			expect(result.trusted).toBe(true);
		});

		it('returns trusted: false when trust denied', async () => {
			const sessionId = 'untitled:test-123';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			const folderUri = vscode.Uri.file('/my/repo');
			workspaceService.trustResponse = false;

			// Use empty workspace to trigger trust check
			workspaceService = new MockWorkspaceService([]);
			workspaceService.trustResponse = false;
			manager = new CopilotCLIFolderRepositoryManager(
				worktreeService,
				workspaceFolderService,
				sessionService,
				gitService,
				workspaceService,
				logService,
				toolsService,
				new MockFileSystemService()
			);

			manager.setUntitledSessionFolder(sessionId, folderUri);

			const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

			expect(result.trusted).toBe(false);
		});
	});

	describe('getFolderMRU', () => {
		it('combines data from all sources', async () => {
			gitService.setTestRecentRepositories([
				{ rootUri: vscode.Uri.file('/repo1'), lastAccessTime: 1000 },
				{ rootUri: vscode.Uri.file('/repo2'), lastAccessTime: 2000 }
			]);
			workspaceFolderService.setTestRecentFolders([
				{ folder: vscode.Uri.file('/folder1'), lastAccessTime: 1500 }
			]);

			const result = manager.getFolderMRU();

			// Should have items from both sources
			expect(result.length).toBeGreaterThan(0);
		});

		it('deduplicates entries', async () => {
			const duplicateUri = vscode.Uri.file('/same/path');
			gitService.setTestRecentRepositories([
				{ rootUri: duplicateUri, lastAccessTime: 1000 }
			]);
			workspaceFolderService.setTestRecentFolders([
				{ folder: duplicateUri, lastAccessTime: 2000 }
			]);

			const result = manager.getFolderMRU();

			// Should only have one entry for the duplicate path
			const paths = result.map(r => r.folder.fsPath);
			const uniquePaths = [...new Set(paths)];
			expect(paths.length).toBe(uniquePaths.length);
		});

		it('sorts by last access time descending', async () => {
			gitService.setTestRecentRepositories([
				{ rootUri: vscode.Uri.file('/old'), lastAccessTime: 1000 },
				{ rootUri: vscode.Uri.file('/new'), lastAccessTime: 3000 },
				{ rootUri: vscode.Uri.file('/middle'), lastAccessTime: 2000 }
			]);

			const result = manager.getFolderMRU();

			expect(result[0].folder.fsPath).toBe(vscode.Uri.file('/new').fsPath);
			expect(result[1].folder.fsPath).toBe(vscode.Uri.file('/middle').fsPath);
			expect(result[2].folder.fsPath).toBe(vscode.Uri.file('/old').fsPath);
		});
	});

	describe('deleteUntitledSessionFolder', () => {
		it('clears in-memory tracking for session', () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/my/folder');

			manager.setUntitledSessionFolder(sessionId, folderUri);
			expect(manager.getUntitledSessionFolder(sessionId)).toBeDefined();

			manager.deleteUntitledSessionFolder(sessionId);

			expect(manager.getUntitledSessionFolder(sessionId)).toBeUndefined();
		});
	});

	describe('deleteMRUEntry', () => {
		it('removes entry from untitled session folders', async () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/my/folder');

			manager.setUntitledSessionFolder(sessionId, folderUri);
			expect(manager.getUntitledSessionFolder(sessionId)).toBeDefined();

			await manager.deleteMRUEntry(folderUri);

			expect(manager.getUntitledSessionFolder(sessionId)).toBeUndefined();
		});

		it('removes entry from workspace folder service', async () => {
			const folderUri = vscode.Uri.file('/workspace/folder');

			workspaceFolderService.setTestRecentFolders([
				{ folder: folderUri, lastAccessTime: Date.now() }
			]);

			// Verify it's there before deletion
			const result = manager.getFolderMRU();
			expect(result.length).toBeGreaterThan(0);

			await manager.deleteMRUEntry(folderUri);

			// Verify deleteRecentFolder was called on workspace folder service
			expect((workspaceFolderService.deleteRecentFolder as any).mock.calls.length).toBe(1);
		});

		it('handles URI equality comparison', async () => {
			const folderPath = '/my/folder';
			const sessionId = 'untitled:test-456';

			manager.setUntitledSessionFolder(sessionId, vscode.Uri.file(folderPath));

			// Delete using a different URI instance with same path
			await manager.deleteMRUEntry(vscode.Uri.file(folderPath));

			expect(manager.getUntitledSessionFolder(sessionId)).toBeUndefined();
		});

		it('removes all matching entries', async () => {
			const folderUri = vscode.Uri.file('/duplicate/folder');
			const session1 = 'untitled:dup-1';
			const session2 = 'untitled:dup-2';

			manager.setUntitledSessionFolder(session1, folderUri);
			manager.setUntitledSessionFolder(session2, folderUri);

			await manager.deleteMRUEntry(folderUri);

			expect(manager.getUntitledSessionFolder(session1)).toBeUndefined();
			expect(manager.getUntitledSessionFolder(session2)).toBeUndefined();
		});

		it('does not affect other folders when deleting one', async () => {
			const folder1 = vscode.Uri.file('/folder/1');
			const folder2 = vscode.Uri.file('/folder/2');
			const session1 = 'untitled:test-1';
			const session2 = 'untitled:test-2';

			manager.setUntitledSessionFolder(session1, folder1);
			manager.setUntitledSessionFolder(session2, folder2);

			await manager.deleteMRUEntry(folder1);

			expect(manager.getUntitledSessionFolder(session1)).toBeUndefined();
			expect(manager.getUntitledSessionFolder(session2)).toBeDefined();
		});

		it('handles non-existent folder deletion gracefully', async () => {
			const nonExistentUri = vscode.Uri.file('/non/existent/path');

			// Should not throw
			await expect(manager.deleteMRUEntry(nonExistentUri)).resolves.toBeUndefined();
		});

		it('deduplicates after deletion from untitled session folders', async () => {
			const folderUri = vscode.Uri.file('/my/folder');

			manager.setUntitledSessionFolder('untitled:1', folderUri);
			manager.setUntitledSessionFolder('untitled:2', folderUri);

			let mru = manager.getFolderMRU();
			const beforeCount = mru.filter(entry => entry.folder.fsPath === folderUri.fsPath).length;

			await manager.deleteMRUEntry(folderUri);

			mru = manager.getFolderMRU();
			const afterCount = mru.filter(entry => entry.folder.fsPath === folderUri.fsPath).length;

			expect(afterCount).toBeLessThan(beforeCount);
		});
	});

	describe('uncommitted changes prompting in initializeFolderRepository', () => {
		const mockToolInvocationToken = {} as vscode.ChatParticipantToolToken;

		it('prompts when untitled session has repo with index changes', async () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/my/repo');
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			toolsService.nextConfirmationButton = 'Copy Changes';

			manager.setUntitledSessionFolder(sessionId, folderUri);
			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository',
				changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [], mergeChanges: [], untrackedChanges: [] }
			} as unknown as RepoContext);

			await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);
			expect(toolsService.invokeTool).toHaveBeenCalledWith(
				'vscode_get_confirmation_with_options',
				expect.objectContaining({ input: expect.objectContaining({ title: 'Uncommitted Changes' }) }),
				token
			);
		});

		it('prompts when untitled session has repo with working tree changes', async () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/my/repo');
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			toolsService.nextConfirmationButton = 'Copy Changes';

			manager.setUntitledSessionFolder(sessionId, folderUri);
			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository',
				changes: { indexChanges: [], workingTree: [{ path: 'file.ts' }], mergeChanges: [], untrackedChanges: [] }
			} as unknown as RepoContext);

			await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);
			expect(toolsService.invokeTool).toHaveBeenCalled();
		});

		it('does not prompt when untitled session has repo with no changes', async () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/my/repo');
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();

			manager.setUntitledSessionFolder(sessionId, folderUri);
			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository',
				changes: { indexChanges: [], workingTree: [], mergeChanges: [], untrackedChanges: [] }
			} as unknown as RepoContext);

			await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);
			expect(toolsService.invokeTool).not.toHaveBeenCalled();
		});

		it('does not prompt when untitled session folder has no git repo', async () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/plain/folder');
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();

			manager.setUntitledSessionFolder(sessionId, folderUri);

			await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);
			expect(toolsService.invokeTool).not.toHaveBeenCalled();
		});

		it('returns cancelled when user cancels', async () => {
			const sessionId = 'untitled:test-123';
			const folderUri = vscode.Uri.file('/my/repo');
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			toolsService.nextConfirmationButton = 'Cancel';

			manager.setUntitledSessionFolder(sessionId, folderUri);
			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository',
				changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [], mergeChanges: [], untrackedChanges: [] }
			} as unknown as RepoContext);

			const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);
			expect(result.cancelled).toBe(true);
		});

		it('uses delegation title when no session ID', async () => {
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			toolsService.nextConfirmationButton = 'Copy Changes';

			gitService.setTestActiveRepository({
				rootUri: vscode.Uri.file('/workspace'),
				kind: 'repository',
				changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [], mergeChanges: [], untrackedChanges: [] }
			} as unknown as RepoContext);

			await manager.initializeFolderRepository(undefined, { stream, toolInvocationToken: mockToolInvocationToken }, token);
			expect(toolsService.invokeTool).toHaveBeenCalledWith(
				'vscode_get_confirmation_with_options',
				expect.objectContaining({ input: expect.objectContaining({ title: 'Delegate to Background Agent' }) }),
				token
			);
		});

		it('does not prompt for delegation without active repository', async () => {
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();

			await manager.initializeFolderRepository(undefined, { stream, toolInvocationToken: mockToolInvocationToken }, token);
			expect(toolsService.invokeTool).not.toHaveBeenCalled();
		});

		it('does not prompt for delegation in welcome view (no workspace folders)', async () => {
			workspaceService = new MockWorkspaceService([]);
			manager = new CopilotCLIFolderRepositoryManager(
				worktreeService,
				workspaceFolderService,
				sessionService,
				gitService,
				workspaceService,
				logService,
				toolsService,
				new MockFileSystemService()
			);
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			toolsService.nextConfirmationButton = 'Copy Changes';

			gitService.setTestActiveRepository({
				rootUri: vscode.Uri.file('/workspace'),
				kind: 'repository',
				changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [], mergeChanges: [], untrackedChanges: [] }
			} as unknown as RepoContext);

			await manager.initializeFolderRepository(undefined, { stream, toolInvocationToken: mockToolInvocationToken }, token);
			expect(toolsService.invokeTool).not.toHaveBeenCalled();
		});
	});

	describe('worktree folder opened as workspace folder', () => {
		const mockToolInvocationToken = {} as vscode.ChatParticipantToolToken;
		const worktreeFolderPath = '/repo-worktree';
		const originalRepoPath = '/original-repo';
		const defaultWorktreeProps: ChatSessionWorktreeProperties = {
			autoCommit: true,
			baseCommit: 'abc123',
			branchName: 'copilot-worktree',
			repositoryPath: originalRepoPath,
			worktreePath: worktreeFolderPath,
			version: 1
		};

		describe('initializeFolderRepository', () => {
			it('skips worktree creation when single workspace folder is already a tracked worktree', async () => {
				workspaceService = new MockWorkspaceService([URI.file(worktreeFolderPath)]);
				gitService.setTestActiveRepository({
					rootUri: vscode.Uri.file(worktreeFolderPath),
					kind: 'repository'
				} as RepoContext);
				worktreeService.setTestWorktreeProperties(vscode.Uri.file(worktreeFolderPath).fsPath, defaultWorktreeProps);
				manager = new CopilotCLIFolderRepositoryManager(
					worktreeService, workspaceFolderService, sessionService,
					gitService, workspaceService, logService, toolsService,
					new MockFileSystemService()
				);

				const sessionId = 'untitled:wt-test-1';
				const token = disposables.add(new CancellationTokenSource()).token;
				const stream = new MockChatResponseStream();

				const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

				expect(worktreeService.createWorktree).not.toHaveBeenCalled();
				expect(result.worktreeProperties).toBeDefined();
				expect(result.worktree?.fsPath).toBe(vscode.Uri.file(worktreeFolderPath).fsPath);
				expect(result.repository?.fsPath).toBe(vscode.Uri.file(originalRepoPath).fsPath);
				expect(result.trusted).toBe(true);
			});

			it('skips worktree creation when explicitly selected folder is a tracked worktree', async () => {
				worktreeService.setTestWorktreeProperties(vscode.Uri.file(worktreeFolderPath).fsPath, defaultWorktreeProps);

				const sessionId = 'untitled:wt-test-2';
				const token = disposables.add(new CancellationTokenSource()).token;
				const stream = new MockChatResponseStream();

				manager.setUntitledSessionFolder(sessionId, vscode.Uri.file(worktreeFolderPath));

				const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

				expect(worktreeService.createWorktree).not.toHaveBeenCalled();
				expect(result.worktreeProperties).toBeDefined();
				expect(result.worktree?.fsPath).toBe(vscode.Uri.file(worktreeFolderPath).fsPath);
				expect(result.repository?.fsPath).toBe(vscode.Uri.file(originalRepoPath).fsPath);
				expect(result.trusted).toBe(true);
			});

			it('skips uncommitted changes prompt when worktree already detected via single workspace folder', async () => {
				workspaceService = new MockWorkspaceService([URI.file(worktreeFolderPath)]);
				gitService.setTestActiveRepository({
					rootUri: vscode.Uri.file(worktreeFolderPath),
					kind: 'repository',
					changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [{ path: 'other.ts' }], mergeChanges: [], untrackedChanges: [] }
				} as unknown as RepoContext);
				worktreeService.setTestWorktreeProperties(vscode.Uri.file(worktreeFolderPath).fsPath, defaultWorktreeProps);
				manager = new CopilotCLIFolderRepositoryManager(
					worktreeService, workspaceFolderService, sessionService,
					gitService, workspaceService, logService, toolsService,
					new MockFileSystemService()
				);

				const sessionId = 'untitled:wt-test-3';
				const token = disposables.add(new CancellationTokenSource()).token;
				const stream = new MockChatResponseStream();

				await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

				expect(toolsService.invokeTool).not.toHaveBeenCalled();
				expect(worktreeService.createWorktree).not.toHaveBeenCalled();
			});

			it('skips uncommitted changes prompt when worktree already detected via explicit selection', async () => {
				worktreeService.setTestWorktreeProperties(vscode.Uri.file(worktreeFolderPath).fsPath, defaultWorktreeProps);
				gitService.setTestRepository(vscode.Uri.file(worktreeFolderPath), {
					rootUri: vscode.Uri.file(worktreeFolderPath),
					kind: 'repository',
					changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [{ path: 'other.ts' }], mergeChanges: [], untrackedChanges: [] }
				} as unknown as RepoContext);

				const sessionId = 'untitled:wt-test-4';
				const token = disposables.add(new CancellationTokenSource()).token;
				const stream = new MockChatResponseStream();

				manager.setUntitledSessionFolder(sessionId, vscode.Uri.file(worktreeFolderPath));

				await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

				expect(toolsService.invokeTool).not.toHaveBeenCalled();
				expect(worktreeService.createWorktree).not.toHaveBeenCalled();
			});

			it('resolves repository path from worktree properties instead of git service', async () => {
				const differentRepo = '/different-repo';
				worktreeService.setTestWorktreeProperties(vscode.Uri.file(worktreeFolderPath).fsPath, defaultWorktreeProps);
				// Git service would return a different repo for this folder
				gitService.setTestRepository(vscode.Uri.file(worktreeFolderPath), {
					rootUri: vscode.Uri.file(differentRepo),
					kind: 'repository'
				} as RepoContext);

				const sessionId = 'untitled:wt-test-5';
				const token = disposables.add(new CancellationTokenSource()).token;
				const stream = new MockChatResponseStream();

				manager.setUntitledSessionFolder(sessionId, vscode.Uri.file(worktreeFolderPath));

				const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

				// Should use repositoryPath from worktreeProperties, not from git service
				expect(result.repository?.fsPath).toBe(vscode.Uri.file(originalRepoPath).fsPath);
			});

			it('verifies trust on original repository path from worktree properties', async () => {
				workspaceService = new MockWorkspaceService([URI.file(worktreeFolderPath)]);
				workspaceService.trustResponse = false;
				gitService.setTestActiveRepository({
					rootUri: vscode.Uri.file(worktreeFolderPath),
					kind: 'repository'
				} as RepoContext);
				worktreeService.setTestWorktreeProperties(vscode.Uri.file(worktreeFolderPath).fsPath, defaultWorktreeProps);
				manager = new CopilotCLIFolderRepositoryManager(
					worktreeService, workspaceFolderService, sessionService,
					gitService, workspaceService, logService, toolsService,
					new MockFileSystemService()
				);

				const sessionId = 'untitled:wt-test-6';
				const token = disposables.add(new CancellationTokenSource()).token;
				const stream = new MockChatResponseStream();

				const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

				// Trust should be checked on the original repository path, not the worktree folder
				expect(workspaceService.trustRequests.some(uri => uri.fsPath === vscode.Uri.file(originalRepoPath).fsPath)).toBe(true);
				expect(result.trusted).toBe(false);
			});

			it('still creates worktree when folder is not a tracked worktree', async () => {
				const regularRepo = vscode.Uri.file('/regular-repo');
				workspaceService = new MockWorkspaceService([URI.file('/regular-repo')]);
				gitService.setTestActiveRepository({
					rootUri: regularRepo,
					kind: 'repository'
				} as RepoContext);
				// NO worktree properties registered — folder is not a tracked worktree
				manager = new CopilotCLIFolderRepositoryManager(
					worktreeService, workspaceFolderService, sessionService,
					gitService, workspaceService, logService, toolsService,
					new MockFileSystemService()
				);

				(worktreeService.createWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
					autoCommit: true,
					baseCommit: 'def456',
					branchName: 'copilot-new-wt',
					repositoryPath: '/regular-repo',
					worktreePath: '/regular-repo-worktree',
					version: 1
				} satisfies ChatSessionWorktreeProperties);

				const sessionId = 'untitled:wt-test-7';
				const token = disposables.add(new CancellationTokenSource()).token;
				const stream = new MockChatResponseStream();

				const result = await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

				expect(worktreeService.createWorktree).toHaveBeenCalled();
				expect(result.worktreeProperties).toBeDefined();
				expect(result.worktree?.fsPath).toBe(vscode.Uri.file('/regular-repo-worktree').fsPath);
			});
		});
	});

	describe('getRepositoryInfo', () => {
		it('returns repository and head branch for a git repo folder', async () => {
			const folderUri = vscode.Uri.file('/my/repo');
			const token = disposables.add(new CancellationTokenSource()).token;

			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository',
				headBranchName: 'main',
				headCommitHash: 'abc123'
			} as RepoContext);

			const result = await manager.getRepositoryInfo(folderUri, token);

			expect(result.repository?.fsPath).toBe(vscode.Uri.file('/my/repo').fsPath);
			expect(result.headBranchName).toBe('main');
		});

		it('returns undefined repository for a non-git folder', async () => {
			const folderUri = vscode.Uri.file('/plain/folder');
			const token = disposables.add(new CancellationTokenSource()).token;

			const result = await manager.getRepositoryInfo(folderUri, token);

			expect(result.repository).toBeUndefined();
			expect(result.headBranchName).toBeUndefined();
		});
	});

	describe('initializeFolderRepository with branch', () => {
		const mockToolInvocationToken = {} as vscode.ChatParticipantToolToken;

		it('passes branch to createWorktree when provided', async () => {
			const sessionId = 'untitled:test-branch';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			const folderUri = vscode.Uri.file('/my/repo');

			manager.setUntitledSessionFolder(sessionId, folderUri);
			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository'
			} as RepoContext);

			(worktreeService.createWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
				autoCommit: true,
				baseCommit: 'abc123',
				branchName: 'copilot-worktree',
				repositoryPath: '/my/repo',
				worktreePath: '/my/repo-worktree',
				version: 1
			} satisfies ChatSessionWorktreeProperties);

			await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken, branch: 'feature-branch' }, token);

			expect(worktreeService.createWorktree).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				'feature-branch'
			);
		});

		it('passes undefined branch when not provided', async () => {
			const sessionId = 'untitled:test-no-branch';
			const token = disposables.add(new CancellationTokenSource()).token;
			const stream = new MockChatResponseStream();
			const folderUri = vscode.Uri.file('/my/repo');

			manager.setUntitledSessionFolder(sessionId, folderUri);
			gitService.setTestRepository(folderUri, {
				rootUri: folderUri,
				kind: 'repository'
			} as RepoContext);

			(worktreeService.createWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
				autoCommit: true,
				baseCommit: 'abc123',
				branchName: 'copilot-worktree',
				repositoryPath: '/my/repo',
				worktreePath: '/my/repo-worktree',
				version: 1
			} satisfies ChatSessionWorktreeProperties);

			await manager.initializeFolderRepository(sessionId, { stream, toolInvocationToken: mockToolInvocationToken }, token);

			expect(worktreeService.createWorktree).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				undefined
			);
		});
	});

	describe('edge cases', () => {
		it('handles empty workspace scenarios', async () => {
			// Create manager with no workspace folders
			workspaceService = new MockWorkspaceService([]);
			manager = new CopilotCLIFolderRepositoryManager(
				worktreeService,
				workspaceFolderService,
				sessionService,
				gitService,
				workspaceService,
				logService,
				toolsService,
				new MockFileSystemService()
			);

			const sessionId = 'untitled:empty-test';
			const folderUri = vscode.Uri.file('/selected/folder');
			const token = disposables.add(new CancellationTokenSource()).token;

			manager.setUntitledSessionFolder(sessionId, folderUri);

			const result = await manager.getFolderRepository(sessionId, undefined, token);

			expect(result.folder?.fsPath).toBe(vscode.Uri.file('/selected/folder').fsPath);
		});

		it('returns undefined for unknown session', async () => {
			const sessionId = 'unknown-session';
			const token = disposables.add(new CancellationTokenSource()).token;

			const result = await manager.getFolderRepository(sessionId, undefined, token);

			expect(result.folder).toBeUndefined();
			expect(result.repository).toBeUndefined();
			expect(result.worktree).toBeUndefined();
		});
	});
});
