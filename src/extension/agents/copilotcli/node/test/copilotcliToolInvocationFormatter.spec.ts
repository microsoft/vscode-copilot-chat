/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatToolInvocationPart } from '../../../../../vscodeTypes';
import { buildChatHistoryFromEvents, CopilotCLIToolNames, createCopilotCLIToolInvocation, processToolExecutionComplete, processToolExecutionStart, stripReminders } from '../copilotcliToolInvocationFormatter';

// Minimal SDK event shapes for testing
interface UserMessageEvent { type: 'user.message'; data: { content?: string; attachments?: { path: string; type: 'file'; displayName: string }[] } }
interface AssistantMessageEvent { type: 'assistant.message'; data: { content?: string } }
interface ToolExecutionStart { type: 'tool.execution_start'; data: { toolName: string; toolCallId: string; arguments: any } }
interface ToolExecutionComplete { type: 'tool.execution_complete'; data: { toolCallId: string; success: boolean; error?: { code: string; message?: string } } }

type SessionEvent = UserMessageEvent | AssistantMessageEvent | ToolExecutionStart | ToolExecutionComplete;

describe('copilotcliToolInvocationFormatter', () => {
	it('stripReminders removes reminder, datetime and pr_metadata tags', () => {
		const input = '\n<reminder>Do not say this</reminder> Keep this text <current_datetime>2025-10-29</current_datetime> and <pr_metadata uri="x" title="t" description="d" author="a" linkTag="l"/> final.';
		const output = stripReminders(input);
		expect(output).toBe('Keep this text and final.');
	});

	it('buildChatHistoryFromEvents constructs user and assistant turns and strips reminders', () => {
		const events: SessionEvent[] = [
			{ type: 'user.message', data: { content: '<reminder>ignore</reminder>User question', attachments: [{ path: '/workspace/file.txt', type: 'file', displayName: 'file.txt' }] } },
			{ type: 'assistant.message', data: { content: '<pr_metadata uri="https://example.com/pr/1" title="Title" description="Desc" author="Alice" linkTag="PR-1"/>Here is the answer' } },
			{ type: 'tool.execution_start', data: { toolName: CopilotCLIToolNames.Think, toolCallId: 'think-1', arguments: { thought: 'Reasoning…' } } },
			{ type: 'tool.execution_complete', data: { toolCallId: 'think-1', success: true } }
		];
		const turns = buildChatHistoryFromEvents(events as any);
		expect(turns.length).toBe(2);
		expect(turns[0]).toBeInstanceOf(ChatRequestTurn2);
		expect(turns[1]).toBeInstanceOf(ChatResponseTurn2);
		// Basic sanity: user content had reminder stripped
		const userTurn = turns[0] as ChatRequestTurn2 & { content?: string };
		const rawContent = userTurn.prompt || '';
		expect(rawContent).not.toMatch(/reminder>/);
	});

	it('createCopilotCLIToolInvocation returns undefined for report_intent and think handled separately', () => {
		const reportIntent = createCopilotCLIToolInvocation(CopilotCLIToolNames.ReportIntent, 'id1', {});
		expect(reportIntent).toBeUndefined();
		const thinkInvocation = createCopilotCLIToolInvocation(CopilotCLIToolNames.Think, 'id2', { thought: 'A chain of thought' });
		expect(thinkInvocation).toBeInstanceOf(ChatResponseThinkingProgressPart);
	});

	it('createCopilotCLIToolInvocation formats str_replace_editor view with range', () => {
		const invocation = createCopilotCLIToolInvocation(CopilotCLIToolNames.StrReplaceEditor, 'id3', { command: 'view', path: '/tmp/file.ts', view_range: [1, 5] }) as ChatToolInvocationPart;
		expect(invocation).toBeInstanceOf(ChatToolInvocationPart);
		const msg = typeof invocation.invocationMessage === 'string' ? invocation.invocationMessage : invocation.invocationMessage?.value;
		expect(msg).toMatch(/Viewed/);
		expect(msg).toMatch(/file.ts/);
	});

	it('createCopilotCLIToolInvocation formats bash invocation with command and description', () => {
		const invocation = createCopilotCLIToolInvocation(CopilotCLIToolNames.Bash, 'bash-1', { command: 'echo "hi"', description: 'Run echo' });
		expect(invocation).toBeInstanceOf(ChatToolInvocationPart);
		// @ts-expect-error internal props
		expect(invocation?.toolSpecificData?.language).toBe('bash');
		// @ts-expect-error invocationMessage internal
		expect(invocation?.invocationMessage?.value).toBe('Run echo');
	});

	it('createCopilotCLIToolInvocation handles generic tool', () => {
		const invocation = createCopilotCLIToolInvocation('custom_tool', 'custom-1', { foo: 'bar' }) as ChatToolInvocationPart;
		expect(invocation).toBeInstanceOf(ChatToolInvocationPart);
		// invocationMessage may be a plain string for generic tools
		const msg = typeof invocation.invocationMessage === 'string' ? invocation.invocationMessage : invocation.invocationMessage?.value;
		expect(msg).toMatch(/Used tool: custom_tool/);
	});

	it('processToolExecutionStart stores invocation and processToolExecutionComplete updates status on success', () => {
		const pending = new Map<string, ChatToolInvocationPart | ChatResponseThinkingProgressPart>();
		const startEvt: ToolExecutionStart = { type: 'tool.execution_start', data: { toolName: CopilotCLIToolNames.View, toolCallId: 'call-1', arguments: { command: 'view', path: '/x.ts' } } };
		const part = processToolExecutionStart(startEvt as any, pending);
		expect(part).toBeInstanceOf(ChatToolInvocationPart);
		const completeEvt: ToolExecutionComplete = { type: 'tool.execution_complete', data: { toolCallId: 'call-1', success: true } };
		const completed = processToolExecutionComplete(completeEvt as any, pending) as ChatToolInvocationPart;
		expect(completed.isComplete).toBe(true);
		expect(completed.isError).toBe(false);
		expect(completed.isConfirmed).toBe(true);
	});

	it('processToolExecutionComplete marks rejected error invocation', () => {
		const pending = new Map<string, ChatToolInvocationPart | ChatResponseThinkingProgressPart>();
		const startEvt: ToolExecutionStart = { type: 'tool.execution_start', data: { toolName: CopilotCLIToolNames.View, toolCallId: 'call-err', arguments: { command: 'view', path: '/y.ts' } } };
		const part = processToolExecutionStart(startEvt as any, pending) as ChatToolInvocationPart;
		expect(part).toBeInstanceOf(ChatToolInvocationPart);
		const completeEvt: ToolExecutionComplete = { type: 'tool.execution_complete', data: { toolCallId: 'call-err', success: false, error: { code: 'rejected', message: 'Denied' } } };
		const completed = processToolExecutionComplete(completeEvt as any, pending) as ChatToolInvocationPart;
		expect(completed.isComplete).toBe(true);
		expect(completed.isError).toBe(true);
		expect(completed.isConfirmed).toBe(false);
		// message could be a string after error override
		const msg = typeof completed.invocationMessage === 'string' ? completed.invocationMessage : completed.invocationMessage?.value;
		expect(msg).toMatch(/Denied/);
	});
});
