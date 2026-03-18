/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PostToolUseFailureHookInput, PostToolUseHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import sinon from 'sinon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ILogService } from '../../../../../platform/log/common/logService';
import { resolveOTelConfig } from '../../../../../platform/otel/common/index';
import { ICompletedSpanData } from '../../../../../platform/otel/common/otelService';
import { InMemoryOTelService } from '../../../../../platform/otel/node/inMemoryOTelService';
import { NullRequestLogger } from '../../../../../platform/requestLogger/node/nullRequestLogger';
import { IClaudeSessionStateService } from '../claudeSessionStateService';
import { PostToolUseFailureLoggingHook, PostToolUseLoggingHook, PreToolUseLoggingHook } from '../hooks/toolHooks';

function createOTelService() {
	const config = resolveOTelConfig({ env: {}, extensionVersion: '0.0.0', sessionId: 'test' });
	const otelService = new InMemoryOTelService(config);
	const spans: ICompletedSpanData[] = [];
	otelService.onDidCompleteSpan(span => spans.push(span));
	return { otelService, spans };
}

function createMockLogService(): sinon.SinonStubbedInstance<ILogService> {
	return {
		trace: sinon.stub(),
		debug: sinon.stub(),
		info: sinon.stub(),
		warn: sinon.stub(),
		error: sinon.stub(),
		show: sinon.stub(),
		createSubLogger: sinon.stub(),
	} as unknown as sinon.SinonStubbedInstance<ILogService>;
}

function createMockSessionStateService(): sinon.SinonStubbedInstance<IClaudeSessionStateService> {
	return {
		onDidChangeSessionState: sinon.stub().returns({ dispose: () => { } }),
		getModelIdForSession: sinon.stub().returns('claude-sonnet-4-20250514'),
		setModelIdForSession: sinon.stub(),
		getPermissionModeForSession: sinon.stub().returns('acceptEdits'),
		setPermissionModeForSession: sinon.stub(),
		getCapturingTokenForSession: sinon.stub().returns(undefined),
		setCapturingTokenForSession: sinon.stub(),
		getFolderInfoForSession: sinon.stub().returns(undefined),
		setFolderInfoForSession: sinon.stub(),
	} as unknown as sinon.SinonStubbedInstance<IClaudeSessionStateService>;
}

function createPreToolUseInput(toolName: string, sessionId: string, toolInput?: unknown): PreToolUseHookInput {
	return {
		tool_name: toolName,
		session_id: sessionId,
		tool_input: toolInput ?? {},
		cwd: '/some/path',
		hook_event_name: 'PreToolUse',
		tool_use_id: `tool-use-${Date.now()}`,
		transcript_path: '/some/transcript.jsonl',
	};
}

function createPostToolUseInput(toolName: string, sessionId: string, response?: unknown): PostToolUseHookInput {
	return {
		tool_name: toolName,
		session_id: sessionId,
		tool_input: {},
		cwd: '/some/path',
		hook_event_name: 'PostToolUse',
		tool_response: response ?? { text: 'ok' },
		tool_use_id: `tool-use-${Date.now()}`,
		transcript_path: '/some/transcript.jsonl',
	};
}

function createPostToolUseFailureInput(toolName: string, sessionId: string, error: string, isInterrupt = false): PostToolUseFailureHookInput {
	return {
		tool_name: toolName,
		session_id: sessionId,
		tool_input: {},
		cwd: '/some/path',
		hook_event_name: 'PostToolUseFailure',
		error,
		is_interrupt: isInterrupt,
		tool_use_id: `tool-use-${Date.now()}`,
		transcript_path: '/some/transcript.jsonl',
	};
}

