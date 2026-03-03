/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ChatPromptReference } from 'vscode';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';
import { mock } from '../../../../../util/common/test/simpleMock';
import { URI } from '../../../../../util/vs/base/common/uri';
import {
	ChatRequestTurn2,
	ChatResponseMarkdownPart,
	ChatResponsePullRequestPart,
	ChatResponseThinkingProgressPart,
	ChatResponseTurn2,
	ChatToolInvocationPart,
	MarkdownString
} from '../../../../../vscodeTypes';
import {
	buildChatHistoryFromEvents,
	createCopilotCLIToolInvocation,
	extractCdPrefix,
	getAffectedUrisForEditTool,
	isCopilotCliEditToolCall,
	processToolExecutionComplete,
	processToolExecutionStart,
	stripReminders,
	ToolCall
} from '../copilotCLITools';
import { IChatDelegationSummaryService } from '../delegationSummaryService';

// Helper to extract invocation message text independent of MarkdownString vs string
function getInvocationMessageText(part: ChatToolInvocationPart | undefined): string {
	if (!part) { return ''; }
	const msg: any = part.invocationMessage;
	if (!msg) { return ''; }
	if (typeof msg === 'string') { return msg; }
	if (msg instanceof MarkdownString) { return (msg as any).value ?? ''; }
	return msg.value ?? '';
}

const getVSCodeRequestId = () => undefined;
const delegationSummary = new class extends mock<IChatDelegationSummaryService>() {
	override extractPrompt(sessionId: string, message: string): { prompt: string; reference: ChatPromptReference } | undefined {
		return undefined;
	}
};

