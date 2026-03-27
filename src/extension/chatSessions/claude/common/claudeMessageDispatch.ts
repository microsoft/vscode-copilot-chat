/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKAssistantMessage, SDKCompactBoundaryMessage, SDKHookResponseMessage, SDKHookStartedMessage, SDKMessage, SDKResultMessage, SDKUserMessage, SDKUserMessageReplay } from '@anthropic-ai/claude-agent-sdk';
import type { TodoWriteInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import type Anthropic from '@anthropic-ai/sdk';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName, IOTelService, type ISpanHandle, SpanKind, SpanStatusCode, truncateForOTel } from '../../../../platform/otel/common/index';
import { ServicesAccessor } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseThinkingProgressPart } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { ClaudeToolNames } from './claudeTools';
import { completeToolInvocation, createFormattedToolInvocation } from './toolInvocationFormatter';

// #region Types

/** Per-request state passed to each handler */
export interface MessageHandlerRequestContext {
	readonly stream: vscode.ChatResponseStream;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken;
	readonly token: vscode.CancellationToken;
}

/** Mutable state shared across handlers within a single _processMessages loop */
export interface MessageHandlerState {
	readonly unprocessedToolCalls: Map<string, Anthropic.Beta.Messages.BetaToolUseBlock>;
	readonly otelToolSpans: Map<string, ISpanHandle>;
	readonly otelHookSpans: Map<string, ISpanHandle>;
}

export interface MessageHandlerResult {
	/** When true, the current request is complete and should be dequeued */
	readonly requestComplete: boolean;
}

// #endregion

// #region Message key

/**
 * Computes a stable lookup key for an SDK message.
 * Non-system messages use `type`; system messages use `type:subtype`.
 */
export function messageKey(message: SDKMessage): string {
	if (message.type === 'system') {
		return `system:${message.subtype}`;
	}
	return message.type;
}

// #endregion

// #region Known message keys

/**
 * Every message key the Claude Agent SDK can produce.
 * When the SDK adds new types, an unknown key will surface as a warning in logs.
 *
 * Keep this in sync with the SDKMessage union in @anthropic-ai/claude-agent-sdk.
 */
export const ALL_KNOWN_MESSAGE_KEYS = new Set([
	'assistant',
	'user',
	'result',
	'stream_event',
	// TODO: Show `tool_progress` — has `tool_name` and `elapsed_time_seconds` for live tool status
	// low pri, where would we show this?
	'tool_progress',
	// TODO: Show `tool_use_summary` — has `summary` text describing tool execution results
	// low pri, where would we show this?
	'tool_use_summary',
	// TODO: Show `auth_status` — has `output` lines and `error` for auth failures
	'auth_status',
	// TODO: Show `rate_limit_event` — has `rate_limit_info.status` (allowed_warning | rejected) and reset time
	'rate_limit_event',
	// TODO: Show `prompt_suggestion` — has `suggestion` text for follow-up prompts
	// low pri, follow ups are dead
	'prompt_suggestion',
	'system:init',
	'system:compact_boundary',
	'system:status',
	// TODO: Show `system:api_retry` — has `error`, `attempt`, `max_retries` for retry visibility
	'system:api_retry',
	// TODO: Show `system:local_command_output` — has `content` text from local slash commands
	'system:local_command_output',
	'system:hook_started',
	// TODO: Show `system:hook_progress` — has `stdout`, `stderr`, `output` for streaming hook output
	'system:hook_progress',
	// TODO: Show `system:hook_response` — has `output`, `stderr`, `outcome` — surface errors to user
	'system:hook_response',
	// TODO: Show `system:task_notification` — has `summary` and `status` for subagent completion
	'system:task_notification',
	// TODO: Show `system:task_started` — has `description` and `prompt` for subagent launch
	'system:task_started',
	// TODO: Show `system:task_progress` — has `description` and `summary` for subagent progress
	'system:task_progress',
	'system:files_persisted',
	'system:elicitation_complete',
]);

// #endregion

// #region Individual handlers

export const DENY_TOOL_MESSAGE = 'The user declined to run the tool';

export class KnownClaudeError extends Error { }

interface IManageTodoListToolInputParams {
	readonly operation?: 'write' | 'read';
	readonly todoList: readonly {
		readonly id: number;
		readonly title: string;
		readonly description: string;
		readonly status: 'not-started' | 'in-progress' | 'completed';
	}[];
}

/**
 * Model ID used by the SDK for synthetic messages (e.g., "No response requested." from abort).
 * These should be filtered out from display and processing.
 */
export const SYNTHETIC_MODEL_ID = '<synthetic>';

