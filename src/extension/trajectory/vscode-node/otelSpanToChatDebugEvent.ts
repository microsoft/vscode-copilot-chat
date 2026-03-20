/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName } from '../../../platform/otel/common/index';
import type { ICompletedSpanData, ISpanEventData, SpanStatusCode } from '../../../platform/otel/common/otelService';

// ── Event ID conventions ──
// {spanId} → direct span mapping (tool calls, model turns, subagent invocations)
// user-msg-{spanId} → user message extracted from a chat span
// agent-msg-{spanId} → agent response extracted from a chat span

function userMsgId(spanId: string): string { return `user-msg-${spanId}`; }
function agentMsgId(spanId: string): string { return `agent-msg-${spanId}`; }

/**
 * Extract the session ID from a span's attributes.
 */
export function extractSessionId(span: ICompletedSpanData): string | undefined {
	return asString(span.attributes[CopilotChatAttr.SESSION_ID])
		?? asString(span.attributes[GenAiAttr.CONVERSATION_ID]);
}

/**
 * Convert a completed span into a debug panel event (tool call, model turn, or subagent invocation).
 * Returns undefined for spans that don't map to a specific event type (e.g., invoke_agent are containers).
 */
export function completedSpanToDebugEvent(span: ICompletedSpanData): vscode.ChatDebugEvent | undefined {
	const opName = asString(span.attributes[GenAiAttr.OPERATION_NAME]);

	switch (opName) {
		case GenAiOperationName.EXECUTE_TOOL:
			return spanToToolCallEvent(span);
		case GenAiOperationName.CHAT:
			return spanToModelTurnEvent(span);
		case GenAiOperationName.INVOKE_AGENT:
			// Subagent spans (those with a parent and an identifiable agent name) become subagent invocation events.
			// Skip SDK wrapper invoke_agent spans that have no agent name — they're transparent containers
			// whose children should appear under their grandparent.
			if (span.parentSpanId) {
				const hasAgentName = !!asString(span.attributes[GenAiAttr.AGENT_NAME])
					|| span.name.replace(/^invoke_agent\s*/, '').trim().length > 0;
				if (hasAgentName) {
					return spanToSubagentEvent(span);
				}
			}
			return undefined; // Top-level agent spans or unnamed wrappers are containers, not events
		case GenAiOperationName.EXECUTE_HOOK:
			return spanToHookExecutionEvent(span);
		case GenAiOperationName.CONTENT_EVENT:
		case 'core_event':
			return spanToGenericEvent(span);
		default:
			return undefined;
	}
}

/**
 * Extract agent response events from a set of chat spans.
 * User messages are handled separately via span events (onDidEmitSpanEvent).
 */
export function extractConversationEvents(spans: readonly ICompletedSpanData[]): vscode.ChatDebugEvent[] {
	const events: vscode.ChatDebugEvent[] = [];
	for (const span of spans) {
		const opName = asString(span.attributes[GenAiAttr.OPERATION_NAME]);
		if (opName !== GenAiOperationName.CHAT) {
			continue;
		}

		// Extract agent response from output messages — only when there's actual text content
		const outputMessages = asString(span.attributes[GenAiAttr.OUTPUT_MESSAGES]);
		if (outputMessages) {
			const hasTextContent = hasAgentTextResponse(outputMessages);
			const agentName = asString(span.attributes[GenAiAttr.AGENT_NAME])
				?? asString(span.attributes[GenAiAttr.RESPONSE_MODEL]);
			const summary = extractAgentResponseSummary(outputMessages, agentName);
			if (hasTextContent && summary) {
				const evt = new vscode.ChatDebugAgentResponseEvent(
					truncate(summary, 200),
					new Date(span.endTime),
				);
				evt.id = agentMsgId(span.spanId);
				evt.parentEventId = span.parentSpanId;
				events.push(evt);
			}
		}
	}
	return events;
}

/**
 * Convert a user_message span event (from onDidEmitSpanEvent) into a ChatDebugUserMessageEvent
 * for real-time streaming to the debug panel before the span completes.
 */
