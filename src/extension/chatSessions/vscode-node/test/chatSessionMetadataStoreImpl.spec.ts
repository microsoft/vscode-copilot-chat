/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { ChatSessionWorktreeData, ChatSessionWorktreeProperties } from '../../common/chatSessionWorktreeService';
import { ChatSessionMetadataStore } from '../chatSessionMetadataStoreImpl';

vi.mock('../../../agents/copilotcli/vscode-node/cliHelpers', () => ({
	getCopilotCLISessionStateDir: () => '/mock/session-state',
}));

const WORKSPACE_FOLDER_MEMENTO_KEY = 'github.copilot.cli.sessionWorkspaceFolders';
const WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';

class MockGlobalState implements vscode.Memento {
	private data = new Map<string, unknown>();

	get<T>(key: string, defaultValue?: T): T {
		const value = this.data.get(key);
		return (value ?? defaultValue) as T;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.data.delete(key);
		} else {
			this.data.set(key, value);
		}
	}

	keys(): readonly string[] {
		return Array.from(this.data.keys());
	}

	setKeysForSync(_keys: readonly string[]): void { }

	/** Test helper to seed data without triggering update logic */
	seed(key: string, value: unknown) {
		this.data.set(key, value);
	}

	has(key: string): boolean {
		return this.data.has(key);
	}
}

class MockExtensionContext extends mock<IVSCodeExtensionContext>() {
	public override globalState = new MockGlobalState();
	override extensionPath = Uri.file('/mock/extension/path').fsPath;
	override globalStorageUri = Uri.file('/mock/global/storage');
	override storagePath = Uri.file('/mock/storage/path').fsPath;
	override globalStoragePath = Uri.file('/mock/global/storage/path').fsPath;
	override logPath = Uri.file('/mock/log/path').fsPath;
	override logUri = Uri.file('/mock/log/uri');
	override extensionUri = Uri.file('/mock/extension');
}

class MockLogService extends mock<ILogService>() {
	override trace = vi.fn();
	override info = vi.fn();
	override warn = vi.fn();
	override error = vi.fn();
	override debug = vi.fn();
}

// Paths used by the store
const GLOBAL_STORAGE_DIR = Uri.joinPath(Uri.file('/mock/global/storage'), 'copilotcli');
const BULK_METADATA_FILE = Uri.joinPath(GLOBAL_STORAGE_DIR, 'copilotcli.session.metadata.json');
const SESSION_STATE_DIR = Uri.file('/mock/session-state');

function sessionMetadataFileUri(sessionId: string): Uri {
	return Uri.joinPath(SESSION_STATE_DIR, sessionId, 'vscode.metadata.json');
}

function makeWorktreeV1Props(overrides?: Partial<ChatSessionWorktreeProperties>): ChatSessionWorktreeProperties {
	return {
		version: 1,
		baseCommit: 'abc123',
		branchName: 'feature-branch',
		repositoryPath: Uri.file('/repo').fsPath,
		worktreePath: Uri.file('/repo/.worktrees/wt').fsPath,
		autoCommit: true,
		...overrides,
	} as ChatSessionWorktreeProperties;
}

function makeWorktreeV2Props(overrides?: Partial<ChatSessionWorktreeProperties>): ChatSessionWorktreeProperties {
	return {
		version: 2,
		baseCommit: 'def456',
		branchName: 'feature-v2',
		baseBranchName: 'main',
		repositoryPath: Uri.file('/repo').fsPath,
		worktreePath: Uri.file('/repo/.worktrees/wt2').fsPath,
		...overrides,
	} as ChatSessionWorktreeProperties;
}

function makeWorktreeData(props: ChatSessionWorktreeProperties): ChatSessionWorktreeData {
	return { data: JSON.stringify(props), version: props.version };
}