describe('Claude Tool Hooks OTel', () => {
	let logService: sinon.SinonStubbedInstance<ILogService>;
	let sessionStateService: sinon.SinonStubbedInstance<IClaudeSessionStateService>;
	let hookOpts: { signal: AbortSignal };

	beforeEach(() => {
		logService = createMockLogService();
		sessionStateService = createMockSessionStateService();
		hookOpts = { signal: new AbortController().signal };
	});

	afterEach(() => {
		sinon.restore();
	});

	describe('PreToolUseLoggingHook', () => {
		it('emits an execute_tool span with correct attributes', async () => {
			const { otelService, spans } = createOTelService();
			const hook = new PreToolUseLoggingHook(logService, otelService);

			const input = createPreToolUseInput('Read', 'session-1', { file_path: '/foo/bar.ts' });
			const result = await hook.hooks[0](input, 'tool-123', hookOpts);

			expect(result).toEqual({ continue: true });

			// Span is started but not ended yet — complete it via PostToolUse
			const postHook = new PostToolUseLoggingHook(logService, new NullRequestLogger(), sessionStateService);
			const postInput = createPostToolUseInput('Read', 'session-1', { text: 'file contents' });
			await postHook.hooks[0](postInput, 'tool-123', hookOpts);

			const toolSpan = spans.find(s => s.name === 'execute_tool Read');
			expect(toolSpan).toBeDefined();
			expect(toolSpan!.attributes['gen_ai.operation.name']).toBe('execute_tool');
			expect(toolSpan!.attributes['gen_ai.tool.name']).toBe('Read');
			expect(toolSpan!.attributes['gen_ai.tool.call.id']).toBe('tool-123');
			expect(toolSpan!.attributes['copilot_chat.chat_session_id']).toBe('session-1');
		});

		it('records tool_input as TOOL_CALL_ARGUMENTS', async () => {
			const { otelService, spans } = createOTelService();
			const hook = new PreToolUseLoggingHook(logService, otelService);

			const input = createPreToolUseInput('Write', 'session-1', { file_path: '/test.ts', content: 'hello' });
			await hook.hooks[0](input, 'tool-args-1', hookOpts);

			// End the span
			const postHook = new PostToolUseLoggingHook(logService, new NullRequestLogger(), sessionStateService);
			await postHook.hooks[0](createPostToolUseInput('Write', 'session-1'), 'tool-args-1', hookOpts);

			const toolSpan = spans.find(s => s.name === 'execute_tool Write');
			expect(toolSpan).toBeDefined();
			expect(toolSpan!.attributes['gen_ai.tool.call.arguments']).toContain('file_path');
			expect(toolSpan!.attributes['gen_ai.tool.call.arguments']).toContain('/test.ts');
		});

		it('uses tool_use_id from input when toolID parameter is undefined', async () => {
			const { otelService, spans } = createOTelService();
			const hook = new PreToolUseLoggingHook(logService, otelService);

			const input = createPreToolUseInput('Bash', 'session-1');
			(input as any).tool_use_id = 'from-input-id';
			await hook.hooks[0](input, undefined, hookOpts);

			// End via PostToolUse using the same fallback key
			const postHook = new PostToolUseLoggingHook(logService, new NullRequestLogger(), sessionStateService);
			const postInput = createPostToolUseInput('Bash', 'session-1');
			await postHook.hooks[0](postInput, 'from-input-id', hookOpts);

			const toolSpan = spans.find(s => s.name === 'execute_tool Bash');
			expect(toolSpan).toBeDefined();
			expect(toolSpan!.attributes['gen_ai.tool.call.id']).toBe('from-input-id');
		});
	});

	describe('PostToolUseLoggingHook', () => {
		it('ends span with OK status and tool result', async () => {
			const { otelService, spans } = createOTelService();
			const preHook = new PreToolUseLoggingHook(logService, otelService);
			const postHook = new PostToolUseLoggingHook(logService, new NullRequestLogger(), sessionStateService);

			await preHook.hooks[0](createPreToolUseInput('Glob', 'session-1'), 'tc-ok', hookOpts);
			const postInput = createPostToolUseInput('Glob', 'session-1', { text: 'file1.ts\nfile2.ts' });
			const result = await postHook.hooks[0](postInput, 'tc-ok', hookOpts);

			expect(result).toEqual({ continue: true });

			const toolSpan = spans.find(s => s.name === 'execute_tool Glob');
			expect(toolSpan).toBeDefined();
			expect(toolSpan!.status.code).toBe(1); // SpanStatusCode.OK
			expect(toolSpan!.attributes['gen_ai.tool.call.result']).toContain('file1.ts');
		});

		it('handles string response', async () => {
			const { otelService, spans } = createOTelService();
			const preHook = new PreToolUseLoggingHook(logService, otelService);
			const postHook = new PostToolUseLoggingHook(logService, new NullRequestLogger(), sessionStateService);

			await preHook.hooks[0](createPreToolUseInput('Bash', 'session-1'), 'tc-str', hookOpts);
			const postInput = createPostToolUseInput('Bash', 'session-1', 'command output');
			await postHook.hooks[0](postInput, 'tc-str', hookOpts);

			const toolSpan = spans.find(s => s.name === 'execute_tool Bash');
			expect(toolSpan!.attributes['gen_ai.tool.call.result']).toBe('command output');
		});

		it('does not fail if no matching PreToolUse span exists', async () => {
			const { spans } = createOTelService();
			const postHook = new PostToolUseLoggingHook(logService, new NullRequestLogger(), sessionStateService);

			const postInput = createPostToolUseInput('Read', 'session-1');
			const result = await postHook.hooks[0](postInput, 'no-matching-pre', hookOpts);

			expect(result).toEqual({ continue: true });
			// No span should be emitted since PreToolUse never started one
			expect(spans.length).toBe(0);
		});
	});

	describe('PostToolUseFailureLoggingHook', () => {
		it('ends span with ERROR status and error message', async () => {
			const { otelService, spans } = createOTelService();
			const preHook = new PreToolUseLoggingHook(logService, otelService);
			const failHook = new PostToolUseFailureLoggingHook(logService, new NullRequestLogger(), sessionStateService);

			await preHook.hooks[0](createPreToolUseInput('Write', 'session-1'), 'tc-fail', hookOpts);
			const failInput = createPostToolUseFailureInput('Write', 'session-1', 'Permission denied');
			const result = await failHook.hooks[0](failInput, 'tc-fail', hookOpts);

			expect(result).toEqual({ continue: true });

			const toolSpan = spans.find(s => s.name === 'execute_tool Write');
			expect(toolSpan).toBeDefined();
			expect(toolSpan!.status.code).toBe(2); // SpanStatusCode.ERROR
			expect(toolSpan!.status.message).toContain('Permission denied');
			expect(toolSpan!.attributes['gen_ai.tool.call.result']).toContain('ERROR');
			expect(toolSpan!.attributes['gen_ai.tool.call.result']).toContain('Permission denied');
		});

		it('includes interrupt marker in error message when is_interrupt is true', async () => {
			const { otelService, spans } = createOTelService();
			const preHook = new PreToolUseLoggingHook(logService, otelService);
			const failHook = new PostToolUseFailureLoggingHook(logService, new NullRequestLogger(), sessionStateService);

			await preHook.hooks[0](createPreToolUseInput('Bash', 'session-1'), 'tc-int', hookOpts);
			const failInput = createPostToolUseFailureInput('Bash', 'session-1', 'User interrupted', true);
			await failHook.hooks[0](failInput, 'tc-int', hookOpts);

			const toolSpan = spans.find(s => s.name === 'execute_tool Bash');
			expect(toolSpan!.status.message).toContain('(interrupted)');
		});

		it('does not fail if no matching PreToolUse span exists', async () => {
			const { spans } = createOTelService();
			const failHook = new PostToolUseFailureLoggingHook(logService, new NullRequestLogger(), sessionStateService);

			const failInput = createPostToolUseFailureInput('Read', 'session-1', 'some error');
			const result = await failHook.hooks[0](failInput, 'no-matching-pre', hookOpts);

			expect(result).toEqual({ continue: true });
			expect(spans.length).toBe(0);
		});
	});

	describe('PreToolUse + PostToolUse full lifecycle', () => {
		it('correctly correlates multiple concurrent tool calls', async () => {
			const { otelService, spans } = createOTelService();
			const preHook = new PreToolUseLoggingHook(logService, otelService);
			const postHook = new PostToolUseLoggingHook(logService, new NullRequestLogger(), sessionStateService);

			// Start two tool calls concurrently
			await preHook.hooks[0](createPreToolUseInput('Read', 'session-1'), 'tc-a', hookOpts);
			await preHook.hooks[0](createPreToolUseInput('Glob', 'session-1'), 'tc-b', hookOpts);

			// Complete them in reverse order
			await postHook.hooks[0](createPostToolUseInput('Glob', 'session-1', 'glob result'), 'tc-b', hookOpts);
			await postHook.hooks[0](createPostToolUseInput('Read', 'session-1', 'read result'), 'tc-a', hookOpts);

			expect(spans.length).toBe(2);

			const readSpan = spans.find(s => s.name === 'execute_tool Read');
			const globSpan = spans.find(s => s.name === 'execute_tool Glob');
			expect(readSpan).toBeDefined();
			expect(globSpan).toBeDefined();
			expect(readSpan!.attributes['gen_ai.tool.call.result']).toContain('read result');
			expect(globSpan!.attributes['gen_ai.tool.call.result']).toContain('glob result');
		});

		it('handles mixed success and failure for concurrent calls', async () => {
			const { otelService, spans } = createOTelService();
			const preHook = new PreToolUseLoggingHook(logService, otelService);
			const postHook = new PostToolUseLoggingHook(logService, new NullRequestLogger(), sessionStateService);
			const failHook = new PostToolUseFailureLoggingHook(logService, new NullRequestLogger(), sessionStateService);

			// Start two tool calls
			await preHook.hooks[0](createPreToolUseInput('Read', 'session-1'), 'tc-s', hookOpts);
			await preHook.hooks[0](createPreToolUseInput('Write', 'session-1'), 'tc-f', hookOpts);

			// One succeeds, one fails
			await postHook.hooks[0](createPostToolUseInput('Read', 'session-1', 'success'), 'tc-s', hookOpts);
			await failHook.hooks[0](createPostToolUseFailureInput('Write', 'session-1', 'disk full'), 'tc-f', hookOpts);

			expect(spans.length).toBe(2);
			const readSpan = spans.find(s => s.name === 'execute_tool Read');
			const writeSpan = spans.find(s => s.name === 'execute_tool Write');
			expect(readSpan!.status.code).toBe(1); // OK
			expect(writeSpan!.status.code).toBe(2); // ERROR
		});
	});
});
