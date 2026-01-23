/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import type { CancellationToken, LanguageModelToolResult2 } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { CapturingToken } from '../../../../platform/requestLogger/common/capturingToken';
import { IChatEndpointLogInfo, ILoggedPendingRequest, LoggedRequestKind } from '../../../../platform/requestLogger/node/requestLogger';
import { TestRequestLogger } from '../../../../platform/requestLogger/test/node/testRequestLogger';
import { ExportedLogEntry } from '../../common/chatReplayTypes';
import { createChatReplayExport, serializeChatReplayExport } from '../../node/chatReplayExport';
import { ChatReplayNotebookSerializer } from '../chatReplayNotebookSerializer';

// NotebookCellKind values from VS Code API
const NotebookCellKind = {
	Markup: 1,
	Code: 2
};

/**
 * Creates a mock LanguageModelToolResult2 for testing.
 * This is the response structure returned from tool invocations.
 */
function createMockToolResult(textValue: string): LanguageModelToolResult2 {
	return {
		content: [{ value: textValue }]
	} as LanguageModelToolResult2;
}

/**
 * Creates a mock chat endpoint info for testing.
 */
function createMockChatEndpoint(modelMaxPromptTokens: number = 100000): IChatEndpointLogInfo {
	return { modelMaxPromptTokens };
}

/**
 * Creates a mock logged pending request for testing.
 */
function createMockChatParams(model: string, location: ChatLocation): Partial<ILoggedPendingRequest> {
	return { model, location };
}

