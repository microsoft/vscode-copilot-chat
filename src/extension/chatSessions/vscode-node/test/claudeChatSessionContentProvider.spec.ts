/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
// eslint-disable-next-line no-duplicate-imports
import * as vscodeShim from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IGitService, RepoContext } from '../../../../platform/git/common/gitService';
import { MockGitService } from '../../../../platform/ignore/node/test/mockGitService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../../util/vs/platform/instantiation/common/serviceCollection';
import { ChatRequestTurn, ChatResponseMarkdownPart, ChatResponseTurn2, ChatSessionStatus, ChatToolInvocationPart, MarkdownString, ThemeIcon } from '../../../../vscodeTypes';
import type { ClaudeAgentManager } from '../../../agents/claude/node/claudeCodeAgent';
import { IClaudeCodeModels, NoClaudeModelsAvailableError } from '../../../agents/claude/node/claudeCodeModels';
import { IClaudeSessionStateService } from '../../../agents/claude/node/claudeSessionStateService';
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../../agents/claude/node/sessionParser/claudeCodeSessionService';
import { IClaudeCodeSessionInfo } from '../../../agents/claude/node/sessionParser/claudeSessionSchema';
import { IClaudeSlashCommandService } from '../../../agents/claude/vscode-node/claudeSlashCommandService';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { MockChatResponseStream, TestChatRequest } from '../../../test/node/testHelpers';
import { FolderRepositoryMRUEntry, IFolderRepositoryManager } from '../../common/folderRepositoryManager';
import { ClaudeChatSessionContentProvider, ClaudeChatSessionItemController, ClaudeSessionUri, UNAVAILABLE_MODEL_ID } from '../claudeChatSessionContentProvider';

// Expose the most recently created items map so tests can inspect controller items.
let lastCreatedItemsMap: Map<string, vscode.ChatSessionItem>;

// Patch vscode shim with missing `chat` namespace before any production code imports it.
beforeAll(() => {
	(vscodeShim as Record<string, unknown>).chat = {
		createChatSessionItemController: () => {
			const itemsMap = new Map<string, vscode.ChatSessionItem>();
			lastCreatedItemsMap = itemsMap;
			const controller: Record<string, unknown> = {
				id: 'claude-code',
				items: {
					get: (resource: URI) => itemsMap.get(resource.toString()),
					add: (item: vscode.ChatSessionItem) => { itemsMap.set(item.resource.toString(), item); },
					delete: (resource: URI) => { itemsMap.delete(resource.toString()); },
					replace: (items: vscode.ChatSessionItem[]) => {
						itemsMap.clear();
						for (const item of items) {
							itemsMap.set(item.resource.toString(), item);
						}
					},
					get size() { return itemsMap.size; },
					[Symbol.iterator]: function* () { yield* itemsMap.values(); },
					forEach: (cb: (item: vscode.ChatSessionItem) => void) => { itemsMap.forEach(cb); },
				},
				createChatSessionItem: (resource: unknown, label: string) => ({
					resource,
					label,
				}),
				refreshHandler: () => Promise.resolve(),
				newChatSessionItemHandler: undefined,
				dispose: () => { },
				onDidChangeChatSessionItemState: () => ({ dispose: () => { } }),
			};
			return controller;
		},
	};
});

// Mock types for testing
interface MockClaudeSession {
	id: string;
	messages: Array<{
		type: 'user' | 'assistant';
		message: Record<string, unknown>;
	}>;
	subagents: Array<unknown>;
}

class MockFolderRepositoryManager implements IFolderRepositoryManager {
	declare _serviceBrand: undefined;

	private readonly _untitledFolders = new Map<string, vscode.Uri>();
	private _mruEntries: FolderRepositoryMRUEntry[] = [];
	private _lastUsedFolderIdInUntitledWorkspace: string | undefined;

	setMRUEntries(entries: FolderRepositoryMRUEntry[]): void {
		this._mruEntries = entries;
	}

	setLastUsedFolderIdInUntitledWorkspace(id: string | undefined): void {
		this._lastUsedFolderIdInUntitledWorkspace = id;
	}

	setUntitledSessionFolder(sessionId: string, folderUri: vscode.Uri): void {
		this._untitledFolders.set(sessionId, folderUri);
	}

	getUntitledSessionFolder(sessionId: string): vscode.Uri | undefined {
		return this._untitledFolders.get(sessionId);
	}

	deleteUntitledSessionFolder(sessionId: string): void {
		this._untitledFolders.delete(sessionId);
	}

	async getFolderRepository(): Promise<{ folder: undefined; repository: undefined; worktree: undefined; worktreeProperties: undefined; trusted: undefined }> {
		return { folder: undefined, repository: undefined, worktree: undefined, worktreeProperties: undefined, trusted: undefined };
	}

	async initializeFolderRepository(): Promise<{ folder: undefined; repository: undefined; worktree: undefined; worktreeProperties: undefined; trusted: undefined }> {
		return { folder: undefined, repository: undefined, worktree: undefined, worktreeProperties: undefined, trusted: undefined };
	}

	async getRepositoryInfo(): Promise<{ repository: undefined; headBranchName: undefined }> {
		return { repository: undefined, headBranchName: undefined };
	}

	getFolderMRU(): FolderRepositoryMRUEntry[] {
		return this._mruEntries;
	}

	async deleteMRUEntry(): Promise<void> { }

	getLastUsedFolderIdInUntitledWorkspace(): string | undefined {
		return this._lastUsedFolderIdInUntitledWorkspace;
	}
}

