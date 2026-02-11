/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../../util/vs/platform/instantiation/common/serviceCollection';
import { ChatRequestTurn, ChatResponseMarkdownPart, ChatResponseTurn2, ChatToolInvocationPart } from '../../../../vscodeTypes';
import { IClaudeCodeModels, NoClaudeModelsAvailableError } from '../../../agents/claude/node/claudeCodeModels';
import { IClaudeSessionStateService } from '../../../agents/claude/node/claudeSessionStateService';
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../../agents/claude/node/sessionParser/claudeCodeSessionService';
import { IClaudeSlashCommandService } from '../../../agents/claude/vscode-node/claudeSlashCommandService';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { FolderRepositoryMRUEntry, IFolderRepositoryManager } from '../../common/folderRepositoryManager';
import { ClaudeChatSessionContentProvider, UNAVAILABLE_MODEL_ID } from '../claudeChatSessionContentProvider';
import type { ClaudeAgentManager } from '../../../agents/claude/node/claudeCodeAgent';
import type { ClaudeChatSessionItemProvider } from '../claudeChatSessionItemProvider';

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

function createProviderWithServices(
	store: DisposableStore,
	workspaceFolders: URI[],
	mocks: ReturnType<typeof createDefaultMocks>,
): { provider: ClaudeChatSessionContentProvider; accessor: ITestingServicesAccessor } {
	const serviceCollection = store.add(createExtensionUnitTestingServices());

	const workspaceService = new TestWorkspaceService(workspaceFolders);
	serviceCollection.set(IWorkspaceService, workspaceService);

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
	const provider = instaService.createInstance(ClaudeChatSessionContentProvider, {} as ClaudeAgentManager, {} as ClaudeChatSessionItemProvider);
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
		const provider = childInstantiationService.createInstance(ClaudeChatSessionContentProvider, {} as ClaudeAgentManager, {} as ClaudeChatSessionItemProvider);

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
			mockSessionStateService.getModelIdForSession = vi.fn().mockResolvedValue('claude-sonnet-4-20250514');

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
});


function createClaudeSessionUri(id: string): URI {
	return URI.parse(`claude-code:/${id}`);
}