export function spanEventToUserMessage(event: ISpanEventData): vscode.ChatDebugUserMessageEvent | undefined {
	if (event.eventName !== 'user_message') {
		return undefined;
	}
	const content = asString(event.attributes.content as string) ?? '';
	const evt = new vscode.ChatDebugUserMessageEvent(
		truncate(content, 200),
		new Date(event.timestamp),
	);
	evt.id = userMsgId(event.spanId);
	evt.parentEventId = event.parentSpanId;
	return evt;
}

// ── Detail Resolution Functions ──

/**
 * Resolve the full content of a tool call or model turn span for the detail view.
 */
export function resolveSpanToContent(span: ICompletedSpanData): vscode.ChatDebugResolvedEventContent | undefined {
	const opName = asString(span.attributes[GenAiAttr.OPERATION_NAME]);
	if (opName === GenAiOperationName.EXECUTE_TOOL) {
		return resolveToolCallContent(span);
	}
	if (opName === GenAiOperationName.CHAT) {
		return resolveModelTurnContent(span);
	}
	if (opName === GenAiOperationName.EXECUTE_HOOK) {
		return resolveHookExecutionContent(span);
	}
	return undefined;
}

/**
 * Resolve a user message from a chat span's attributes into structured sections.
 */
export function resolveUserMessageFromSpan(span: ICompletedSpanData): vscode.ChatDebugUserMessageEvent {
	const sections: vscode.ChatDebugMessageSection[] = [];

	// Build sections from dedicated attributes
	const systemInstr = asString(span.attributes[GenAiAttr.SYSTEM_INSTRUCTIONS]);
	if (systemInstr) {
		sections.push(new vscode.ChatDebugMessageSection('System', systemInstr));
	}
	const promptContext = asString(span.attributes[CopilotChatAttr.PROMPT_CONTEXT]);
	if (promptContext) {
		sections.push(new vscode.ChatDebugMessageSection('Context', promptContext));
	}
	const promptInstructions = asString(span.attributes[CopilotChatAttr.PROMPT_INSTRUCTIONS]);
	if (promptInstructions) {
		sections.push(new vscode.ChatDebugMessageSection('Instructions', promptInstructions));
	}
	const userRequest = asString(span.attributes[CopilotChatAttr.USER_REQUEST]);
	if (userRequest) {
		sections.push(new vscode.ChatDebugMessageSection('User Request', userRequest));
	}

	// Fallback: if no dedicated attributes, parse from gen_ai.input.messages
	if (sections.length === 0) {
		const inputMessages = asString(span.attributes[GenAiAttr.INPUT_MESSAGES]);
		if (inputMessages) {
			try {
				const parsed = JSON.parse(inputMessages) as Array<{ role?: string; parts?: Array<{ type?: string; content?: unknown }> }>;
				for (const msg of parsed) {
					if (!msg.parts) { continue; }
					const textContent = msg.parts
						.filter(p => p.type === 'text' && typeof p.content === 'string')
						.map(p => p.content as string)
						.join('\n');
					if (textContent) {
						sections.push(new vscode.ChatDebugMessageSection(
							capitalize(msg.role ?? 'unknown'),
							textContent,
						));
					}
				}
			} catch { /* invalid JSON, skip */ }
		}
	}

	// If we still have no sections, use the raw user request or input messages as a single section
	if (sections.length === 0) {
		const inputMessages = asString(span.attributes[GenAiAttr.INPUT_MESSAGES]);
		if (inputMessages) {
			sections.push(new vscode.ChatDebugMessageSection('Input Messages', inputMessages));
		}
	}

	const summary = userRequest ?? 'User Message';
	const evt = new vscode.ChatDebugUserMessageEvent(truncate(summary, 200), new Date(span.startTime));
	evt.id = userMsgId(span.spanId);
	evt.sections = sections;
	return evt;
}

/**
 * Resolve an agent response from a chat span's attributes into structured sections.
 */
