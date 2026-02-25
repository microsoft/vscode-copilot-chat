/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { MockGitService } from '../../../../platform/ignore/node/test/mockGitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { URI } from '../../../../util/vs/base/common/uri';
import { IChatSessionMetadataStore, WorkspaceFolderEntry } from '../../common/chatSessionMetadataStore';
import { ChatSessionWorkspaceFolderService } from '../chatSessionWorkspaceFolderServiceImpl';

/**
 * Mock implementation of globalState for testing
 */
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

	setKeysForSync(_keys: readonly string[]): void {
		// No-op for testing
	}
}

/**
 * Mock implementation of IVSCodeExtensionContext for testing
 */
class MockExtensionContext extends mock<IVSCodeExtensionContext>() {
	public override globalState = new MockGlobalState();

	override extensionPath = vscode.Uri.file('/mock/extension/path').fsPath;
	override globalStorageUri = vscode.Uri.file('/mock/global/storage');
	override storagePath = vscode.Uri.file('/mock/storage/path').fsPath;
	override globalStoragePath = vscode.Uri.file('/mock/global/storage/path').fsPath;
	override logPath = vscode.Uri.file('/mock/log/path').fsPath;
	override logUri = vscode.Uri.file('/mock/log/uri');
	override extensionUri = vscode.Uri.file('/mock/extension');
}

/**
 * Mock implementation of ILogService for testing
 */
class MockLogService extends mock<ILogService>() {
	override trace = vi.fn();
	override info = vi.fn();
	override warn = vi.fn();
	override error = vi.fn();
	override debug = vi.fn();
}

class MockMetadataStore extends mock<IChatSessionMetadataStore>() {
	private readonly _data = new Map<string, WorkspaceFolderEntry>();
	override storeWorktreeInfo = vi.fn(async () => { });
	override storeWorkspaceFolderInfo = vi.fn(async (_sessionId: string, _entry: WorkspaceFolderEntry) => {
		this._data.set(_sessionId, _entry);
	});
	override getWorktreeProperties = vi.fn(async () => undefined);
	override getSessionWorkspaceFolder = vi.fn(async (_sessionId: string): Promise<vscode.Uri | undefined> => {
		const entry = this._data.get(_sessionId);
		if (entry?.folderPath) {
			return vscode.Uri.file(entry.folderPath);
		}
		return undefined;
	});
	override getUsedWorkspaceFolders = vi.fn(async (): Promise<WorkspaceFolderEntry[]> => Array.from(this._data.values()));
	override deleteSessionMetadata = vi.fn(async (_sessionId: string) => {
		this._data.delete(_sessionId);
	});
}

