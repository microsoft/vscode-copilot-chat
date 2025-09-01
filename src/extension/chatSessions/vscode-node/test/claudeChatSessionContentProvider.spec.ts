/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../../util/vs/platform/instantiation/common/serviceCollection';
import { ChatRequestTurn, ChatResponseMarkdownPart, ChatResponseTurn2, ChatToolInvocationPart } from '../../../../vscodeTypes';
import { ClaudeAgentManager } from '../../../agents/claude/node/claudeCodeAgent';
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../../agents/claude/node/claudeCodeSessionService';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ClaudeChatSessionContentProvider } from '../claudeChatSessionContentProvider';
import { ClaudeSessionDataStore } from '../claudeChatSessionItemProvider';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';

// Mock types for testing
interface MockClaudeSession {
	id: string;
	messages: Array<{
		type: 'user' | 'assistant';
		message: Anthropic.MessageParam | Anthropic.Message;
	}>;
}

describe('ChatSessionContentProvider', () => {
	let mockClaudeAgentManager: ClaudeAgentManager;
	let mockSessionStore: ClaudeSessionDataStore;
	let mockSessionService: IClaudeCodeSessionService;
	let provider: ClaudeChatSessionContentProvider;
	const store = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	const workspaceFolderUri = URI.file('/project');

	beforeEach(() => {
		mockClaudeAgentManager = {
			handleRequest: vi.fn().mockResolvedValue({ claudeSessionId: 'test-claude-session' })
		} as any;

		mockSessionStore = {
			getAndConsumeInitialRequest: vi.fn(),
			setClaudeSessionId: vi.fn(),
			getSessionId: vi.fn()
		} as any;

		mockSessionService = {
			getSession: vi.fn()
		} as any;

		const serviceCollection = store.add(createExtensionUnitTestingServices());

		const workspaceService = new TestWorkspaceService([workspaceFolderUri]);
		serviceCollection.set(IWorkspaceService, workspaceService);

		serviceCollection.define(IClaudeCodeSessionService, mockSessionService);
		accessor = serviceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		provider = instaService.createInstance(ClaudeChatSessionContentProvider,
			mockClaudeAgentManager,
			mockSessionStore);
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

	const mockInitialRequest: vscode.ChatRequest = { prompt: 'initial prompt' } as Partial<vscode.ChatRequest> as any;
	describe('provideChatSessionContent', () => {
		it('returns empty history when no existing session', async () => {
			vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
			vi.mocked(mockSessionStore.getSessionId).mockReturnValue('test-session');
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);

			const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

			expect(result.history).toEqual([]);
			expect(mockSessionService.getSession).toHaveBeenCalledWith('test-session', CancellationToken.None);
		});

		it('converts user messages to ChatRequestTurn2', async () => {
			const mockSession: MockClaudeSession = {
				id: 'test-session',
				messages: [
					{
						type: 'user',
						message: {
							role: 'user',
							content: 'Hello, how are you?'
						} as Anthropic.MessageParam
					}
				]
			};

			vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
			vi.mocked(mockSessionStore.getSessionId).mockReturnValue('test-session');
			vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);

			const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

			expect(mapHistoryForSnapshot(result.history)).toMatchInlineSnapshot(`
				[
				  {
				    "prompt": "Hello, how are you?",
				    "type": "request",
				  },
				]
			`);
		});

		it('converts assistant messages with text to ChatResponseTurn2', async () => {
			const mockSession: MockClaudeSession = {
				id: 'test-session',
				messages: [
					{
						type: 'assistant',
						message: {
							id: 'msg-1',
							type: 'message',
							role: 'assistant',
							content: [
								{
									type: 'text',
									text: 'I am doing well, thank you!'
								}
							],
							model: 'claude-3-sonnet',
							stop_reason: 'end_turn',
							stop_sequence: null,
							usage: { input_tokens: 10, output_tokens: 8 }
						} as Anthropic.Message
					}
				]
			};

			vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
			vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);
			vi.mocked(mockSessionStore.getSessionId).mockReturnValue('test-session');

			const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

			expect(mapHistoryForSnapshot(result.history)).toMatchInlineSnapshot(`
				[
				  {
				    "parts": [
				      {
				        "content": "I am doing well, thank you!",
				        "type": "markdown",
				      },
				    ],
				    "type": "response",
				  },
				]
			`);
		});

		it('converts assistant messages with tool_use to ChatToolInvocationPart', async () => {
			const mockSession: MockClaudeSession = {
				id: 'test-session',
				messages: [
					{
						type: 'assistant',
						message: {
							id: 'msg-1',
							type: 'message',
							role: 'assistant',
							content: [
								{
									type: 'tool_use',
									id: 'tool-1',
									name: 'bash',
									input: { command: 'ls -la' }
								}
							],
							model: 'claude-3-sonnet',
							stop_reason: 'tool_use',
							stop_sequence: null,
							usage: { input_tokens: 15, output_tokens: 12 }
						} as Anthropic.Message
					}
				]
			};

			vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
			vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);
			vi.mocked(mockSessionStore.getSessionId).mockReturnValue('test-session');

			const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

			expect(mapHistoryForSnapshot(result.history)).toMatchInlineSnapshot(`
				[
				  {
				    "parts": [
				      {
				        "invocationMessage": "Used tool: bash",
				        "isError": false,
				        "toolCallId": "tool-1",
				        "toolName": "bash",
				        "type": "tool",
				      },
				    ],
				    "type": "response",
				  },
				]
			`);
		});

		it('creates activeResponseCallback that calls claudeAgentManager', async () => {
			vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(mockInitialRequest);
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);
			vi.mocked(mockClaudeAgentManager.handleRequest).mockResolvedValue({ claudeSessionId: 'new-claude-session' });

			const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

			// Mock stream and test the callback
			const mockStream = {} as vscode.ChatResponseStream;
			expect(result.activeResponseCallback).toBeDefined();
			await result.activeResponseCallback!(mockStream, CancellationToken.None);

			expect(mockClaudeAgentManager.handleRequest).toHaveBeenCalledWith(
				undefined,
				expect.objectContaining({
					prompt: 'initial prompt'
				}),
				{ history: [] },
				mockStream,
				CancellationToken.None
			);

			expect(mockSessionStore.setClaudeSessionId).toHaveBeenCalledWith('test-session', 'new-claude-session');
		});

		it('not new session - does not have activeResponseCallback', async () => {
			vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);
			vi.mocked(mockClaudeAgentManager.handleRequest).mockResolvedValue({ claudeSessionId: 'new-claude-session' });

			const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);
			expect(result.activeResponseCallback).toBeUndefined();
		});

		it('creates requestHandler that calls claudeAgentManager with session id', async () => {
			vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
			vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);
			vi.mocked(mockSessionStore.getSessionId).mockReturnValue('existing-claude-session');

			const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

			// Mock request, context, and stream
			const mockRequest = { prompt: 'test request' } as vscode.ChatRequest;
			const mockContext = { history: [] } as vscode.ChatContext;
			const mockStream = {} as vscode.ChatResponseStream;

			if (result.requestHandler) {
				result.requestHandler(mockRequest, mockContext, mockStream, CancellationToken.None);
			}

			expect(mockSessionStore.getSessionId).toHaveBeenCalledWith('test-session');
			expect(mockClaudeAgentManager.handleRequest).toHaveBeenCalledWith(
				'existing-claude-session',
				mockRequest,
				mockContext,
				mockStream,
				CancellationToken.None
			);
		});
	});

	it('handles mixed content with text and tool_use', async () => {
		const mockSession: MockClaudeSession = {
			id: 'test-session',
			messages: [
				{
					type: 'assistant',
					message: {
						id: 'msg-1',
						type: 'message',
						role: 'assistant',
						content: [
							{
								type: 'text',
								text: 'Let me run a command:'
							},
							{
								type: 'tool_use',
								id: 'tool-1',
								name: 'bash',
								input: { command: 'pwd' }
							}
						],
						model: 'claude-3-sonnet',
						stop_reason: 'tool_use',
						stop_sequence: null,
						usage: { input_tokens: 20, output_tokens: 15 }
					} as Anthropic.Message
				}
			]
		};

		vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
		vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);
		vi.mocked(mockSessionStore.getSessionId).mockReturnValue('test-session');

		const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

		expect(mapHistoryForSnapshot(result.history)).toMatchInlineSnapshot(`
			[
			  {
			    "parts": [
			      {
			        "content": "Let me run a command:",
			        "type": "markdown",
			      },
			      {
			        "invocationMessage": "Used tool: bash",
			        "isError": false,
			        "toolCallId": "tool-1",
			        "toolName": "bash",
			        "type": "tool",
			      },
			    ],
			    "type": "response",
			  },
			]
		`);
	});

	it('handles complete tool invocation flow: user → assistant with tool_use → user with tool_result', async () => {
		const mockSession: MockClaudeSession = {
			id: 'test-session',
			messages: [
				// Initial user message
				{
					type: 'user',
					message: {
						role: 'user',
						content: 'Can you list the files in the current directory?'
					} as Anthropic.MessageParam
				},
				// Assistant message with text and tool_use
				{
					type: 'assistant',
					message: {
						id: 'msg-1',
						type: 'message',
						role: 'assistant',
						content: [
							{
								type: 'text',
								text: 'I\'ll list the files for you.'
							},
							{
								type: 'tool_use',
								id: 'tool-1',
								name: 'bash',
								input: { command: 'ls -la' }
							}
						],
						model: 'claude-3-sonnet',
						stop_reason: 'tool_use',
						stop_sequence: null,
						usage: { input_tokens: 20, output_tokens: 15 }
					} as Anthropic.Message
				},
				// User message with tool_result
				{
					type: 'user',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool-1',
								content: 'total 8\ndrwxr-xr-x  3 user user 4096 Aug 29 10:00 .\ndrwxr-xr-x  5 user user 4096 Aug 29 09:30 ..\n-rw-r--r--  1 user user  256 Aug 29 10:00 file.txt',
								is_error: false
							}
						]
					} as Anthropic.MessageParam
				}
			]
		};

		vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
		vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);
		vi.mocked(mockSessionStore.getSessionId).mockReturnValue('test-session');

		const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

		expect(mapHistoryForSnapshot(result.history)).toMatchInlineSnapshot(`
			[
			  {
			    "prompt": "Can you list the files in the current directory?",
			    "type": "request",
			  },
			  {
			    "parts": [
			      {
			        "content": "I'll list the files for you.",
			        "type": "markdown",
			      },
			      {
			        "invocationMessage": "Used tool: bash",
			        "isError": false,
			        "toolCallId": "tool-1",
			        "toolName": "bash",
			        "type": "tool",
			      },
			    ],
			    "type": "response",
			  },
			]
		`);
	}); it('handles user messages with complex content blocks', async () => {
		const mockSession: MockClaudeSession = {
			id: 'test-session',
			messages: [
				{
					type: 'user',
					message: {
						role: 'user',
						content: [
							{
								type: 'text',
								text: 'Check this result: '
							},
							{
								type: 'tool_result',
								tool_use_id: 'tool-1',
								content: 'Command executed successfully',
								is_error: false
							}
						]
					} as Anthropic.MessageParam
				}
			]
		};

		vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
		vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);
		vi.mocked(mockSessionStore.getSessionId).mockReturnValue('test-session');

		const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

		expect(mapHistoryForSnapshot(result.history)).toMatchInlineSnapshot(`
			[
			  {
			    "prompt": "Check this result: ",
			    "type": "request",
			  },
			]
		`);
	});

	it('creates activeResponseCallback that calls claudeAgentManager', async () => {
		vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(mockInitialRequest);
		vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);
		vi.mocked(mockClaudeAgentManager.handleRequest).mockResolvedValue({ claudeSessionId: 'new-claude-session' });

		const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

		// Mock stream and test the callback
		const mockStream = {} as vscode.ChatResponseStream;
		if (result.activeResponseCallback) {
			await result.activeResponseCallback(mockStream, CancellationToken.None);
		}

		expect(mockClaudeAgentManager.handleRequest).toHaveBeenCalledWith(
			undefined,
			expect.objectContaining({
				prompt: 'initial prompt'
			}),
			{ history: [] },
			mockStream,
			CancellationToken.None
		);

		expect(mockSessionStore.setClaudeSessionId).toHaveBeenCalledWith('test-session', 'new-claude-session');
	});

	it('creates requestHandler that calls claudeAgentManager with session id', async () => {
		vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
		vi.mocked(mockSessionService.getSession).mockResolvedValue(undefined);
		vi.mocked(mockSessionStore.getSessionId).mockReturnValue('existing-claude-session');

		const result = await provider.provideChatSessionContent('test-session', CancellationToken.None);

		// Mock request, context, and stream
		const mockRequest = { prompt: 'test request' } as vscode.ChatRequest;
		const mockContext = { history: [] } as vscode.ChatContext;
		const mockStream = {} as vscode.ChatResponseStream;

		if (result.requestHandler) {
			result.requestHandler(mockRequest, mockContext, mockStream, CancellationToken.None);
		}

		expect(mockSessionStore.getSessionId).toHaveBeenCalledWith('test-session');
		expect(mockClaudeAgentManager.handleRequest).toHaveBeenCalledWith(
			'existing-claude-session',
			mockRequest,
			mockContext,
			mockStream,
			CancellationToken.None
		);
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
			[IClaudeCodeSessionService, realSessionService]
		));
		const provider = childInstantiationService.createInstance(ClaudeChatSessionContentProvider,
			mockClaudeAgentManager,
			mockSessionStore);

		vi.mocked(mockSessionStore.getAndConsumeInitialRequest).mockReturnValue(undefined);
		vi.mocked(mockSessionStore.getSessionId).mockReturnValue('4c289ca8-f8bb-4588-8400-88b78beb784d');

		const result = await provider.provideChatSessionContent('4c289ca8-f8bb-4588-8400-88b78beb784d', CancellationToken.None);
		expect(mapHistoryForSnapshot(result.history)).toMatchSnapshot();
	});
});