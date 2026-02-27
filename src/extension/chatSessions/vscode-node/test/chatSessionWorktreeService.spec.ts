/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IGitCommitMessageService } from '../../../../platform/git/common/gitCommitMessageService';
import { IGitService, RepoContext } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../util/common/test/simpleMock';
import { IChatSessionMetadataStore } from '../../common/chatSessionMetadataStore';
import { ChatSessionWorktreeProperties } from '../../common/chatSessionWorktreeService';
import { ChatSessionWorktreeService } from '../chatSessionWorktreeServiceImpl';

class MockGlobalState implements vscode.Memento {
	private data = new Map<string, unknown>();
	get<T>(key: string, defaultValue?: T): T {
		return (this.data.get(key) ?? defaultValue) as T;
	}
	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.data.delete(key);
		} else {
			this.data.set(key, value);
		}
	}
	keys(): readonly string[] { return Array.from(this.data.keys()); }
	setKeysForSync(_keys: readonly string[]): void { }
}

class MockExtensionContext extends mock<IVSCodeExtensionContext>() {
	public override globalState = new MockGlobalState();
	override globalStorageUri = Uri.file('/mock/global/storage');
}

class MockLogService extends mock<ILogService>() {
	override trace = vi.fn((_msg: string, ..._args: unknown[]) => { });
	override info = vi.fn((_msg: string, ..._args: unknown[]) => { });
	override warn = vi.fn((_msg: string, ..._args: unknown[]) => { });
	override error = vi.fn((_msg: string, ..._args: unknown[]) => { });
}

class MockMetadataStore extends mock<IChatSessionMetadataStore>() {
	private _store = new Map<string, ChatSessionWorktreeProperties>();
	override getWorktreeProperties = vi.fn(async (sessionId: string): Promise<ChatSessionWorktreeProperties | undefined> => {
		return this._store.get(sessionId);
	});
	override storeWorktreeInfo = vi.fn(async (sessionId: string, properties: ChatSessionWorktreeProperties): Promise<void> => {
		this._store.set(sessionId, properties);
	});
	setTestProperties(sessionId: string, properties: ChatSessionWorktreeProperties): void {
		this._store.set(sessionId, properties);
	}
}

class MockGitService extends mock<IGitService>() {
	private _repos = new Map<string, RepoContext | undefined>();
	override getRepository = vi.fn(async (uri: vscode.Uri, _forceOpen?: boolean): Promise<RepoContext | undefined> => {
		return this._repos.get(uri.fsPath);
	});
	setRepo(path: string, repo: RepoContext | undefined): void {
		this._repos.set(path, repo);
	}
}

function makeRepoContext(overrides: Partial<RepoContext>): RepoContext {
	return {
		rootUri: Uri.file('/mock/repo'),
		kind: 'repository',
		headBranchName: 'main',
		headCommitHash: 'abc123',
		upstreamBranchName: undefined,
		upstreamRemote: undefined,
		isRebasing: false,
		remoteFetchUrls: [],
		remotes: [],
		worktrees: [],
		changes: undefined,
		headBranchNameObs: { get: () => 'main' } as unknown as RepoContext['headBranchNameObs'],
		headCommitHashObs: { get: () => 'abc123' } as unknown as RepoContext['headCommitHashObs'],
		upstreamBranchNameObs: { get: () => undefined } as unknown as RepoContext['upstreamBranchNameObs'],
		upstreamRemoteObs: { get: () => undefined } as unknown as RepoContext['upstreamRemoteObs'],
		isRebasingObs: { get: () => false } as unknown as RepoContext['isRebasingObs'],
		isIgnored: vi.fn(async () => false),
		...overrides,
	};
}

