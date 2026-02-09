/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ChatPromptReference } from 'vscode';
import { TestLogService } from '../../../../../platform/testing/common/testLogService';
import { mock } from '../../../../../util/common/test/simpleMock';
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
			const turns = buildChatHistoryFromEvents('', events, getVSCodeRequestId, delegationSummary, logger);
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
				// uri is stored as a Uri
				expect((prPart as any).uri.toString()).toContain('https://example.com/pr/1');
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
			const turns = buildChatHistoryFromEvents('', events, getVSCodeRequestId, delegationSummary, logger);
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

	describe('integration edge cases', () => {
		it('ignores report_intent events inside history build', () => {
			const events: any[] = [
				{ type: 'user.message', data: { content: 'Hi', attachments: [] } },
				{ type: 'tool.execution_start', data: { toolName: 'report_intent', toolCallId: 'ri-1', arguments: {} } },
				{ type: 'tool.execution_complete', data: { toolName: 'report_intent', toolCallId: 'ri-1', success: true } }
			];
			const turns = buildChatHistoryFromEvents('', events, getVSCodeRequestId, delegationSummary, logger);
			expect(turns).toHaveLength(1); // Only user turn, no response parts because no assistant/tool parts were added
		});

		it('handles multiple user messages flushing response parts correctly', () => {
			const events: any[] = [
				{ type: 'assistant.message', data: { content: 'Hello' } },
				{ type: 'user.message', data: { content: 'Follow up', attachments: [] } },
				{ type: 'assistant.message', data: { content: 'Response 2' } }
			];
			const turns = buildChatHistoryFromEvents('', events, getVSCodeRequestId, delegationSummary, logger);
			// Expect: first assistant message buffered until user msg -> becomes response turn, then user request, then second assistant -> another response
			expect(turns.filter(t => t instanceof ChatResponseTurn2)).toHaveLength(2);
			expect(turns.filter(t => t instanceof ChatRequestTurn2)).toHaveLength(1);
		});

		it('creates markdown part only when cleaned content not empty after stripping PR metadata', () => {
			const events: any[] = [
				{ type: 'assistant.message', data: { content: '<pr_metadata uri="u" title="t" description="d" author="a" linkTag="l"/>' } }
			];
			const turns = buildChatHistoryFromEvents('', events, getVSCodeRequestId, delegationSummary, logger);
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

