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
	ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponsePullRequestPart, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatToolInvocationPart, MarkdownString
} from '../../../../../vscodeTypes';
import {
	buildChatHistoryFromEvents, createCopilotCLIToolInvocation, extractCdPrefix, getAffectedUrisForEditTool, isCopilotCliEditToolCall, isCopilotCLIToolThatCouldRequirePermissions, processToolExecutionComplete, processToolExecutionStart, stripReminders, ToolCall
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

		it('renders task_complete summary as markdown in chat history', () => {
			const events: any[] = [
				{ type: 'user.message', data: { content: 'Finish task', attachments: [] } },
				{ type: 'tool.execution_start', data: { toolName: 'task_complete', toolCallId: 'tc-1', arguments: { summary: 'All tests are passing.' } } },
				{ type: 'tool.execution_complete', data: { toolName: 'task_complete', toolCallId: 'tc-1', success: true } }
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			expect(turns).toHaveLength(2);
			const responseTurn = turns[1] as ChatResponseTurn2;
			const responseParts: any = (responseTurn as any).response;
			const parts: any[] = (responseParts.parts ?? responseParts._parts ?? responseParts);
			const markdownParts = parts.filter(p => p instanceof ChatResponseMarkdownPart);
			expect(markdownParts).toHaveLength(1);
			expect((markdownParts[0] as any).value?.value || (markdownParts[0] as any).value).toContain('All tests are passing.');
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

		it('excludes subagent markdown from top-level history', () => {
			const events: any[] = [
				{ type: 'user.message', id: 'u1', data: { content: 'Do something', attachments: [] } },
				// Top-level assistant message (no parentToolCallId)
				{ type: 'assistant.message', id: 'a1', data: { messageId: 'msg-1', content: 'Top-level reply' } },
				// Sub-agent delta (has parentToolCallId) — should be excluded
				{ type: 'assistant.message_delta', id: 'a2', data: { messageId: 'msg-2', deltaContent: 'sub-agent thinking...', parentToolCallId: 'task-1' } },
				// Sub-agent full message (has parentToolCallId) — should be excluded
				{ type: 'assistant.message', id: 'a3', data: { messageId: 'msg-3', content: 'sub-agent result text', parentToolCallId: 'task-1' } },
				// Top-level assistant message after subagent
				{ type: 'assistant.message', id: 'a4', data: { messageId: 'msg-4', content: 'Final answer' } },
			];
			const turns = buildChatHistoryFromEvents('', undefined, events, getVSCodeRequestId, delegationSummary, logger);
			expect(turns).toHaveLength(2); // 1 request + 1 response
			const responseTurn = turns[1] as ChatResponseTurn2;
			const parts: any[] = ((responseTurn as any).response.parts ?? (responseTurn as any).response._parts ?? (responseTurn as any).response);
			const markdownParts = parts.filter(p => p instanceof ChatResponseMarkdownPart);
			const allText = markdownParts.map(p => (p as any).value?.value ?? (p as any).value).join('');
			// Top-level messages should be present
			expect(allText).toContain('Top-level reply');
			expect(allText).toContain('Final answer');
			// Sub-agent messages should NOT be present
			expect(allText).not.toContain('sub-agent thinking');
			expect(allText).not.toContain('sub-agent result text');
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
		it.skip('formats show_file invocation with path', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'show_file', toolCallId: 'sf1', arguments: { path: '/tmp/file.ts' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toMatch(/Showing.*file\.ts/);
		});
		it.skip('formats show_file invocation with diff mode', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'show_file', toolCallId: 'sf2', arguments: { path: '/tmp/file.ts', diff: true } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toMatch(/diff/i);
		});
		it.skip('formats show_file invocation with view_range', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'show_file', toolCallId: 'sf3', arguments: { path: '/tmp/file.ts', view_range: [10, 20] } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			const msg = getInvocationMessageText(part as ChatToolInvocationPart);
			expect(msg).toMatch(/10/);
			expect(msg).toMatch(/20/);
		});
		it('formats propose_work invocation with title', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'propose_work', toolCallId: 'pw1', arguments: { workType: 'code_change', workTitle: 'Refactor auth', workDescription: 'desc' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('Refactor auth');
		});
		it('returns markdown part for task_complete invocation with summary', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'task_complete', toolCallId: 'tc1', arguments: { summary: 'Fixed the bug' } });
			expect(part).toBeInstanceOf(ChatResponseMarkdownPart);
			expect((part as ChatResponseMarkdownPart).value.value).toContain('Fixed the bug');
		});
		it('returns undefined for task_complete invocation without summary', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'task_complete', toolCallId: 'tc2', arguments: {} });
			expect(part).toBeUndefined();
		});
		it('formats ask_user invocation with question', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'ask_user', toolCallId: 'au1', arguments: { question: 'Which DB?' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('Which DB?');
		});
		it('formats ask_user invocation with structured message', () => {
			const part = createCopilotCLIToolInvocation({
				toolName: 'ask_user',
				toolCallId: 'au2',
				arguments: {
					message: 'Pick a deployment target',
					requestedSchema: {
						properties: {
							target: { type: 'string', enum: ['staging', 'prod'] }
						},
						required: ['target']
					}
				}
			});
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('Pick a deployment target');
		});
		it('formats skill invocation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'skill', toolCallId: 'sk1', arguments: { skill: 'pdf' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('pdf');
		});
		it('formats task invocation with description', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'task', toolCallId: 't1', arguments: { description: 'Run tests', prompt: 'Run all unit tests', agent_type: 'task' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('Run tests');
		});
		it('formats read_agent invocation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'read_agent', toolCallId: 'ra1', arguments: { agent_id: 'agent-123' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('agent-123');
		});
		it('formats exit_plan_mode invocation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'exit_plan_mode', toolCallId: 'ep1', arguments: { summary: 'Plan summary' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toMatch(/plan/i);
		});
		it('formats sql invocation with description', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'sql', toolCallId: 'sq1', arguments: { description: 'Query todos', query: 'SELECT * FROM todos' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('Query todos');
		});
		it('formats lsp invocation with file', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'lsp', toolCallId: 'lsp1', arguments: { operation: 'goToDefinition', file: '/tmp/app.ts', line: 10, character: 5 } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			const msg = getInvocationMessageText(part as ChatToolInvocationPart);
			expect(msg).toContain('goToDefinition');
			expect(msg).toMatch(/app\.ts/);
		});
		it('formats lsp invocation without file', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'lsp', toolCallId: 'lsp2', arguments: { operation: 'workspaceSymbol', query: 'MyClass' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('workspaceSymbol');
		});
		it('formats create_pull_request invocation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'create_pull_request', toolCallId: 'pr1', arguments: { title: 'Fix auth flow', description: 'Summary of changes', draft: false } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('Fix auth flow');
			expect((part as ChatToolInvocationPart).originMessage).toContain('Summary of changes');
		});
		it('formats search_code_subagent invocation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'search_code_subagent', toolCallId: 'sc1', arguments: { query: 'find auth middleware' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('find auth middleware');
		});
		it('formats store_memory invocation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'store_memory', toolCallId: 'sm1', arguments: { subject: 'naming', fact: 'Use camelCase', citations: 'src/foo.ts:1', reason: 'consistency', category: 'general' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('naming');
		});
		it('creates invocation for fetch_copilot_cli_documentation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'fetch_copilot_cli_documentation', toolCallId: 'fd1', arguments: {} });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
		});
		it('creates invocation for list_agents', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'list_agents', toolCallId: 'la1', arguments: {} });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
		});
		it('creates invocation for list_bash', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'list_bash', toolCallId: 'lb1', arguments: {} });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
		});
		it('creates invocation for list_powershell', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'list_powershell', toolCallId: 'lp1', arguments: {} });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
		});
		it('creates invocation for gh-advisory-database', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'gh-advisory-database', toolCallId: 'gh1', arguments: { dependencies: [{ name: 'lodash', version: '4.17.0', ecosystem: 'npm' }] } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
		});
		it('creates invocation for parallel_validation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'parallel_validation', toolCallId: 'pv1', arguments: {} });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
		});
		it('formats apply_patch invocation', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'apply_patch', toolCallId: 'ap1', arguments: { input: '*** Begin Patch\n*** End Patch' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toMatch(/patch/i);
		});
		it('formats write_agent invocation with agent_id', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'write_agent', toolCallId: 'wa1', arguments: { agent_id: 'agent-42', message: 'Hello agent' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('agent-42');
		});
		it('creates invocation for mcp_reload', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'mcp_reload', toolCallId: 'mr1', arguments: {} });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
		});
		it('formats mcp_validate invocation with path', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'mcp_validate', toolCallId: 'mv1', arguments: { path: '/home/user/.copilot/config/mcp-config.json' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toMatch(/mcp-config\.json/i);
		});
		it('formats tool_search_tool_regex invocation with pattern', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'tool_search_tool_regex', toolCallId: 'ts1', arguments: { pattern: 'search.*file' } });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			expect(getInvocationMessageText(part as ChatToolInvocationPart)).toContain('search.*file');
		});
		it('creates invocation for codeql_checker', () => {
			const part = createCopilotCLIToolInvocation({ toolName: 'codeql_checker', toolCallId: 'cq1', arguments: {} });
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
		});
	});

	describe('process tool execution lifecycle', () => {
		it('marks tool invocation complete and confirmed on success', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
			const startEvent: any = { type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'bash-1', arguments: { command: 'echo hi' } } };
			const part = processToolExecutionStart(startEvent, pending);
			expect(part).toBeInstanceOf(ChatToolInvocationPart);
			const completeEvent: any = { type: 'tool.execution_complete', data: { toolName: 'bash', toolCallId: 'bash-1', success: true } };
			const [completed,] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			expect(completed.isComplete).toBe(true);
			expect(completed.isError).toBe(false);
			expect(completed.isConfirmed).toBe(true);
		});
		it('marks tool invocation error and unconfirmed when denied', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
			processToolExecutionStart({ type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'bash-2', arguments: { command: 'rm *' } } } as any, pending);
			const completeEvent: any = { type: 'tool.execution_complete', data: { toolName: 'bash', toolCallId: 'bash-2', success: false, error: { message: 'Denied', code: 'denied' } } };
			const [completed,] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			expect(completed.isComplete).toBe(true);
			expect(completed.isError).toBe(true);
			expect(completed.isConfirmed).toBe(false);
			expect(getInvocationMessageText(completed)).toContain('Denied');
		});

		it('adds task_complete markdown start event to pending invocations', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
			const part = processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'task_complete', toolCallId: 'tc-start', arguments: { summary: 'Task done.' } }
			} as any, pending);

			expect(part).toBeInstanceOf(ChatResponseMarkdownPart);
			expect((part as ChatResponseMarkdownPart).value.value).toContain('Task done.');
			expect(pending.size).toBe(1);
		});

		it('returns task_complete markdown part on completion', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
			processToolExecutionStart({
				type: 'tool.execution_start',
				data: { toolName: 'task_complete', toolCallId: 'tc-complete', arguments: { summary: 'Done.' } }
			} as any, pending);

			const completed = processToolExecutionComplete({
				type: 'tool.execution_complete',
				data: { toolName: 'task_complete', toolCallId: 'tc-complete', success: true }
			} as any, pending, logger);

			expect(completed).toBeDefined();
			const [part] = completed!;
			expect(part).toBeInstanceOf(ChatResponseMarkdownPart);
			expect((part as ChatResponseMarkdownPart).value.value).toContain('Done.');
		});
	});

	describe('MCP tool result handling', () => {
		it('handles MCP tool with text content in result.contents', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			expect(completed.isComplete).toBe(true);
			expect(completed.toolSpecificData).toBeDefined();
			const mcpData = completed.toolSpecificData as any;
			expect(mcpData.input).toContain('foo');
			expect(mcpData.output).toHaveLength(1);
		});

		it('handles MCP tool with empty result.contents', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			expect(completed.toolSpecificData).toBeDefined();
			const mcpData = completed.toolSpecificData as any;
			expect(mcpData.output).toHaveLength(0);
		});

		it('handles MCP tool with undefined result.contents', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			expect(completed.toolSpecificData).toBeDefined();
			const mcpData = completed.toolSpecificData as any;
			expect(mcpData.output).toHaveLength(0);
		});
	});

	describe('glob/grep tool with terminal content type', () => {
		it('parses files from result.contents with terminal type', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			expect(completed.pastTenseMessage).toContain('3 results');
			expect(completed.toolSpecificData).toBeDefined();
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(3);
		});

		it('handles empty terminal text as no matches', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			expect(completed.pastTenseMessage).toContain('.');
			expect(completed.pastTenseMessage).not.toContain('result');
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(0);
		});

		it('handles whitespace-only terminal text as no matches', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(0);
		});

		it('falls back to result.content when contents is not present', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
			expect(completed.pastTenseMessage).toContain('2 results');
			const data = completed.toolSpecificData as any;
			expect(data.values).toHaveLength(2);
		});

		it('detects no matches message in legacy result.content format', () => {
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			const [completed] = processToolExecutionComplete(completeEvent, pending, logger)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];
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
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			} as any, pending, logger, workingDirectory)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];

			const data = completed.toolSpecificData as any;
			expect(data.commandLine.original).toBe('make build');
			expect(data.presentationOverrides).toEqual({ commandLine: 'make build' });
			expect(data.state.exitCode).toBe(0);
		});

		it('does not set presentationOverrides on completed shell invocation when cd does not match workingDirectory', () => {
			const workingDirectory = URI.file('/other');
			const pending = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();
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
			} as any, pending, logger, workingDirectory)! as [ChatToolInvocationPart, ToolCall, parentToolCallId: string | undefined];

			const data = completed.toolSpecificData as any;
			expect(data.presentationOverrides).toBeUndefined();
		});
	});

	describe('isCopilotCLIToolThatCouldRequirePermissions', () => {
		const makeEvent = (data: Record<string, unknown>) => ({ type: 'tool.execution_start', data } as any);

		it('returns true for edit tool calls (create, edit)', () => {
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'create', toolCallId: '1', arguments: { path: '/tmp/a' } }))).toBe(true);
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'edit', toolCallId: '2', arguments: { path: '/tmp/b' } }))).toBe(true);
		});

		it('returns true for str_replace_editor non-view commands', () => {
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'str_replace_editor', toolCallId: '3', arguments: { command: 'str_replace', path: '/tmp/a' } }))).toBe(true);
		});

		it('returns true for bash and powershell', () => {
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'bash', toolCallId: '4', arguments: { command: 'echo hi' } }))).toBe(true);
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'powershell', toolCallId: '5', arguments: { command: 'echo hi' } }))).toBe(true);
		});

		it('returns true for view tool', () => {
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'view', toolCallId: '6', arguments: { path: '/tmp/a' } }))).toBe(true);
		});

		it('returns false for MCP tools even if tool name matches', () => {
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'bash', toolCallId: '7', mcpServerName: 'my-server', arguments: { command: 'echo' } }))).toBe(false);
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'view', toolCallId: '8', mcpServerName: 'my-server', arguments: { path: '/tmp' } }))).toBe(false);
		});

		it('returns false for non-permission tools like think, report_intent, glob', () => {
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'think', toolCallId: '9', arguments: { thought: 'hmm' } }))).toBe(false);
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'report_intent', toolCallId: '10', arguments: {} }))).toBe(false);
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'glob', toolCallId: '11', arguments: { pattern: '*.ts' } }))).toBe(false);
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'grep', toolCallId: '12', arguments: { pattern: 'foo' } }))).toBe(false);
		});

		it('returns false for str_replace_editor view command (not an edit)', () => {
			expect(isCopilotCLIToolThatCouldRequirePermissions(makeEvent({ toolName: 'str_replace_editor', toolCallId: '13', arguments: { command: 'view', path: '/tmp/a' } }))).toBe(false);
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

