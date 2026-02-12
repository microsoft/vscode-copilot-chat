/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
// eslint-disable-next-line no-duplicate-imports
import * as vscodeShim from 'vscode';
import { IGitService } from '../../../../platform/git/common/gitService';
import { MockGitService } from '../../../../platform/ignore/node/test/mockGitService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../../util/vs/platform/instantiation/common/serviceCollection';
import type { ClaudeAgentManager } from '../../../agents/claude/node/claudeCodeAgent';
import { IClaudeCodeModels } from '../../../agents/claude/node/claudeCodeModels';
import { IClaudeCodeSessionService } from '../../../agents/claude/node/sessionParser/claudeCodeSessionService';
import { IClaudeCodeSessionInfo } from '../../../agents/claude/node/sessionParser/claudeSessionSchema';
import { IClaudeSlashCommandService } from '../../../agents/claude/vscode-node/claudeSlashCommandService';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { MockChatResponseStream, TestChatRequest } from '../../../test/node/testHelpers';
import { IFolderRepositoryManager } from '../../common/folderRepositoryManager';
import { ClaudeChatSessionContentProvider } from '../claudeChatSessionContentProvider';

// Patch vscode shim with missing `chat` namespace before any production code imports it.
beforeAll(() => {
	(vscodeShim as Record<string, unknown>).chat = {
		createChatSessionItemController: () => {
			const itemsMap = new Map<string, vscode.ChatSessionItem>();
			return {
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
				dispose: () => { },
				onDidArchiveChatSessionItem: () => ({ dispose: () => { } }),
			};
		},
	};
});

function createClaudeSessionUri(id: string): URI {
	return URI.parse(`claude-code:/${id}`);
}

function createMockAgentManager(): ClaudeAgentManager {
	return {
		handleRequest: vi.fn().mockResolvedValue({}),
	} as unknown as ClaudeAgentManager;
}

describe('ClaudeChatSessionContentProvider - Session Forking', () => {
	const store = new DisposableStore();
	let provider: ClaudeChatSessionContentProvider;
	let mockSessionService: IClaudeCodeSessionService;
	let mockAgentManager: ClaudeAgentManager;
	const workspaceFolderUri = URI.file('/project');

	beforeEach(() => {
		store.clear();

		const serviceCollection = store.add(createExtensionUnitTestingServices(store));

		const workspaceService = new TestWorkspaceService([workspaceFolderUri]);
		serviceCollection.set(IWorkspaceService, workspaceService);
		serviceCollection.set(IGitService, new MockGitService());

		mockSessionService = {
			getAllSessions: vi.fn().mockResolvedValue([]),
			getSession: vi.fn().mockResolvedValue(undefined),
		} as any;

		const mockClaudeCodeModels: IClaudeCodeModels = {
			getModels: vi.fn().mockResolvedValue([
				{ id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
			]),
			getDefaultModel: vi.fn().mockResolvedValue('claude-3-5-sonnet-20241022'),
		} as any;

		const mockFolderRepositoryManager = {
			getFolderMRU: vi.fn().mockReturnValue([]),
			getLastUsedFolderIdInUntitledWorkspace: vi.fn().mockReturnValue(undefined),
		} as any;

		serviceCollection.define(IClaudeCodeSessionService, mockSessionService);
		serviceCollection.define(IClaudeCodeModels, mockClaudeCodeModels);
		serviceCollection.define(IFolderRepositoryManager, mockFolderRepositoryManager);
		serviceCollection.define(IClaudeSlashCommandService, {
			_serviceBrand: undefined,
			tryHandleCommand: vi.fn().mockResolvedValue({ handled: false }),
			getRegisteredCommands: vi.fn().mockReturnValue([]),
		});

		mockAgentManager = createMockAgentManager();

		const accessor = serviceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		provider = instaService.createInstance(ClaudeChatSessionContentProvider, mockAgentManager);
	});

	it('detects fork via initialSessionOptions', async () => {
		const parentSessionId = 'parent-session-id';
		const forkSessionId = 'fork-session-id';
		const stream = new MockChatResponseStream();
		const mockHandleRequest = vi.fn().mockResolvedValue({ claudeSessionId: forkSessionId });
		vi.spyOn(mockAgentManager, 'handleRequest').mockImplementation(mockHandleRequest);

		const request = new TestChatRequest('Test fork request');
		const context = {
			history: [],
			chatSessionContext: {
				chatSessionItem: {
					resource: createClaudeSessionUri(forkSessionId),
					label: 'Forked Session'
				},
				isUntitled: true,
				initialSessionOptions: [
					{ optionId: '__fork_from__', value: parentSessionId }
				]
			}
		};

		const handler = provider.createHandler();
		await handler(request, context as any, stream, CancellationToken.None);

		// Verify that handleRequest was called with fork parent session ID
		expect(mockHandleRequest).toHaveBeenCalledWith(
			expect.any(String), // effective session ID
			request,
			context,
			stream,
			CancellationToken.None,
			true, // isNewSession
			expect.any(Function), // yieldRequested
			parentSessionId // forkFromSessionId
		);
	});

	it('fires onDidCommitChatSessionItem for forked sessions', async () => {
		const forkSessionId = 'fork-session-id';
		const stream = new MockChatResponseStream();
		const mockHandleRequest = vi.fn().mockResolvedValue({ claudeSessionId: forkSessionId });
		vi.spyOn(mockAgentManager, 'handleRequest').mockImplementation(mockHandleRequest);

		const commitListener = vi.fn();
		provider.onDidCommitChatSessionItem(commitListener);

		const request = new TestChatRequest('Test fork request');
		const untitledSessionUri = createClaudeSessionUri('untitled-fork');
		const context = {
			history: [],
			chatSessionContext: {
				chatSessionItem: {
					resource: untitledSessionUri,
					label: 'Untitled Fork'
				},
				isUntitled: true,
				initialSessionOptions: [
					{ optionId: '__fork_from__', value: 'parent-session-id' }
				]
			}
		};

		const handler = provider.createHandler();
		await handler(request, context as any, stream, CancellationToken.None);

		// Verify that onDidCommitChatSessionItem was fired
		expect(commitListener).toHaveBeenCalledTimes(1);
		const event = commitListener.mock.calls[0][0];
		expect(event.original).toBe(context.chatSessionContext.chatSessionItem);
		expect(event.modified.resource.scheme).toBe('claude-code');
		expect(event.modified.label).toContain('Test fork request');
	});

	it('provides session items for ChatSessionItemProvider interface', async () => {
		const mockSessions: IClaudeCodeSessionInfo[] = [
			{
				id: 'session-1',
				label: 'Session 1',
				created: Date.now(),
				lastRequestEnded: Date.now(),
				folderName: 'test-folder'
			},
			{
				id: 'session-2',
				label: 'Session 2',
				created: Date.now() - 1000,
				lastRequestEnded: Date.now() - 500,
				folderName: undefined
			}
		];

		vi.mocked(mockSessionService.getAllSessions).mockResolvedValue(mockSessions);

		const items = await provider.provideChatSessionItems(CancellationToken.None);

		expect(items).toHaveLength(2);
		expect(items[0].label).toBe('Session 1');
		expect(items[1].label).toBe('Session 2');
	});
});