describe('ChatSessionWorkspaceFolderService', () => {
	let service: ChatSessionWorkspaceFolderService;
	let extensionContext: MockExtensionContext;
	let gitService: MockGitService;
	let logService: MockLogService;
	let metadataStore: MockMetadataStore;

	beforeEach(() => {
		extensionContext = new MockExtensionContext();
		logService = new MockLogService();
		gitService = new MockGitService();
		metadataStore = new MockMetadataStore();
		service = new ChatSessionWorkspaceFolderService(gitService, logService, metadataStore);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('trackSessionWorkspaceFolder', () => {
		it('should track a workspace folder for a session', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);

			const tracked = await service.getSessionWorkspaceFolder(sessionId);
			expect(tracked?.fsPath).toBe(folderPath);
		});

		it('should update timestamp when tracking a folder', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			const beforeTime = Date.now();
			await service.trackSessionWorkspaceFolder(sessionId, folderPath);
			const afterTime = Date.now();

			// Verify that metadataStore was called with correct timestamp
			expect(metadataStore.storeWorkspaceFolderInfo).toHaveBeenCalledWith(
				sessionId,
				expect.objectContaining({ folderPath })
			);
			const entry = metadataStore.storeWorkspaceFolderInfo.mock.calls[0][1];
			expect(entry.timestamp).toBeGreaterThanOrEqual(beforeTime);
			expect(entry.timestamp).toBeLessThanOrEqual(afterTime);
		});

		it('should persist data to metadata store', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);

			// Verify metadata store was called
			expect(metadataStore.storeWorkspaceFolderInfo).toHaveBeenCalledWith(
				sessionId,
				expect.objectContaining({ folderPath })
			);
		});

		it('should handle multiple concurrent tracking calls', async () => {
			const sessionIds = ['session-1', 'session-2', 'session-3'];
			const folderPaths = [vscode.Uri.file('/path/1').fsPath, vscode.Uri.file('/path/2').fsPath, vscode.Uri.file('/path/3').fsPath];

			await Promise.all(
				sessionIds.map((sessionId, idx) => service.trackSessionWorkspaceFolder(sessionId, folderPaths[idx]))
			);

			for (let i = 0; i < sessionIds.length; i++) {
				const tracked = await service.getSessionWorkspaceFolder(sessionIds[i]);
				expect(tracked?.fsPath).toBe(folderPaths[i]);
			}
		});

		it('should trigger cleanup when exceeding MAX_ENTRIES', async () => {
			// Track MAX_ENTRIES + 1 entries to trigger cleanup
			const MAX_ENTRIES = 1500;

			// Pre-fill globalState with old entries
			const oldData: Record<string, unknown> = {};
			for (let i = 0; i < MAX_ENTRIES; i++) {
				oldData[`session-old-${i}`] = {
					folderPath: vscode.Uri.file(`/old/path/${i}`).fsPath,
					timestamp: Date.now() - 10000 + i  // Incrementing timestamps
				};
			}
			await extensionContext.globalState.update('github.copilot.cli.sessionWorkspaceFolders', oldData);

			// Add one more entry to trigger cleanup
			await service.trackSessionWorkspaceFolder('session-new', vscode.Uri.file('/new/path').fsPath);

			// Verify that cleanup occurred (some old entries should be gone)
			const data = extensionContext.globalState.get<Record<string, unknown>>('github.copilot.cli.sessionWorkspaceFolders', {});
			const entryCount = Object.keys(data).length;
			expect(entryCount).toBeLessThan(MAX_ENTRIES + 1);
		});
	});

	describe('getSessionWorkspaceFolder', () => {
		it('should return undefined for non-existent session', async () => {
			const result = await service.getSessionWorkspaceFolder('non-existent-session');
			expect(result).toBeUndefined();
		});

		it('should return correct URI for tracked session', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);
			const result = await service.getSessionWorkspaceFolder(sessionId);

			expect(result).toBeDefined();
			expect(result?.fsPath).toBe(folderPath);
		});

		it('should return URI object with correct properties', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);
			const result = await service.getSessionWorkspaceFolder(sessionId);

			expect(result).toBeInstanceOf(vscode.Uri);
			expect(result?.scheme).toBe('file');
		});

		it('should handle malformed data gracefully', async () => {
			// Manually inject malformed data
			await extensionContext.globalState.update('github.copilot.cli.sessionWorkspaceFolders', {
				'session-bad': {} // Missing folderPath
			});

			const result = await service.getSessionWorkspaceFolder('session-bad');
			expect(result).toBeUndefined();
		});

		it('should return undefined if folderPath is empty string', async () => {
			// Manually inject entry with empty folderPath
			await extensionContext.globalState.update('github.copilot.cli.sessionWorkspaceFolders', {
				'session-empty': { folderPath: '', timestamp: Date.now() }
			});

			const result = await service.getSessionWorkspaceFolder('session-empty');
			expect(result).toBeUndefined();
		});
	});

	describe('deleteTrackedWorkspaceFolder', () => {
		it('should delete tracked folder for session', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);
			expect(await service.getSessionWorkspaceFolder(sessionId)).toBeDefined();

			await service.deleteTrackedWorkspaceFolder(sessionId);
			expect(await service.getSessionWorkspaceFolder(sessionId)).toBeUndefined();
		});

		it('should call metadata store when deleting', async () => {
			const sessionId = 'session-1';
			await service.trackSessionWorkspaceFolder(sessionId, vscode.Uri.file('/path/to/folder').fsPath);

			await service.deleteTrackedWorkspaceFolder(sessionId);

			expect(metadataStore.deleteSessionMetadata).toHaveBeenCalledWith(sessionId);
		});

		it('should handle deletion of non-existent session', async () => {
			// Should not throw
			await expect(service.deleteTrackedWorkspaceFolder('non-existent')).resolves.toBeUndefined();
		});

		it('should not affect other sessions when deleting one', async () => {
			const session1 = 'session-1';
			const session2 = 'session-2';

			await service.trackSessionWorkspaceFolder(session1, vscode.Uri.file('/path/1').fsPath);
			await service.trackSessionWorkspaceFolder(session2, vscode.Uri.file('/path/2').fsPath);

			await service.deleteTrackedWorkspaceFolder(session1);

			expect(await service.getSessionWorkspaceFolder(session1)).toBeUndefined();
			expect(await service.getSessionWorkspaceFolder(session2)).toBeDefined();
		});
	});

	describe('getRecentFolders', () => {
		it('should return empty array when no folders tracked', async () => {
			const result = await service.getRecentFolders();
			expect(result).toEqual([]);
		});

		it('should return tracked folders sorted by access time (newest first)', async () => {
			// Add folders with controlled timestamps
			await service.trackSessionWorkspaceFolder('session-1', vscode.Uri.file('/path/1').fsPath);
			// Small delay to ensure different timestamps
			await new Promise(resolve => setTimeout(resolve, 10));
			await service.trackSessionWorkspaceFolder('session-2', vscode.Uri.file('/path/2').fsPath);
			await new Promise(resolve => setTimeout(resolve, 10));
			await service.trackSessionWorkspaceFolder('session-3', vscode.Uri.file('/path/3').fsPath);

			const result = await service.getRecentFolders();

			expect(result.length).toBe(3);
			// Most recent first
			expect(result[0].folder.fsPath).toBe(vscode.Uri.file('/path/3').fsPath);
			expect(result[1].folder.fsPath).toBe(vscode.Uri.file('/path/2').fsPath);
			expect(result[2].folder.fsPath).toBe(vscode.Uri.file('/path/1').fsPath);
		});

		it('should include lastAccessTime for each folder', async () => {
			await service.trackSessionWorkspaceFolder('session-1', vscode.Uri.file('/path/1').fsPath);
			const result = await service.getRecentFolders();

			expect(result.length).toBeGreaterThan(0);
			expect(result[0]).toHaveProperty('lastAccessTime');
			expect(typeof result[0].lastAccessTime).toBe('number');
		});

		it('should filter out entries with missing folderPath', async () => {
			// Override mock to return entries with and without folderPath
			metadataStore.getUsedWorkspaceFolders.mockResolvedValueOnce([
				{ folderPath: vscode.Uri.file('/path/1').fsPath, timestamp: Date.now() },
				{ folderPath: '', timestamp: Date.now() },
			]);

			const result = await service.getRecentFolders();

			// Should only include the valid entry
			expect(result.length).toBe(1);
			expect(result[0].folder.fsPath).toBe(vscode.Uri.file('/path/1').fsPath);
		});

		it('should return entries from metadata store with valid folderPath', async () => {
			metadataStore.getUsedWorkspaceFolders.mockResolvedValueOnce([
				{ folderPath: vscode.Uri.file('/some/path').fsPath, timestamp: Date.now() }
			]);

			const result = await service.getRecentFolders();

			expect(result.length).toBe(1);
			expect(result[0].folder.fsPath).toBe(vscode.Uri.file('/some/path').fsPath);
		});

		it('should handle entries with missing fields gracefully', async () => {
			// Override mock to return entries with missing fields
			metadataStore.getUsedWorkspaceFolders.mockResolvedValueOnce([
				{ folderPath: '', timestamp: 0 } as WorkspaceFolderEntry
			]);

			// Should not throw
			const result = await service.getRecentFolders();
			expect(Array.isArray(result)).toBe(true);
			expect(result.length).toBe(0);
		});
	});

	describe('deleteRecentFolder', () => {
		it('should delete folder by matching fsPath', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);
			const deleteUri = vscode.Uri.file(folderPath);

			await service.deleteRecentFolder(deleteUri);

			expect(await service.getSessionWorkspaceFolder(sessionId)).toBeUndefined();
		});

		it('should delete folder by URI equality', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);
			const deleteUri = URI.file(folderPath);

			await service.deleteRecentFolder(deleteUri);

			expect(await service.getSessionWorkspaceFolder(sessionId)).toBeUndefined();
		});

		it('should delete all entries matching the folder', async () => {
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder('session-1', folderPath);
			await service.trackSessionWorkspaceFolder('session-2', folderPath);
			await service.trackSessionWorkspaceFolder('session-3', vscode.Uri.file('/different/path').fsPath);

			await service.deleteRecentFolder(vscode.Uri.file(folderPath));

			expect(await service.getSessionWorkspaceFolder('session-1')).toBeUndefined();
			expect(await service.getSessionWorkspaceFolder('session-2')).toBeUndefined();
			expect(await service.getSessionWorkspaceFolder('session-3')).toBeDefined();
		});

		it('should handle UUID entries (empty folderPath)', async () => {
			// Manually inject entry with no folderPath
			const data = {
				'session-1': { timestamp: Date.now() }
			};
			await extensionContext.globalState.update('github.copilot.cli.sessionWorkspaceFolders', data);

			// Should not throw
			await expect(service.deleteRecentFolder(vscode.Uri.file('/some/path'))).resolves.toBeUndefined();
		});

		it('should not affect other folders when deleting one', async () => {
			const folder1 = vscode.Uri.file('/path/1').fsPath;
			const folder2 = vscode.Uri.file('/path/2').fsPath;

			await service.trackSessionWorkspaceFolder('session-1', folder1);
			await service.trackSessionWorkspaceFolder('session-2', folder2);

			await service.deleteRecentFolder(vscode.Uri.file(folder1));

			expect(await service.getSessionWorkspaceFolder('session-1')).toBeUndefined();
			expect(await service.getSessionWorkspaceFolder('session-2')).toBeDefined();
		});

		it('should handle non-existent folder deletion gracefully', async () => {
			const result = await service.deleteRecentFolder(vscode.Uri.file('/non/existent/path'));
			expect(result).toBeUndefined();
		});

		it('should persist deletion to metadata store', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/to/folder').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);
			expect(await service.getSessionWorkspaceFolder(sessionId)).toBeDefined();

			await service.deleteRecentFolder(vscode.Uri.file(folderPath));

			expect(await service.getSessionWorkspaceFolder(sessionId)).toBeUndefined();
			expect(metadataStore.deleteSessionMetadata).toHaveBeenCalledWith(sessionId);
		});
	});

	describe('cleanupOldEntries', () => {
		it('should handle large number of entries from metadata store', async () => {
			const entries: WorkspaceFolderEntry[] = [];
			for (let i = 0; i < 100; i++) {
				entries.push({
					folderPath: vscode.Uri.file(`/old/path/${i}`).fsPath,
					timestamp: Date.now() - 10000 + i
				});
			}
			metadataStore.getUsedWorkspaceFolders.mockResolvedValueOnce(entries);

			const result = await service.getRecentFolders();
			expect(result.length).toBe(100);
		});

		it('should keep newer entries and remove older ones', async () => {
			const MAX_ENTRIES = 1500;

			// Create old entries with predictable timestamps
			const oldData: Record<string, unknown> = {};
			for (let i = 0; i < MAX_ENTRIES; i++) {
				oldData[`session-old-${i}`] = {
					folderPath: vscode.Uri.file(`/old/path/${i}`).fsPath,
					timestamp: 1000 + i  // Older timestamps
				};
			}
			await extensionContext.globalState.update('github.copilot.cli.sessionWorkspaceFolders', oldData);

			// Add a new entry with current timestamp
			const now = Date.now();
			const data = extensionContext.globalState.get<Record<string, unknown>>('github.copilot.cli.sessionWorkspaceFolders', {});
			(data as any)['session-new'] = {
				folderPath: vscode.Uri.file('/new/path').fsPath,
				timestamp: now
			};
			await extensionContext.globalState.update('github.copilot.cli.sessionWorkspaceFolders', data);

			// Trigger cleanup by adding another entry
			await service.trackSessionWorkspaceFolder('session-trigger', vscode.Uri.file('/trigger/path').fsPath);

			const finalData = extensionContext.globalState.get<Record<string, unknown>>('github.copilot.cli.sessionWorkspaceFolders', {});

			// The newest entries should be preserved
			expect(finalData['session-new']).toBeDefined();
		});
	});

	describe('integration scenarios', () => {
		it('should maintain data across multiple operations', async () => {
			await service.trackSessionWorkspaceFolder('session-1', vscode.Uri.file('/path/1').fsPath);
			await service.trackSessionWorkspaceFolder('session-2', vscode.Uri.file('/path/2').fsPath);
			await service.trackSessionWorkspaceFolder('session-3', vscode.Uri.file('/path/3').fsPath);

			let recent = await service.getRecentFolders();
			expect(recent.length).toBe(3);

			await service.deleteRecentFolder(vscode.Uri.file('/path/2'));

			recent = await service.getRecentFolders();
			expect(recent.length).toBe(2);

			const folder1 = await service.getSessionWorkspaceFolder('session-1');
			const folder3 = await service.getSessionWorkspaceFolder('session-3');
			expect(folder1?.fsPath).toBe(vscode.Uri.file('/path/1').fsPath);
			expect(folder3?.fsPath).toBe(vscode.Uri.file('/path/3').fsPath);
		});

		it('should handle rapid concurrent operations', async () => {
			const operations = [];
			for (let i = 0; i < 50; i++) {
				operations.push(
					service.trackSessionWorkspaceFolder(`session-${i}`, vscode.Uri.file(`/path/${i}`).fsPath)
				);
			}

			await Promise.all(operations);

			const recent = await service.getRecentFolders();
			expect(recent.length).toBe(50);
		});

		it('should maintain consistency after delete and re-track', async () => {
			const sessionId = 'session-1';
			const folderPath = vscode.Uri.file('/path/1').fsPath;

			await service.trackSessionWorkspaceFolder(sessionId, folderPath);
			await service.deleteTrackedWorkspaceFolder(sessionId);
			await service.trackSessionWorkspaceFolder(sessionId, folderPath);

			const result = await service.getSessionWorkspaceFolder(sessionId);
			expect(result?.fsPath).toBe(folderPath);

			const recent = await service.getRecentFolders();
			expect(recent.length).toBe(1);
		});
	});
});