describe('ChatReplayNotebookSerializer', () => {
	let logger: TestRequestLogger;
	let serializer: ChatReplayNotebookSerializer;

	beforeEach(() => {
		logger = new TestRequestLogger();
		serializer = new ChatReplayNotebookSerializer();
	});

	describe('end-to-end: RequestLogger → export → notebook', () => {
		it('creates notebook cells from a real logger export with prompt, tool call, and response', async () => {
			// This test validates the full pipeline using the TestRequestLogger
			// It should catch any changes to the request logger export format that break the notebook parser
			const userPromptToken = new CapturingToken('create a hello world file', 'comment', false);

			await logger.captureInvocation(userPromptToken, async () => {
				// 1. Tool call - creates the file
				logger.logToolCall('tool-1', 'create_file', { path: '/hello.txt', content: 'Hello World!' }, createMockToolResult('File created successfully'));

				// 2. Markdown response - what the user sees in chat
				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'assistantResponse',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'done!',
					isConversationRequest: true
				});
			});

			// Export the logged entries using the logger
			const entries = logger.getRequests();
			expect(entries.length).toBe(2); // tool call + markdown response

			const exportData = await createChatReplayExport(entries);

			// Verify export structure
			expect(exportData.totalPrompts).toBe(1);
			expect(exportData.totalLogEntries).toBe(2);
			expect(exportData.prompts[0].prompt).toBe('create a hello world file');
			expect(exportData.prompts[0].logs.length).toBe(2);

			// Deserialize through notebook serializer
			const jsonContent = serializeChatReplayExport(exportData);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			// Should have: header cell, user query cell, tool call cell, response cell
			expect(notebookData.cells.length).toBe(4);

			// All cells should be markdown
			for (const cell of notebookData.cells) {
				expect(cell.kind).toBe(NotebookCellKind.Markup);
				expect(cell.languageId).toBe('markdown');
			}

			// First cell: export header (collapsed, read-only)
			expect(notebookData.cells[0].value).toContain('## Chat Replay Export');
			expect(notebookData.cells[0].value).toContain('**Total Prompts:** 1');
			expect(notebookData.cells[0].metadata).toEqual({ editable: false, collapsed: true });

			// Second cell: user query (not collapsed, read-only)
			expect(notebookData.cells[1].value).toBe('### User\n\ncreate a hello world file');
			expect(notebookData.cells[1].metadata).toEqual({ editable: false });

			// Third cell: tool call (collapsed, read-only)
			expect(notebookData.cells[2].value).toContain('#### Tool Call: create_file');
			expect(notebookData.cells[2].metadata).toEqual({ editable: false, collapsed: true });

			// Fourth cell: assistant response - should be EXACTLY the content shown to user (not collapsed, read-only)
			expect(notebookData.cells[3].value).toBe('done!');
			expect(notebookData.cells[3].metadata).toEqual({ editable: false });
		});

		it('displays ChatMLSuccess response.message as plain markdown (not in details tag)', async () => {
			// This tests the real response format from model completions
			// ChatMLSuccess entries have response: { type: 'success', message: 'the text' }
			// We use TestRequestLogger.addEntry() with a ChatMLSuccess entry to test the real pipeline
			const userPromptToken = new CapturingToken('test query', 'comment', false);

			await logger.captureInvocation(userPromptToken, async () => {
				// Create a ChatMLSuccess entry with a mock result - this matches how real model responses are logged
				logger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'panel/editAgent',
					chatEndpoint: createMockChatEndpoint(),
					chatParams: createMockChatParams('gpt-4', ChatLocation.Panel) as ILoggedPendingRequest,
					startTime: new Date(),
					endTime: new Date(),
					timeToFirstToken: 100,
					isConversationRequest: true,
					result: {
						type: ChatFetchResponseType.Success,
						value: ['Here is the model response!'],
						requestId: 'test-request-id',
						serverRequestId: undefined,
						usage: undefined,
						resolvedModel: 'gpt-4'
					},
					usage: undefined
				});
			});

			const entries = logger.getRequests();
			const exportData = await createChatReplayExport(entries);

			// Verify the export produces the expected structure
			// Note: message is an array because FetchSuccess<string[]> returns an array of response chunks
			expect(exportData.prompts[0].logs[0]).toMatchObject({
				kind: 'request',
				type: 'ChatMLSuccess',
				response: {
					type: 'success',
					message: ['Here is the model response!']
				}
			});

			const jsonContent = serializeChatReplayExport(exportData);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			// Should have: header cell, user query cell, request metadata cell, response cell
			expect(notebookData.cells.length).toBe(4);

			// Third cell: request metadata cell (collapsed, read-only)
			const metadataCell = notebookData.cells[2];
			expect(metadataCell.kind).toBe(NotebookCellKind.Markup);
			expect(metadataCell.value).toContain('#### Request:');
			expect(metadataCell.metadata).toEqual({ editable: false, collapsed: true });

			// Fourth cell: model response - should be the message directly, NOT wrapped in details tag (not collapsed, read-only)
			const responseCell = notebookData.cells[3];
			expect(responseCell.value).toBe('Here is the model response!');
			// Ensure it's NOT in a details tag
			expect(responseCell.value).not.toContain('<details>');
			expect(responseCell.value).not.toContain('Response');
			// Not collapsed since it's user-facing response, but still read-only
			expect(responseCell.metadata).toEqual({ editable: false });
		});

		it('adds collapsed request metadata and JSON code cell before ChatMLSuccess response when requestMessages exist', async () => {
			// When a ChatMLSuccess entry has requestMessages, we should show:
			// 1. A collapsed markdown cell with metadata
			// 2. A collapsed JSON code cell with the request messages
			// 3. The response cell
			const exportData = {
				exportedAt: new Date().toISOString(),
				totalPrompts: 1,
				totalLogEntries: 1,
				prompts: [{
					prompt: 'test query',
					logCount: 1,
					logs: [{
						id: 'req-1',
						kind: 'request',
						name: 'panel/editAgent',
						type: 'ChatMLSuccess',
						metadata: {
							model: 'gpt-4',
							duration: 1500,
							usage: {
								prompt_tokens: 800,
								completion_tokens: 200
							}
						},
						requestMessages: {
							messages: [
								{ role: 'system', content: 'You are a helpful assistant.' },
								{ role: 'user', content: 'test query' }
							]
						},
						response: {
							type: 'success',
							message: 'Here is the model response!'
						}
					}]
				}]
			};

			const jsonContent = JSON.stringify(exportData, null, 2);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			// Should have: header cell, user query cell, request metadata cell, request messages JSON cell, response cell
			expect(notebookData.cells.length).toBe(5);

			// Third cell: request metadata cell (collapsed markdown, read-only)
			const metadataCell = notebookData.cells[2];
			expect(metadataCell.kind).toBe(NotebookCellKind.Markup);
			expect(metadataCell.languageId).toBe('markdown');
			expect(metadataCell.value).toContain('#### Request: panel/editAgent');
			expect(metadataCell.value).toContain('**Model:** gpt-4');
			expect(metadataCell.value).toContain('**Duration:** 1,500ms');
			expect(metadataCell.value).toContain('**Prompt Tokens:** 800');
			expect(metadataCell.value).toContain('**Completion Tokens:** 200');
			expect(metadataCell.metadata).toEqual({ editable: false, collapsed: true });

			// Fourth cell: request messages JSON code cell (collapsed, read-only)
			// Wrapped in { "requestMessages": [...] } so collapsed preview shows "requestMessages" instead of "["
			const messagesCell = notebookData.cells[3];
			expect(messagesCell.kind).toBe(NotebookCellKind.Code);
			expect(messagesCell.languageId).toBe('json');
			expect(messagesCell.value).toContain('"requestMessages":');
			expect(messagesCell.value).toContain('You are a helpful assistant.');
			expect(messagesCell.value).toContain('test query');
			expect(messagesCell.metadata).toEqual({ editable: false, collapsed: true });

			// Fifth cell: model response - should be the message directly (not collapsed, read-only)
			const responseCell = notebookData.cells[4];
			expect(responseCell.value).toBe('Here is the model response!');
			expect(responseCell.metadata).toEqual({ editable: false });
		});

		it('creates notebook cells for multiple prompts with mixed entry types', async () => {
			// First prompt
			const firstToken = new CapturingToken('what files are in this directory?', 'comment', false);
			await logger.captureInvocation(firstToken, async () => {
				logger.logToolCall('tool-1', 'list_dir', { path: '/workspace' }, createMockToolResult('file1.ts\nfile2.ts\nREADME.md'));
			});

			// Second prompt
			const secondToken = new CapturingToken('read the README file', 'comment', false);
			await logger.captureInvocation(secondToken, async () => {
				logger.logToolCall('tool-2', 'read_file', { path: '/workspace/README.md' }, createMockToolResult('# My Project\n\nThis is a test project.'));

				// Add a request entry too
				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'modelResponse',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'Here is the README content...',
					isConversationRequest: true
				});
			});

			// Export and convert to notebook
			const entries = logger.getRequests();
			const exportData = await createChatReplayExport(entries);

			expect(exportData.totalPrompts).toBe(2);
			expect(exportData.prompts[0].logCount).toBe(1); // 1 tool call
			expect(exportData.prompts[1].logCount).toBe(2); // 1 tool call + 1 request

			const jsonContent = serializeChatReplayExport(exportData);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			// Expected: header + (user1 + tool1) + (user2 + tool2 + request2) = 6 cells
			expect(notebookData.cells.length).toBe(6);

			// Verify first prompt user cell (not collapsed, read-only)
			expect(notebookData.cells[1].value).toBe('### User\n\nwhat files are in this directory?');
			expect(notebookData.cells[1].metadata).toEqual({ editable: false });

			// Verify second prompt user cell (not collapsed, read-only)
			expect(notebookData.cells[3].value).toBe('### User\n\nread the README file');
			expect(notebookData.cells[3].metadata).toEqual({ editable: false });
		});

		it('handles entries without capturing token gracefully', async () => {
			// Add an entry without a capturing token (e.g., model list call)
			logger.addEntry({
				type: LoggedRequestKind.MarkdownContentRequest,
				debugName: 'orphanEntry',
				startTimeMs: Date.now(),
				icon: undefined,
				markdownContent: 'Orphan content',
				isConversationRequest: false
			});

			// Add an entry with a token
			const userToken = new CapturingToken('test prompt', 'comment', false);
			await logger.captureInvocation(userToken, async () => {
				logger.logToolCall('tool-1', 'test_tool', {}, { content: [] });
			});

			const entries = logger.getRequests();
			const exportData = await createChatReplayExport(entries);

			// Only entries with tokens should become prompts
			expect(exportData.totalPrompts).toBe(1);
			expect(exportData.prompts[0].prompt).toBe('test prompt');
		});

		it('preserves tool call arguments and response in exported JSON', async () => {
			const token = new CapturingToken('search for something', 'comment', false);

			const toolArgs = {
				query: 'find me files',
				includeHidden: true,
				maxResults: 10
			};

			await logger.captureInvocation(token, async () => {
				logger.logToolCall('tool-1', 'grep_search', toolArgs, createMockToolResult('result1.ts\nresult2.ts'));
			});

			const entries = logger.getRequests();
			const exportData = await createChatReplayExport(entries);

			const toolLog = exportData.prompts[0].logs[0] as ExportedLogEntry;
			expect(toolLog.kind).toBe('toolCall');
			expect(toolLog.args).toEqual(toolArgs);
		});

		it('creates valid notebook even with empty export', () => {
			const emptyExport = {
				exportedAt: new Date().toISOString(),
				totalPrompts: 0,
				totalLogEntries: 0,
				prompts: []
			};

			const jsonContent = JSON.stringify(emptyExport, null, 2);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			// Should have just the header cell
			expect(notebookData.cells.length).toBe(1);
			expect(notebookData.cells[0].value).toContain('## Chat Replay Export');
			expect(notebookData.cells[0].value).toContain('**Total Prompts:** 0');
		});

		it('handles malformed JSON gracefully with error cell', () => {
			const malformedJson = '{ "invalid": json }';
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(malformedJson),
				undefined as unknown as CancellationToken
			);

			expect(notebookData.cells.length).toBe(1);
			expect(notebookData.cells[0].value).toContain('### Error Parsing Chat Replay');
		});

		it('handles empty file with informative message', () => {
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(''),
				undefined as unknown as CancellationToken
			);

			expect(notebookData.cells.length).toBe(1);
			expect(notebookData.cells[0].value).toContain('### Empty Chat Replay File');
			expect(notebookData.cells[0].value).toContain('This file is empty');
		});

		it('handles whitespace-only file with informative message', () => {
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode('   \n\t  \n  '),
				undefined as unknown as CancellationToken
			);

			expect(notebookData.cells.length).toBe(1);
			expect(notebookData.cells[0].value).toContain('### Empty Chat Replay File');
		});

		it('handles single prompt export format (without prompts array wrapper)', () => {
			// Single prompt exports have the prompt data directly at root level,
			// without the ChatReplayExport wrapper (no exportedAt, totalPrompts, prompts array)
			const singlePromptExport = {
				prompt: 'can you make the notebook read-only',
				promptId: '7d76a580-prompt',
				hasSeen: false,
				logCount: 2,
				logs: [
					{
						id: 'tool-1',
						kind: 'toolCall',
						tool: 'read_file',
						args: { path: '/test.ts' },
						response: ['file contents']
					},
					{
						id: 'req-1',
						kind: 'request',
						type: 'MarkdownContentRequest',
						content: 'Done!'
					}
				]
			};

			const jsonContent = JSON.stringify(singlePromptExport, null, 2);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			// Should have: user query cell, tool call cell, response cell (NO header cell)
			expect(notebookData.cells.length).toBe(3);

			// First cell: user query (no export header for single prompts)
			expect(notebookData.cells[0].value).toBe('### User\n\ncan you make the notebook read-only');
			expect(notebookData.cells[0].metadata).toEqual({ editable: false });

			// Second cell: tool call (collapsed, read-only)
			expect(notebookData.cells[1].value).toContain('#### Tool Call: read_file');
			expect(notebookData.cells[1].metadata).toEqual({ editable: false, collapsed: true });

			// Third cell: response (not collapsed, read-only)
			expect(notebookData.cells[2].value).toBe('Done!');
			expect(notebookData.cells[2].metadata).toEqual({ editable: false });
		});
	});

	describe('notebook cell formatting', () => {
		it('formats element entries with token information', async () => {
			// Create a mock export with an element entry
			const exportData = {
				exportedAt: new Date().toISOString(),
				totalPrompts: 1,
				totalLogEntries: 1,
				prompts: [{
					prompt: 'test query',
					logCount: 1,
					logs: [{
						id: 'elem-1',
						kind: 'element',
						name: 'PromptElement',
						tokens: 5000,
						maxTokens: 100000
					}]
				}]
			};

			const jsonContent = JSON.stringify(exportData, null, 2);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			// Should have header + user + element = 3 cells
			expect(notebookData.cells.length).toBe(3);

			// Element cell should show token usage
			const elementCell = notebookData.cells[2];
			expect(elementCell.value).toContain('#### Element: PromptElement');
			expect(elementCell.value).toContain('**Tokens:** 5,000 / 100,000');
		});

		it('formats request entries with metadata (non-ChatMLSuccess)', async () => {
			// Non-ChatMLSuccess request entries (e.g., failures, cancellations, or requests without response.message)
			// should still show metadata and details
			const exportData = {
				exportedAt: new Date().toISOString(),
				totalPrompts: 1,
				totalLogEntries: 1,
				prompts: [{
					prompt: 'test query',
					logCount: 1,
					logs: [{
						id: 'req-1',
						kind: 'request',
						name: 'panel/editAgent',
						type: 'ChatMLFailure',
						metadata: {
							model: 'gpt-4',
							duration: 2500,
							startTime: '2025-01-21T10:00:00.000Z',
							usage: {
								prompt_tokens: 1000,
								completion_tokens: 500
							}
						},
						response: {
							type: 'failure',
							reason: 'Rate limit exceeded'
						}
					}]
				}]
			};

			const jsonContent = JSON.stringify(exportData, null, 2);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			const requestCell = notebookData.cells[2];
			expect(requestCell.value).toContain('#### Request: panel/editAgent');
			expect(requestCell.value).toContain('**Model:** gpt-4');
			expect(requestCell.value).toContain('**Duration:** 2,500ms');
			expect(requestCell.value).toContain('**Prompt Tokens:** 1,000');
		});

		it('truncates long responses in tool call cells', async () => {
			const longResponse = 'x'.repeat(2000);
			const exportData = {
				exportedAt: new Date().toISOString(),
				totalPrompts: 1,
				totalLogEntries: 1,
				prompts: [{
					prompt: 'test query',
					logCount: 1,
					logs: [{
						id: 'tool-1',
						kind: 'toolCall',
						tool: 'read_file',
						args: { path: '/large-file.txt' },
						response: [longResponse]
					}]
				}]
			};

			const jsonContent = JSON.stringify(exportData, null, 2);
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode(jsonContent),
				undefined as unknown as CancellationToken
			);

			const toolCell = notebookData.cells[2];
			expect(toolCell.value).toContain('(truncated)');
			// Should not contain the full 2000 character response
			expect(toolCell.value.length).toBeLessThan(longResponse.length);
		});
	});

	describe('serialization (read-only)', () => {
		it('returns empty array on serialize (read-only notebook)', () => {
			const notebookData = serializer.deserializeNotebook(
				new TextEncoder().encode('{}'),
				undefined as unknown as CancellationToken
			);

			const serialized = serializer.serializeNotebook(notebookData, undefined as unknown as CancellationToken);
			expect(serialized).toEqual(new Uint8Array());
		});
	});
});