export function handleAssistantMessage(
	message: SDKAssistantMessage,
	accessor: ServicesAccessor,
	sessionId: string,
	request: MessageHandlerRequestContext,
	state: MessageHandlerState,
): void {
	if (message.message.model === SYNTHETIC_MODEL_ID) {
		accessor.get(ILogService).trace('[ClaudeMessageDispatch] Skipping synthetic message');
		return;
	}

	const logService = accessor.get(ILogService);
	const otelService = accessor.get(IOTelService);
	const { stream } = request;
	const { otelToolSpans, unprocessedToolCalls } = state;

	for (const item of message.message.content) {
		if (item.type === 'text') {
			stream.markdown(item.text);
		} else if (item.type === 'thinking') {
			stream.push(new ChatResponseThinkingProgressPart(item.thinking));
		} else if (item.type === 'tool_use') {
			unprocessedToolCalls.set(item.id, item);

			const toolSpan = otelService.startSpan(`execute_tool ${item.name}`, {
				kind: SpanKind.INTERNAL,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
					[GenAiAttr.TOOL_NAME]: item.name,
					[GenAiAttr.TOOL_CALL_ID]: item.id,
					[CopilotChatAttr.CHAT_SESSION_ID]: sessionId,
				},
			});
			if (item.input !== undefined) {
				try {
					toolSpan.setAttribute(GenAiAttr.TOOL_CALL_ARGUMENTS, truncateForOTel(
						typeof item.input === 'string' ? item.input : JSON.stringify(item.input)
					));
				} catch (e) {
					logService.warn(`[ClaudeMessageDispatch] Failed to serialize tool arguments for ${item.name}: ${e}`);
				}
			}
			otelToolSpans.set(item.id, toolSpan);

			const invocation = createFormattedToolInvocation(item, false);
			if (invocation) {
				if (message.parent_tool_use_id) {
					invocation.subAgentInvocationId = message.parent_tool_use_id;
				}
				invocation.enablePartialUpdate = true;
				stream.push(invocation);
			}
		}
	}
}

export function handleUserMessage(
	message: SDKUserMessage | SDKUserMessageReplay,
	accessor: ServicesAccessor,
	request: MessageHandlerRequestContext,
	state: MessageHandlerState,
): void {
	if (!Array.isArray(message.message.content)) {
		return;
	}
	for (const toolResult of message.message.content) {
		if (toolResult.type === 'tool_result') {
			processToolResult(toolResult, accessor, request, state);
		}
	}
}

function processToolResult(
	toolResult: Anthropic.Messages.ToolResultBlockParam,
	accessor: ServicesAccessor,
	request: MessageHandlerRequestContext,
	state: MessageHandlerState,
): void {
	const logService = accessor.get(ILogService);
	const { stream } = request;
	const { unprocessedToolCalls, otelToolSpans } = state;

	const toolUseId = toolResult.tool_use_id;
	const toolUse = unprocessedToolCalls.get(toolUseId);
	if (!toolUse) {
		return;
	}

	unprocessedToolCalls.delete(toolUseId);

	const toolSpan = otelToolSpans.get(toolUseId);
	if (toolSpan) {
		if (toolResult.is_error) {
			const errContent = typeof toolResult.content === 'string' ? toolResult.content : 'tool error';
			toolSpan.setStatus(SpanStatusCode.ERROR, errContent);
			toolSpan.setAttribute(GenAiAttr.TOOL_CALL_RESULT, truncateForOTel(`ERROR: ${errContent}`));
		} else {
			toolSpan.setStatus(SpanStatusCode.OK);
			if (toolResult.content !== undefined) {
				try {
					const result = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content);
					toolSpan.setAttribute(GenAiAttr.TOOL_CALL_RESULT, truncateForOTel(result));
				} catch (e) {
					logService.warn(`[ClaudeMessageDispatch] Failed to serialize tool result: ${e}`);
				}
			}
		}
		toolSpan.end();
		otelToolSpans.delete(toolUseId);
	}

	const invocation = createFormattedToolInvocation(toolUse, true);
	if (invocation) {
		invocation.enablePartialUpdate = true;
		invocation.isComplete = true;
		invocation.isError = toolResult.is_error;
		if (toolResult.content === DENY_TOOL_MESSAGE) {
			invocation.isConfirmed = false;
		}
		completeToolInvocation(toolUse, toolResult, invocation);
	}

	if (toolUse.name === ClaudeToolNames.TodoWrite) {
		processTodoWriteTool(toolUse, accessor, request);
	}

	if (invocation) {
		stream.push(invocation);
	}
}

function processTodoWriteTool(
	toolUse: Anthropic.Beta.Messages.BetaToolUseBlock,
	accessor: ServicesAccessor,
	request: MessageHandlerRequestContext,
): void {
	const toolsService = accessor.get(IToolsService);
	const input = toolUse.input as TodoWriteInput;
	toolsService.invokeTool(ToolName.CoreManageTodoList, {
		input: {
			operation: 'write',
			todoList: input.todos.map((todo, i) => ({
				id: i,
				title: todo.content,
				description: '',
				status: todo.status === 'pending' ?
					'not-started' :
					(todo.status === 'in_progress' ?
						'in-progress' :
						'completed'),
			} satisfies IManageTodoListToolInputParams['todoList'][number])),
		} satisfies IManageTodoListToolInputParams,
		toolInvocationToken: request.toolInvocationToken,
	}, request.token);
}

