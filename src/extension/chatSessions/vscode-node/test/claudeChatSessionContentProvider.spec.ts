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
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../../util/vs/platform/instantiation/common/serviceCollection';
import { ChatRequestTurn, ChatResponseMarkdownPart, ChatResponseTurn2, ChatToolInvocationPart } from '../../../../vscodeTypes';
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../../agents/claude/node/claudeCodeSessionService';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ClaudeChatSessionContentProvider } from '../claudeChatSessionContentProvider';

// Mock types for testing
interface MockClaudeSession {
	id: string;
	messages: Array<{
		type: 'user' | 'assistant';
		message: Anthropic.MessageParam | Anthropic.Message;
	}>;
}

describe('ChatSessionContentProvider', () => {
	let mockSessionService: IClaudeCodeSessionService;
	let provider: ClaudeChatSessionContentProvider;
	const store = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	const workspaceFolderUri = URI.file('/project');

	beforeEach(() => {
		mockSessionService = {
			getSession: vi.fn()
		} as any;

		const serviceCollection = store.add(createExtensionUnitTestingServices());

		const workspaceService = new TestWorkspaceService([workspaceFolderUri]);
		serviceCollection.set(IWorkspaceService, workspaceService);

		serviceCollection.define(IClaudeCodeSessionService, mockSessionService);
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

	describe('provideChatSessionContent', () => {
		it('returns empty history when no existing session', async () => {
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

			vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);

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

			vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);

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

		vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);

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

		vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);

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

		vi.mocked(mockSessionService.getSession).mockResolvedValue(mockSession as any);

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
		const provider = childInstantiationService.createInstance(ClaudeChatSessionContentProvider);

		const result = await provider.provideChatSessionContent('4c289ca8-f8bb-4588-8400-88b78beb784d', CancellationToken.None);
		expect(mapHistoryForSnapshot(result.history)).toMatchSnapshot();
	});
});