export function resolveAgentResponseFromSpan(span: ICompletedSpanData): vscode.ChatDebugAgentResponseEvent {
	const sections: vscode.ChatDebugMessageSection[] = [];

	// Response text from output messages
	const outputMessages = asString(span.attributes[GenAiAttr.OUTPUT_MESSAGES]);
	if (outputMessages) {
		try {
			const parsed = JSON.parse(outputMessages) as Array<{ role?: string; parts?: Array<{ type?: string; content?: string; name?: string; arguments?: unknown }> }>;
			for (const msg of parsed) {
				if (!msg.parts) { continue; }
				const textContent = msg.parts
					.filter(p => p.type === 'text' && typeof p.content === 'string' && p.content.trim())
					.map(p => p.content!)
					.join('\n');
				if (textContent) {
					sections.push(new vscode.ChatDebugMessageSection('Response', textContent));
				}
				const toolCalls = msg.parts.filter(p => p.type === 'tool_call');
				if (toolCalls.length > 0) {
					const toolSection = toolCalls.map(tc =>
						`${tc.name ?? 'unknown'}(${typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {})})`
					).join('\n');
					sections.push(new vscode.ChatDebugMessageSection('Tool Calls', toolSection));
				}
			}
		} catch { /* invalid JSON, skip */ }
	}

	// Reasoning content
	const reasoning = asString(span.attributes[CopilotChatAttr.REASONING_CONTENT]);
	if (reasoning) {
		sections.push(new vscode.ChatDebugMessageSection('Reasoning', reasoning));
	}

	const agentName = asString(span.attributes[GenAiAttr.AGENT_NAME])
		?? asString(span.attributes[GenAiAttr.RESPONSE_MODEL]);
	const summary = extractAgentResponseSummary(outputMessages ?? '', agentName);
	const evt = new vscode.ChatDebugAgentResponseEvent(truncate(summary, 200), new Date(span.endTime));
	evt.id = agentMsgId(span.spanId);
	evt.sections = sections;
	return evt;
}

// ── Grouping Functions ──

/**
 * Group execute_tool spans by their parent span ID to reconstruct "tool call rounds".
 * Returns a map from parentSpanId → tool call spans in that round (ordered by startTime).
 */
export function groupToolCallsByParent(spans: readonly ICompletedSpanData[]): Map<string, ICompletedSpanData[]> {
	const groups = new Map<string, ICompletedSpanData[]>();
	for (const span of spans) {
		if (asString(span.attributes[GenAiAttr.OPERATION_NAME]) !== GenAiOperationName.EXECUTE_TOOL) {
			continue;
		}
		const parent = span.parentSpanId;
		if (!parent) { continue; }
		let group = groups.get(parent);
		if (!group) {
			group = [];
			groups.set(parent, group);
		}
		group.push(span);
	}
	// Sort each group by start time
	for (const group of groups.values()) {
		group.sort((a, b) => a.startTime - b.startTime);
	}
	return groups;
}

/**
 * Detect parallel subagent invocations: execute_tool "runSubagent" spans
 * that share the same parentSpanId and have overlapping time ranges.
 */
export function detectParallelSubagents(spans: readonly ICompletedSpanData[]): ParallelSubagentGroup[] {
	// Find all runSubagent tool spans
	const subagentToolSpans = spans.filter(s => {
		const opName = asString(s.attributes[GenAiAttr.OPERATION_NAME]);
		const toolName = asString(s.attributes[GenAiAttr.TOOL_NAME]);
		return opName === GenAiOperationName.EXECUTE_TOOL && toolName === 'runSubagent';
	});

	// Group by parent
	const byParent = new Map<string, ICompletedSpanData[]>();
	for (const span of subagentToolSpans) {
		const parent = span.parentSpanId;
		if (!parent) { continue; }
		let group = byParent.get(parent);
		if (!group) {
			group = [];
			byParent.set(parent, group);
		}
		group.push(span);
	}

	const result: ParallelSubagentGroup[] = [];
	for (const [parentId, group] of byParent) {
		if (group.length < 2) { continue; }
		// Check for time overlap — if any two spans overlap, they're parallel
		group.sort((a, b) => a.startTime - b.startTime);
		const hasOverlap = group.some((span, i) => {
			if (i === 0) { return false; }
			return span.startTime < group[i - 1].endTime;
		});
		if (hasOverlap) {
			result.push({
				parallelGroupId: parentId,
				spans: group,
			});
		}
	}
	return result;
}