export function handleCompactBoundary(
	_message: SDKCompactBoundaryMessage,
	request: MessageHandlerRequestContext,
): void {
	request.stream.markdown(`*${l10n.t('Conversation compacted')}*`);
}

export function handleHookStarted(
	message: SDKHookStartedMessage,
	accessor: ServicesAccessor,
	sessionId: string,
	state: MessageHandlerState,
): void {
	const otelService = accessor.get(IOTelService);
	const span = otelService.startSpan(`user_hook ${message.hook_event}:${message.hook_name}`, {
		kind: SpanKind.INTERNAL,
		attributes: {
			[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_HOOK,
			'copilot_chat.hook_type': message.hook_event,
			'copilot_chat.hook_command': message.hook_name,
			'copilot_chat.hook_id': message.hook_id,
			[CopilotChatAttr.CHAT_SESSION_ID]: sessionId,
		},
	});
	state.otelHookSpans.set(message.hook_id, span);
}

export function handleHookResponse(
	message: SDKHookResponseMessage,
	accessor: ServicesAccessor,
	request: MessageHandlerRequestContext,
	state: MessageHandlerState,
): void {
	const logService = accessor.get(ILogService);
	const span = state.otelHookSpans.get(message.hook_id);
	if (span) {
		if (message.outcome === 'error') {
			span.setStatus(SpanStatusCode.ERROR, message.stderr || message.output);
		} else if (message.outcome === 'cancelled') {
			span.setStatus(SpanStatusCode.ERROR, 'cancelled');
		} else {
			span.setStatus(SpanStatusCode.OK);
		}
		if (message.exit_code !== undefined) {
			span.setAttribute('copilot_chat.hook_exit_code', message.exit_code);
		}
		if (message.output) {
			span.setAttribute('copilot_chat.hook_output', truncateForOTel(message.output));
		}
		span.end();
		state.otelHookSpans.delete(message.hook_id);
	}

	if (message.outcome === 'error') {
		logService.warn(`[ClaudeMessageDispatch] Hook "${message.hook_name}" (${message.hook_event}) failed: ${message.stderr || message.output}`);
		request.stream.markdown(`*${l10n.t('Hook "{0}" failed', message.hook_name)}*\n`);
		if (message.stderr) {
			request.stream.markdown(`\`\`\`\n${message.stderr}\n\`\`\`\n`);
		}
	}
}

export function handleResultMessage(
	message: SDKResultMessage,
	request: MessageHandlerRequestContext,
): MessageHandlerResult {
	if (message.subtype === 'error_max_turns') {
		request.stream.progress(l10n.t('Maximum turns reached ({0})', message.num_turns));
	} else if (message.subtype === 'error_during_execution') {
		throw new KnownClaudeError(l10n.t('Error during execution'));
	}
	return { requestComplete: true };
}

// #endregion

// #region Dispatch

/**
 * Routes an SDK message to the appropriate handler.
 *
 * Designed as an `invokeFunction` target — services are resolved from the DI
 * accessor, extra arguments are passed through.
 *
 * Uses TypeScript discriminated union narrowing — no type assertions needed.
 * Handlers that don't exist for a given key are logged:
 * - Known keys without a handler → trace-logged.
 * - Unknown keys → warn-logged.
 */
export function dispatchMessage(
	accessor: ServicesAccessor,
	message: SDKMessage,
	sessionId: string,
	request: MessageHandlerRequestContext,
	state: MessageHandlerState,
): MessageHandlerResult | undefined {
	const logService = accessor.get(ILogService);

	switch (message.type) {
		case 'assistant':
			handleAssistantMessage(message, accessor, sessionId, request, state);
			return;
		case 'user':
			handleUserMessage(message, accessor, request, state);
			return;
		case 'result':
			return handleResultMessage(message, request);
		case 'system':
			if (message.subtype === 'compact_boundary') {
				handleCompactBoundary(message, request);
				return;
			}
			if (message.subtype === 'hook_started') {
				handleHookStarted(message, accessor, sessionId, state);
				return;
			}
			if (message.subtype === 'hook_response') {
				handleHookResponse(message, accessor, request, state);
				return;
			}
			break;
	}

	// Not handled — log based on whether the key is expected
	const key = messageKey(message);
	if (ALL_KNOWN_MESSAGE_KEYS.has(key)) {
		logService.trace(`[ClaudeMessageDispatch] Unhandled known message type: ${key}`);
	} else {
		logService.warn(`[ClaudeMessageDispatch] Unknown message type: ${key}`);
	}
	return undefined;
}

// #endregion