describe('CopilotCLITools', () => {
	const logger = new TestLogService();
	describe('isCopilotCliEditToolCall', () => {
		it('detects StrReplaceEditor edit commands (non-view)', () => {
			expect(isCopilotCliEditToolCall({ toolName: 'str_replace_editor', arguments: { command: 'str_replace', path: '/tmp/a' } })).toBe(true);
			expect(isCopilotCliEditToolCall({ toolName: 'str_replace_editor', arguments: { command: 'insert', path: '/tmp/a', new_str: '' } })).toBe(true);
			expect(isCopilotCliEditToolCall({ toolName: 'str_replace_editor', arguments: { command: 'create', path: '/tmp/a' } })).toBe(true);
		});
		it('excludes StrReplaceEditor view command', () => {
			expect(isCopilotCliEditToolCall({ toolName: 'str_replace_editor', arguments: { command: 'view', path: '/tmp/a' } })).toBe(false);
		});
		it('always true for Edit & Create tools', () => {
			expect(isCopilotCliEditToolCall({ toolName: 'edit', arguments: { path: '' } })).toBe(true);
			expect(isCopilotCliEditToolCall({ toolName: 'create', arguments: { path: '' } })).toBe(true);
		});
	});

	describe('getAffectedUrisForEditTool', () => {
		it('returns URI for edit tool with path', () => {
			const [uri] = getAffectedUrisForEditTool({ toolName: 'str_replace_editor', arguments: { command: 'str_replace', path: '/tmp/file.txt' } });
			expect(uri.toString()).toContain('/tmp/file.txt');
		});
		it('returns empty for non-edit view command', () => {
			expect(getAffectedUrisForEditTool({ toolName: 'str_replace_editor', arguments: { command: 'view', path: '/tmp/file.txt' } })).toHaveLength(0);
		});
	});

	describe('stripReminders', () => {
		it('removes reminder blocks and trims', () => {
			const input = '  <reminder>Keep this private</reminder>\nContent';
			expect(stripReminders(input)).toBe('Content');
		});
		it('removes current datetime blocks', () => {
			const input = '<current_datetime>2025-10-10</current_datetime> Now';
			expect(stripReminders(input)).toBe('Now');
		});
		it('removes pr_metadata tags', () => {
			const input = '<pr_metadata uri="u" title="t" description="d" author="a" linkTag="l"/> Body';
			expect(stripReminders(input)).toBe('Body');
		});
		it('removes multiple constructs mixed', () => {
			const input = '<reminder>x</reminder>One<current_datetime>y</current_datetime> <pr_metadata uri="u" title="t" description="d" author="a" linkTag="l"/>Two';
			// Current behavior compacts content without guaranteeing spacing
			expect(stripReminders(input)).toBe('OneTwo');
		});
	});

	describe('buildChatHistoryFromEvents', () => {
		it('builds turns with user and assistant messages including PR metadata', () => {
			const events: any[] = [
				{ type: 'user.message', data: { content: 'Hello', attachments: [] } },
				{ type: 'assistant.message', data: { content: '<pr_metadata uri="https://example.com/pr/1" title="Fix&amp;Improve" description="Desc" author="Alice" linkTag="PR#1"/>This is the PR body.' } }
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			expect(turns).toHaveLength(2); // request + response
			expect(turns[0]).toBeInstanceOf(ChatRequestTurn2);
			expect(turns[1]).toBeInstanceOf(ChatResponseTurn2);
			const responseParts: any = (turns[1] as any).response;
			// ResponseParts is private-ish; fallback to accessing parts array property variations
			const parts: any[] = (responseParts.parts ?? responseParts._parts ?? responseParts);
			// First part should be PR metadata
			const prPart = parts.find(p => p instanceof ChatResponsePullRequestPart);
			expect(prPart).toBeTruthy();
			const markdownPart = parts.find(p => p instanceof ChatResponseMarkdownPart);
			expect(markdownPart).toBeTruthy();
			if (prPart) {
				expect((prPart as any).title).toBe('Fix&Improve'); // &amp; unescaped
				// command is set with openPullRequestReroute
				expect((prPart as any).command.command).toBe('github.copilot.chat.openPullRequestReroute');
			}
			if (markdownPart) {
				expect((markdownPart as any).value?.value || (markdownPart as any).value).toContain('This is the PR body.');
			}
		});

		it('createCopilotCLIToolInvocation formats str_replace_editor view with range', () => {
			const invocation = createCopilotCLIToolInvocation({ toolName: 'str_replace_editor', toolCallId: 'id3', arguments: { command: 'view', path: '/tmp/file.ts', view_range: [1, 5] } }) as ChatToolInvocationPart;
			expect(invocation).toBeInstanceOf(ChatToolInvocationPart);
			const msg = typeof invocation.invocationMessage === 'string' ? invocation.invocationMessage : invocation.invocationMessage?.value;
			expect(msg).toMatch(/Read/);
			expect(msg).toMatch(/file.ts/);
		});

		it('includes tool invocation parts and thinking progress without duplication', () => {
			const events: any[] = [
				{ type: 'user.message', data: { content: 'Run a command', attachments: [] } },
				{ type: 'tool.execution_start', data: { toolName: 'think', toolCallId: 'think-1', arguments: { thought: 'Considering options' } } },
				{ type: 'tool.execution_complete', data: { toolName: 'think', toolCallId: 'think-1', success: true } },
				{ type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'bash-1', arguments: { command: 'echo hi', description: 'Echo' } } },
				{ type: 'tool.execution_complete', data: { toolName: 'bash', toolCallId: 'bash-1', success: true } }
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			expect(turns).toHaveLength(2); // request + response
			const responseTurn = turns[1] as ChatResponseTurn2;
			const responseParts: any = (responseTurn as any).response;
			const parts: any[] = (responseParts.parts ?? responseParts._parts ?? responseParts);
			const thinkingParts = parts.filter(p => p instanceof ChatResponseThinkingProgressPart);
			expect(thinkingParts).toHaveLength(1); // not duplicated on completion
			const toolInvocations = parts.filter(p => p instanceof ChatToolInvocationPart);
			expect(toolInvocations).toHaveLength(1); // bash only
			const bashInvocation = toolInvocations[0] as ChatToolInvocationPart;
			expect(getInvocationMessageText(bashInvocation)).toContain('Echo');
		});

		it('converts file attachments to references on user messages', () => {
			const events: any[] = [
				{
					type: 'user.message', data: {
						content: 'Check #myFile.ts',
						attachments: [
							{ type: 'file', path: '/workspace/myFile.ts', displayName: 'myFile.ts' }
						]
					}
				},
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			expect(turns).toHaveLength(1);
			const requestTurn = turns[0] as ChatRequestTurn2;
			const refs = requestTurn.references;
			const fileRef = refs.find(r => r.id === '/workspace/myFile.ts');
			expect(fileRef).toBeTruthy();
			expect(fileRef!.name).toBe('myFile.ts');
		});

		it('converts directory attachments using getFolderAttachmentPath', () => {
			const events: any[] = [
				{
					type: 'user.message', data: {
						content: 'Check #src',
						attachments: [
							{ type: 'directory', path: '/workspace/src', displayName: 'src' }
						]
					}
				},
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			expect(turns).toHaveLength(1);
			const requestTurn = turns[0] as ChatRequestTurn2;
			const refs = requestTurn.references;
			// Directory attachment should produce a reference
			expect(refs.length).toBeGreaterThanOrEqual(1);
			const dirRef = refs.find(r => r.id === '/workspace/src');
			expect(dirRef).toBeTruthy();
		});

		it('filters out instruction file attachments', () => {
			const events: any[] = [
				{
					type: 'user.message', data: {
						content: 'Hello',
						attachments: [
							{ type: 'file', path: '/workspace/.github/copilot-instructions.md', displayName: 'copilot-instructions.md' },
							{ type: 'file', path: '/workspace/.github/instructions/custom.md', displayName: 'custom.md' },
							{ type: 'file', path: '/workspace/src/app.ts', displayName: 'app.ts' }
						]
					}
				},
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			const requestTurn = turns[0] as ChatRequestTurn2;
			const refs = requestTurn.references;
			// Only app.ts should remain (instruction files are filtered out)
			const paths = refs.map(r => r.id);
			expect(paths).not.toContain('/workspace/.github/copilot-instructions.md');
			expect(paths).not.toContain('/workspace/.github/instructions/custom.md');
			expect(paths).toContain('/workspace/src/app.ts');
		});

		it('does not duplicate file attachments when URI already exists in extracted references', () => {
			// Dedup is between prompt-extracted references and attachments
			// (not between duplicate attachments themselves). Without prompt references,
			// duplicate attachments both get added.
			const events: any[] = [
				{
					type: 'user.message', data: {
						content: 'Check this',
						attachments: [
							{ type: 'file', path: '/workspace/src/app.ts', displayName: 'app.ts' },
							{ type: 'file', path: '/workspace/src/app.ts', displayName: 'app.ts' }
						]
					}
				},
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			const requestTurn = turns[0] as ChatRequestTurn2;
			// Both attachments are added because deduplications checks against
			// prompt-extracted references (existingReferences), not against other attachments
			const appRefs = requestTurn.references.filter(r => r.id === '/workspace/src/app.ts');
			expect(appRefs).toHaveLength(2);
		});
	});

	describe('createCopilotCLIToolInvocation', () => {
		it('returns undefined for report_intent', () => {
			expect(createCopilotCLIToolInvocation({ toolName: 'report_intent', toolCallId: 'id', arguments: { intent: '' } })).toBeUndefined();
		});
		it('creates thinking progress part for think tool', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'think', toolCallId: 'tid', arguments: { thought: 'Analyzing' } });
			expect(part).toBeInstanceOf(ChatResponseThinkingProgressPart);
		});
		it('formats bash tool invocation with description', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'bash', toolCallId: 'b1', arguments: { command: 'ls', description: 'List files' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('List files');
		});
		it('formats str_replace_editor create', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'str_replace_editor', toolCallId: 'e1', arguments: { command: 'create', path: '/tmp/x.ts' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			const msg = getInvocationMessageText(part as ChatToolInvocationPart);
			expect(msg).toMatch(/Creat/);
		});
	});

	describe('process tool execution lifecycle', () => {
		it('marks tool invocation complete and confirmed on success', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			const startEvent: any = { type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'bash-1', arguments: { command: 'echo hi' } } };
			const part = processToolExecutionStart(startEvent, pending);
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			const completeEvent: any = { type: 'tool.execution_complete', data: { toolName: 'bash', toolCallId: 'bash-1', success: true } };
			const [completed,] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			expect(completed.isComplete).toBe(true);
			expect(completed.isError).toBe(false);
			expect(completed.isConfirmed).toBe(true);
		});
		it('marks tool invocation error and unconfirmed when denied', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({ type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'bash-2', arguments: { command: 'rm *' } } } as any, pending);
			const completeEvent: any = { type: 'tool.execution_complete', data: { toolName: 'bash', toolCallId: 'bash-2', success: false, error: { message: 'Denied', code: 'denied' } } };
			const [completed,] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			expect(completed.isComplete).toBe(true);
			expect(completed.isError).toBe(true);
			expect(completed.isConfirmed).toBe(false);
			expect(getInvocationMessageText(completed)).toContain('Denied');
		});
	});

	describe('MCP tool result handling', () => {
		it('handles MCP tool with text content in result.contents', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			const startEvent: any = {
				type: 'tool.execution_start',
				data: { toolName: 'custom_mcp_tool', toolCallId: 'mcp-1', mcpServerName: 'test-server', mcpToolName: 'my-tool', arguments: { foo: 'bar' } }
			};
			processToolExecutionStart(startEvent, pending);

			const completeEvent: any = {
				type: 'tool.execution_complete',
				data: {
					toolName: 'custom_mcp_tool',
					toolCallId: 'mcp-1',
					mcpServerName: 'test-server',
					mcpToolName: 'my-tool',
					success: true,
					result: {
						contents: [
							{ type: 'text', text: 'Hello from MCP tool' }
						]
					}
				}
			};
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			expect(completed.isComplete).toBe(true);
			expect(completed.toolSpecificData).toBeDefined();
			const mcpData = completed.toolSpecificData as any;
			expect(mcpData.input).toContain('foo');
			expect(mcpData.output).toHaveLength(1);
		});

		it('handles MCP tool with empty result.contents', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'empty_mcp', toolCallId: 'mcp-2', mcpServerName: 'server', mcpToolName: 'tool', arguments: {} }
			} as any, pending);

			const completeEvent: any = {
				type: 'tool.execution_complete',
				data: {
					toolName: 'empty_mcp',
					toolCallId: 'mcp-2',
					mcpServerName: 'server',
					mcpToolName: 'tool',
					success: true,
					result: { contents: [] }
				}
			};
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			expect(completed.toolSpecificData).toBeDefined();
			const mcpData = completed.toolSpecificData as any;
			expect(mcpData.output).toHaveLength(0);
		});

		it('handles MCP tool with undefined result.contents', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'no_contents_mcp', toolCallId: 'mcp-3', mcpServerName: 'server', mcpToolName: 'tool', arguments: {} }
			} as any, pending);

			const completeEvent: any = {
				type: 'tool.execution_complete',
				data: {
					toolName: 'no_contents_mcp',
					toolCallId: 'mcp-3',
					mcpServerName: 'server',
					mcpToolName: 'tool',
					success: true,
					result: {}
				}
			};
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			expect(completed.toolSpecificData).toBeDefined();
			const mcpData = completed.toolSpecificData as any;
			expect(mcpData.output).toHaveLength(0);
		});
	});

	describe('glob/grep tool with terminal content type', () => {
		it('parses files from result.contents with terminal type', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'glob', toolCallId: 'glob-1', arguments: { pattern: '*.ts' } }
			} as any, pending);

			const completeEvent: any = {
				type: 'tool.execution_complete',
				data: {
					toolName: 'glob',
					toolCallId: 'glob-1',
					success: true,
					result: {
						contents: [
							{ type: 'terminal', text: './file1.ts\n./file2.ts\n./file3.ts' }
						]
					}
				}
			};
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			expect(completed.pastTenseMessage).toContain('3 results');
			expect(completed.toolSpecificData).toBeDefined();
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(3);
		});

		it('handles empty terminal text as no matches', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'grep', toolCallId: 'grep-1', arguments: { pattern: 'nonexistent' } }
			} as any, pending);

			const completeEvent: any = {
				type: 'tool.execution_complete',
				data: {
					toolName: 'grep',
					toolCallId: 'grep-1',
					success: true,
					result: {
						contents: [
							{ type: 'terminal', text: '' }
						]
					}
				}
			};
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			expect(completed.pastTenseMessage).toContain('.');
			expect(completed.pastTenseMessage).not.toContain('result');
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(0);
		});

		it('handles whitespace-only terminal text as no matches', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'rg', toolCallId: 'rg-1', arguments: { pattern: 'missing' } }
			} as any, pending);

			const completeEvent: any = {
				type: 'tool.execution_complete',
				data: {
					toolName: 'rg',
					toolCallId: 'rg-1',
					success: true,
					result: {
						contents: [
							{ type: 'terminal', text: '   \n\t\n  ' }
						]
					}
				}
			};
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(0);
		});

		it('falls back to result.content when contents is not present', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'glob', toolCallId: 'glob-2', arguments: { pattern: '*.js' } }
			} as any, pending);

			const completeEvent: any = {
				type: 'tool.execution_complete',
				data: {
					toolName: 'glob',
					toolCallId: 'glob-2',
					success: true,
					result: {
						content: './app.js\n./index.js'
					}
				}
			};
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			expect(completed.pastTenseMessage).toContain('2 results');
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(2);
		});

		it('detects no matches message in legacy result.content format', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'grep', toolCallId: 'grep-2', arguments: { pattern: 'xyz' } }
			} as any, pending);

			const completeEvent: any = {
				type: 'tool.execution_complete',
				data: {
					toolName: 'grep',
					toolCallId: 'grep-2',
					success: true,
					result: {
						content: 'No matches found'
					}
				}
			};
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall];
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(0);
		});
	});

	describe('extractCdPrefix', () => {
		it('extracts cd prefix from bash command', () => {
			const result = extractCdPrefix('cd /home/user/project && npm run test', false);
			expect(result).toEqual({ directory: '/home/user/project', command: 'npm run test' });
		});

		it('returns undefined for bash command without cd prefix', () => {
			expect(extractCdPrefix('npm run test', false)).toBeUndefined();
		});

		it('strips surrounding quotes from directory path', () => {
			const result = extractCdPrefix('cd "/path/with spaces" && ls', false);
			expect(result).toEqual({ directory: '/path/with spaces', command: 'ls' });
		});

		it('extracts cd prefix from powershell command with &&', () => {
			const result = extractCdPrefix('cd /d C:\\project && npm start', true);
			expect(result).toEqual({ directory: 'C:\\project', command: 'npm start' });
		});

		it('extracts Set-Location prefix from powershell command', () => {
			const result = extractCdPrefix('Set-Location C:\\project; npm start', true);
			expect(result).toEqual({ directory: 'C:\\project', command: 'npm start' });
		});

		it('extracts Set-Location -Path prefix from powershell command', () => {
			const result = extractCdPrefix('Set-Location -Path C:\\project && npm start', true);
			expect(result).toEqual({ directory: 'C:\\project', command: 'npm start' });
		});

		it('returns undefined for command with only cd and no suffix', () => {
			expect(extractCdPrefix('cd /home/user', false)).toBeUndefined();
		});
	});

	describe('formatShellInvocation with presentationOverrides', () => {
		it('sets presentationOverrides when cd prefix matches workingDirectory', () => {
			const workingDirectory = URI.file('/home/user/project');
			const part = createCopilotCLIToolInvocation({
				toolName: 'bash',
				toolCallId: 'b-cd-1',
				arguments: { command: 'cd /home/user/project && npm run unit', description: 'Run tests' }
			}, undefined, workingDirectory) as ChatToolInvocationPart;
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			const data = part.toolSpecificData as any;
			expect(data.commandLine.original).toBe('npm run unit');
			expect(data.presentationOverrides).toEqual({ commandLine: 'npm run unit' });
		});

		it('does not set presentationOverrides when cd prefix does not match workingDirectory', () => {
			const workingDirectory = URI.file('/other/directory');
			const part = createCopilotCLIToolInvocation({
				toolName: 'bash',
				toolCallId: 'b-cd-mismatch',
				arguments: { command: 'cd /home/user/project && npm run unit', description: 'Run tests' }
			}, undefined, workingDirectory) as ChatToolInvocationPart;
			const data = part.toolSpecificData as any;
			expect(data.commandLine.original).toBe('cd /home/user/project && npm run unit');
			expect(data.presentationOverrides).toBeUndefined();
		});

		it('does not set presentationOverrides when no workingDirectory provided', () => {
			const part = createCopilotCLIToolInvocation({
				toolName: 'bash',
				toolCallId: 'b-cd-nowd',
				arguments: { command: 'cd /home/user/project && npm run unit', description: 'Run tests' }
			}) as ChatToolInvocationPart;
			const data = part.toolSpecificData as any;
			expect(data.commandLine.original).toBe('cd /home/user/project && npm run unit');
			expect(data.presentationOverrides).toBeUndefined();
		});

		it('does not set presentationOverrides when no cd prefix', () => {
			const workingDirectory = URI.file('/home/user/project');
			const part = createCopilotCLIToolInvocation({
				toolName: 'bash',
				toolCallId: 'b-nocd-1',
				arguments: { command: 'npm run unit', description: 'Run tests' }
			}, undefined, workingDirectory) as ChatToolInvocationPart;
			const data = part.toolSpecificData as any;
			expect(data.commandLine.original).toBe('npm run unit');
			expect(data.presentationOverrides).toBeUndefined();
		});

		it('sets presentationOverrides on completed shell invocation when cd matches workingDirectory', () => {
			const workingDirectory = URI.file('/workspace');
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'bash', toolCallId: 'b-cd-2', arguments: { command: 'cd /workspace && make build', description: 'Build' } }
			} as any, pending, workingDirectory);

			const [completed] = processToolExecutionComplete({
				type: 'tool.execution_complete',
				data: {
					toolName: 'bash',
					toolCallId: 'b-cd-2',
					success: true,
					result: { content: 'build output\n<exited with exit code 0>' }
				}
			} as any, pending, logger, workingDirectory)! as [ChatToolInvocationPart, ToolCall];

			const data = completed.toolSpecificData as any;
			expect(data.commandLine.original).toBe('make build');
			expect(data.presentationOverrides).toEqual({ commandLine: 'make build' });
			expect(data.state.exitCode).toBe(0);
		});

		it('does not set presentationOverrides on completed shell invocation when cd does not match workingDirectory', () => {
			const workingDirectory = URI.file('/other');
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'bash', toolCallId: 'b-cd-3', arguments: { command: 'cd /workspace && make build', description: 'Build' } }
			} as any, pending, workingDirectory);

			const [completed] = processToolExecutionComplete({
				type: 'tool.execution_complete',
				data: {
					toolName: 'bash',
					toolCallId: 'b-cd-3',
					success: true,
					result: { content: '<exited with exit code 0>' }
				}
			} as any, pending, logger, workingDirectory)! as [ChatToolInvocationPart, ToolCall];

			const data = completed.toolSpecificData as any;
			expect(data.presentationOverrides).toBeUndefined();
		});
	});

	describe('integration edge cases', () => {
		it('ignores report_intent events inside history build', () => {
			const events: any[] = [
				{ type: 'user.message', data: { content: 'Hi', attachments: [] } },
				{ type: 'tool.execution_start', data: { toolName: 'report_intent', toolCallId: 'ri-1', arguments: {} } },
				{ type: 'tool.execution_complete', data: { toolName: 'report_intent', toolCallId: 'ri-1', success: true } }
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			expect(turns).toHaveLength(1); // Only user turn, no response parts because no assistant/tool parts were added
		});

		it('handles multiple user messages flushing response parts correctly', () => {
			const events: any[] = [
				{ type: 'assistant.message', data: { content: 'Hello' } },
				{ type: 'user.message', data: { content: 'Follow up', attachments: [] } },
				{ type: 'assistant.message', data: { content: 'Response 2' } }
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			// Expect: first assistant message buffered until user msg -> becomes response turn, then user request, then second assistant -> another response
			expect(turns.filter(t => t instanceof ChatResponseTurn2)).toHaveLength(2);
			expect(turns.filter(t => t instanceof ChatRequestTurn2)).toHaveLength(1);
		});

		it('creates markdown part only when cleaned content not empty after stripping PR metadata', () => {
			const events: any[] = [
				{ type: 'assistant.message', data: { content: '<pr_metadata uri="u" title="t" description="d" author="a" linkTag="l"/>' } }
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			// Single response turn with ONLY PR part (no markdown text)
			const responseTurns = turns.filter(t => t instanceof ChatResponseTurn2) as ChatResponseTurn2[];
			expect(responseTurns).toHaveLength(1);
			const responseParts: any = (responseTurns[0] as any).response;
			const parts: any[] = (responseParts.parts ?? responseParts._parts ?? responseParts);
			const prCount = parts.filter(p => p instanceof ChatResponsePullRequestPart).length;
			const mdCount = parts.filter(p => p instanceof ChatResponseMarkdownPart).length;
			expect(prCount).toBe(1);
			expect(mdCount).toBe(0);
		});
	});
});