export interface ParallelSubagentGroup {
	readonly parallelGroupId: string;
	readonly spans: readonly ICompletedSpanData[];
}

// ── Private helpers ──

function spanToToolCallEvent(span: ICompletedSpanData): vscode.ChatDebugToolCallEvent {
	let toolName = asString(span.attributes[GenAiAttr.TOOL_NAME]) ?? 'unknown';
	if (toolName === 'runSubagent') {
		const agentName = extractJsonField(asString(span.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS]), 'agentName');
		if (agentName) {
			toolName = `runSubagent (${agentName})`;
		}
	}
	const evt = new vscode.ChatDebugToolCallEvent(toolName, new Date(span.startTime));
	evt.id = span.spanId;
	evt.parentEventId = span.parentSpanId;
	evt.toolCallId = asString(span.attributes[GenAiAttr.TOOL_CALL_ID]);
	evt.input = asString(span.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS]);
	evt.output = asString(span.attributes[GenAiAttr.TOOL_CALL_RESULT]);
	evt.result = span.status.code === 1 /* OK */
		? vscode.ChatDebugToolCallResult.Success
		: span.status.code === 2 /* ERROR */
			? vscode.ChatDebugToolCallResult.Error
			: undefined;
	evt.durationInMillis = span.endTime - span.startTime;
	return evt;
}

function spanToModelTurnEvent(span: ICompletedSpanData): vscode.ChatDebugModelTurnEvent {
	const evt = new vscode.ChatDebugModelTurnEvent(new Date(span.startTime));
	evt.id = span.spanId;
	evt.parentEventId = span.parentSpanId;
	evt.model = asString(span.attributes[GenAiAttr.REQUEST_MODEL]);
	evt.inputTokens = asNumber(span.attributes[GenAiAttr.USAGE_INPUT_TOKENS]);
	evt.outputTokens = asNumber(span.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS]);
	evt.cachedTokens = asNumber(span.attributes[GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS]);
	evt.totalTokens = (evt.inputTokens ?? 0) + (evt.outputTokens ?? 0);
	evt.durationInMillis = span.endTime - span.startTime;
	evt.timeToFirstTokenInMillis = asNumber(span.attributes[CopilotChatAttr.TIME_TO_FIRST_TOKEN]);
	evt.maxInputTokens = asNumber(span.attributes[CopilotChatAttr.MAX_PROMPT_TOKENS]);
	evt.maxOutputTokens = asNumber(span.attributes[GenAiAttr.REQUEST_MAX_TOKENS]);
	evt.requestName = asString(span.attributes[CopilotChatAttr.DEBUG_NAME])
		?? asString(span.attributes[GenAiAttr.AGENT_NAME]);
	evt.status = spanStatusToString(span.status.code as SpanStatusCode);
	return evt;
}

function spanToSubagentEvent(span: ICompletedSpanData): vscode.ChatDebugSubagentInvocationEvent {
	// Use agent name from attributes, falling back to parsing from span name (e.g., "invoke_agent task" → "task")
	const agentName = asString(span.attributes[GenAiAttr.AGENT_NAME])
		?? (span.name.replace(/^invoke_agent\s*/, '').trim() || 'agent');
	const evt = new vscode.ChatDebugSubagentInvocationEvent(agentName, new Date(span.startTime));
	evt.id = span.spanId;
	evt.parentEventId = span.parentSpanId;
	evt.durationInMillis = span.endTime - span.startTime;
	evt.status = span.status.code === 1 /* OK */
		? vscode.ChatDebugSubagentStatus.Completed
		: span.status.code === 2 /* ERROR */
			? vscode.ChatDebugSubagentStatus.Failed
			: vscode.ChatDebugSubagentStatus.Running;
	const turnCount = asNumber(span.attributes[CopilotChatAttr.TURN_COUNT]);
	evt.modelTurnCount = turnCount;
	return evt;
}

