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
import { ClaudeChatSessionContentProvider, UNAVAILABLE_MODEL_ID } from '../claudeChatSessionContentProvider';

// Mock types for testing
interface MockClaudeSession {
	id: string;
	messages: Array<{
		type: 'user' | 'assistant';
		message: Record<string, unknown>;
	}>;
}

describe('ChatSessionContentProvider', () => {
	let mockSessionService: IClaudeCodeSessionService;
	let mockClaudeCodeModels: IClaudeCodeModels;
	let provider: ClaudeChatSessionContentProvider;
	const store = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	const workspaceFolderUri = URI.file('/project');

	beforeEach(() => {
		mockSessionService = {
			getSession: vi.fn()
		} as any;

		mockClaudeCodeModels = {
			resolveModel: vi.fn().mockResolvedValue('claude-3-5-sonnet-20241022'),
			getDefaultModel: vi.fn().mockResolvedValue('claude-3-5-sonnet-20241022'),
			setDefaultModel: vi.fn().mockResolvedValue(undefined),
			getModels: vi.fn().mockResolvedValue([
				{ id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
				{ id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' }
			]),
			mapSdkModelToEndpointModel: vi.fn().mockResolvedValue(undefined)
		} as any;

		const serviceCollection = store.add(createExtensionUnitTestingServices());

		const workspaceService = new TestWorkspaceService([workspaceFolderUri]);
		serviceCollection.set(IWorkspaceService, workspaceService);

		serviceCollection.define(IClaudeCodeSessionService, mockSessionService);
		serviceCollection.define(IClaudeCodeModels, mockClaudeCodeModels);
		serviceCollection.define(IClaudeSlashCommandService, {
			_serviceBrand: undefined,
			tryHandleCommand: vi.fn().mockResolvedValue({ handled: false }),
			getRegisteredCommands: vi.fn().mockReturnValue([]),
		});
		accessor = serviceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		provider = instaService.createInstance(ClaudeChatSessionContentProvider);
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
		const provider = childInstantiationService.createInstance(ClaudeChatSessionContentProvider);

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
});


function createClaudeSessionUri(id: string): URI {
	return URI.parse(`claude-code:/${id}`);
}