function createDefaultMocks() {
	const mockSessionService: IClaudeCodeSessionService = {
		getSession: vi.fn()
	} as any;

	const mockClaudeCodeModels: IClaudeCodeModels = {
		resolveModel: vi.fn().mockResolvedValue('claude-3-5-sonnet-20241022'),
		getDefaultModel: vi.fn().mockResolvedValue('claude-3-5-sonnet-20241022'),
		setDefaultModel: vi.fn().mockResolvedValue(undefined),
		getModels: vi.fn().mockResolvedValue([
			{ id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
			{ id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' }
		]),
		mapSdkModelToEndpointModel: vi.fn().mockResolvedValue(undefined)
	} as any;

	const mockFolderRepositoryManager = new MockFolderRepositoryManager();

	return { mockSessionService, mockClaudeCodeModels, mockFolderRepositoryManager };
}

function createMockAgentManager(): ClaudeAgentManager {
	return {
		handleRequest: vi.fn().mockResolvedValue({}),
	} as unknown as ClaudeAgentManager;
}

function createProviderWithServices(
	store: DisposableStore,
	workspaceFolders: URI[],
	mocks: ReturnType<typeof createDefaultMocks>,
	agentManager?: ClaudeAgentManager,
): { provider: ClaudeChatSessionContentProvider; accessor: ITestingServicesAccessor } {
	const serviceCollection = store.add(createExtensionUnitTestingServices(store));

	const workspaceService = new TestWorkspaceService(workspaceFolders);
	serviceCollection.set(IWorkspaceService, workspaceService);
	serviceCollection.set(IGitService, new MockGitService());

	serviceCollection.define(IClaudeCodeSessionService, mocks.mockSessionService);
	serviceCollection.define(IClaudeCodeModels, mocks.mockClaudeCodeModels);
	serviceCollection.define(IFolderRepositoryManager, mocks.mockFolderRepositoryManager);
	serviceCollection.define(IClaudeSlashCommandService, {
		_serviceBrand: undefined,
		tryHandleCommand: vi.fn().mockResolvedValue({ handled: false }),
		getRegisteredCommands: vi.fn().mockReturnValue([]),
	});

	const accessor = serviceCollection.createTestingAccessor();
	const instaService = accessor.get(IInstantiationService);
	const provider = instaService.createInstance(ClaudeChatSessionContentProvider, agentManager ?? createMockAgentManager());
	return { provider, accessor };
}

describe('ChatSessionContentProvider', () => {
	let mockSessionService: IClaudeCodeSessionService;
	let mockClaudeCodeModels: IClaudeCodeModels;
	let mockFolderRepositoryManager: MockFolderRepositoryManager;
	let provider: ClaudeChatSessionContentProvider;
	const store = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	const workspaceFolderUri = URI.file('/project');

	beforeEach(() => {
		const mocks = createDefaultMocks();
		mockSessionService = mocks.mockSessionService;
		mockClaudeCodeModels = mocks.mockClaudeCodeModels;
		mockFolderRepositoryManager = mocks.mockFolderRepositoryManager;

		const result = createProviderWithServices(store, [workspaceFolderUri], mocks);
		provider = result.provider;
		accessor = result.accessor;
	});

	afterEach(() => {
		vi.clearAllMocks();
		store.clear();
	});

	// Helper function to create simplified objects for snapshot testing
	function mapHistoryForSnapshot(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[]) {
		return history.map(turn => {
			if (turn instanceof ChatRequestTurn) {
				return {
					type: 'request',
					prompt: turn.prompt
				};
			} else if (turn instanceof ChatResponseTurn2) {
				return {
					type: 'response',
					parts: turn.response.map(part => {
						if (part instanceof ChatResponseMarkdownPart) {
							return {
								type: 'markdown',
								content: part.value.value
							};
						} else if (part instanceof ChatToolInvocationPart) {
							return {
								type: 'tool',
								toolName: part.toolName,
								toolCallId: part.toolCallId,
								isError: part.isError,
								invocationMessage: part.invocationMessage
									? (typeof part.invocationMessage === 'string'
										? part.invocationMessage
										: part.invocationMessage.value)
									: undefined
							};
						}
						return { type: 'unknown' };
					})
				};
			}
			return { type: 'unknown' };
		});
	}

	// #region Provider-Level Tests

	describe('provideChatSessionContent', () => {
		it('returns empty history when no existing session', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);

			const sessionUri = createClaudeSessionUri('test-session');
			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);

			expect(result.history).toEqual([]);
			expect(mockSessionService.getSession).toHaveBeenCalledWith(sessionUri, CancellationToken.None);
		});
	});

	it('loads real fixture file with tool invocation flow and converts to correct chat history', async () => {
		const fixtureContent = await readFile(path.join(__dirname, 'fixtures', '4c289ca8-f8bb-4588-8400-88b78beb784d.jsonl'), 'utf8');

		const mockFileSystem = accessor.get(IFileSystemService) as MockFileSystemService;
		const testEnvService = accessor.get(INativeEnvService);

		const folderSlug = '/project'.replace(/[\/\.]/g, '-');
		const projectDir = joinPath(testEnvService.userHome, `.claude/projects/${folderSlug}`);
		const fixtureFile = URI.joinPath(projectDir, '4c289ca8-f8bb-4588-8400-88b78beb784d.jsonl');

		mockFileSystem.mockDirectory(projectDir, [['4c289ca8-f8bb-4588-8400-88b78beb784d.jsonl', FileType.File]]);
		mockFileSystem.mockFile(fixtureFile, fixtureContent);

		const instaService = accessor.get(IInstantiationService);
		const realSessionService = instaService.createInstance(ClaudeCodeSessionService);

		const childInstantiationService = instaService.createChild(new ServiceCollection(
			[IClaudeCodeSessionService, realSessionService],
			[IClaudeCodeModels, mockClaudeCodeModels]
		));
		const provider = childInstantiationService.createInstance(ClaudeChatSessionContentProvider, createMockAgentManager());

		const sessionUri = createClaudeSessionUri('4c289ca8-f8bb-4588-8400-88b78beb784d');
		const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);
		expect(mapHistoryForSnapshot(result.history)).toMatchSnapshot();
	});

	// #endregion

	// #region Model Resolution and Caching

	describe('model resolution and caching', () => {
		it('uses user-selected model from session state', async () => {
			const session: MockClaudeSession = {
				id: 'test-session',
				messages: [{
					type: 'assistant',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Hello' }],
						model: 'claude-opus-4-5-20251101',
					},
				}],
				subagents: [],
			};

			vi.mocked(mockSessionService.getSession).mockResolvedValue(session as any);
			const mockSessionStateService = accessor.get(IClaudeSessionStateService) as any;
			mockSessionStateService.getModelIdForSession = vi.fn().mockReturnValue('claude-sonnet-4-20250514');

			const sessionUri = createClaudeSessionUri('test-session');
			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);

			expect(result.options?.['model']).toBe('claude-sonnet-4-20250514');
			expect(mockClaudeCodeModels.mapSdkModelToEndpointModel).not.toHaveBeenCalled();
		});

		it('extracts and maps SDK model from session messages when no user selection', async () => {
			const session: MockClaudeSession = {
				id: 'test-session',
				messages: [{
					type: 'assistant',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Hello' }],
						model: 'claude-opus-4-5-20251101',
					},
				}],
				subagents: [],
			};

			vi.mocked(mockSessionService.getSession).mockResolvedValue(session as any);
			vi.mocked(mockClaudeCodeModels.mapSdkModelToEndpointModel).mockResolvedValue('claude-opus-4.5');

			const sessionUri = createClaudeSessionUri('test-session');
			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);

			expect(mockClaudeCodeModels.mapSdkModelToEndpointModel).toHaveBeenCalledWith('claude-opus-4-5-20251101');
			expect(result.options?.['model']).toBe('claude-opus-4.5');
		});

		it('falls back to default model when no SDK model in session', async () => {
			const session: MockClaudeSession = {
				id: 'test-session',
				messages: [{
					type: 'user',
					message: {
						role: 'user',
						content: 'Hello',
					},
				}],
				subagents: [],
			};

			vi.mocked(mockSessionService.getSession).mockResolvedValue(session as any);
			vi.mocked(mockClaudeCodeModels.getDefaultModel).mockResolvedValue('claude-sonnet-4-20250514');

			const sessionUri = createClaudeSessionUri('test-session');
			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);

			expect(mockClaudeCodeModels.getDefaultModel).toHaveBeenCalled();
			expect(result.options?.['model']).toBe('claude-sonnet-4-20250514');
		});

		it('falls back to default model when SDK model cannot be mapped', async () => {
			const session: MockClaudeSession = {
				id: 'test-session',
				messages: [{
					type: 'assistant',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Hello' }],
						model: 'claude-unknown-1-0-20251101',
					},
				}],
				subagents: [],
			};

			vi.mocked(mockSessionService.getSession).mockResolvedValue(session as any);
			vi.mocked(mockClaudeCodeModels.mapSdkModelToEndpointModel).mockResolvedValue(undefined);
			vi.mocked(mockClaudeCodeModels.getDefaultModel).mockResolvedValue('claude-sonnet-4-20250514');

			const sessionUri = createClaudeSessionUri('test-session');
			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);

			expect(mockClaudeCodeModels.getDefaultModel).toHaveBeenCalled();
			expect(result.options?.['model']).toBe('claude-sonnet-4-20250514');
		});

		it('caches resolved model in session state', async () => {
			const session: MockClaudeSession = {
				id: 'test-session',
				messages: [{
					type: 'assistant',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Hello' }],
						model: 'claude-opus-4-5-20251101',
					},
				}],
				subagents: [],
			};

			vi.mocked(mockSessionService.getSession).mockResolvedValue(session as any);
			vi.mocked(mockClaudeCodeModels.mapSdkModelToEndpointModel).mockResolvedValue('claude-opus-4.5');

			const mockSessionStateService = accessor.get(IClaudeSessionStateService) as any;
			const setModelSpy = vi.spyOn(mockSessionStateService, 'setModelIdForSession');

			const sessionUri = createClaudeSessionUri('test-session');
			await provider.provideChatSessionContent(sessionUri, CancellationToken.None);

			expect(setModelSpy).toHaveBeenCalledWith('test-session', 'claude-opus-4.5');
		});

		it('extracts model from most recent assistant message', async () => {
			const session: MockClaudeSession = {
				id: 'test-session',
				messages: [
					{
						type: 'assistant',
						message: {
							role: 'assistant',
							content: [{ type: 'text', text: 'First' }],
							model: 'claude-haiku-3-5-20250514',
						},
					},
					{
						type: 'user',
						message: {
							role: 'user',
							content: 'Question',
						},
					},
					{
						type: 'assistant',
						message: {
							role: 'assistant',
							content: [{ type: 'text', text: 'Second' }],
							model: 'claude-opus-4-5-20251101',
						},
					},
				],
				subagents: [],
			};

			vi.mocked(mockSessionService.getSession).mockResolvedValue(session as any);
			vi.mocked(mockClaudeCodeModels.mapSdkModelToEndpointModel).mockResolvedValue('claude-opus-4.5');

			const sessionUri = createClaudeSessionUri('test-session');
			await provider.provideChatSessionContent(sessionUri, CancellationToken.None);

			expect(mockClaudeCodeModels.mapSdkModelToEndpointModel).toHaveBeenCalledWith('claude-opus-4-5-20251101');
		});
	});

	// #endregion

	// #region Unavailable Model Handling

	describe('unavailable model handling', () => {
		it('shows unavailable option when no models available', async () => {
			vi.mocked(mockClaudeCodeModels.getModels).mockResolvedValue([]);

			const options = await provider.provideChatSessionProviderOptions();
			const modelGroup = options.optionGroups?.find(g => g.id === 'model');

			expect(modelGroup?.items).toHaveLength(1);
			expect(modelGroup?.items[0]).toEqual({
				id: UNAVAILABLE_MODEL_ID,
				name: 'Unavailable',
				description: 'No Claude models with Messages API found',
			});
		});

		it('ignores unavailable model selection in provideHandleOptionsChange', async () => {
			const sessionUri = createClaudeSessionUri('test-session');
			await provider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'model', value: UNAVAILABLE_MODEL_ID }],
				CancellationToken.None
			);

			expect(mockClaudeCodeModels.setDefaultModel).not.toHaveBeenCalled();
		});

		it('throws NoClaudeModelsAvailableError from getModelIdForSession when no models exist', async () => {
			vi.mocked(mockClaudeCodeModels.getModels).mockResolvedValue([]);
			vi.mocked(mockClaudeCodeModels.getDefaultModel).mockRejectedValue(new NoClaudeModelsAvailableError());

			await expect(provider.getModelIdForSession('test-session')).rejects.toThrow(NoClaudeModelsAvailableError);
		});

		it('returns unavailable model in provideChatSessionContent when no models exist', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);
			vi.mocked(mockClaudeCodeModels.getModels).mockResolvedValue([]);
			vi.mocked(mockClaudeCodeModels.getDefaultModel).mockRejectedValue(new NoClaudeModelsAvailableError());

			const sessionUri = createClaudeSessionUri('test-session');
			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);

			expect(result.options?.['model']).toBe(UNAVAILABLE_MODEL_ID);
		});
	});

	// #endregion

	// #region Folder Option Tests

	describe('folder option - single-root workspace', () => {
		it('does NOT include folder option group when single-root workspace', async () => {
			const options = await provider.provideChatSessionProviderOptions();
			const folderGroup = options.optionGroups?.find(g => g.id === 'folder');
			expect(folderGroup).toBeUndefined();
		});

		it('getFolderInfoForSession returns the one workspace folder as cwd', () => {
			const folderInfo = provider.getFolderInfoForSession('test-session');
			expect(folderInfo.cwd).toBe(workspaceFolderUri.fsPath);
			expect(folderInfo.additionalDirectories).toEqual([]);
		});

		it('does NOT include folder in provideChatSessionContent options', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);
			const sessionUri = createClaudeSessionUri('test-session');
			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);
			expect(result.options?.['folder']).toBeUndefined();
		});
	});

	describe('folder option - multi-root workspace', () => {
		const folderA = URI.file('/project-a');
		const folderB = URI.file('/project-b');
		const folderC = URI.file('/project-c');
		let multiRootProvider: ClaudeChatSessionContentProvider;

		beforeEach(() => {
			const mocks = createDefaultMocks();
			mockSessionService = mocks.mockSessionService;
			mockClaudeCodeModels = mocks.mockClaudeCodeModels;
			mockFolderRepositoryManager = mocks.mockFolderRepositoryManager;

			const result = createProviderWithServices(store, [folderA, folderB, folderC], mocks);
			multiRootProvider = result.provider;
		});

		it('includes folder option group with all workspace folders', async () => {
			const options = await multiRootProvider.provideChatSessionProviderOptions();
			const folderGroup = options.optionGroups?.find(g => g.id === 'folder');

			expect(folderGroup).toBeDefined();
			expect(folderGroup!.items).toHaveLength(3);
			expect(folderGroup!.items.map(i => i.id)).toEqual([
				folderA.fsPath,
				folderB.fsPath,
				folderC.fsPath,
			]);
		});

		it('defaults cwd to first workspace folder when no selection made', () => {
			const folderInfo = multiRootProvider.getFolderInfoForSession('test-session');
			expect(folderInfo.cwd).toBe(folderA.fsPath);
			expect(folderInfo.additionalDirectories).toEqual([folderB.fsPath, folderC.fsPath]);
		});

		it('uses selected folder as cwd after provideHandleOptionsChange', async () => {
			const sessionUri = createClaudeSessionUri('test-session');
			await multiRootProvider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'folder', value: folderB.fsPath }],
				CancellationToken.None,
			);

			const folderInfo = multiRootProvider.getFolderInfoForSession('test-session');
			expect(folderInfo.cwd).toBe(folderB.fsPath);
			expect(folderInfo.additionalDirectories).toEqual([folderA.fsPath, folderC.fsPath]);
		});

		it('includes default folder in provideChatSessionContent options for untitled session', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);
			const sessionUri = createClaudeSessionUri('test-session');
			const result = await multiRootProvider.provideChatSessionContent(sessionUri, CancellationToken.None);

			// Should include folder option as string (not locked) for untitled sessions
			expect(result.options?.['folder']).toBe(folderA.fsPath);
		});

		it('locks folder option for existing sessions', async () => {
			const session: MockClaudeSession = {
				id: 'test-session',
				messages: [{
					type: 'user',
					message: { role: 'user', content: 'Hello' },
				}],
				subagents: [],
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(session as any);

			const sessionUri = createClaudeSessionUri('test-session');
			const result = await multiRootProvider.provideChatSessionContent(sessionUri, CancellationToken.None);

			const folderOption = result.options?.['folder'];
			expect(folderOption).toBeDefined();
			expect(typeof folderOption).toBe('object');
			expect((folderOption as vscode.ChatSessionProviderOptionItem).locked).toBe(true);
		});

		it('locked folder option preserves the selected folder, not the first one', async () => {
			// Simulate user selecting folder B before the session is created
			const untitledSessionUri = createClaudeSessionUri('untitled-session');
			await multiRootProvider.provideHandleOptionsChange(
				untitledSessionUri,
				[{ optionId: 'folder', value: folderB.fsPath }],
				CancellationToken.None,
			);

			// Verify the selection took effect
			const folderInfo = multiRootProvider.getFolderInfoForSession('untitled-session');
			expect(folderInfo.cwd).toBe(folderB.fsPath);

			// Now load the same session as an existing session (post-swap scenario)
			const session: MockClaudeSession = {
				id: 'untitled-session',
				messages: [{
					type: 'user',
					message: { role: 'user', content: 'Hello' },
				}],
				subagents: [],
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(session as any);

			const result = await multiRootProvider.provideChatSessionContent(untitledSessionUri, CancellationToken.None);

			const folderOption = result.options?.['folder'] as vscode.ChatSessionProviderOptionItem;
			expect(folderOption).toBeDefined();
			expect(folderOption.locked).toBe(true);
			// Should show folder B (the selected folder), not folder A (the first)
			expect(folderOption.id).toBe(folderB.fsPath);
		});
	});

	describe('folder option - empty workspace', () => {
		let emptyWorkspaceProvider: ClaudeChatSessionContentProvider;
		let emptyMocks: ReturnType<typeof createDefaultMocks>;

		beforeEach(() => {
			emptyMocks = createDefaultMocks();
			mockSessionService = emptyMocks.mockSessionService;
			mockClaudeCodeModels = emptyMocks.mockClaudeCodeModels;
			mockFolderRepositoryManager = emptyMocks.mockFolderRepositoryManager;

			const result = createProviderWithServices(store, [], emptyMocks);
			emptyWorkspaceProvider = result.provider;
		});

		it('includes folder option group with MRU entries', async () => {
			const mruFolder = URI.file('/recent/project');
			const mruRepo = URI.file('/recent/repo');
			mockFolderRepositoryManager.setMRUEntries([
				{ folder: mruFolder, repository: undefined, lastAccessed: Date.now(), isUntitledSessionSelection: true },
				{ folder: mruRepo, repository: mruRepo, lastAccessed: Date.now() - 1000, isUntitledSessionSelection: false },
			]);

			const options = await emptyWorkspaceProvider.provideChatSessionProviderOptions();
			const folderGroup = options.optionGroups?.find(g => g.id === 'folder');

			expect(folderGroup).toBeDefined();
			expect(folderGroup!.items).toHaveLength(2);
			expect(folderGroup!.items[0].id).toBe(mruFolder.fsPath);
			expect(folderGroup!.items[1].id).toBe(mruRepo.fsPath);
		});

		it('shows empty folder options when no MRU entries', async () => {
			const options = await emptyWorkspaceProvider.provideChatSessionProviderOptions();
			const folderGroup = options.optionGroups?.find(g => g.id === 'folder');

			expect(folderGroup).toBeDefined();
			expect(folderGroup!.items).toHaveLength(0);
		});

		it('getFolderInfoForSession uses MRU fallback when no selection', () => {
			const mruFolder = URI.file('/recent/project');
			mockFolderRepositoryManager.setMRUEntries([
				{ folder: mruFolder, repository: undefined, lastAccessed: Date.now(), isUntitledSessionSelection: true },
			]);

			const folderInfo = emptyWorkspaceProvider.getFolderInfoForSession('test-session');
			expect(folderInfo.cwd).toBe(mruFolder.fsPath);
			expect(folderInfo.additionalDirectories).toEqual([]);
		});

		it('getFolderInfoForSession throws when no folder available', () => {
			expect(() => emptyWorkspaceProvider.getFolderInfoForSession('test-session'))
				.toThrow('No folder available');
		});

		it('getFolderInfoForSession uses selected folder over MRU', async () => {
			const mruFolder = URI.file('/recent/project');
			const selectedFolder = URI.file('/selected/project');
			mockFolderRepositoryManager.setMRUEntries([
				{ folder: mruFolder, repository: undefined, lastAccessed: Date.now(), isUntitledSessionSelection: true },
			]);

			const sessionUri = createClaudeSessionUri('test-session');
			await emptyWorkspaceProvider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'folder', value: selectedFolder.fsPath }],
				CancellationToken.None,
			);

			const folderInfo = emptyWorkspaceProvider.getFolderInfoForSession('test-session');
			expect(folderInfo.cwd).toBe(selectedFolder.fsPath);
		});
	});

	// #endregion

	// #region Option Change Local Storage

	describe('provideHandleOptionsChange stores locally without updating session state', () => {
		it('stores model selection locally and does not update session state service', async () => {
			const sessionUri = createClaudeSessionUri('test-session');
			const mockSessionStateService = accessor.get(IClaudeSessionStateService);
			const setModelSpy = vi.spyOn(mockSessionStateService, 'setModelIdForSession');

			await provider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'model', value: 'claude-3-5-haiku-20241022' }],
				CancellationToken.None
			);

			// Session state service should NOT have been called
			expect(setModelSpy).not.toHaveBeenCalled();

			// But getModelIdForSession should return the local selection
			const modelId = await provider.getModelIdForSession('test-session');
			expect(modelId).toBe('claude-3-5-haiku-20241022');
		});

		it('stores permission mode selection locally and does not update session state service', async () => {
			const sessionUri = createClaudeSessionUri('test-session');
			const mockSessionStateService = accessor.get(IClaudeSessionStateService);
			const setPermissionSpy = vi.spyOn(mockSessionStateService, 'setPermissionModeForSession');

			await provider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'permissionMode', value: 'plan' }],
				CancellationToken.None
			);

			// Session state service should NOT have been called
			expect(setPermissionSpy).not.toHaveBeenCalled();

			// But getPermissionModeForSession should return the local selection
			const permissionMode = provider.getPermissionModeForSession('test-session');
			expect(permissionMode).toBe('plan');
		});

		it('local model selection is used in provideChatSessionContent', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);

			const sessionUri = createClaudeSessionUri('test-session');

			// Set a local model selection
			await provider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'model', value: 'claude-3-5-haiku-20241022' }],
				CancellationToken.None
			);

			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);
			expect(result.options?.['model']).toBe('claude-3-5-haiku-20241022');
		});

		it('local permission mode selection is used in provideChatSessionContent', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);

			const sessionUri = createClaudeSessionUri('test-session');

			// Set a local permission mode selection
			await provider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'permissionMode', value: 'plan' }],
				CancellationToken.None
			);

			const result = await provider.provideChatSessionContent(sessionUri, CancellationToken.None);
			expect(result.options?.['permissionMode']).toBe('plan');
		});

		it('local model selection takes priority over session state service', async () => {
			const sessionUri = createClaudeSessionUri('test-session');

			// Set a value in the session state service directly (as if committed during a previous request)
			const mockSessionStateService = accessor.get(IClaudeSessionStateService);
			mockSessionStateService.setModelIdForSession('test-session', 'claude-3-5-sonnet-20241022');

			// Now set a different local selection
			await provider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'model', value: 'claude-3-5-haiku-20241022' }],
				CancellationToken.None
			);

			// Local selection should take priority
			const modelId = await provider.getModelIdForSession('test-session');
			expect(modelId).toBe('claude-3-5-haiku-20241022');
		});

		it('local permission mode selection takes priority over session state service', async () => {
			const sessionUri = createClaudeSessionUri('test-session');

			// Set a value in the session state service directly
			const mockSessionStateService = accessor.get(IClaudeSessionStateService);
			mockSessionStateService.setPermissionModeForSession('test-session', 'acceptEdits');

			// Now set a different local selection
			await provider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'permissionMode', value: 'plan' }],
				CancellationToken.None
			);

			// Local selection should take priority
			const permissionMode = provider.getPermissionModeForSession('test-session');
			expect(permissionMode).toBe('plan');
		});
	});

	// #endregion

	// #region Session ID Handling

	describe('session ID handling in handler', () => {
		let mockAgentManager: ClaudeAgentManager;
		let handlerProvider: ClaudeChatSessionContentProvider;
		let handlerAccessor: ITestingServicesAccessor;

		function createChatContext(sessionId: string): vscode.ChatContext {
			return {
				history: [],
				yieldRequested: false,
				chatSessionContext: {
					isUntitled: false,
					chatSessionItem: {
						resource: ClaudeSessionUri.forSessionId(sessionId),
						label: 'Test Session',
					},
				},
			} as vscode.ChatContext;
		}

		beforeEach(() => {
			const mocks = createDefaultMocks();
			mockSessionService = mocks.mockSessionService;
			mockClaudeCodeModels = mocks.mockClaudeCodeModels;
			mockFolderRepositoryManager = mocks.mockFolderRepositoryManager;
			mockAgentManager = createMockAgentManager();

			const result = createProviderWithServices(store, [workspaceFolderUri], mocks, mockAgentManager);
			handlerProvider = result.provider;
			handlerAccessor = result.accessor;
		});

		it('uses session ID from resource directly', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);

			const handler = handlerProvider.createHandler();
			const context = createChatContext('my-session-id');
			const stream = new MockChatResponseStream();

			await handler(new TestChatRequest('hello'), context, stream, CancellationToken.None);

			const handleRequestMock = vi.mocked(mockAgentManager.handleRequest);
			expect(handleRequestMock).toHaveBeenCalledOnce();

			const [sessionId] = handleRequestMock.mock.calls[0];
			expect(sessionId).toBe('my-session-id');
		});

		it('marks session as new when no existing session on disk', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);

			const handler = handlerProvider.createHandler();
			const context = createChatContext('new-session');
			const stream = new MockChatResponseStream();

			await handler(new TestChatRequest('hello'), context, stream, CancellationToken.None);

			const handleRequestMock = vi.mocked(mockAgentManager.handleRequest);
			const [, , , , , isNewSession] = handleRequestMock.mock.calls[0];
			expect(isNewSession).toBe(true);
		});

		it('marks session as existing when session exists on disk', async () => {
			const existingSession = {
				id: 'existing-session',
				messages: [{ type: 'user', message: { role: 'user', content: 'Hello' } }],
				subagents: [],
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(existingSession as any);

			const handler = handlerProvider.createHandler();
			const context = createChatContext('existing-session');
			const stream = new MockChatResponseStream();

			await handler(new TestChatRequest('hello'), context, stream, CancellationToken.None);

			const handleRequestMock = vi.mocked(mockAgentManager.handleRequest);
			const [sessionId, , , , , isNewSession] = handleRequestMock.mock.calls[0];
			expect(sessionId).toBe('existing-session');
			expect(isNewSession).toBe(false);
		});

		it('commits option selections to session state under the resource session ID', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);

			const sessionUri = createClaudeSessionUri('my-session');
			await handlerProvider.provideHandleOptionsChange(
				sessionUri,
				[
					{ optionId: 'model', value: 'claude-3-5-haiku-20241022' },
					{ optionId: 'permissionMode', value: 'plan' },
				],
				CancellationToken.None,
			);

			const handler = handlerProvider.createHandler();
			const context = createChatContext('my-session');
			const stream = new MockChatResponseStream();

			await handler(new TestChatRequest('hello'), context, stream, CancellationToken.None);

			const sessionStateService = handlerAccessor.get(IClaudeSessionStateService);
			const committedModel = await sessionStateService.getModelIdForSession('my-session');
			expect(committedModel).toBe('claude-3-5-haiku-20241022');

			const committedPermission = sessionStateService.getPermissionModeForSession('my-session');
			expect(committedPermission).toBe('plan');
		});

		it('commits folder info to session state under the resource session ID in multi-root workspace', async () => {
			const folderA = URI.file('/project-a');
			const folderB = URI.file('/project-b');
			const mocks = createDefaultMocks();
			mockClaudeCodeModels = mocks.mockClaudeCodeModels;
			const multiMockAgentManager = createMockAgentManager();
			const result = createProviderWithServices(store, [folderA, folderB], mocks, multiMockAgentManager);
			const multiProvider = result.provider;

			vi.mocked(mocks.mockSessionService.getSession).mockResolvedValue(undefined);

			const sessionUri = createClaudeSessionUri('my-session');
			await multiProvider.provideHandleOptionsChange(
				sessionUri,
				[{ optionId: 'folder', value: folderB.fsPath }],
				CancellationToken.None,
			);

			const handler = multiProvider.createHandler();
			const context = createChatContext('my-session');
			const stream = new MockChatResponseStream();

			await handler(new TestChatRequest('hello'), context, stream, CancellationToken.None);

			const sessionStateService = result.accessor.get(IClaudeSessionStateService);
			const committedFolder = sessionStateService.getFolderInfoForSession('my-session');
			expect(committedFolder?.cwd).toBe(folderB.fsPath);
		});

		it('onDidChangeSessionState fires event with the session resource', async () => {
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);

			const handler = handlerProvider.createHandler();
			const context = createChatContext('my-session');
			const stream = new MockChatResponseStream();

			await handler(new TestChatRequest('hello'), context, stream, CancellationToken.None);

			// Listen for option change events
			const firedEvents: vscode.ChatSessionOptionChangeEvent[] = [];
			handlerProvider.onDidChangeChatSessionOptions(e => firedEvents.push(e));

			// Simulate the session state service updating the model
			const sessionStateService = handlerAccessor.get(IClaudeSessionStateService);
			sessionStateService.setModelIdForSession('my-session', 'claude-3-5-haiku-20241022');

			expect(firedEvents).toHaveLength(1);
			expect(ClaudeSessionUri.getId(firedEvents[0].resource)).toBe('my-session');
			expect(firedEvents[0].updates).toContainEqual({ optionId: 'model', value: 'claude-3-5-haiku-20241022' });
		});
	});

	// #endregion

	// #region Handler Integration

	describe('handler integration', () => {
		let mockAgentManager: ClaudeAgentManager;
		let handlerProvider: ClaudeChatSessionContentProvider;
		let handlerAccessor: ITestingServicesAccessor;

		function createChatContext(sessionId: string): vscode.ChatContext {
			return {
				history: [],
				yieldRequested: false,
				chatSessionContext: {
					isUntitled: false,
					chatSessionItem: {
						resource: ClaudeSessionUri.forSessionId(sessionId),
						label: 'Test Session',
					},
				},
			} as vscode.ChatContext;
		}

		beforeEach(() => {
			const mocks = createDefaultMocks();
			mockSessionService = mocks.mockSessionService;
			mockClaudeCodeModels = mocks.mockClaudeCodeModels;
			mockFolderRepositoryManager = mocks.mockFolderRepositoryManager;
			mockAgentManager = createMockAgentManager();

			const result = createProviderWithServices(store, [workspaceFolderUri], mocks, mockAgentManager);
			handlerProvider = result.provider;
			handlerAccessor = result.accessor;
		});

		it('returns errorDetails when no Claude models are available', async () => {
			vi.mocked(mockClaudeCodeModels.getModels).mockResolvedValue([]);
			vi.mocked(mockClaudeCodeModels.getDefaultModel).mockRejectedValue(new NoClaudeModelsAvailableError());

			const handler = handlerProvider.createHandler();
			const context = createChatContext('session-1');
			const stream = new MockChatResponseStream();

			const result = await handler(new TestChatRequest('hello'), context, stream, CancellationToken.None);

			expect(result).toBeDefined();
			expect(result!.errorDetails).toBeDefined();
			expect(result!.errorDetails!.message).toBeDefined();
			// handleRequest should NOT have been called
			expect(vi.mocked(mockAgentManager.handleRequest)).not.toHaveBeenCalled();
		});

		it('short-circuits when slash command is handled', async () => {
			const slashCommandService = handlerAccessor.get(IClaudeSlashCommandService);
			vi.mocked(slashCommandService.tryHandleCommand).mockResolvedValue({
				handled: true,
				result: { metadata: { command: '/test' } },
			} as any);

			const handler = handlerProvider.createHandler();
			const context = createChatContext('session-1');
			const stream = new MockChatResponseStream();

			const result = await handler(new TestChatRequest('/test'), context, stream, CancellationToken.None);

			// Slash command handled → no agent call
			expect(vi.mocked(mockAgentManager.handleRequest)).not.toHaveBeenCalled();
			expect(result).toEqual({ metadata: { command: '/test' } });
		});
	});

	// #endregion
});