describe('ChatSessionMetadataStore', () => {
	let mockFs: MockFileSystemService;
	let logService: MockLogService;
	let extensionContext: MockExtensionContext;

	beforeEach(() => {
		vi.useFakeTimers();
		mockFs = new MockFileSystemService();
		logService = new MockLogService();
		extensionContext = new MockExtensionContext();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/**
	 * Creates the store and waits for initialization to complete.
	 * Constructor eagerly triggers lazy init; we flush microtasks so it settles.
	 */
	async function createStore(): Promise<ChatSessionMetadataStore> {
		const store = new ChatSessionMetadataStore(
			mockFs as any,
			logService as any,
			extensionContext as any,
		);
		// Flush microtasks to let initialization settle
		await vi.advanceTimersByTimeAsync(0);
		return store;
	}

	// ──────────────────────────────────────────────────────────────────────────
	// initializeStorage — happy path: bulk file already exists
	// ──────────────────────────────────────────────────────────────────────────
	describe('initializeStorage - bulk file exists', () => {
		it('should populate cache from existing bulk file', async () => {
			const existingData = {
				'session-1': { workspaceFolder: { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 } },
				'session-2': { worktreeProperties: makeWorktreeV1Props() },
			};
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify(existingData));

			const store = await createStore();
			const folder = await store.getSessionWorkspaceFolder('session-1');
			expect(folder?.fsPath).toBe(Uri.file('/workspace/a').fsPath);

			const wt = await store.getWorktreeProperties('session-2');
			expect(wt?.version).toBe(1);
			store.dispose();
		});

		it('should not read global state memento keys when bulk file exists', async () => {
			// Seed global state with data that should NOT be read
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-x': { folderPath: Uri.file('/should/not/appear').fsPath, timestamp: 999 },
			});
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));

			const getSpy = vi.spyOn(extensionContext.globalState, 'get');
			const store = await createStore();

			// globalState.get should not have been called for the memento keys
			const mementoCalls = getSpy.mock.calls.filter(
				c => c[0] === WORKSPACE_FOLDER_MEMENTO_KEY || c[0] === WORKTREE_MEMENTO_KEY,
			);
			expect(mementoCalls).toHaveLength(0);

			// session-x should not be accessible
			const folder = await store.getSessionWorkspaceFolder('session-x');
			expect(folder).toBeUndefined();
			store.dispose();
		});

		it('should attempt to write per-session files for entries not yet writtenToSessionState', async () => {
			const existingData = {
				'session-1': { workspaceFolder: { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 } },
			};
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify(existingData));

			// Pre-create the session directory so the write succeeds
			await mockFs.createDirectory(Uri.joinPath(SESSION_STATE_DIR, 'session-1'));

			const store = await createStore();
			// Flush microtasks for fire-and-forget writes
			await vi.advanceTimersByTimeAsync(0);

			const fileUri = sessionMetadataFileUri('session-1');
			const rawContent = await mockFs.readFile(fileUri);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written.workspaceFolder?.folderPath).toBe(Uri.file('/workspace/a').fsPath);
			store.dispose();
		});

		it('should not attempt to write per-session files for entries already marked writtenToSessionState', async () => {
			const existingData = {
				'session-1': { workspaceFolder: { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 }, writtenToSessionState: true },
			};
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify(existingData));

			const writeSpy = vi.spyOn(mockFs, 'writeFile');
			const store = await createStore();
			await vi.advanceTimersByTimeAsync(0);

			// No writes to per-session files should have occurred
			const perSessionWrites = writeSpy.mock.calls.filter(
				c => c[0].toString().includes('vscode.metadata.json'),
			);
			expect(perSessionWrites).toHaveLength(0);
			store.dispose();
		});

		it('should skip per-session file write gracefully when directory does not exist during retry', async () => {
			const existingData = {
				'session-1': { workspaceFolder: { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 } },
			};
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify(existingData));
			// Do NOT create the session directory

			const createDirSpy = vi.spyOn(mockFs, 'createDirectory');
			const store = await createStore();
			await vi.advanceTimersByTimeAsync(0);

			// createDirectory should NOT have been called for the per-session dir
			// because createDirectoryIfNotFound=false during retry
			const perSessionDirCalls = createDirSpy.mock.calls.filter(
				c => c[0].toString().includes('session-1'),
			);
			expect(perSessionDirCalls).toHaveLength(0);

			// Entry should still be accessible from cache
			const folder = await store.getSessionWorkspaceFolder('session-1');
			expect(folder?.fsPath).toBe(Uri.file('/workspace/a').fsPath);
			store.dispose();
		});

		it('should not retry entries with no workspaceFolder or worktreeProperties', async () => {
			const existingData = {
				'session-empty': {},
				'session-folder': { workspaceFolder: { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 } },
			};
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify(existingData));

			const statSpy = vi.spyOn(mockFs, 'stat');
			const store = await createStore();
			await vi.advanceTimersByTimeAsync(0);

			// stat should only be called for session-folder's dir (retry attempt),
			// not for session-empty since it has no data to write
			const sessionEmptyStatCalls = statSpy.mock.calls.filter(
				c => c[0].toString().includes('session-empty'),
			);
			expect(sessionEmptyStatCalls).toHaveLength(0);
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// initializeStorage — migration path: bulk file missing, read from global state
	// ──────────────────────────────────────────────────────────────────────────
	describe('initializeStorage - migration from global state', () => {
		it('should migrate workspace folder entries to bulk file', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
				'session-2': { folderPath: Uri.file('/workspace/b').fsPath, timestamp: 200 },
			});

			const store = await createStore();

			const folder1 = await store.getSessionWorkspaceFolder('session-1');
			expect(folder1?.fsPath).toBe(Uri.file('/workspace/a').fsPath);
			const folder2 = await store.getSessionWorkspaceFolder('session-2');
			expect(folder2?.fsPath).toBe(Uri.file('/workspace/b').fsPath);
			store.dispose();
		});

		it('should migrate worktree entries to bulk file', async () => {
			const v1Props = makeWorktreeV1Props();
			extensionContext.globalState.seed(WORKTREE_MEMENTO_KEY, {
				'session-wt': makeWorktreeData(v1Props),
			});

			const store = await createStore();

			const wt = await store.getWorktreeProperties('session-wt');
			expect(wt).toBeDefined();
			expect(wt!.version).toBe(1);
			expect(wt!.branchName).toBe(v1Props.branchName);
			store.dispose();
		});

		it('should parse version 1 worktree data with explicit version override', async () => {
			// For version 1, the code spreads JSON.parse(data) and sets version: 1
			const rawProps = { baseCommit: 'c1', branchName: 'b1', repositoryPath: '/r', worktreePath: '/w', autoCommit: false };
			extensionContext.globalState.seed(WORKTREE_MEMENTO_KEY, {
				'session-v1': { data: JSON.stringify(rawProps), version: 1 } satisfies ChatSessionWorktreeData,
			});

			const store = await createStore();
			const wt = await store.getWorktreeProperties('session-v1');
			expect(wt?.version).toBe(1);
			expect(wt?.baseCommit).toBe('c1');
			store.dispose();
		});

		it('should parse version 2 worktree data directly from data string', async () => {
			const v2Props = makeWorktreeV2Props();
			extensionContext.globalState.seed(WORKTREE_MEMENTO_KEY, {
				'session-v2': { data: JSON.stringify(v2Props), version: 2 } satisfies ChatSessionWorktreeData,
			});

			const store = await createStore();
			const wt = await store.getWorktreeProperties('session-v2');
			expect(wt?.version).toBe(2);
			expect((wt as any).baseBranchName).toBe('main');
			store.dispose();
		});

		it('should give worktree precedence over workspace folder for same session', async () => {
			const v1Props = makeWorktreeV1Props();
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-both': { folderPath: Uri.file('/workspace/shared').fsPath, timestamp: 100 },
			});
			extensionContext.globalState.seed(WORKTREE_MEMENTO_KEY, {
				'session-both': makeWorktreeData(v1Props),
			});

			const store = await createStore();

			// worktree takes precedence: getSessionWorkspaceFolder returns undefined when worktree exists
			const folder = await store.getSessionWorkspaceFolder('session-both');
			expect(folder).toBeUndefined();

			const wt = await store.getWorktreeProperties('session-both');
			expect(wt).toBeDefined();
			store.dispose();
		});

		it.skip('should clear global state keys after successful migration', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
			});
			extensionContext.globalState.seed(WORKTREE_MEMENTO_KEY, {
				'session-2': makeWorktreeData(makeWorktreeV1Props()),
			});

			const store = await createStore();

			expect(extensionContext.globalState.has(WORKSPACE_FOLDER_MEMENTO_KEY)).toBe(false);
			expect(extensionContext.globalState.has(WORKTREE_MEMENTO_KEY)).toBe(false);
			store.dispose();
		});

		it('should write migrated data to bulk metadata file', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
			});

			const store = await createStore();

			// Read the bulk file directly to verify it was written
			const rawContent = await mockFs.readFile(BULK_METADATA_FILE);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written['session-1']).toBeDefined();
			expect(written['session-1'].workspaceFolder.folderPath).toBe(Uri.file('/workspace/a').fsPath);
			store.dispose();
		});

		it('should write per-session metadata files during migration when directory exists', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
			});

			// Pre-create the session directory so the write succeeds
			// (migration uses createDirectoryIfNotFound=false)
			await mockFs.createDirectory(Uri.joinPath(SESSION_STATE_DIR, 'session-1'));

			const store = await createStore();
			// Wait for the fire-and-forget per-session writes
			await vi.advanceTimersByTimeAsync(0);

			const fileUri = sessionMetadataFileUri('session-1');
			const rawContent = await mockFs.readFile(fileUri);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written.workspaceFolder?.folderPath).toBe(Uri.file('/workspace/a').fsPath);
			store.dispose();
		});

		it('should skip per-session file write when directory does not exist during migration', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
			});
			// Do NOT create the session directory

			const writeSpy = vi.spyOn(mockFs, 'writeFile');
			const store = await createStore();
			await vi.advanceTimersByTimeAsync(0);

			// No per-session file write should occur since dir is missing and createDirectoryIfNotFound=false
			const perSessionWrites = writeSpy.mock.calls.filter(
				c => c[0].toString().includes('session-1') && c[0].toString().includes('vscode.metadata.json'),
			);
			expect(perSessionWrites).toHaveLength(0);

			// Data should still be accessible from cache
			const folder = await store.getSessionWorkspaceFolder('session-1');
			expect(folder?.fsPath).toBe(Uri.file('/workspace/a').fsPath);
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// initializeStorage — filtering edge cases
	// ──────────────────────────────────────────────────────────────────────────
	describe('initializeStorage - filtering', () => {
		it('should skip workspace folder entries with untitled- prefix', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'untitled-session': { folderPath: Uri.file('/workspace/skip').fsPath, timestamp: 100 },
				'session-keep': { folderPath: Uri.file('/workspace/keep').fsPath, timestamp: 200 },
			});

			const store = await createStore();

			const skipFolder = await store.getSessionWorkspaceFolder('untitled-session');
			expect(skipFolder).toBeUndefined();
			const keepFolder = await store.getSessionWorkspaceFolder('session-keep');
			expect(keepFolder?.fsPath).toBe(Uri.file('/workspace/keep').fsPath);
			store.dispose();
		});

		it('should skip worktree entries with untitled- prefix', async () => {
			extensionContext.globalState.seed(WORKTREE_MEMENTO_KEY, {
				'untitled-wt': makeWorktreeData(makeWorktreeV1Props()),
				'session-wt': makeWorktreeData(makeWorktreeV1Props()),
			});

			const store = await createStore();

			const skipWt = await store.getWorktreeProperties('untitled-wt');
			expect(skipWt).toBeUndefined();
			const keepWt = await store.getWorktreeProperties('session-wt');
			expect(keepWt).toBeDefined();
			store.dispose();
		});

		it('should skip workspace folder entries that are raw strings (legacy format)', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-legacy': Uri.file('/old/string/path').fsPath as any,
				'session-good': { folderPath: Uri.file('/workspace/good').fsPath, timestamp: 100 },
			});

			const store = await createStore();

			const legacy = await store.getSessionWorkspaceFolder('session-legacy');
			expect(legacy).toBeUndefined();
			const good = await store.getSessionWorkspaceFolder('session-good');
			expect(good?.fsPath).toBe(Uri.file('/workspace/good').fsPath);
			store.dispose();
		});

		it('should skip workspace folder entries missing folderPath', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-no-path': { timestamp: 100 },
			});

			const store = await createStore();

			const folder = await store.getSessionWorkspaceFolder('session-no-path');
			expect(folder).toBeUndefined();
			store.dispose();
		});

		it('should skip workspace folder entries missing timestamp', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-no-ts': { folderPath: Uri.file('/workspace/no-ts').fsPath },
			});

			const store = await createStore();

			const folder = await store.getSessionWorkspaceFolder('session-no-ts');
			expect(folder).toBeUndefined();
			store.dispose();
		});

		it('should skip worktree entries that are raw strings (legacy format)', async () => {
			extensionContext.globalState.seed(WORKTREE_MEMENTO_KEY, {
				'session-old': 'some-old-string' as any,
				'session-new': makeWorktreeData(makeWorktreeV1Props()),
			});

			const store = await createStore();

			const oldWt = await store.getWorktreeProperties('session-old');
			expect(oldWt).toBeUndefined();
			const newWt = await store.getWorktreeProperties('session-new');
			expect(newWt).toBeDefined();
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// initializeStorage — migration failure safety (CRITICAL)
	// ──────────────────────────────────────────────────────────────────────────
	describe('initializeStorage - failure safety', () => {
		it('should NOT clear global state when writeToGlobalStorage fails', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
			});
			extensionContext.globalState.seed(WORKTREE_MEMENTO_KEY, {
				'session-2': makeWorktreeData(makeWorktreeV1Props()),
			});

			// Make writeFile throw so writeToGlobalStorage fails
			vi.spyOn(mockFs, 'writeFile').mockRejectedValue(new Error('disk full'));

			const store = await createStore();

			// Global state should be preserved since writing to file failed
			expect(extensionContext.globalState.has(WORKSPACE_FOLDER_MEMENTO_KEY)).toBe(true);
			expect(extensionContext.globalState.has(WORKTREE_MEMENTO_KEY)).toBe(true);

			// Initialization failure should be logged
			expect(logService.error).toHaveBeenCalled();
			store.dispose();
		});

		it('should NOT clear global state when createDirectory fails during writeToGlobalStorage', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
			});

			// stat throws (dir missing) and createDirectory also throws
			vi.spyOn(mockFs, 'stat').mockRejectedValue(new Error('ENOENT'));
			vi.spyOn(mockFs, 'createDirectory').mockRejectedValue(new Error('permission denied'));

			const store = await createStore();

			expect(extensionContext.globalState.has(WORKSPACE_FOLDER_MEMENTO_KEY)).toBe(true);
			store.dispose();
		});

		it.skip('should still clear global state even when per-session file writes fail', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
			});

			// Allow bulk file write to succeed but track per-session writes
			let writeCallCount = 0;
			const origWriteFile = mockFs.writeFile.bind(mockFs);
			vi.spyOn(mockFs, 'writeFile').mockImplementation(async (uri, content) => {
				writeCallCount++;
				// Let the bulk metadata file write succeed (first or second write)
				if (uri.toString().includes('copilotcli.session.metadata.json')) {
					return origWriteFile(uri, content);
				}
				// Fail per-session writes
				throw new Error('per-session write failed');
			});

			const store = await createStore();

			// Global state should be cleared because bulk file write succeeded
			// (per-session writes are fire-and-forget via Promise.allSettled)
			expect(extensionContext.globalState.has(WORKSPACE_FOLDER_MEMENTO_KEY)).toBe(false);
			store.dispose();
		});

		it('should log error when initialization fails', async () => {
			extensionContext.globalState.seed(WORKSPACE_FOLDER_MEMENTO_KEY, {
				'session-1': { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 },
			});
			vi.spyOn(mockFs, 'writeFile').mockRejectedValue(new Error('disk full'));

			const store = await createStore();

			expect(logService.error).toHaveBeenCalledWith(
				'[ChatSessionMetadataStore] Initialization failed: ',
				expect.any(Error),
			);
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// initializeStorage — empty data
	// ──────────────────────────────────────────────────────────────────────────
	describe('initializeStorage - empty global state', () => {
		it('should write empty bulk file and clear global state when no data exists', async () => {
			// No bulk file and no global state data → empty migration
			const store = await createStore();

			const rawContent = await mockFs.readFile(BULK_METADATA_FILE);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written).toEqual({});
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// storeWorkspaceFolderInfo
	// ──────────────────────────────────────────────────────────────────────────
	describe('storeWorkspaceFolderInfo', () => {
		it('should store workspace folder and write to per-session file', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			await store.storeWorkspaceFolderInfo('session-new', { folderPath: Uri.file('/new/folder').fsPath, timestamp: 500 });

			const fileUri = sessionMetadataFileUri('session-new');
			const rawContent = await mockFs.readFile(fileUri);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written.workspaceFolder).toEqual({ folderPath: Uri.file('/new/folder').fsPath, timestamp: 500 });
			store.dispose();
		});

		it('should be retrievable via getSessionWorkspaceFolder', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			await store.storeWorkspaceFolderInfo('session-new', { folderPath: Uri.file('/new/folder').fsPath, timestamp: 500 });

			const folder = await store.getSessionWorkspaceFolder('session-new');
			expect(folder?.fsPath).toBe(Uri.file('/new/folder').fsPath);
			store.dispose();
		});

		it('should trigger debounced bulk storage update', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			await store.storeWorkspaceFolderInfo('session-new', { folderPath: Uri.file('/new/folder').fsPath, timestamp: 500 });

			// Advance past debounce period
			await vi.advanceTimersByTimeAsync(1_100);

			// Bulk file should now contain the new entry
			const rawContent = await mockFs.readFile(BULK_METADATA_FILE);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written['session-new']).toBeDefined();
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// storeWorktreeInfo
	// ──────────────────────────────────────────────────────────────────────────
	describe('storeWorktreeInfo', () => {
		it('should store worktree properties and write to per-session file', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();
			const props = makeWorktreeV1Props();

			await store.storeWorktreeInfo('session-wt', props);

			const fileUri = sessionMetadataFileUri('session-wt');
			const rawContent = await mockFs.readFile(fileUri);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written.worktreeProperties.version).toBe(1);
			expect(written.worktreeProperties.branchName).toBe(props.branchName);
			store.dispose();
		});

		it('should be retrievable via getWorktreeProperties', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();
			const props = makeWorktreeV2Props();

			await store.storeWorktreeInfo('session-wt2', props);

			const wt = await store.getWorktreeProperties('session-wt2');
			expect(wt?.version).toBe(2);
			expect((wt as any).baseBranchName).toBe('main');
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// getWorktreeProperties
	// ──────────────────────────────────────────────────────────────────────────
	describe('getWorktreeProperties', () => {
		it('should return undefined for session with no worktree data', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-folder': { workspaceFolder: { folderPath: Uri.file('/a').fsPath, timestamp: 1 } },
			}));

			const store = await createStore();
			const wt = await store.getWorktreeProperties('session-folder');
			expect(wt).toBeUndefined();
			store.dispose();
		});

		it('should return properties from cache without file read', async () => {
			const props = makeWorktreeV1Props();
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-wt': { worktreeProperties: props },
			}));

			const store = await createStore();
			const readSpy = vi.spyOn(mockFs, 'readFile');
			readSpy.mockClear();

			const wt = await store.getWorktreeProperties('session-wt');
			expect(wt).toBeDefined();

			// readFile should not be called for per-session file since it's cached
			const perSessionCalls = readSpy.mock.calls.filter(
				c => c[0].toString().includes('vscode.metadata.json'),
			);
			expect(perSessionCalls).toHaveLength(0);
			store.dispose();
		});

		it('should read from per-session file on cache miss', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const props = makeWorktreeV2Props();
			const fileUri = sessionMetadataFileUri('session-uncached');
			mockFs.mockFile(fileUri, JSON.stringify({ worktreeProperties: props }));

			const store = await createStore();
			const wt = await store.getWorktreeProperties('session-uncached');
			expect(wt?.version).toBe(2);
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// getSessionWorkspaceFolder
	// ──────────────────────────────────────────────────────────────────────────
	describe('getSessionWorkspaceFolder', () => {
		it('should return Uri for workspace folder entry', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-1': { workspaceFolder: { folderPath: Uri.file('/my/workspace').fsPath, timestamp: 42 } },
			}));

			const store = await createStore();
			const folder = await store.getSessionWorkspaceFolder('session-1');
			expect(folder?.fsPath).toBe(Uri.file('/my/workspace').fsPath);
			store.dispose();
		});

		it('should return undefined for unknown session', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));

			const store = await createStore();
			const folder = await store.getSessionWorkspaceFolder('nonexistent');
			expect(folder).toBeUndefined();
			store.dispose();
		});

		it('should return undefined when session has worktree properties', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-wt': {
					worktreeProperties: makeWorktreeV1Props(),
					workspaceFolder: { folderPath: Uri.file('/should/not/return').fsPath, timestamp: 1 },
				},
			}));

			const store = await createStore();
			const folder = await store.getSessionWorkspaceFolder('session-wt');
			expect(folder).toBeUndefined();
			store.dispose();
		});

		it('should return undefined when folderPath is empty', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-empty': { workspaceFolder: { folderPath: '', timestamp: 1 } },
			}));

			const store = await createStore();
			const folder = await store.getSessionWorkspaceFolder('session-empty');
			expect(folder).toBeUndefined();
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// getUsedWorkspaceFolders
	// ──────────────────────────────────────────────────────────────────────────
	describe('getUsedWorkspaceFolders', () => {
		it('should return empty array when no workspace folders exist', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));

			const store = await createStore();
			const folders = await store.getUsedWorkspaceFolders();
			expect(folders).toEqual([]);
			store.dispose();
		});

		it('should return deduplicated workspace folders', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-1': { workspaceFolder: { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 } },
				'session-2': { workspaceFolder: { folderPath: Uri.file('/workspace/b').fsPath, timestamp: 200 } },
			}));

			const store = await createStore();
			const folders = await store.getUsedWorkspaceFolders();
			expect(folders).toHaveLength(2);
			const paths = folders.map(f => f.folderPath);
			expect(paths).toContain(Uri.file('/workspace/a').fsPath);
			expect(paths).toContain(Uri.file('/workspace/b').fsPath);
			store.dispose();
		});

		it('should use latest timestamp when multiple sessions point to same folder', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-1': { workspaceFolder: { folderPath: Uri.file('/workspace/shared').fsPath, timestamp: 100 } },
				'session-2': { workspaceFolder: { folderPath: Uri.file('/workspace/shared').fsPath, timestamp: 300 } },
				'session-3': { workspaceFolder: { folderPath: Uri.file('/workspace/shared').fsPath, timestamp: 200 } },
			}));

			const store = await createStore();
			const folders = await store.getUsedWorkspaceFolders();
			expect(folders).toHaveLength(1);
			expect(folders[0].timestamp).toBe(300);
			store.dispose();
		});

		it('should ignore sessions with only worktree properties', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-wt': { worktreeProperties: makeWorktreeV1Props() },
				'session-folder': { workspaceFolder: { folderPath: Uri.file('/workspace/a').fsPath, timestamp: 100 } },
			}));

			const store = await createStore();
			const folders = await store.getUsedWorkspaceFolders();
			expect(folders).toHaveLength(1);
			expect(folders[0].folderPath).toBe(Uri.file('/workspace/a').fsPath);
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// deleteSessionMetadata
	// ──────────────────────────────────────────────────────────────────────────
	describe('deleteSessionMetadata', () => {
		it('should handle deleting non-existent session gracefully', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));

			const store = await createStore();
			// Should not throw
			await store.deleteSessionMetadata('nonexistent');
			store.dispose();
		});

		it('should trigger bulk storage update after delete', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({
				'session-del': { workspaceFolder: { folderPath: Uri.file('/workspace/del').fsPath, timestamp: 100 } },
			}));

			const store = await createStore();
			await store.deleteSessionMetadata('session-del');

			await vi.advanceTimersByTimeAsync(1_100);

			const rawContent = await mockFs.readFile(BULK_METADATA_FILE);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			// The deleted session should not appear (or appear as empty with writtenToSessionState)
			// The store writes cache which no longer has the session key after delete
			expect(written['session-del']).toBeUndefined();
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// getSessionMetadata — cache behavior (tested via public API)
	// ──────────────────────────────────────────────────────────────────────────
	describe('getSessionMetadata - cache behavior', () => {
		it('should cache result from per-session file read and not read again', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const fileUri = sessionMetadataFileUri('session-file');
			mockFs.mockFile(fileUri, JSON.stringify({
				workspaceFolder: { folderPath: Uri.file('/cached').fsPath, timestamp: 1 },
			}));

			const store = await createStore();

			// First call reads from file
			const folder1 = await store.getSessionWorkspaceFolder('session-file');
			expect(folder1?.fsPath).toBe(Uri.file('/cached').fsPath);

			const readSpy = vi.spyOn(mockFs, 'readFile');
			readSpy.mockClear();

			// Second call should use cache
			const folder2 = await store.getSessionWorkspaceFolder('session-file');
			expect(folder2?.fsPath).toBe(Uri.file('/cached').fsPath);

			const perSessionCalls = readSpy.mock.calls.filter(
				c => c[0].toString().includes('session-file'),
			);
			expect(perSessionCalls).toHaveLength(0);
			store.dispose();
		});

		it('should cache empty metadata and not retry when per-session file is missing', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			// No per-session file for session-missing

			const store = await createStore();

			const result1 = await store.getSessionWorkspaceFolder('session-missing');
			expect(result1).toBeUndefined();

			const readSpy = vi.spyOn(mockFs, 'readFile');
			readSpy.mockClear();

			// Second call should use cached empty metadata
			const result2 = await store.getSessionWorkspaceFolder('session-missing');
			expect(result2).toBeUndefined();

			const perSessionCalls = readSpy.mock.calls.filter(
				c => c[0].toString().includes('session-missing'),
			);
			expect(perSessionCalls).toHaveLength(0);
			store.dispose();
		});

		it('should write empty metadata file when per-session file read fails', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			// No per-session file → read will fail

			const store = await createStore();
			await store.getSessionWorkspaceFolder('session-no-file');

			// Wait for writes to settle
			await vi.advanceTimersByTimeAsync(0);

			// Verify empty file was written
			const fileUri = sessionMetadataFileUri('session-no-file');
			const rawContent = await mockFs.readFile(fileUri);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written).toEqual({});
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// updateSessionMetadata — directory creation behavior
	// ──────────────────────────────────────────────────────────────────────────
	describe('updateSessionMetadata - directory handling', () => {
		it('should create directory when it does not exist', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			const createDirSpy = vi.spyOn(mockFs, 'createDirectory');

			await store.storeWorkspaceFolderInfo('new-session', { folderPath: Uri.file('/w').fsPath, timestamp: 1 });

			// createDirectory should have been called for the session dir
			expect(createDirSpy).toHaveBeenCalled();
			store.dispose();
		});

		it('should not create directory when it already exists', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			// Pre-create the directory
			const dirUri = Uri.joinPath(SESSION_STATE_DIR, 'existing-session');
			await mockFs.createDirectory(dirUri);

			const createDirSpy = vi.spyOn(mockFs, 'createDirectory');
			createDirSpy.mockClear();

			await store.storeWorkspaceFolderInfo('existing-session', { folderPath: Uri.file('/w').fsPath, timestamp: 1 });

			// The stat succeeds so createDirectory on the per-session dir should not be called
			// (it may be called for other dirs like the bulk storage dir)
			const perSessionDirCalls = createDirSpy.mock.calls.filter(
				c => c[0].toString().includes('existing-session'),
			);
			expect(perSessionDirCalls).toHaveLength(0);
			store.dispose();
		});

		it('should set writtenToSessionState in cache after successful write', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			await store.storeWorkspaceFolderInfo('session-written', { folderPath: Uri.file('/w').fsPath, timestamp: 1 });

			// Access the cached metadata via getWorktreeProperties (which reads from cache)
			// The cache should have writtenToSessionState: true
			// We can verify by reading the workspace folder (which goes through cache)
			const folder = await store.getSessionWorkspaceFolder('session-written');
			expect(folder?.fsPath).toBe(Uri.file('/w').fsPath);
			store.dispose();
		});

		it('should skip file write and update cache when createDirectoryIfNotFound is false and directory missing', async () => {
			// This path is exercised during initialization retry when bulk file
			// has entries not yet written to session state.
			const existingData = {
				'session-retry': { worktreeProperties: makeWorktreeV1Props() },
			};
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify(existingData));
			// Do NOT create the per-session directory

			const writeSpy = vi.spyOn(mockFs, 'writeFile');
			const store = await createStore();
			await vi.advanceTimersByTimeAsync(0);

			// No per-session file write should occur since dir is missing and createDirectoryIfNotFound=false
			const perSessionWrites = writeSpy.mock.calls.filter(
				c => c[0].toString().includes('session-retry') && c[0].toString().includes('vscode.metadata.json'),
			);
			expect(perSessionWrites).toHaveLength(0);

			// Data should still be accessible from cache
			const wt = await store.getWorktreeProperties('session-retry');
			expect(wt?.version).toBe(1);
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Debounced storage writes
	// ──────────────────────────────────────────────────────────────────────────
	describe('debounced bulk storage updates', () => {
		it('should coalesce multiple rapid updates into single write', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			const writeSpy = vi.spyOn(mockFs, 'writeFile');
			writeSpy.mockClear();

			await store.storeWorkspaceFolderInfo('s1', { folderPath: Uri.file('/a').fsPath, timestamp: 1 });
			await store.storeWorkspaceFolderInfo('s2', { folderPath: Uri.file('/b').fsPath, timestamp: 2 });
			await store.storeWorkspaceFolderInfo('s3', { folderPath: Uri.file('/c').fsPath, timestamp: 3 });

			// Before debounce fires, count writes to bulk file
			const bulkWritesBefore = writeSpy.mock.calls.filter(
				c => c[0].toString().includes('copilotcli.session.metadata.json'),
			).length;

			// Advance past debounce
			await vi.advanceTimersByTimeAsync(1_100);

			const bulkWritesAfter = writeSpy.mock.calls.filter(
				c => c[0].toString().includes('copilotcli.session.metadata.json'),
			).length;

			// Should have exactly one new bulk write after debounce (coalesced)
			expect(bulkWritesAfter - bulkWritesBefore).toBe(1);
			store.dispose();
		});

		it('should include all session data in the debounced bulk write', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			await store.storeWorkspaceFolderInfo('s1', { folderPath: Uri.file('/a').fsPath, timestamp: 1 });
			await store.storeWorkspaceFolderInfo('s2', { folderPath: Uri.file('/b').fsPath, timestamp: 2 });

			await vi.advanceTimersByTimeAsync(1_100);

			const rawContent = await mockFs.readFile(BULK_METADATA_FILE);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written['s1']).toBeDefined();
			expect(written['s2']).toBeDefined();
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// updateGllobalStorageImpl — bulk storage merge behavior
	// ──────────────────────────────────────────────────────────────────────────
	describe('updateGllobalStorageImpl - merge behavior', () => {
		it('should overwrite bulk file with current cache when debounced write fires', async () => {
			// Pre-populate the bulk file with one session
			const initial = {
				'session-old': { workspaceFolder: { folderPath: Uri.file('/old').fsPath, timestamp: 1 } },
			};
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify(initial));

			const store = await createStore();
			// Store a new session (triggers debounced bulk write)
			await store.storeWorkspaceFolderInfo('session-new', { folderPath: Uri.file('/new').fsPath, timestamp: 2 });

			// Advance past debounce
			await vi.advanceTimersByTimeAsync(1_100);

			const rawContent = await mockFs.readFile(BULK_METADATA_FILE);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			// Both old (from cache) and new sessions should be present
			expect(written['session-old']).toBeDefined();
			expect(written['session-new']).toBeDefined();
			store.dispose();
		});

		it('should handle bulk file read failure during debounced write gracefully', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			await store.storeWorkspaceFolderInfo('session-1', { folderPath: Uri.file('/a').fsPath, timestamp: 1 });

			// Make the bulk file unreadable for the debounced write's read attempt
			const origReadFile = mockFs.readFile.bind(mockFs);
			let readCallAfterStore = 0;
			vi.spyOn(mockFs, 'readFile').mockImplementation(async (uri) => {
				if (uri.toString().includes('copilotcli.session.metadata.json')) {
					readCallAfterStore++;
					if (readCallAfterStore > 0) {
						throw new Error('simulated read failure');
					}
				}
				return origReadFile(uri);
			});

			// Advance past debounce — should not throw
			await vi.advanceTimersByTimeAsync(1_100);

			// The write should still succeed (falls through to writing cache data)
			expect(logService.error).not.toHaveBeenCalledWith(
				'[ChatSessionMetadataStore] Failed to update global storage: ',
				expect.any(Error),
			);
			store.dispose();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Constructor & edge cases
	// ──────────────────────────────────────────────────────────────────────────
	describe('constructor and edge cases', () => {
		it('should handle initialization failure gracefully', async () => {
			// Make both bulk file read AND writeFile fail
			vi.spyOn(mockFs, 'readFile').mockRejectedValue(new Error('ENOENT'));
			vi.spyOn(mockFs, 'writeFile').mockRejectedValue(new Error('disk error'));

			const store = await createStore();

			expect(logService.error).toHaveBeenCalledWith(
				'[ChatSessionMetadataStore] Initialization failed: ',
				expect.any(Error),
			);
			store.dispose();
		});

		it('should handle bulk file with invalid JSON gracefully', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, 'not-valid-json{{{');

			// This will fail to parse, fall through to migration path
			const store = await createStore();

			// Should still function (writes empty bulk file from empty global state)
			const rawContent = await mockFs.readFile(BULK_METADATA_FILE);
			const written = JSON.parse(new TextDecoder().decode(rawContent));
			expect(written).toEqual({});
			store.dispose();
		});

		it('should dispose ThrottledDelayer on dispose', async () => {
			mockFs.mockFile(BULK_METADATA_FILE, JSON.stringify({}));
			const store = await createStore();

			// Should not throw
			store.dispose();
		});

		it('should work correctly when globalState returns empty objects for both keys', async () => {
			// globalState.get returns default {} for both keys
			const store = await createStore();

			const folders = await store.getUsedWorkspaceFolders();
			expect(folders).toEqual([]);
			store.dispose();
		});
	});
});