describe('ChatSessionWorktreeService.detectAndRegisterWorktreeFromPath', () => {
	let service: ChatSessionWorktreeService;
	let gitService: MockGitService;
	let metadataStore: MockMetadataStore;
	let extensionContext: MockExtensionContext;
	let logService: MockLogService;

	beforeEach(() => {
		gitService = new MockGitService();
		metadataStore = new MockMetadataStore();
		extensionContext = new MockExtensionContext();
		logService = new MockLogService();

		service = new ChatSessionWorktreeService(
			new (mock<IGitCommitMessageService>())(),
			gitService as unknown as IGitService,
			logService as unknown as ILogService,
			extensionContext as unknown as IVSCodeExtensionContext,
			new (mock<IWorkspaceService>())(),
			metadataStore as unknown as IChatSessionMetadataStore,
		);
	});

	it('returns undefined when path is not a git worktree', async () => {
		const path = Uri.file('/some/regular/dir');
		gitService.setRepo(path.fsPath, makeRepoContext({ kind: 'repository' }));

		const result = await service.detectAndRegisterWorktreeFromPath('session-1', path);

		expect(result).toBeUndefined();
	});

	it('returns undefined when git repository is not found for path', async () => {
		const path = Uri.file('/some/dir');
		gitService.setRepo(path.fsPath, undefined);

		const result = await service.detectAndRegisterWorktreeFromPath('session-1', path);

		expect(result).toBeUndefined();
	});

	it('returns undefined when path is a worktree but main worktree is the current path (edge case)', async () => {
		const worktreePath = Uri.file('/repo/.worktrees/feature');
		gitService.setRepo(worktreePath.fsPath, makeRepoContext({
			kind: 'worktree',
			rootUri: worktreePath,
			headBranchName: 'feature-branch',
			headCommitHash: 'def456',
			worktrees: [
				// First entry is the current worktree itself (should not happen with real git, but testing edge case)
				{ name: 'feature', path: worktreePath.fsPath, ref: 'feature-branch', detached: false },
			],
		}));

		const result = await service.detectAndRegisterWorktreeFromPath('session-1', worktreePath);

		expect(result).toBeUndefined();
	});

	it('detects and registers worktree properties when path is a git worktree', async () => {
		const worktreePath = Uri.file('/repo/.worktrees/feature');
		const mainRepoPath = '/repo';
		gitService.setRepo(worktreePath.fsPath, makeRepoContext({
			kind: 'worktree',
			rootUri: worktreePath,
			headBranchName: 'feature-branch',
			headCommitHash: 'def456',
			worktrees: [
				{ name: 'main', path: mainRepoPath, ref: 'main', detached: false },
				{ name: 'feature', path: worktreePath.fsPath, ref: 'feature-branch', detached: false },
			],
		}));

		const result = await service.detectAndRegisterWorktreeFromPath('session-1', worktreePath);

		expect(result).toBeDefined();
		expect(result!.worktreePath).toBe(worktreePath.fsPath);
		expect(result!.repositoryPath).toBe(mainRepoPath);
		expect(result!.branchName).toBe('feature-branch');
		expect(result!.baseCommit).toBe('def456');
		expect(result!.version).toBe(2);
	});

	it('stores detected worktree properties for future calls', async () => {
		const worktreePath = Uri.file('/repo/.worktrees/feature');
		const mainRepoPath = '/repo';
		gitService.setRepo(worktreePath.fsPath, makeRepoContext({
			kind: 'worktree',
			rootUri: worktreePath,
			headBranchName: 'feature-branch',
			headCommitHash: 'def456',
			worktrees: [
				{ name: 'main', path: mainRepoPath, ref: 'main', detached: false },
				{ name: 'feature', path: worktreePath.fsPath, ref: 'feature-branch', detached: false },
			],
		}));

		// First call: detects and stores
		await service.detectAndRegisterWorktreeFromPath('session-1', worktreePath);

		// Second call: should return stored properties without calling git again
		const getCallsBefore = (gitService.getRepository as ReturnType<typeof vi.fn>).mock.calls.length;
		const result = await service.detectAndRegisterWorktreeFromPath('session-1', worktreePath);
		const getCallsAfter = (gitService.getRepository as ReturnType<typeof vi.fn>).mock.calls.length;

		expect(result).toBeDefined();
		// Git should not be called again since properties are already stored
		expect(getCallsAfter).toBe(getCallsBefore);
	});

	it('returns already-registered properties without calling git', async () => {
		const worktreePath = Uri.file('/repo/.worktrees/feature');
		const existingProperties: ChatSessionWorktreeProperties = {
			branchName: 'existing-branch',
			baseCommit: 'existing-commit',
			baseBranchName: 'main',
			repositoryPath: '/repo',
			worktreePath: worktreePath.fsPath,
			version: 2,
		};

		// Pre-register properties for the session
		await service.setWorktreeProperties('session-1', existingProperties);

		const result = await service.detectAndRegisterWorktreeFromPath('session-1', worktreePath);

		expect(result).toEqual(existingProperties);
		// Git should not be called since properties are already in memory
		expect(gitService.getRepository).not.toHaveBeenCalled();
	});

	it('returns properties from metadata store without calling git when available', async () => {
		const worktreePath = Uri.file('/repo/.worktrees/feature');
		const storedProperties: ChatSessionWorktreeProperties = {
			branchName: 'stored-branch',
			baseCommit: 'stored-commit',
			baseBranchName: 'main',
			repositoryPath: '/repo',
			worktreePath: worktreePath.fsPath,
			version: 2,
		};
		metadataStore.setTestProperties('session-1', storedProperties);

		const result = await service.detectAndRegisterWorktreeFromPath('session-1', worktreePath);

		expect(result).toEqual(storedProperties);
		// Git should not be called since metadata store has the properties
		expect(gitService.getRepository).not.toHaveBeenCalled();
	});

	it('returns undefined when worktree has no head branch name', async () => {
		const worktreePath = Uri.file('/repo/.worktrees/feature');
		gitService.setRepo(worktreePath.fsPath, makeRepoContext({
			kind: 'worktree',
			rootUri: worktreePath,
			headBranchName: undefined,
			headCommitHash: 'def456',
			worktrees: [
				{ name: 'main', path: '/repo', ref: 'main', detached: false },
				{ name: 'feature', path: worktreePath.fsPath, ref: 'feature-branch', detached: false },
			],
		}));

		const result = await service.detectAndRegisterWorktreeFromPath('session-1', worktreePath);

		expect(result).toBeUndefined();
	});
});