// #region FakeGitService

/**
 * A git service mock with event emitters that can be fired in tests.
 * Unlike MockGitService, this supports onDidOpenRepository event firing.
 */
class FakeGitService extends mock<IGitService>() {
	private readonly _onDidOpenRepository = new Emitter<RepoContext>();
	override readonly onDidOpenRepository = this._onDidOpenRepository.event;

	private readonly _onDidCloseRepository = new Emitter<RepoContext>();
	override readonly onDidCloseRepository = this._onDidCloseRepository.event;

	override readonly onDidFinishInitialization: Event<void> = Event.None;

	override repositories: RepoContext[] = [];
	override isInitialized = true;

	fireOpenRepository(repo: RepoContext): void {
		this._onDidOpenRepository.fire(repo);
	}

	fireCloseRepository(repo: RepoContext): void {
		this._onDidCloseRepository.fire(repo);
	}

	override dispose(): void {
		this._onDidOpenRepository.dispose();
		this._onDidCloseRepository.dispose();
	}
}

// #endregion

describe('ClaudeChatSessionItemController', () => {
	const store = new DisposableStore();
	let mockSessionService: IClaudeCodeSessionService;
	let controller: ClaudeChatSessionItemController;

	function getItem(sessionId: string): vscode.ChatSessionItem | undefined {
		return lastCreatedItemsMap.get(ClaudeSessionUri.forSessionId(sessionId).toString());
	}

	function createController(workspaceFolders: URI[], gitService?: IGitService): ClaudeChatSessionItemController {
		const serviceCollection = store.add(createExtensionUnitTestingServices());
		const workspaceService = new TestWorkspaceService(workspaceFolders);
		serviceCollection.set(IWorkspaceService, workspaceService);
		serviceCollection.set(IGitService, gitService ?? new MockGitService());
		serviceCollection.define(IClaudeCodeSessionService, mockSessionService);

		const accessor = serviceCollection.createTestingAccessor();
		const ctrl = accessor.get(IInstantiationService).createInstance(ClaudeChatSessionItemController);
		store.add(ctrl);
		return ctrl;
	}

	beforeEach(() => {
		mockSessionService = {
			_serviceBrand: undefined,
			getSession: vi.fn().mockResolvedValue(undefined),
			getAllSessions: vi.fn().mockResolvedValue([]),
			getLastParseErrors: vi.fn().mockReturnValue([]),
		} as unknown as IClaudeCodeSessionService;
	});

	afterEach(() => {
		vi.clearAllMocks();
		store.clear();
	});

	// #region updateItemStatus

	describe('updateItemStatus', () => {
		beforeEach(() => {
			controller = createController([URI.file('/project')]);
		});

		it('creates a new item with the provided label when no disk session exists', async () => {
			await controller.updateItemStatus('new-session', ChatSessionStatus.InProgress, 'Hello world');

			const item = getItem('new-session');
			expect(item).toBeDefined();
			expect(item!.label).toBe('Hello world');
			expect(item!.status).toBe(ChatSessionStatus.InProgress);
		});

		it('sets timing.lastRequestStarted and clears lastRequestEnded for InProgress', async () => {
			const before = Date.now();
			await controller.updateItemStatus('session-1', ChatSessionStatus.InProgress, 'Test prompt');
			const after = Date.now();

			const item = getItem('session-1');
			expect(item!.timing).toBeDefined();
			expect(item!.timing!.lastRequestStarted).toBeGreaterThanOrEqual(before);
			expect(item!.timing!.lastRequestStarted).toBeLessThanOrEqual(after);
			expect(item!.timing!.lastRequestEnded).toBeUndefined();
		});

		it('sets timing.lastRequestEnded for Completed status', async () => {
			await controller.updateItemStatus('session-1', ChatSessionStatus.InProgress, 'Test prompt');

			const beforeComplete = Date.now();
			await controller.updateItemStatus('session-1', ChatSessionStatus.Completed, 'Test prompt');
			const afterComplete = Date.now();

			const item = getItem('session-1');
			expect(item!.timing!.lastRequestEnded).toBeGreaterThanOrEqual(beforeComplete);
			expect(item!.timing!.lastRequestEnded).toBeLessThanOrEqual(afterComplete);
		});

		it('clears lastRequestEnded on second InProgress after Completed', async () => {
			await controller.updateItemStatus('session-1', ChatSessionStatus.InProgress, 'Test prompt');
			await controller.updateItemStatus('session-1', ChatSessionStatus.Completed, 'Test prompt');
			await controller.updateItemStatus('session-1', ChatSessionStatus.InProgress, 'Test prompt');

			const item = getItem('session-1');
			expect(item!.timing!.lastRequestEnded).toBeUndefined();
			expect(item!.timing!.lastRequestStarted).toBeDefined();
		});

		it('creates timing with lastRequestEnded when Completed is called without prior InProgress', async () => {
			const before = Date.now();
			await controller.updateItemStatus('session-1', ChatSessionStatus.Completed, 'Test prompt');
			const after = Date.now();

			const item = getItem('session-1');
			expect(item!.timing).toBeDefined();
			expect(item!.timing!.created).toBeGreaterThanOrEqual(before);
			expect(item!.timing!.created).toBeLessThanOrEqual(after);
			expect(item!.timing!.lastRequestEnded).toBeGreaterThanOrEqual(before);
			expect(item!.timing!.lastRequestEnded).toBeLessThanOrEqual(after);
		});

		it('uses session data from disk when available', async () => {
			const diskSession: IClaudeCodeSessionInfo = {
				id: 'disk-session',
				label: 'Disk Session Label',
				created: new Date('2024-01-01T00:00:00Z').getTime(),
				lastRequestEnded: new Date('2024-01-01T01:00:00Z').getTime(),
				folderName: 'my-project',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(diskSession as any);

			await controller.updateItemStatus('disk-session', ChatSessionStatus.InProgress, 'Ignored label');

			const item = getItem('disk-session');
			expect(item).toBeDefined();
			expect(item!.label).toBe('Disk Session Label');
			expect(item!.tooltip).toBe('Claude Code session: Disk Session Label');

			expect(mockSessionService.getSession).toHaveBeenCalledOnce();
			const [calledUri] = vi.mocked(mockSessionService.getSession).mock.calls[0];
			expect(calledUri.scheme).toBe('claude-code');
			expect(calledUri.path).toBe('/disk-session');
		});

		it('handles multiple independent sessions', async () => {
			await controller.updateItemStatus('session-a', ChatSessionStatus.InProgress, 'Prompt A');
			await controller.updateItemStatus('session-b', ChatSessionStatus.InProgress, 'Prompt B');
			await controller.updateItemStatus('session-a', ChatSessionStatus.Completed, 'Prompt A');

			const itemA = getItem('session-a');
			const itemB = getItem('session-b');
			expect(itemA!.status).toBe(ChatSessionStatus.Completed);
			expect(itemB!.status).toBe(ChatSessionStatus.InProgress);
		});
	});

	// #endregion

	// #region Session item properties

	describe('session item properties', () => {
		beforeEach(() => {
			controller = createController([URI.file('/project')]);
		});

		it('sets resource with correct scheme and path', async () => {
			await controller.updateItemStatus('my-session', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('my-session');
			expect(item!.resource.scheme).toBe('claude-code');
			expect(item!.resource.path).toBe('/my-session');
		});

		it('sets tooltip to formatted session name', async () => {
			await controller.updateItemStatus('my-session', ChatSessionStatus.InProgress, 'fix the bug');

			const item = getItem('my-session');
			expect(item!.tooltip).toBe('Claude Code session: fix the bug');
		});

		it('sets iconPath to claude ThemeIcon', async () => {
			await controller.updateItemStatus('my-session', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('my-session');
			expect(item!.iconPath).toBeDefined();
			expect(item!.iconPath).toBeInstanceOf(ThemeIcon);
			expect((item!.iconPath as ThemeIcon).id).toBe('claude');
		});

		it('uses disk session label and timestamps when available', async () => {
			const diskSession: IClaudeCodeSessionInfo = {
				id: 'disk-session',
				label: 'Disk Label',
				created: new Date('2024-06-01T12:00:00Z').getTime(),
				lastRequestEnded: new Date('2024-06-01T13:00:00Z').getTime(),
				folderName: undefined,
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(diskSession as any);

			await controller.updateItemStatus('disk-session', ChatSessionStatus.InProgress, 'Prompt');

			const item = getItem('disk-session');
			expect(item!.label).toBe('Disk Label');
			expect(item!.tooltip).toBe('Claude Code session: Disk Label');
			// timing.created is derived from created
			expect(item!.timing!.created).toBe(new Date('2024-06-01T12:00:00Z').getTime());
		});
	});

	// #endregion

	// #region Badge visibility

	describe('badge visibility', () => {
		it('does not show badge in single-root workspace with zero repos', async () => {
			controller = createController([URI.file('/project')]);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test',
				label: 'Test',
				created: Date.now(),
				lastRequestEnded: Date.now(),
				folderName: 'project',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);

			await controller.updateItemStatus('test', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('test');
			expect(item!.badge).toBeUndefined();
		});

		it('shows badge in multi-root workspace', async () => {
			controller = createController([URI.file('/project-a'), URI.file('/project-b')]);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test',
				label: 'Test',
				created: Date.now(),
				lastRequestEnded: Date.now(),
				folderName: 'project-a',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);

			await controller.updateItemStatus('test', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('test');
			expect(item!.badge).toBeDefined();
			expect(item!.badge).toBeInstanceOf(MarkdownString);
			expect((item!.badge as MarkdownString).value).toBe('$(folder) project-a');
		});

		it('shows badge in empty workspace', async () => {
			controller = createController([]);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test',
				label: 'Test',
				created: Date.now(),
				lastRequestEnded: Date.now(),
				folderName: 'my-folder',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);

			await controller.updateItemStatus('test', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('test');
			expect(item!.badge).toBeDefined();
			expect((item!.badge as MarkdownString).value).toBe('$(folder) my-folder');
		});

		it('badge has supportThemeIcons set to true', async () => {
			controller = createController([URI.file('/a'), URI.file('/b')]);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test',
				label: 'Test',
				created: Date.now(),
				lastRequestEnded: Date.now(),
				folderName: 'project',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);

			await controller.updateItemStatus('test', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('test');
			expect((item!.badge as MarkdownString).supportThemeIcons).toBe(true);
		});

		it('badge is undefined when session has no folderName', async () => {
			controller = createController([URI.file('/a'), URI.file('/b')]);

			await controller.updateItemStatus('test', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('test');
			// No disk session → no folderName → no badge even though multi-root
			expect(item!.badge).toBeUndefined();
		});

		it('different sessions show their own folder names', async () => {
			controller = createController([URI.file('/a'), URI.file('/b')]);

			vi.mocked(mockSessionService.getSession)
				.mockResolvedValueOnce({
					id: 'session-1', label: 'S1',
					created: Date.now(), lastRequestEnded: Date.now(),
					folderName: 'frontend',
				} as any)
				.mockResolvedValueOnce({
					id: 'session-2', label: 'S2',
					created: Date.now(), lastRequestEnded: Date.now(),
					folderName: 'backend',
				} as any);

			await controller.updateItemStatus('session-1', ChatSessionStatus.InProgress, 'S1');
			await controller.updateItemStatus('session-2', ChatSessionStatus.InProgress, 'S2');

			expect((getItem('session-1')!.badge as MarkdownString).value).toBe('$(folder) frontend');
			expect((getItem('session-2')!.badge as MarkdownString).value).toBe('$(folder) backend');
		});

		it('shows badge in single-root workspace with multiple non-worktree repos', async () => {
			const fakeGit = new FakeGitService();
			fakeGit.repositories = [
				{ rootUri: URI.file('/project/repo1'), kind: 'repository' } as unknown as RepoContext,
				{ rootUri: URI.file('/project/repo2'), kind: 'repository' } as unknown as RepoContext,
			];
			controller = createController([URI.file('/project')], fakeGit);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test', label: 'Test',
				created: Date.now(), lastRequestEnded: Date.now(),
				folderName: 'repo1',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);

			await controller.updateItemStatus('test', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('test');
			expect(item!.badge).toBeDefined();
			expect((item!.badge as MarkdownString).value).toBe('$(folder) repo1');
		});

		it('does not show badge when extra repos are worktrees', async () => {
			const fakeGit = new FakeGitService();
			fakeGit.repositories = [
				{ rootUri: URI.file('/project/main'), kind: 'repository' } as unknown as RepoContext,
				{ rootUri: URI.file('/project/wt'), kind: 'worktree' } as unknown as RepoContext,
			];
			controller = createController([URI.file('/project')], fakeGit);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test', label: 'Test',
				created: Date.now(), lastRequestEnded: Date.now(),
				folderName: 'main',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);

			await controller.updateItemStatus('test', ChatSessionStatus.InProgress, 'hello');

			const item = getItem('test');
			// Only 1 non-worktree repo → no badge
			expect(item!.badge).toBeUndefined();
		});
	});

	// #endregion

	// #region Git event refresh

	describe('git event refresh', () => {
		it('recomputes badge when a repository opens', async () => {
			const fakeGit = new FakeGitService();
			fakeGit.repositories = [];
			controller = createController([URI.file('/project')], fakeGit);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test', label: 'Test',
				created: Date.now(), lastRequestEnded: Date.now(),
				folderName: 'repo1',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);
			vi.mocked(mockSessionService.getAllSessions).mockResolvedValue([sessionInfo]);

			// Initially no repos → single-root with 0 repos, _computeShowBadge returns false
			await controller.updateItemStatus('test', ChatSessionStatus.Completed, 'hello');
			expect(getItem('test')!.badge).toBeUndefined();

			// Now simulate two repos opening (monorepo scenario)
			const repo1 = { rootUri: URI.file('/project/r1'), kind: 'repository' } as unknown as RepoContext;
			const repo2 = { rootUri: URI.file('/project/r2'), kind: 'repository' } as unknown as RepoContext;
			fakeGit.repositories = [repo1, repo2];
			fakeGit.fireOpenRepository(repo2);

			// Flush microtask queue so the async _refreshItems completes.
			await new Promise(r => setTimeout(r, 0));

			const refreshedItem = getItem('test');
			expect(refreshedItem).toBeDefined();
			expect(refreshedItem!.badge).toBeDefined();
			expect((refreshedItem!.badge as MarkdownString).value).toBe('$(folder) repo1');
		});

		it('recomputes badge when a repository closes', async () => {
			const fakeGit = new FakeGitService();
			const repo1 = { rootUri: URI.file('/project/r1'), kind: 'repository' } as unknown as RepoContext;
			const repo2 = { rootUri: URI.file('/project/r2'), kind: 'repository' } as unknown as RepoContext;
			fakeGit.repositories = [repo1, repo2];
			controller = createController([URI.file('/project')], fakeGit);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test', label: 'Test',
				created: Date.now(), lastRequestEnded: Date.now(),
				folderName: 'repo1',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);
			vi.mocked(mockSessionService.getAllSessions).mockResolvedValue([sessionInfo]);

			await controller.updateItemStatus('test', ChatSessionStatus.Completed, 'hello');
			expect(getItem('test')!.badge).toBeDefined();

			// Close one repo → single non-worktree repo → badge should disappear
			fakeGit.repositories = [repo1];
			fakeGit.fireCloseRepository(repo2);

			// Flush microtask queue so the async _refreshItems completes.
			await new Promise(r => setTimeout(r, 0));

			const refreshedItem = getItem('test');
			expect(refreshedItem).toBeDefined();
			expect(refreshedItem!.badge).toBeUndefined();
		});

		it('preserves in-progress items after refresh', async () => {
			const fakeGit = new FakeGitService();
			fakeGit.repositories = [];
			controller = createController([URI.file('/project')], fakeGit);

			const sessionInfo: IClaudeCodeSessionInfo = {
				id: 'test', label: 'Test',
				created: Date.now(), lastRequestEnded: Date.now(),
				folderName: 'repo1',
			};
			vi.mocked(mockSessionService.getSession).mockResolvedValue(sessionInfo as any);
			vi.mocked(mockSessionService.getAllSessions).mockResolvedValue([sessionInfo]);

			await controller.updateItemStatus('test', ChatSessionStatus.InProgress, 'hello');
			const itemBeforeRefresh = getItem('test');
			expect(itemBeforeRefresh).toBeDefined();
			expect(itemBeforeRefresh!.status).toBe(ChatSessionStatus.InProgress);

			// Trigger a refresh via git event
			const repo1 = { rootUri: URI.file('/project/r1'), kind: 'repository' } as unknown as RepoContext;
			fakeGit.repositories = [repo1];
			fakeGit.fireOpenRepository(repo1);

			await new Promise(r => setTimeout(r, 0));

			const refreshedItem = getItem('test');
			expect(refreshedItem).toBeDefined();
			expect(refreshedItem!.status).toBe(ChatSessionStatus.InProgress);
		});
	});

	// #endregion
});


function createClaudeSessionUri(id: string): URI {
	return URI.parse(`claude-code:/${id}`);
}