function resolveHookExecutionContent(span: ICompletedSpanData): vscode.ChatDebugEventHookContent {
	const hookType = asString(span.attributes['copilot_chat.hook_type']) ?? 'unknown';
	const content = new vscode.ChatDebugEventHookContent(hookType);
	content.command = asString(span.attributes['copilot_chat.hook_command']);
	const resultKind = asString(span.attributes['copilot_chat.hook_result_kind']);
	content.result = resultKind === 'success'
		? vscode.ChatDebugHookResult.Success
		: resultKind === 'error'
			? vscode.ChatDebugHookResult.Error
			: resultKind === 'non_blocking_error'
				? vscode.ChatDebugHookResult.NonBlockingError
				: undefined;
	content.durationInMillis = span.endTime - span.startTime;
	content.input = asString(span.attributes['copilot_chat.hook_input']);
	content.output = asString(span.attributes['copilot_chat.hook_output']);
	if (span.status.code === 2 /* ERROR */ && span.status.message) {
		content.errorMessage = span.status.message;
	}
	content.exitCode = asNumber(span.attributes['copilot_chat.hook_exit_code']);
	return content;
}

function spanToHookExecutionEvent(span: ICompletedSpanData): vscode.ChatDebugGenericEvent {
	const hookType = asString(span.attributes['copilot_chat.hook_type']) ?? 'unknown';
	const hookCommand = asString(span.attributes['copilot_chat.hook_command']) ?? '';
	const resultKind = asString(span.attributes['copilot_chat.hook_result_kind']);
	const durationMs = span.endTime - span.startTime;

	const name = `Hook: ${hookType}`;
	const level = resultKind === 'error'
		? vscode.ChatDebugLogLevel.Error
		: resultKind === 'non_blocking_error'
			? vscode.ChatDebugLogLevel.Warning
			: vscode.ChatDebugLogLevel.Info;
	const evt = new vscode.ChatDebugGenericEvent(name, level, new Date(span.startTime));
	evt.id = span.spanId;
	evt.parentEventId = span.parentSpanId;
	evt.details = `${hookCommand} (${durationMs}ms, ${resultKind ?? 'unknown'})`;
	evt.category = 'hook';
	return evt;
}

function spanToGenericEvent(span: ICompletedSpanData): vscode.ChatDebugGenericEvent {
	const name = asString(span.attributes[CopilotChatAttr.DEBUG_NAME]) ?? span.name;
	const evt = new vscode.ChatDebugGenericEvent(name, vscode.ChatDebugLogLevel.Info, new Date(span.startTime));
	evt.id = span.spanId;
	evt.parentEventId = span.parentSpanId;
	evt.details = asString(span.attributes[CopilotChatAttr.MARKDOWN_CONTENT])
		?? asString(span.attributes['copilot_chat.event_details']);
	evt.category = asString(span.attributes['copilot_chat.event_category']);
	return evt;
}

function resolveToolCallContent(span: ICompletedSpanData): vscode.ChatDebugEventToolCallContent {
	const toolName = asString(span.attributes[GenAiAttr.TOOL_NAME]) ?? 'unknown';
	const content = new vscode.ChatDebugEventToolCallContent(toolName);
	content.input = asString(span.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS]);
	content.output = asString(span.attributes[GenAiAttr.TOOL_CALL_RESULT]);
	content.result = span.status.code === 1 /* OK */
		? vscode.ChatDebugToolCallResult.Success
		: span.status.code === 2 /* ERROR */
			? vscode.ChatDebugToolCallResult.Error
			: undefined;
	content.durationInMillis = span.endTime - span.startTime;
	return content;
}