describe('chatReplayExport', () => {
	let logger: TestRequestLogger;

	beforeEach(() => {
		logger = new TestRequestLogger();
	});

	describe('createChatReplayExport', () => {
		it('creates valid export structure', async () => {
			const token = new CapturingToken('test prompt', 'comment', false);
			await logger.captureInvocation(token, async () => {
				logger.logToolCall('t1', 'test_tool', { arg: 'value' }, { content: [] });
			});

			const exportData = await createChatReplayExport(logger.getRequests());

			expect(exportData).toHaveProperty('exportedAt');
			expect(exportData).toHaveProperty('totalPrompts', 1);
			expect(exportData).toHaveProperty('totalLogEntries', 1);
			expect(exportData).toHaveProperty('prompts');
			expect(exportData.prompts[0]).toHaveProperty('prompt', 'test prompt');
			expect(exportData.prompts[0]).toHaveProperty('logCount', 1);
			expect(exportData.prompts[0]).toHaveProperty('logs');
		});

		it('includes MCP servers when provided', async () => {
			const mcpServers = [{ type: 'stdio', label: 'test-server' }];
			const exportData = await createChatReplayExport([], mcpServers);

			expect(exportData.mcpServers).toEqual(mcpServers);
		});
	});

	describe('serializeChatReplayExport', () => {
		it('produces valid JSON', async () => {
			const token = new CapturingToken('prompt', 'comment', false);
			await logger.captureInvocation(token, async () => {
				logger.logToolCall('t1', 'tool', {}, { content: [] });
			});

			const exportData = await createChatReplayExport(logger.getRequests());
			const jsonString = serializeChatReplayExport(exportData);

			// Should be valid JSON
			expect(() => JSON.parse(jsonString)).not.toThrow();

			// Should be pretty-printed
			expect(jsonString).toContain('\n');
		});
	});
});
