/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IGitService, RepoContext } from '../../../../platform/git/common/gitService';
import { NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { NullCopilotCLIAgents } from '../../../agents/copilotcli/node/test/copilotCliSessionService.spec';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { IChatSessionWorktreeService, type ChatSessionWorktreeProperties } from '../../common/chatSessionWorktreeService';
import { IFolderRepositoryManager, type FolderRepositoryInfo, type FolderRepositoryMRUEntry } from '../../common/folderRepositoryManager';
import { isUntitledSessionId } from '../../common/utils';
import {
	AGENTS_OPTION_ID, BRANCH_OPTION_ID, ChatSessionOptionsManager, ISOLATION_OPTION_ID,
	REPOSITORY_OPTION_ID, SessionIdForCLI,
} from '../copilotCLIChatSessionsContribution';

vi.mock('../copilotCLITerminalIntegration', () => {
	const createServiceIdentifier = (name: string) => { const fn: any = () => { }; fn.toString = () => name; return fn; };
	return { ICopilotCLITerminalIntegration: createServiceIdentifier('ICopilotCLITerminalIntegration'), CopilotCLITerminalIntegration: class { dispose() { } openTerminal = vi.fn(async () => { }); } };
});

vi.mock('vscode', async () => {
	const actual = await import('../../../../vscodeTypes');
	return { ...actual, commands: { executeCommand: vi.fn() }, window: { showErrorMessage: vi.fn() } };
});

class FakeGitService extends mock<IGitService>() {
	override activeRepository = { get: () => undefined } as unknown as IGitService['activeRepository'];
	override repositories: RepoContext[] = [];
	override onDidFinishInitialization = vi.fn(() => ({ dispose() { } })) as unknown as IGitService['onDidFinishInitialization'];
	override onDidOpenRepository = vi.fn(() => ({ dispose() { } })) as unknown as IGitService['onDidOpenRepository'];
	override async getRepository(uri: URI): Promise<RepoContext | undefined> { return this.repositories.find(r => r.rootUri.fsPath === uri.fsPath); }
	override getRefs = vi.fn(async () => []) as unknown as IGitService['getRefs'];
}

class FakeWorktreeService extends mock<IChatSessionWorktreeService>() {
	private _properties = new Map<string, ChatSessionWorktreeProperties>();
	override createWorktree = vi.fn(async () => undefined) as unknown as IChatSessionWorktreeService['createWorktree'];
	override getWorktreeProperties = vi.fn((id: string | vscode.Uri) => typeof id === 'string' ? this._properties.get(id) : undefined);
	override setWorktreeProperties = vi.fn(async () => { });
	override getWorktreePath = vi.fn(() => undefined);
	override handleRequestCompleted = vi.fn(async () => { });
	override getWorktreeRepository = vi.fn(async () => undefined);

	setTestProps(sessionId: string, props: ChatSessionWorktreeProperties): void { this._properties.set(sessionId, props); }
}

class FakeFolderRepositoryManager extends mock<IFolderRepositoryManager>() {
	private _repoInfo: { repository: vscode.Uri | undefined; headBranchName: string | undefined } = { repository: undefined, headBranchName: undefined };
	private _folderRepoInfo: FolderRepositoryInfo = { folder: undefined, repository: undefined, worktree: undefined, worktreeProperties: undefined, trusted: undefined };

	override setUntitledSessionFolder = vi.fn();
	override getUntitledSessionFolder = vi.fn(() => undefined);
	override deleteUntitledSessionFolder = vi.fn();
	override getFolderRepository = vi.fn(async () => this._folderRepoInfo);
	override getRepositoryInfo = vi.fn(async () => this._repoInfo);
	override getFolderMRU = vi.fn((): FolderRepositoryMRUEntry[] => []);
	override deleteMRUEntry = vi.fn(async () => { });
	override getLastUsedFolderIdInUntitledWorkspace = vi.fn(() => undefined as string | undefined);
	override initializeFolderRepository = vi.fn(async () => this._folderRepoInfo);

	setFolderRepoInfo(info: Partial<FolderRepositoryInfo>): void {
		this._folderRepoInfo = { folder: undefined, repository: undefined, worktree: undefined, worktreeProperties: undefined, trusted: undefined, ...info };
	}
	setRepoInfo(info: { repository: vscode.Uri | undefined; headBranchName: string | undefined }): void { this._repoInfo = info; }
}

describe('ChatSessionOptionsManager', () => {
	const disposables = new DisposableStore();
	let git: FakeGitService;
	let wt: FakeWorktreeService;
	let frm: FakeFolderRepositoryManager;
	let fs: MockFileSystemService;
	let cfg: InMemoryConfigurationService;
	let ws: NullWorkspaceService;
	let agents: NullCopilotCLIAgents;
	let mgr: ChatSessionOptionsManager;

	const make = (opts?: { workspaceFolders?: URI[] }) =>
		disposables.add(new ChatSessionOptionsManager(
			isUntitledSessionId, agents, git, frm, fs, cfg,
			opts?.workspaceFolders !== undefined ? new NullWorkspaceService(opts.workspaceFolders) : ws, wt,
		));

	beforeEach(async () => {
		const svc = disposables.add(createExtensionUnitTestingServices());
		const acc = svc.createTestingAccessor();
		disposables.add(acc);
		git = new FakeGitService();
		wt = new FakeWorktreeService();
		frm = new FakeFolderRepositoryManager();
		fs = new MockFileSystemService();
		cfg = acc.get(IConfigurationService) as InMemoryConfigurationService;
		ws = new NullWorkspaceService([URI.file('/workspace')]);
		agents = new NullCopilotCLIAgents();
		await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, false);
		await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, false);
		mgr = make();
	});

	afterEach(() => { vi.restoreAllMocks(); disposables.clear(); });

	// ── Session branch state ───────────────────────────────────────────

	describe('session branch state', () => {
		it('returns undefined for unknown sessionId', () => {
			expect(mgr.getSessionBranch('unknown')).toBeUndefined();
		});

		it('stores and retrieves branch value', () => {
			mgr.setSessionBranch('s1', 'main');
			expect(mgr.getSessionBranch('s1')).toBe('main');
		});

		it('deleteSessionBranch removes stored value', () => {
			mgr.setSessionBranch('s1', 'main');
			mgr.deleteSessionBranch('s1');
			expect(mgr.getSessionBranch('s1')).toBeUndefined();
		});

		it('multiple sessions have independent branch state', () => {
			mgr.setSessionBranch('s1', 'main');
			mgr.setSessionBranch('s2', 'feature');
			expect(mgr.getSessionBranch('s1')).toBe('main');
			expect(mgr.getSessionBranch('s2')).toBe('feature');
		});
	});

	// ── Session isolation state ────────────────────────────────────────

	describe('session isolation state', () => {
		it('returns undefined for unknown sessionId', () => {
			expect(mgr.getSessionIsolation('unknown')).toBeUndefined();
		});

		it('stores and retrieves isolation value', () => {
			mgr.setSessionIsolation('s1', 'worktree');
			expect(mgr.getSessionIsolation('s1')).toBe('worktree');
		});

		it('hasSessionIsolation returns false for unknown, true for known', () => {
			expect(mgr.hasSessionIsolation('s1')).toBe(false);
			mgr.setSessionIsolation('s1', 'workspace');
			expect(mgr.hasSessionIsolation('s1')).toBe(true);
		});

		it('deleteSessionIsolation removes stored value', () => {
			mgr.setSessionIsolation('s1', 'worktree');
			mgr.deleteSessionIsolation('s1');
			expect(mgr.getSessionIsolation('s1')).toBeUndefined();
			expect(mgr.hasSessionIsolation('s1')).toBe(false);
		});

		it('multiple sessions have independent isolation state', () => {
			mgr.setSessionIsolation('s1', 'worktree');
			mgr.setSessionIsolation('s2', 'workspace');
			expect(mgr.getSessionIsolation('s1')).toBe('worktree');
			expect(mgr.getSessionIsolation('s2')).toBe('workspace');
		});
	});

	// ── Feature flags ──────────────────────────────────────────────────

	describe('feature flags', () => {
		it('isBranchOptionFeatureEnabled reflects config', async () => {
			expect(mgr.isBranchOptionFeatureEnabled()).toBe(false);
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			expect(mgr.isBranchOptionFeatureEnabled()).toBe(true);
		});

		it('isIsolationOptionFeatureEnabled reflects config', async () => {
			expect(mgr.isIsolationOptionFeatureEnabled()).toBe(false);
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			expect(mgr.isIsolationOptionFeatureEnabled()).toBe(true);
		});
	});

	// ── isWorktreeIsolationSelected ────────────────────────────────────

	describe('isWorktreeIsolationSelected', () => {
		it('returns true when isolation feature is disabled', () => {
			expect(mgr.isWorktreeIsolationSelected()).toBe(true);
		});

		it('returns false when no currentSessionId is set', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			mgr.currentSessionId = undefined;
			expect(mgr.isWorktreeIsolationSelected()).toBe(false);
		});

		it('returns true when currentSessionId has worktree isolation', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			mgr.currentSessionId = 's1';
			mgr.setSessionIsolation('s1', 'worktree');
			expect(mgr.isWorktreeIsolationSelected()).toBe(true);
		});

		it('returns false when currentSessionId has workspace isolation', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			mgr.currentSessionId = 's1';
			mgr.setSessionIsolation('s1', 'workspace');
			expect(mgr.isWorktreeIsolationSelected()).toBe(false);
		});
	});

	// ── isUntitledWorkspace ────────────────────────────────────────────

	describe('isUntitledWorkspace', () => {
		it('returns false when workspace folders exist', () => {
			expect(mgr.isUntitledWorkspace()).toBe(false);
		});

		it('returns true when no workspace folders', () => {
			expect(make({ workspaceFolders: [] }).isUntitledWorkspace()).toBe(true);
		});

		it('returns false when are workspace folders', () => {
			expect(make({ workspaceFolders: [vscode.Uri.file('/proj')] }).isUntitledWorkspace()).toBe(false);
		});
	});

	// ── buildLockSessionOptionChanges ──────────────────────────────────

	describe('buildLockSessionOptionChanges', () => {
		it('returns undefined when no folder', () => {
			expect(mgr.buildLockSessionOptionChanges('s1', {})).toBeUndefined();
		});

		it('returns locked repo option with folder', () => {
			const f = vscode.Uri.file('/proj');
			const r = mgr.buildLockSessionOptionChanges('s1', { folder: f })!;
			expect(r.length).toBe(1);
			expect(r[0].optionId).toBe(REPOSITORY_OPTION_ID);
			expect((r[0].value as vscode.ChatSessionProviderOptionItem).locked).toBe(true);
		});

		it('returns locked repo option with repository', () => {
			const f = vscode.Uri.file('/proj');
			const repo = vscode.Uri.file('/proj');
			const r = mgr.buildLockSessionOptionChanges('s1', { folder: f, repository: repo })!;
			expect(r.length).toBe(1);
			expect((r[0].value as vscode.ChatSessionProviderOptionItem).locked).toBe(true);
		});

		it('includes branch when set and feature enabled', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			mgr.setSessionBranch('s1', 'main');
			const r = mgr.buildLockSessionOptionChanges('s1', { folder: vscode.Uri.file('/p') })!;
			expect(r.length).toBe(2);
			expect(r[1].optionId).toBe(BRANCH_OPTION_ID);
			expect((r[1].value as vscode.ChatSessionProviderOptionItem).locked).toBe(true);
			expect((r[1].value as vscode.ChatSessionProviderOptionItem).id).toBe('main');
		});

		it('includes isolation when set and feature enabled', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			mgr.setSessionIsolation('s1', 'worktree');
			const r = mgr.buildLockSessionOptionChanges('s1', { folder: vscode.Uri.file('/p') })!;
			expect(r.length).toBe(2);
			expect(r[1].optionId).toBe(ISOLATION_OPTION_ID);
			expect((r[1].value as vscode.ChatSessionProviderOptionItem).id).toBe('worktree');
		});

		it('does NOT include branch when feature disabled', () => {
			mgr.setSessionBranch('s1', 'main');
			expect(mgr.buildLockSessionOptionChanges('s1', { folder: vscode.Uri.file('/p') })!.length).toBe(1);
		});

		it('does NOT include isolation when feature disabled', () => {
			mgr.setSessionIsolation('s1', 'worktree');
			expect(mgr.buildLockSessionOptionChanges('s1', { folder: vscode.Uri.file('/p') })!.length).toBe(1);
		});

		it('includes all three when both features enabled', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			mgr.setSessionBranch('s1', 'dev');
			mgr.setSessionIsolation('s1', 'workspace');
			const r = mgr.buildLockSessionOptionChanges('s1', { folder: vscode.Uri.file('/p') })!;
			expect(r.map(x => x.optionId)).toEqual([REPOSITORY_OPTION_ID, BRANCH_OPTION_ID, ISOLATION_OPTION_ID]);
		});
	});

	// ── buildUnlockSessionOptionChanges ────────────────────────────────

	describe('buildUnlockSessionOptionChanges', () => {
		it('returns undefined when no folder', () => {
			expect(mgr.buildUnlockSessionOptionChanges('s1', {})).toBeUndefined();
		});

		it('returns folder fsPath', () => {
			const f = vscode.Uri.file('/p');
			expect(mgr.buildUnlockSessionOptionChanges('s1', { folder: f })![0].value).toBe(f.fsPath);
		});

		it('prefers repository fsPath over folder', () => {
			const result = mgr.buildUnlockSessionOptionChanges('s1', { folder: vscode.Uri.file('/f'), repository: vscode.Uri.file('/r') })!;
			expect(result[0].value).toBe(vscode.Uri.file('/r').fsPath);
		});

		it('includes branch when set and feature enabled', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			mgr.setSessionBranch('s1', 'feat');
			const r = mgr.buildUnlockSessionOptionChanges('s1', { folder: vscode.Uri.file('/p') })!;
			expect(r.length).toBe(2);
			expect(r[1].optionId).toBe(BRANCH_OPTION_ID);
			expect(r[1].value).toBe('feat');
		});

		it('includes isolation when set and feature enabled', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			mgr.setSessionIsolation('s1', 'workspace');
			const r = mgr.buildUnlockSessionOptionChanges('s1', { folder: vscode.Uri.file('/p') })!;
			expect(r.length).toBe(2);
			expect(r[1].optionId).toBe(ISOLATION_OPTION_ID);
			expect(r[1].value).toBe('workspace');
		});
	});

	// ── buildSessionContentOptions (untitled) ──────────────────────────

	describe('buildSessionContentOptions (untitled)', () => {
		const tok = () => disposables.add(new CancellationTokenSource()).token;

		it('sets agent option', async () => {
			const { options } = await mgr.buildSessionContentOptions('untitled:s1', true, 'my-agent', tok());
			expect(options[AGENTS_OPTION_ID]).toBe('my-agent');
		});

		it('sets repository option from default repo', async () => {
			const u = URI.file('/myrepo');
			frm.setFolderRepoInfo({ folder: u });
			frm.setRepoInfo({ repository: undefined, headBranchName: undefined });
			const { options } = await mgr.buildSessionContentOptions('untitled:s1', true, 'agent', tok());
			expect(options[REPOSITORY_OPTION_ID]).toBe(u.fsPath);
		});

		it('returns providerOptionsChanged = true when repo found', async () => {
			frm.setFolderRepoInfo({ folder: URI.file('/r') });
			frm.setRepoInfo({ repository: undefined, headBranchName: undefined });
			const { providerOptionsChanged } = await mgr.buildSessionContentOptions('untitled:s1', true, 'a', tok());
			expect(providerOptionsChanged).toBe(true);
		});

		it('tracks untitled folder with folderRepositoryManager', async () => {
			const u = URI.file('/r');
			frm.setFolderRepoInfo({ folder: u });
			frm.setRepoInfo({ repository: undefined, headBranchName: undefined });
			await mgr.buildSessionContentOptions('untitled:s1', true, 'a', tok());
			expect(frm.setUntitledSessionFolder).toHaveBeenCalledWith('untitled:s1', u);
		});

		it('sets isolation option when repo + isolation feature enabled', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			const u = URI.file('/r');
			frm.setFolderRepoInfo({ folder: u });
			frm.setRepoInfo({ repository: u, headBranchName: 'main' });
			const { options } = await mgr.buildSessionContentOptions('untitled:s1', true, 'a', tok());
			expect((options[ISOLATION_OPTION_ID] as vscode.ChatSessionProviderOptionItem).id).toBe('workspace');
		});

		it('sets branch option when branches available', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			const u = URI.file('/r');
			frm.setFolderRepoInfo({ folder: u });
			frm.setRepoInfo({ repository: u, headBranchName: 'main' });
			git.getRefs = vi.fn(async () => [{ name: 'main', type: 0 }, { name: 'feat', type: 0 }]) as unknown as IGitService['getRefs'];
			const { options } = await mgr.buildSessionContentOptions('untitled:s1', true, 'a', tok());
			expect((options[BRANCH_OPTION_ID] as vscode.ChatSessionProviderOptionItem).id).toBe('main');
		});

		it('returns providerOptionsChanged = false when no default repo and empty workspace', async () => {
			const m = make({ workspaceFolders: [] });
			const { providerOptionsChanged } = await m.buildSessionContentOptions('untitled:s1', true, 'a', tok());
			expect(providerOptionsChanged).toBe(false);
		});
	});

	// ── buildSessionContentOptions (existing) ──────────────────────────

	describe('buildSessionContentOptions (existing)', () => {
		const tok = () => disposables.add(new CancellationTokenSource()).token;

		it('sets agent option', async () => {
			const { options } = await mgr.buildSessionContentOptions('s1', false, 'ag', tok());
			expect(options[AGENTS_OPTION_ID]).toBe('ag');
		});

		it('sets locked repository option from existing folder info', async () => {
			frm.setFolderRepoInfo({ folder: URI.file('/p') });
			const { options } = await mgr.buildSessionContentOptions('s1', false, 'a', tok());
			expect((options[REPOSITORY_OPTION_ID] as vscode.ChatSessionProviderOptionItem).locked).toBe(true);
		});

		it('returns providerOptionsChanged = false', async () => {
			frm.setFolderRepoInfo({ folder: URI.file('/p') });
			const { providerOptionsChanged } = await mgr.buildSessionContentOptions('s1', false, 'a', tok());
			expect(providerOptionsChanged).toBe(false);
		});

		it('sets locked branch from v2 worktree (baseBranchName)', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			const u = URI.file('/repo');
			frm.setFolderRepoInfo({ folder: u, repository: u });
			git.repositories = [{ rootUri: u, kind: 'repository' } as unknown as RepoContext];
			wt.setTestProps('s1', { version: 2, baseCommit: 'a', branchName: 'wt', baseBranchName: 'main', repositoryPath: u.fsPath, worktreePath: '/wt' });
			const { options } = await mgr.buildSessionContentOptions('s1', false, 'a', tok());
			const b = options[BRANCH_OPTION_ID] as vscode.ChatSessionProviderOptionItem;
			expect(b.id).toBe('main');
			expect(b.locked).toBe(true);
		});

		it('sets locked branch from v1 worktree (branchName)', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			const u = URI.file('/repo');
			frm.setFolderRepoInfo({ folder: u, repository: u });
			git.repositories = [{ rootUri: u, kind: 'repository' } as unknown as RepoContext];
			wt.setTestProps('s1', { version: 1, autoCommit: true, baseCommit: 'a', branchName: 'my-b', repositoryPath: u.fsPath, worktreePath: '/wt' });
			const { options } = await mgr.buildSessionContentOptions('s1', false, 'a', tok());
			expect((options[BRANCH_OPTION_ID] as vscode.ChatSessionProviderOptionItem).id).toBe('my-b');
		});

		it('sets locked isolation = worktree when worktree exists', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			const u = URI.file('/repo');
			frm.setFolderRepoInfo({ folder: u });
			wt.setTestProps('s1', { version: 2, baseCommit: 'a', branchName: 'b', baseBranchName: 'm', repositoryPath: u.fsPath, worktreePath: '/wt' });
			const { options } = await mgr.buildSessionContentOptions('s1', false, 'a', tok());
			const iso = options[ISOLATION_OPTION_ID] as vscode.ChatSessionProviderOptionItem;
			expect(iso.id).toBe('worktree');
			expect(iso.locked).toBe(true);
		});

		it('sets locked isolation = workspace when no worktree', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			frm.setFolderRepoInfo({ folder: URI.file('/p') });
			const { options } = await mgr.buildSessionContentOptions('s1', false, 'a', tok());
			expect((options[ISOLATION_OPTION_ID] as vscode.ChatSessionProviderOptionItem).id).toBe('workspace');
		});

		it('falls back to Unknown when no folder info', async () => {
			const m = make({ workspaceFolders: [] });
			const { options } = await m.buildSessionContentOptions('s1', false, 'a', tok());
			expect((options[REPOSITORY_OPTION_ID] as vscode.ChatSessionProviderOptionItem).name).toBe('Unknown');
		});

		it('uses single workspace folder name when only one exists', async () => {
			// Default workspace: [/workspace]
			const { options } = await mgr.buildSessionContentOptions('s1', false, 'a', tok());
			const repo = options[REPOSITORY_OPTION_ID] as vscode.ChatSessionProviderOptionItem;
			expect(repo.locked).toBe(true);
			// Should use the workspace folder name, not 'Unknown'
			expect(repo.name).not.toBe('Unknown');
		});
	});

	// ── handleOptionsChange ────────────────────────────────────────────

	describe('handleOptionsChange', () => {
		const tok = () => disposables.add(new CancellationTokenSource()).token;

		it('agent option updates default agent and tracks session agent', async () => {
			const spy1 = vi.spyOn(agents, 'setDefaultAgent');
			const spy2 = vi.spyOn(agents, 'trackSessionAgent');
			await mgr.handleOptionsChange(SessionIdForCLI.getResource('s1'), [{ optionId: AGENTS_OPTION_ID, value: 'ag' }], tok());
			expect(spy1).toHaveBeenCalledWith('ag');
			expect(spy2).toHaveBeenCalledWith('s1', 'ag');
		});

		it('branch option stores session branch', async () => {
			await mgr.handleOptionsChange(SessionIdForCLI.getResource('s1'), [{ optionId: BRANCH_OPTION_ID, value: 'feat' }], tok());
			expect(mgr.getSessionBranch('s1')).toBe('feat');
		});

		it('isolation option stores value and triggers provider change', async () => {
			const fn = vi.fn();
			disposables.add(mgr.onDidChangeProviderOptions(fn));
			await mgr.handleOptionsChange(SessionIdForCLI.getResource('s1'), [{ optionId: ISOLATION_OPTION_ID, value: 'worktree' }], tok());
			expect(mgr.getSessionIsolation('s1')).toBe('worktree');
			expect(fn).toHaveBeenCalled();
		});

		it('sets currentSessionId when handling changes', async () => {
			await mgr.handleOptionsChange(SessionIdForCLI.getResource('abc'), [{ optionId: BRANCH_OPTION_ID, value: 'x' }], tok());
			expect(mgr.currentSessionId).toBe('abc');
		});

		it('switching isolation to workspace deletes session branch', async () => {
			mgr.setSessionBranch('s1', 'feat');
			await mgr.handleOptionsChange(SessionIdForCLI.getResource('s1'), [{ optionId: ISOLATION_OPTION_ID, value: 'workspace' }], tok());
			expect(mgr.getSessionBranch('s1')).toBeUndefined();
		});

		it('switching isolation to worktree pushes branch selection when branch feature enabled', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			// Set up selectedRepoForBranches so branches can be fetched
			mgr.selectedRepoForBranches = { repoUri: URI.file('/repo'), headBranchName: 'main' };
			git.getRefs = vi.fn(async () => [{ name: 'main', type: 0 }]) as unknown as IGitService['getRefs'];

			const sessionOptionsFired = vi.fn();
			disposables.add(mgr.onDidChangeSessionOptions(sessionOptionsFired));

			await mgr.handleOptionsChange(SessionIdForCLI.getResource('s1'), [{ optionId: ISOLATION_OPTION_ID, value: 'worktree' }], tok());
			expect(mgr.getSessionBranch('s1')).toBe('main');
			expect(sessionOptionsFired).toHaveBeenCalled();
		});
	});

	// ── Events ─────────────────────────────────────────────────────────

	describe('events', () => {
		it('onDidChangeSessionOptions fires when notifySessionOptionsChange is called', () => {
			const fn = vi.fn();
			disposables.add(mgr.onDidChangeSessionOptions(fn));
			const r = vscode.Uri.from({ scheme: 'copilotcli', path: '/s1' });
			mgr.notifySessionOptionsChange(r, [{ optionId: 't', value: 'v' }]);
			expect(fn).toHaveBeenCalledWith({ resource: r, updates: [{ optionId: 't', value: 'v' }] });
		});

		it('onDidChangeProviderOptions fires when notifyProviderOptionsChange is called', () => {
			const fn = vi.fn();
			disposables.add(mgr.onDidChangeProviderOptions(fn));
			mgr.notifyProviderOptionsChange();
			expect(fn).toHaveBeenCalled();
		});
	});

	// ── getRepositoryOptionItems ───────────────────────────────────────

	describe('getRepositoryOptionItems', () => {
		it('returns empty array for no repos and no workspace folders', () => {
			expect(make({ workspaceFolders: [] }).getRepositoryOptionItems()).toEqual([]);
		});

		it('returns repo items for git repositories', () => {
			git.repositories = [
				{ rootUri: URI.file('/a'), kind: 'repository' },
				{ rootUri: URI.file('/b'), kind: 'repository' },
			] as unknown as RepoContext[];
			const m = make({ workspaceFolders: [] });
			expect(m.getRepositoryOptionItems().length).toBe(2);
		});

		it('includes workspace folders without repos', () => {
			const items = mgr.getRepositoryOptionItems();
			expect(items.length).toBe(1);
			expect(items[0].id).toBe(URI.file('/workspace').fsPath);
		});

		it('excludes worktree repositories', () => {
			git.repositories = [
				{ rootUri: URI.file('/r'), kind: 'repository' },
				{ rootUri: URI.file('/w'), kind: 'worktree' },
			] as unknown as RepoContext[];
			expect(make({ workspaceFolders: [] }).getRepositoryOptionItems().length).toBe(1);
		});

		it('items are sorted alphabetically', () => {
			git.repositories = [
				{ rootUri: URI.file('/zeta'), kind: 'repository' },
				{ rootUri: URI.file('/alpha'), kind: 'repository' },
			] as unknown as RepoContext[];
			const items = make({ workspaceFolders: [] }).getRepositoryOptionItems();
			expect(items[0].name).toBe('alpha');
			expect(items[1].name).toBe('zeta');
		});
	});

	// ── provideChatSessionProviderOptions ───────────────────────────────

	describe('provideChatSessionProviderOptions', () => {
		it('returns empty optionGroups by default', async () => {
			const { optionGroups } = await mgr.provideChatSessionProviderOptions();
			expect(optionGroups).toBeDefined();
		});

		it('includes isolation group when selectedRepoForBranches set and isolation enabled', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIIsolationOption, true);
			mgr.selectedRepoForBranches = { repoUri: URI.file('/r'), headBranchName: 'main' };
			const { optionGroups } = await mgr.provideChatSessionProviderOptions();
			expect(optionGroups!.some(g => g.id === ISOLATION_OPTION_ID)).toBe(true);
		});

		it('includes repository group in multi-repo workspace', async () => {
			git.repositories = [
				{ rootUri: URI.file('/a'), kind: 'repository' },
				{ rootUri: URI.file('/b'), kind: 'repository' },
			] as unknown as RepoContext[];
			const { optionGroups } = await mgr.provideChatSessionProviderOptions();
			expect(optionGroups!.some(g => g.id === REPOSITORY_OPTION_ID)).toBe(true);
		});

		it('does not include repository group for single-repo workspace', async () => {
			git.repositories = [{ rootUri: URI.file('/workspace'), kind: 'repository' }] as unknown as RepoContext[];
			const m = make({ workspaceFolders: [URI.file('/workspace')] });
			const { optionGroups } = await m.provideChatSessionProviderOptions();
			// Single repo = only 1 item, so no group
			expect(optionGroups!.some(g => g.id === REPOSITORY_OPTION_ID)).toBe(false);
		});

		it('includes branch group when branches available and worktree isolation selected', async () => {
			await cfg.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);
			mgr.selectedRepoForBranches = { repoUri: URI.file('/r'), headBranchName: 'main' };
			git.getRefs = vi.fn(async () => [{ name: 'main', type: 0 }]) as unknown as IGitService['getRefs'];
			// isolation feature disabled => isWorktreeIsolationSelected returns true
			const { optionGroups } = await mgr.provideChatSessionProviderOptions();
			expect(optionGroups!.some(g => g.id === BRANCH_OPTION_ID)).toBe(true);
		});
	});
});
