/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { IGitService, RepoContext } from '../../../../platform/git/common/gitService';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IClaudeCodeSessionService } from '../../../agents/claude/node/sessionParser/claudeCodeSessionService';
import { IClaudeCodeSessionInfo } from '../../../agents/claude/node/sessionParser/claudeSessionSchema';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ClaudeChatSessionItemProvider } from '../claudeChatSessionItemProvider';

// #region Mocks

class FakeGitService extends mock<IGitService>() {
	override repositories: RepoContext[] = [];
	private readonly _onDidOpenRepository = new Emitter<RepoContext>();
	override readonly onDidOpenRepository = this._onDidOpenRepository.event;
	private readonly _onDidCloseRepository = new Emitter<RepoContext>();
	override readonly onDidCloseRepository = this._onDidCloseRepository.event;

	fireOpenRepository(repo: RepoContext): void {
		this._onDidOpenRepository.fire(repo);
	}

	fireCloseRepository(repo: RepoContext): void {
		this._onDidCloseRepository.fire(repo);
	}
}

function createMockSessionService(sessions: IClaudeCodeSessionInfo[]): IClaudeCodeSessionService {
	return {
		_serviceBrand: undefined,
		getAllSessions: vi.fn().mockResolvedValue(sessions),
		getSession: vi.fn().mockResolvedValue(undefined),
		getLastParseErrors: vi.fn().mockReturnValue([]),
		getLastParseStats: vi.fn().mockReturnValue(undefined),
		waitForSessionReady: vi.fn().mockResolvedValue(undefined),
	};
}

function createSession(overrides: Partial<IClaudeCodeSessionInfo> & { id: string }): IClaudeCodeSessionInfo {
	return {
		label: 'Test session',
		timestamp: new Date(),
		firstMessageTimestamp: new Date(),
		lastMessageTimestamp: new Date(),
		...overrides,
	};
}

// #endregion