function resolveModelTurnContent(span: ICompletedSpanData): vscode.ChatDebugEventModelTurnContent {
	const requestName = asString(span.attributes[CopilotChatAttr.DEBUG_NAME])
		?? asString(span.attributes[GenAiAttr.AGENT_NAME])
		?? span.name;
	const content = new vscode.ChatDebugEventModelTurnContent(requestName);
	content.model = asString(span.attributes[GenAiAttr.REQUEST_MODEL]);
	content.status = spanStatusToString(span.status.code as SpanStatusCode);
	content.durationInMillis = span.endTime - span.startTime;
	content.timeToFirstTokenInMillis = asNumber(span.attributes[CopilotChatAttr.TIME_TO_FIRST_TOKEN]);
	content.maxInputTokens = asNumber(span.attributes[CopilotChatAttr.MAX_PROMPT_TOKENS]);
	content.maxOutputTokens = asNumber(span.attributes[GenAiAttr.REQUEST_MAX_TOKENS]);
	content.inputTokens = asNumber(span.attributes[GenAiAttr.USAGE_INPUT_TOKENS]);
	content.outputTokens = asNumber(span.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS]);
	content.cachedTokens = asNumber(span.attributes[GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS]);
	content.totalTokens = (content.inputTokens ?? 0) + (content.outputTokens ?? 0);

	// Build sections for the detail view
	const sections: vscode.ChatDebugMessageSection[] = [];
	const systemInstr = asString(span.attributes[GenAiAttr.SYSTEM_INSTRUCTIONS]);
	if (systemInstr) {
		sections.push(new vscode.ChatDebugMessageSection('System', systemInstr));
	}
	const inputMessages = asString(span.attributes[GenAiAttr.INPUT_MESSAGES]);
	if (inputMessages) {
		sections.push(new vscode.ChatDebugMessageSection('Input Messages', inputMessages));
	}
	const outputMessages = asString(span.attributes[GenAiAttr.OUTPUT_MESSAGES]);
	if (outputMessages) {
		sections.push(new vscode.ChatDebugMessageSection('Output Messages', outputMessages));
	}
	if (sections.length > 0) {
		content.sections = sections;
	}
	if (span.status.code === 2 /* ERROR */ && span.status.message) {
		content.errorMessage = span.status.message;
	}
	return content;
}

function extractAgentResponseSummary(outputMessagesJson: string, agentName?: string): string {
	const label = agentName ? `${agentName} response` : 'Agent Response';
	try {
		const parsed = JSON.parse(outputMessagesJson) as Array<{ parts?: Array<{ type?: string; content?: string; name?: string }> }>;
		for (const msg of parsed) {
			if (!msg.parts) { continue; }
			const text = msg.parts.find(p => p.type === 'text' && p.content)?.content;
			if (text) {
				// For very short responses, prefix with agent/model name for context
				if (text.length <= 40 && agentName) {
					return `${label}: ${text}`;
				}
				return text;
			}
			const toolCalls = msg.parts.filter(p => p.type === 'tool_call');
			if (toolCalls.length > 0) {
				return `Tool calls: ${toolCalls.map(tc => tc.name ?? 'unknown').join(', ')}`;
			}
		}
	} catch { /* ignore */ }
	return label;
}

function hasAgentTextResponse(outputMessagesJson: string): boolean {
	try {
		const parsed = JSON.parse(outputMessagesJson) as Array<{ parts?: Array<{ type?: string; content?: string }> }>;
		for (const msg of parsed) {
			if (!msg.parts) { continue; }
			if (msg.parts.some(p => p.type === 'text' && typeof p.content === 'string' && p.content.trim())) {
				return true;
			}
		}
	} catch { /* ignore */ }
	return false;
}

// As per oTel spec, default is success.
function spanStatusToString(code: SpanStatusCode): string {
	switch (code) {
		case 2: return 'error';
		default: return 'success';
	}
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === 'number' ? v : undefined;
}

function extractJsonField(json: string | undefined, field: string): string | undefined {
	if (!json) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(json);
		const value = parsed[field];
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