describe('ClaudeChatSessionItemProvider', () => {
	const store = new DisposableStore();
	let gitService: FakeGitService;
	let sessionService: IClaudeCodeSessionService;

	function createProvider(
		workspaceFolders: URI[],
		sessions: IClaudeCodeSessionInfo[],
		repos: RepoContext[] = []
	): ClaudeChatSessionItemProvider {
		sessionService = createMockSessionService(sessions);
		gitService = new FakeGitService();
		gitService.repositories = repos;

		const serviceCollection = store.add(createExtensionUnitTestingServices(store));
		serviceCollection.set(IWorkspaceService, store.add(new TestWorkspaceService(workspaceFolders)));
		serviceCollection.define(IGitService, gitService);
		serviceCollection.define(IClaudeCodeSessionService, sessionService);

		const accessor = serviceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		return instaService.createInstance(ClaudeChatSessionItemProvider);
	}

	afterEach(() => {
		store.clear();
	});

	// #region Badge Visibility

	describe('badge visibility', () => {
		it('shows badge in empty window', async () => {
			const sessions = [createSession({ id: 'session-1', folderName: 'my-project' })];
			const provider = createProvider([], sessions);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect(items).toHaveLength(1);
			expect(items[0].badge).toBeDefined();
			expect((items[0].badge as vscode.MarkdownString).value).toBe('$(folder) my-project');
		});

		it('shows badge in multi-root workspace', async () => {
			const folders = [URI.file('/project-a'), URI.file('/project-b')];
			const sessions = [createSession({ id: 'session-1', folderName: 'project-a' })];
			const provider = createProvider(folders, sessions);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect(items[0].badge).toBeDefined();
			expect((items[0].badge as vscode.MarkdownString).value).toBe('$(folder) project-a');
		});

		it('shows badge in multi-root workspace without git', async () => {
			const folders = [URI.file('/project-a'), URI.file('/project-b')];
			const sessions = [createSession({ id: 'session-1', folderName: 'project-a' })];
			// No git repos at all
			const provider = createProvider(folders, sessions, []);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect(items[0].badge).toBeDefined();
		});

		it('does not show badge in single-root workspace with single repo', async () => {
			const folders = [URI.file('/project')];
			const sessions = [createSession({ id: 'session-1', folderName: 'project' })];
			const repo: RepoContext = {
				rootUri: URI.file('/project'),
				kind: 'repository',
			} as RepoContext;
			const provider = createProvider(folders, sessions, [repo]);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect(items[0].badge).toBeUndefined();
		});

		it('does not show badge in single-root workspace with no repos', async () => {
			const folders = [URI.file('/project')];
			const sessions = [createSession({ id: 'session-1', folderName: 'project' })];
			const provider = createProvider(folders, sessions, []);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect(items[0].badge).toBeUndefined();
		});

		it('shows badge in single-root workspace with multiple git repos', async () => {
			const folders = [URI.file('/monorepo')];
			const sessions = [createSession({ id: 'session-1', folderName: 'monorepo' })];
			const repos: RepoContext[] = [
				{ rootUri: URI.file('/monorepo'), kind: 'repository' } as RepoContext,
				{ rootUri: URI.file('/monorepo/packages/sub'), kind: 'repository' } as RepoContext,
			];
			const provider = createProvider(folders, sessions, repos);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect(items[0].badge).toBeDefined();
		});

		it('excludes worktree repos when counting repositories', async () => {
			const folders = [URI.file('/project')];
			const sessions = [createSession({ id: 'session-1', folderName: 'project' })];
			const repos: RepoContext[] = [
				{ rootUri: URI.file('/project'), kind: 'repository' } as RepoContext,
				{ rootUri: URI.file('/project-worktree'), kind: 'worktree' } as RepoContext,
			];
			const provider = createProvider(folders, sessions, repos);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			// Only one non-worktree repo, so no badge
			expect(items[0].badge).toBeUndefined();
		});

		it('does not show badge when session has no folderName', async () => {
			const sessions = [createSession({ id: 'session-1' })]; // No folderName
			const provider = createProvider([], sessions); // Empty window would normally show badge

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect(items[0].badge).toBeUndefined();
		});
	});

	// #endregion

	// #region Badge Content

	describe('badge content', () => {
		it('badge contains folder icon and folder name', async () => {
			const sessions = [createSession({ id: 'session-1', folderName: 'vscode-copilot-chat' })];
			const provider = createProvider([], sessions);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			const badge = items[0].badge as vscode.MarkdownString;
			expect(badge.value).toBe('$(folder) vscode-copilot-chat');
			expect(badge.supportThemeIcons).toBe(true);
		});

		it('different sessions show their respective folder names', async () => {
			const folders = [URI.file('/project-a'), URI.file('/project-b')];
			const sessions = [
				createSession({ id: 'session-1', folderName: 'project-a' }),
				createSession({ id: 'session-2', folderName: 'project-b' }),
			];
			const provider = createProvider(folders, sessions);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect((items[0].badge as vscode.MarkdownString).value).toBe('$(folder) project-a');
			expect((items[1].badge as vscode.MarkdownString).value).toBe('$(folder) project-b');
		});
	});

	// #endregion

	// #region Other Session Item Properties

	describe('session item properties', () => {
		it('includes all required session item fields', async () => {
			const now = new Date();
			const sessions = [createSession({
				id: 'test-id',
				label: 'My session',
				firstMessageTimestamp: now,
				lastMessageTimestamp: now,
			})];
			const provider = createProvider([URI.file('/project')], sessions);

			const items = await provider.provideChatSessionItems(CancellationToken.None);

			expect(items).toHaveLength(1);
			expect(items[0].label).toBe('My session');
			expect(items[0].tooltip).toBe('Claude Code session: My session');
			expect(items[0].timing?.created).toBe(now.getTime());
			expect(items[0].timing?.lastRequestEnded).toBe(now.getTime());
			expect(items[0].resource.scheme).toBe('claude-code');
			expect(items[0].resource.path).toBe('/test-id');
		});
	});

	// #endregion

	// #region Git Event Refresh

	describe('git event refresh', () => {
		it('fires onDidChangeChatSessionItems when a repository opens', async () => {
			const sessions = [createSession({ id: 'session-1', folderName: 'project' })];
			const provider = createProvider([URI.file('/project')], sessions);

			const fired = new Promise<void>(resolve => {
				provider.onDidChangeChatSessionItems(() => resolve());
			});

			gitService.fireOpenRepository({ rootUri: URI.file('/project'), kind: 'repository' } as RepoContext);
			await fired;
		});

		it('fires onDidChangeChatSessionItems when a repository closes', async () => {
			const repo = { rootUri: URI.file('/project'), kind: 'repository' } as RepoContext;
			const sessions = [createSession({ id: 'session-1', folderName: 'project' })];
			const provider = createProvider([URI.file('/project')], sessions, [repo]);

			const fired = new Promise<void>(resolve => {
				provider.onDidChangeChatSessionItems(() => resolve());
			});

			gitService.fireCloseRepository(repo);
			await fired;
		});
	});

	// #endregion
});
