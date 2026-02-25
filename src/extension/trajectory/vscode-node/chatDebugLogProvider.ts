/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { messageToMarkdown } from '../../../platform/log/common/messageStringify';
import { isOpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { IRequestLogger, LoggedInfoKind, LoggedRequestKind, type LoggedRequest } from '../../../platform/requestLogger/node/requestLogger';
import { ITrajectoryLogger, ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryLogger';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IAgentDebugEventService } from '../../agentDebug/common/agentDebugEventService';
import { AgentDebugEventCategory, IAgentDebugEvent, IDiscoveryEvent, IErrorEvent, ILLMRequestEvent, IToolCallEvent } from '../../agentDebug/common/agentDebugTypes';
import { formatEventDetail } from '../../agentDebug/common/agentDebugViewLogic';
import { IExtensionContribution } from '../../common/contributions';

/**
 * Safely serializes a value to JSON, returning a fallback string on failure
 * (e.g., circular references, BigInt values).
 */
function safeJsonStringify(value: unknown, indent?: number): string {
	try {
		return JSON.stringify(value, null, indent);
	} catch {
		return String(value);
	}
}

/**
 * Maps an agent debug event category to a ChatDebugLogLevel.
 */
function eventCategoryToLogLevel(event: IAgentDebugEvent): vscode.ChatDebugLogLevel {
	switch (event.category) {
		case AgentDebugEventCategory.Error:
			return vscode.ChatDebugLogLevel.Error;
		case AgentDebugEventCategory.ToolCall: {
			const tc = event as IToolCallEvent;
			if (tc.status === 'failure') {
				return vscode.ChatDebugLogLevel.Warning;
			}
			return vscode.ChatDebugLogLevel.Info;
		}
		case AgentDebugEventCategory.LLMRequest: {
			const lr = event as ILLMRequestEvent;
			if (lr.status === 'failure') {
				return vscode.ChatDebugLogLevel.Error;
			}
			return vscode.ChatDebugLogLevel.Info;
		}
		case AgentDebugEventCategory.Discovery:
			return vscode.ChatDebugLogLevel.Info;
		case AgentDebugEventCategory.LoopControl:
			return vscode.ChatDebugLogLevel.Info;
	}
}

/**
 * Maps an agent debug event category to the string category label.
 */
function eventCategoryToString(category: AgentDebugEventCategory): string {
	switch (category) {
		case AgentDebugEventCategory.Discovery: return 'discovery';
		case AgentDebugEventCategory.ToolCall: return 'toolCall';
		case AgentDebugEventCategory.LLMRequest: return 'llmRequest';
		case AgentDebugEventCategory.Error: return 'error';
		case AgentDebugEventCategory.LoopControl: return 'loopControl';
	}
}

/**
 * Formats the details of an agent debug event into a human-readable string.
 */
function formatEventDetails(event: IAgentDebugEvent): string | undefined {
	// For trajectory step events (user/system/agent messages), build a rich preview
	if (event.category === AgentDebugEventCategory.LoopControl) {
		const details = event.details;
		const parts: string[] = [];

		if (details['message']) {
			const message = String(details['message']);
			parts.push(message.length > 200 ? message.slice(0, 200) + '…' : message);
		}

		if (Array.isArray(details['toolCalls'])) {
			const calls = details['toolCalls'] as { name?: string }[];
			const names = calls.map(tc => tc.name ?? vscode.l10n.t('unknown')).join(', ');
			parts.push(vscode.l10n.t('Tool calls: {0}', names));
		}

		if (Array.isArray(details['observations'])) {
			const obs = details['observations'] as { content?: string }[];
			const count = obs.filter(o => o.content).length;
			if (count > 0) {
				parts.push(count > 1 ? vscode.l10n.t('{0} tool results', count) : vscode.l10n.t('{0} tool result', count));
			}
		}

		if (details['metrics'] && typeof details['metrics'] === 'object') {
			const metrics = details['metrics'] as Record<string, unknown>;
			const metricParts: string[] = [];
			if (metrics['duration_ms'] !== undefined) {
				metricParts.push(`${metrics['duration_ms']}ms`);
			}
			if (metrics['prompt_tokens'] !== undefined || metrics['completion_tokens'] !== undefined) {
				const total = (Number(metrics['prompt_tokens'] ?? 0)) + (Number(metrics['completion_tokens'] ?? 0));
				metricParts.push(`${total} tokens`);
			}
			if (metricParts.length > 0) {
				parts.push(metricParts.join(', '));
			}
		}

		if (details['reasoning']) {
			parts.push(vscode.l10n.t('(has reasoning)'));
		}

		if (parts.length > 0) {
			return parts.join('\n');
		}

		// Fallback for loop start/stop events
		if (details['agentName']) {
			return vscode.l10n.t('Agent: {0}', details['agentName']);
		}
	}

	let detail: Record<string, string>;
	try {
		detail = formatEventDetail(event);
	} catch {
		return undefined;
	}
	const parts: string[] = [];
	for (const [key, value] of Object.entries(detail)) {
		parts.push(`${key}: ${value}`);
	}

	// Include raw details for additional context
	if (event.category === AgentDebugEventCategory.Error) {
		const ee = event as IErrorEvent;
		if (ee.originalError) {
			parts.push(`\n[${vscode.l10n.t('Original Error')}]\n${ee.originalError}`);
		}
	}

	return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Extracts the subagent name from a tool call event.
 * Tries the summary ("SubAgent started: Name"), then argsSummary JSON, then falls back to toolName.
 */
function extractSubagentName(tc: IToolCallEvent): string {
	if (tc.summary.startsWith('SubAgent started: ')) {
		return tc.summary.slice('SubAgent started: '.length);
	}
	try {
		const args = JSON.parse(tc.argsSummary);
		if (typeof args.agentName === 'string') {
			return args.agentName;
		}
	} catch { /* argsSummary may be truncated */ }
	return tc.toolName;
}

/**
 * Extracts the subagent task description from the argsSummary JSON, if available.
 */
function extractSubagentDescription(tc: IToolCallEvent): string | undefined {
	try {
		const args = JSON.parse(tc.argsSummary);
		if (typeof args.description === 'string') {
			return args.description;
		}
	} catch { /* argsSummary may be truncated */ }
	return undefined;
}

/**
 * Converts an internal agent debug event to a ChatDebugEvent for the proposed API.
 * Dispatches to the appropriate class based on event category.
 */
function agentEventToLogEvent(event: IAgentDebugEvent): vscode.ChatDebugEvent {
	switch (event.category) {
		case AgentDebugEventCategory.ToolCall: {
			const tc = event as IToolCallEvent;

			if (tc.isSubAgent) {
				const agentName = extractSubagentName(tc);
				const subagentEvent = new vscode.ChatDebugSubagentInvocationEvent(agentName, new Date(event.timestamp));
				subagentEvent.id = event.id;
				subagentEvent.parentEventId = event.parentEventId;
				subagentEvent.description = extractSubagentDescription(tc);
				subagentEvent.durationInMillis = tc.durationMs;
				subagentEvent.toolCallCount = tc.childCount;
				if (tc.summary.startsWith('SubAgent started:')) {
					subagentEvent.status = vscode.ChatDebugSubagentStatus.Running;
				} else if (tc.status === 'failure') {
					subagentEvent.status = vscode.ChatDebugSubagentStatus.Failed;
				} else {
					subagentEvent.status = vscode.ChatDebugSubagentStatus.Completed;
				}
				return subagentEvent;
			}

			const toolEvent = new vscode.ChatDebugToolCallEvent(`🛠 ${tc.toolName}`, new Date(event.timestamp));
			toolEvent.id = event.id;
			toolEvent.parentEventId = event.parentEventId;
			toolEvent.input = tc.argsSummary;
			toolEvent.output = tc.resultSummary;
			toolEvent.result = tc.status === 'failure'
				? vscode.ChatDebugToolCallResult.Error
				: tc.status === 'success'
					? vscode.ChatDebugToolCallResult.Success
					: undefined;
			toolEvent.durationInMillis = tc.durationMs;
			return toolEvent;
		}
		case AgentDebugEventCategory.LLMRequest: {
			const lr = event as ILLMRequestEvent;
			const modelEvent = new vscode.ChatDebugModelTurnEvent(new Date(event.timestamp));
			modelEvent.id = event.id;
			modelEvent.parentEventId = event.parentEventId;
			modelEvent.model = lr.model;
			modelEvent.inputTokens = lr.promptTokens;
			modelEvent.outputTokens = lr.completionTokens;
			modelEvent.totalTokens = lr.totalTokens;
			modelEvent.durationInMillis = lr.durationMs;
			modelEvent.cachedTokens = lr.cachedTokens;
			modelEvent.timeToFirstTokenInMillis = lr.timeToFirstTokenMs;
			modelEvent.maxInputTokens = lr.maxInputTokens;
			modelEvent.maxOutputTokens = lr.maxOutputTokens;
			modelEvent.requestName = lr.requestName;
			modelEvent.status = lr.status;
			return modelEvent;
		}
		case AgentDebugEventCategory.Discovery: {
			const de = event as IDiscoveryEvent;
			const icon = de.resourceType === 'skill' ? '📖' : '📋';
			const genericEvent = new vscode.ChatDebugGenericEvent(
				`${icon} ${event.summary}`,
				vscode.ChatDebugLogLevel.Info,
				new Date(event.timestamp),
			);
			genericEvent.id = event.id;
			genericEvent.parentEventId = event.parentEventId;
			genericEvent.category = 'discovery';
			genericEvent.details = vscode.workspace.asRelativePath(de.resourcePath);
			return genericEvent;
		}
		default: {
			const genericEvent = new vscode.ChatDebugGenericEvent(
				event.summary,
				eventCategoryToLogLevel(event),
				new Date(event.timestamp),
			);
			genericEvent.id = event.id;
			genericEvent.parentEventId = event.parentEventId;
			genericEvent.details = formatEventDetails(event);
			genericEvent.category = eventCategoryToString(event.category);
			return genericEvent;
		}
	}
}

// ────────────────────────────────────────────────────────────────
// Trajectory step → ChatDebugEvent conversion (direct bridge)
// ────────────────────────────────────────────────────────────────

function stepSourceToLogLevel(source: ITrajectoryStep['source']): vscode.ChatDebugLogLevel {
	switch (source) {
		case 'system':
			return vscode.ChatDebugLogLevel.Info;
		case 'user':
			return vscode.ChatDebugLogLevel.Info;
		case 'agent':
			return vscode.ChatDebugLogLevel.Info;
		default:
			return vscode.ChatDebugLogLevel.Info;
	}
}

function formatStepName(step: ITrajectoryStep): string {
	switch (step.source) {
		case 'system':
			return vscode.l10n.t('System message');
		case 'user':
			return vscode.l10n.t('User message');
		case 'agent': {
			const toolCount = step.tool_calls?.length ?? 0;
			const model = step.model_name ? ` (${step.model_name})` : '';
			if (toolCount > 0) {
				const toolNames = step.tool_calls!.map((tc: { function_name: string }) => tc.function_name).join(', ');
				return toolCount > 1
					? vscode.l10n.t('Agent response{0} → {1} tool calls: {2}', model, toolCount, toolNames)
					: vscode.l10n.t('Agent response{0} → {1} tool call: {2}', model, toolCount, toolNames);
			}
			return vscode.l10n.t('Agent response{0}', model);
		}
		default:
			return step.source;
	}
}

function formatStepContents(step: ITrajectoryStep): string | undefined {
	const parts: string[] = [];

	if (step.message) {
		let message = step.message;
		if (step.source === 'user') {
			const match = message.match(/<userRequest>([\s\S]*?)<\/userRequest>/);
			if (match) {
				message = match[1].trim();
			}
		}
		parts.push(message);
	}

	if (step.tool_calls) {
		for (const tc of step.tool_calls) {
			parts.push(`\n[${vscode.l10n.t('Tool Call')}: ${tc.function_name} (${tc.tool_call_id})]`);
			parts.push(safeJsonStringify(tc.arguments, 2));
		}
	}

	if (step.observation?.results) {
		for (const result of step.observation.results) {
			if (result.content) {
				const source = result.source_call_id ? ` (${result.source_call_id})` : '';
				parts.push(`\n[${vscode.l10n.t('Tool Result')}${source}]`);
				parts.push(result.content);
			}
			if (result.subagent_trajectory_ref) {
				for (const ref of result.subagent_trajectory_ref) {
					parts.push(`\n[${vscode.l10n.t('Subagent')}: ${ref.session_id}]`);
				}
			}
		}
	}

	return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Formats the full, unextracted contents of a trajectory step for the resolved detail view.
 */
function formatStepFullContents(step: ITrajectoryStep): string | undefined {
	const parts: string[] = [];

	if (step.message) {
		parts.push(step.message);
	}

	if (step.reasoning_content) {
		parts.push(`\n[${vscode.l10n.t('Reasoning')}]\n${step.reasoning_content}`);
	}

	if (step.tool_calls) {
		for (const tc of step.tool_calls) {
			parts.push(`\n[${vscode.l10n.t('Tool Call')}: ${tc.function_name} (${tc.tool_call_id})]`);
			parts.push(safeJsonStringify(tc.arguments, 2));
		}
	}

	if (step.observation?.results) {
		for (const result of step.observation.results) {
			if (result.content) {
				const source = result.source_call_id ? ` (${result.source_call_id})` : '';
				parts.push(`\n[${vscode.l10n.t('Tool Result')}${source}]`);
				parts.push(result.content);
			}
			if (result.subagent_trajectory_ref) {
				for (const ref of result.subagent_trajectory_ref) {
					parts.push(`\n[${vscode.l10n.t('Subagent')}: ${ref.session_id}]`);
				}
			}
		}
	}

	return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Builds structured sections from a user trajectory step's message.
 * Extracts top-level XML-like tags (e.g., `<userRequest>`, `<context>`) into named sections.
 * Uses a tag-aware approach so nested tags don't cause incorrect splitting.
 */
function buildUserMessageSections(step: ITrajectoryStep): vscode.ChatDebugMessageSection[] {
	const sections: vscode.ChatDebugMessageSection[] = [];
	const message = step.message;
	if (!message) {
		return sections;
	}

	// Find top-level tag boundaries by matching opening tags and their
	// corresponding closing tags (handling nesting of the same tag name).
	const openTagPattern = /<(\w+)>/g;
	const extractedRanges: { tagName: string; start: number; end: number; content: string }[] = [];
	let openMatch: RegExpExecArray | null;

	while ((openMatch = openTagPattern.exec(message)) !== null) {
		const tagName = openMatch[1];
		const contentStart = openMatch.index + openMatch[0].length;

		// Find the matching closing tag, accounting for nesting
		let depth = 1;
		const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const nestedPattern = new RegExp(`<${escapedTag}>|</${escapedTag}>`, 'g');
		nestedPattern.lastIndex = contentStart;
		let nestedMatch: RegExpExecArray | null;
		let closingIndex = -1;

		while ((nestedMatch = nestedPattern.exec(message)) !== null) {
			if (nestedMatch[0] === `</${tagName}>`) {
				depth--;
				if (depth === 0) {
					closingIndex = nestedMatch.index;
					break;
				}
			} else {
				depth++;
			}
		}

		if (closingIndex === -1) {
			continue; // No matching close tag, skip
		}

		const content = message.slice(contentStart, closingIndex).trim();
		const fullEnd = closingIndex + `</${tagName}>`.length;
		extractedRanges.push({ tagName, start: openMatch.index, end: fullEnd, content });

		// Advance past this tag to avoid re-matching nested opens
		openTagPattern.lastIndex = fullEnd;
	}

	// If no tags were found, put the whole message in a single section
	if (extractedRanges.length === 0) {
		sections.push(new vscode.ChatDebugMessageSection(vscode.l10n.t('User Request'), message));
		return sections;
	}

	// Build sections from extracted tags (include empty sections too)
	for (const range of extractedRanges) {
		sections.push(new vscode.ChatDebugMessageSection(range.tagName, range.content));
	}

	// Collect any remaining text outside tags
	let remaining = '';
	let lastEnd = 0;
	for (const range of extractedRanges) {
		const gap = message.slice(lastEnd, range.start).trim();
		if (gap) {
			remaining += gap + '\n';
		}
		lastEnd = range.end;
	}
	const trailing = message.slice(lastEnd).trim();
	if (trailing) {
		remaining += trailing;
	}
	if (remaining.trim()) {
		sections.unshift(new vscode.ChatDebugMessageSection(vscode.l10n.t('Other'), remaining.trim()));
	}

	return sections;
}

/**
 * Builds structured sections from an agent trajectory step.
 */
function buildAgentResponseSections(step: ITrajectoryStep): vscode.ChatDebugMessageSection[] {
	const sections: vscode.ChatDebugMessageSection[] = [];

	if (step.message) {
		sections.push(new vscode.ChatDebugMessageSection(vscode.l10n.t('Response'), step.message));
	}

	if (step.reasoning_content) {
		sections.push(new vscode.ChatDebugMessageSection(vscode.l10n.t('Reasoning'), step.reasoning_content));
	}

	if (step.tool_calls && step.tool_calls.length > 0) {
		const toolParts: string[] = [];
		for (const tc of step.tool_calls) {
			toolParts.push(`[${tc.function_name} (${tc.tool_call_id})]`);
			toolParts.push(safeJsonStringify(tc.arguments, 2));
		}
		sections.push(new vscode.ChatDebugMessageSection(vscode.l10n.t('Tool Calls'), toolParts.join('\n')));
	}

	if (step.observation?.results) {
		const resultParts: string[] = [];
		for (const result of step.observation.results) {
			if (result.content) {
				const source = result.source_call_id ? ` (${result.source_call_id})` : '';
				resultParts.push(`[${vscode.l10n.t('Tool Result')}${source}]`);
				resultParts.push(result.content);
			}
			if (result.subagent_trajectory_ref) {
				for (const ref of result.subagent_trajectory_ref) {
					resultParts.push(`[${vscode.l10n.t('Subagent')}: ${ref.session_id}]`);
				}
			}
		}
		if (resultParts.length > 0) {
			sections.push(new vscode.ChatDebugMessageSection(vscode.l10n.t('Tool Results'), resultParts.join('\n')));
		}
	}

	return sections;
}

/**
 * Checks whether a trajectory step contains any subagent tool calls.
 */
function hasSubagentToolCalls(step: ITrajectoryStep): boolean {
	return !!step.tool_calls?.some(tc => tc.function_name === 'runSubagent' || tc.function_name === 'search_subagent');
}

function stepToLogEvent(step: ITrajectoryStep, stepMap: Map<string, ITrajectoryStep>): vscode.ChatDebugEvent {
	const created = step.timestamp ? new Date(step.timestamp) : new Date();
	const id = `trajectory-step-${generateUuid()}`;
	const genericEvent = new vscode.ChatDebugGenericEvent(
		formatStepName(step),
		stepSourceToLogLevel(step.source),
		created,
	);
	genericEvent.id = id;
	genericEvent.details = formatStepContents(step);
	genericEvent.category = 'trajectory';
	stepMap.set(id, step);
	return genericEvent;
}

/**
 * Provider that supplies chat debug log events from the agent debug event
 * service. It returns existing events for the requested session and streams
 * new events as they arrive.
 *
 * Architecture:
 * - The AgentDebugEventCollector feeds events into IAgentDebugEventService
 *   from IRequestLogger, ITrajectoryLogger, and ICustomInstructionsService
 * - This provider bridges those events to the VS Code proposed ChatDebugLogProvider API
 * - Events are mapped from IAgentDebugEvent to ChatDebugEvent with proper
 *   levels, categories, and parent-child relationships
 */
export class ChatDebugLogProviderContribution extends Disposable implements IExtensionContribution {
	readonly id = 'chatDebugLogProvider';
	private readonly _trajectoryStepMap = new Map<string, ITrajectoryStep>();

	constructor(
		@ITrajectoryLogger private readonly _trajectoryLogger: ITrajectoryLogger,
		@IAgentDebugEventService private readonly _debugEventService: IAgentDebugEventService,
		@ILogService private readonly _logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
	) {
		super();

		if (typeof vscode.chat?.registerChatDebugLogProvider !== 'function') {
			this._logService.info('[ChatDebugLogProvider] Chat debug API not available, skipping registration');
			return;
		}

		this._logService.info('[ChatDebugLogProvider] Registering chat debug log provider');
		try {
			this._register(vscode.chat.registerChatDebugLogProvider({
				provideChatDebugLog: (sessionResource, progress, token) =>
					this._provideChatDebugLog(sessionResource, progress, token),
				resolveChatDebugLogEvent: (eventId, token) =>
					this._resolveChatDebugLogEvent(eventId, token),
			}));
		} catch (e) {
			this._logService.warn(`[ChatDebugLogProvider] Failed to register: ${e}`);
		}
	}

	private _provideChatDebugLog(
		sessionResource: vscode.Uri,
		progress: vscode.Progress<vscode.ChatDebugEvent>,
		token: vscode.CancellationToken,
	): vscode.ChatDebugEvent[] | undefined {
		// Extract the raw session ID from the URI (e.g. vscode-chat-session://local/<base64EncodedSessionId>)
		// The path segment is base64-encoded, so decode it to get the actual UUID used internally.
		const pathSegment = sessionResource.path.replace(/^\//, '').split('/').pop() || '';
		const sessionId = pathSegment ? Buffer.from(pathSegment, 'base64').toString('utf-8') : sessionResource.toString();
		this._logService.info(`[ChatDebugLogProvider] provideChatDebugLog called for sessionResource: ${sessionResource.toString()}, extracted sessionId: ${sessionId}`);

		const initialEvents: vscode.ChatDebugEvent[] = [];
		/** Track trajectory step IDs for this session so we can clean up on cancel. */
		const sessionStepIds: string[] = [];

		// 1. Primary source: trajectory steps (always available, uses same session IDs as VS Code)
		const allTrajectories = this._trajectoryLogger.getAllTrajectories();
		const trajectory = allTrajectories.get(sessionId);
		let reportedStepCount = 0;
		if (trajectory) {
			this._logService.debug(`[ChatDebugLogProvider] Found trajectory with ${trajectory.steps.length} steps for session ${sessionId}`);
			for (const step of trajectory.steps) {
				const toolNames = step.tool_calls?.map(tc => tc.function_name).join(', ') ?? 'none';
				this._logService.debug(`[ChatDebugLogProvider] Step source=${step.source}, tool_calls=${step.tool_calls?.length ?? 0} [${toolNames}], hasSubagent=${step.tool_calls ? hasSubagentToolCalls(step) : false}`);
				// Skip agent steps with tool calls — these are already represented
				// by enriched ToolCall events from the debug event service.
				// Exception: steps that invoke subagents should still be emitted as
				// agent response events so the user can see the reasoning.
				if (step.source === 'agent' && step.tool_calls && step.tool_calls.length > 0) {
					if (hasSubagentToolCalls(step)) {
						this._logService.debug(`[ChatDebugLogProvider] Emitting agent step with subagent tool calls: ${toolNames}, message length: ${step.message?.length ?? 0}`);
					} else {
						continue;
					}
				}
				try {
					const logEvent = stepToLogEvent(step, this._trajectoryStepMap);
					sessionStepIds.push(logEvent.id!);
					initialEvents.push(logEvent);
				} catch (e) {
					this._logService.warn(`[ChatDebugLogProvider] Failed to map trajectory step: ${e}`);
				}
			}
			reportedStepCount = trajectory.steps.length;
		} else {
			this._logService.debug(`[ChatDebugLogProvider] No trajectory found for session ${sessionId}. Available sessions: [${[...allTrajectories.keys()].join(', ')}]`);
		}

		// 2. Supplementary source: enriched events from the agent debug event service
		//    (tool call details, LLM request metrics, errors, redundancy detection)
		//    Skip LoopControl events — they duplicate trajectory steps which already
		//    show properly extracted user/agent messages.
		const serviceEvents = this._debugEventService.getEvents({ sessionId });
		const reportedEventIds = new Set<string>();
		for (const event of serviceEvents) {
			if (event.category === AgentDebugEventCategory.LoopControl) {
				continue;
			}
			reportedEventIds.add(event.id);
			if (event.category === AgentDebugEventCategory.ToolCall && (event as IToolCallEvent).isSubAgent) {
				const tc = event as IToolCallEvent;
				this._logService.debug(`[ChatDebugLogProvider] Mapping subagent event: tool=${tc.toolName}, summary=${tc.summary}, status=${tc.status}, isSubAgent=${tc.isSubAgent}, childCount=${tc.childCount}, durationMs=${tc.durationMs}`);
			}
			try {
				initialEvents.push(agentEventToLogEvent(event));
			} catch (e) {
				this._logService.warn(`[ChatDebugLogProvider] Failed to map debug event ${event.id}: ${e}`);
			}
		}
		this._logService.debug(`[ChatDebugLogProvider] Found ${serviceEvents.length} events from debug event service`);

		// Sort all initial events by timestamp
		initialEvents.sort((a, b) => a.created.getTime() - b.created.getTime());

		this._logService.debug(`[ChatDebugLogProvider] Returning ${initialEvents.length} total initial events, setting up live listeners`);

		// 3. Stream new trajectory steps as they arrive
		const trajectoryListener = this._trajectoryLogger.onDidUpdateTrajectory(() => {
			if (token.isCancellationRequested) {
				return;
			}
			const trajectories = this._trajectoryLogger.getAllTrajectories();
			const traj = trajectories.get(sessionId);
			if (!traj) {
				return;
			}
			const newSteps = traj.steps.slice(reportedStepCount);
			if (newSteps.length > 0) {
				this._logService.debug(`[ChatDebugLogProvider] Streaming ${newSteps.length} new trajectory step(s) for session ${sessionId}`);
			}
			for (const step of newSteps) {
				// Skip agent steps with tool calls — covered by ToolCall debug events.
				// Exception: steps that invoke subagents should still be emitted.
				if (step.source === 'agent' && step.tool_calls && step.tool_calls.length > 0) {
					if (hasSubagentToolCalls(step)) {
						this._logService.debug(`[ChatDebugLogProvider] Streaming agent step with subagent tool calls: ${step.tool_calls.map(tc => tc.function_name).join(', ')}`);
					} else {
						continue;
					}
				}
				try {
					const logEvent = stepToLogEvent(step, this._trajectoryStepMap);
					sessionStepIds.push(logEvent.id!);
					progress.report(logEvent);
				} catch (e) {
					this._logService.warn(`[ChatDebugLogProvider] Failed to stream trajectory step: ${e}`);
				}
			}
			reportedStepCount = traj.steps.length;
		});

		// 4. Stream new enriched events from the debug event service
		const eventListener = this._debugEventService.onDidAddEvent(event => {
			if (token.isCancellationRequested) {
				return;
			}
			if (event.sessionId !== sessionId) {
				return;
			}
			if (event.category === AgentDebugEventCategory.LoopControl) {
				return;
			}
			if (reportedEventIds.has(event.id)) {
				return;
			}
			reportedEventIds.add(event.id);
			this._logService.debug(`[ChatDebugLogProvider] Streaming event ${event.summary} for session ${sessionId}`);
			if (event.category === AgentDebugEventCategory.ToolCall && (event as IToolCallEvent).isSubAgent) {
				const tc = event as IToolCallEvent;
				this._logService.debug(`[ChatDebugLogProvider] Streaming subagent event: tool=${tc.toolName}, summary=${tc.summary}, status=${tc.status}, isSubAgent=${tc.isSubAgent}, childCount=${tc.childCount}, durationMs=${tc.durationMs}`);
			}
			try {
				progress.report(agentEventToLogEvent(event));
			} catch (e) {
				this._logService.warn(`[ChatDebugLogProvider] Failed to stream debug event ${event.id}: ${e}`);
			}
		});

		token.onCancellationRequested(() => {
			this._logService.debug(`[ChatDebugLogProvider] Session ${sessionId} cancelled, disposing listeners`);
			trajectoryListener.dispose();
			eventListener.dispose();
			// Clean up cached trajectory steps for this session to prevent unbounded growth
			for (const stepId of sessionStepIds) {
				this._trajectoryStepMap.delete(stepId);
			}
		});

		return initialEvents;
	}

	private async _resolveChatDebugLogEvent(
		eventId: string,
		_token: vscode.CancellationToken,
	): Promise<vscode.ChatDebugResolvedEventContent | undefined> {
		// Check trajectory steps first — return structured event types for user/agent
		const step = this._trajectoryStepMap.get(eventId);
		if (step) {
			const created = step.timestamp ? new Date(step.timestamp) : new Date();
			if (step.source === 'user') {
				const match = step.message?.match(/<userRequest>([\s\S]*?)<\/userRequest>/);
				const summary = match ? match[1].trim() : (step.message || vscode.l10n.t('User message'));
				const truncatedSummary = summary.length > 200 ? summary.slice(0, 200) + '…' : summary;
				const userEvent = new vscode.ChatDebugUserMessageEvent(truncatedSummary, created);
				userEvent.sections = buildUserMessageSections(step);
				this._logService.debug(`[ChatDebugLogProvider] Resolving user message event=${eventId}, sections=${userEvent.sections.length}: ${userEvent.sections.map(s => `[${s.name}: ${s.content.length} chars]`).join(', ')}`);
				return userEvent;
			}
			if (step.source === 'agent') {
				const agentEvent = new vscode.ChatDebugAgentResponseEvent(formatStepName(step), created);
				agentEvent.sections = buildAgentResponseSections(step);
				this._logService.debug(`[ChatDebugLogProvider] Resolving agent response event=${eventId}, sections=${agentEvent.sections.length}: ${agentEvent.sections.map(s => `[${s.name}: ${s.content.length} chars]`).join(', ')}`);
				return agentEvent;
			}
			const text = formatStepFullContents(step);
			return text ? new vscode.ChatDebugEventTextContent(text) : undefined;
		}

		// Then check the debug event service
		const event = this._debugEventService.getEventById(eventId);
		if (!event) {
			return undefined;
		}

		const parts: string[] = [];

		switch (event.category) {
			case AgentDebugEventCategory.LoopControl: {
				const details = event.details;

				if (details['message']) {
					parts.push(String(details['message']));
				}

				if (details['reasoning']) {
					parts.push(`\n[${vscode.l10n.t('Reasoning')}]\n${details['reasoning']}`);
				}

				if (Array.isArray(details['toolCalls'])) {
					for (const tc of details['toolCalls'] as { id?: string; name?: string; args?: unknown }[]) {
						parts.push(`\n[${vscode.l10n.t('Tool Call')}: ${tc.name ?? vscode.l10n.t('unknown')} (${tc.id ?? ''})]`);
						parts.push(safeJsonStringify(tc.args, 2));
					}
				}

				if (Array.isArray(details['observations'])) {
					for (const obs of details['observations'] as { sourceCallId?: string; content?: string; subagentRefs?: string[] }[]) {
						if (obs.content) {
							const source = obs.sourceCallId ? ` (${obs.sourceCallId})` : '';
							parts.push(`\n[${vscode.l10n.t('Tool Result')}${source}]`);
							parts.push(obs.content);
						}
						if (obs.subagentRefs) {
							for (const ref of obs.subagentRefs) {
								parts.push(`\n[${vscode.l10n.t('Subagent')}: ${ref}]`);
							}
						}
					}
				}

				if (details['metrics'] && typeof details['metrics'] === 'object') {
					const metrics = details['metrics'] as Record<string, unknown>;
					const metricParts: string[] = [];
					if (metrics['prompt_tokens'] !== undefined) {
						metricParts.push(vscode.l10n.t('prompt: {0}', String(metrics['prompt_tokens'])));
					}
					if (metrics['completion_tokens'] !== undefined) {
						metricParts.push(vscode.l10n.t('completion: {0}', String(metrics['completion_tokens'])));
					}
					if (metrics['cached_tokens'] !== undefined) {
						metricParts.push(vscode.l10n.t('cached: {0}', String(metrics['cached_tokens'])));
					}
					if (metrics['duration_ms'] !== undefined) {
						metricParts.push(vscode.l10n.t('duration: {0}ms', String(metrics['duration_ms'])));
					}
					if (metrics['time_to_first_token_ms'] !== undefined) {
						metricParts.push(vscode.l10n.t('TTFT: {0}ms', String(metrics['time_to_first_token_ms'])));
					}
					if (metricParts.length > 0) {
						parts.push(`\n[${vscode.l10n.t('Metrics')}]\n${metricParts.join(' | ')}`);
					}
				}

				// Fallback for loop start/stop: show agent info
				if (parts.length === 0) {
					if (details['agentName']) {
						parts.push(vscode.l10n.t('Agent: {0}', details['agentName']));
					}
					if (details['model']) {
						parts.push(vscode.l10n.t('Model: {0}', details['model']));
					}
					if (details['totalSteps'] !== undefined) {
						parts.push(vscode.l10n.t('Total steps: {0}', String(details['totalSteps'])));
					}
					if (details['totalToolCalls'] !== undefined) {
						parts.push(vscode.l10n.t('Total tool calls: {0}', String(details['totalToolCalls'])));
					}
					if (details['totalTokens'] !== undefined) {
						parts.push(vscode.l10n.t('Total tokens: {0}', String(details['totalTokens'])));
					}
				}
				break;
			}

			case AgentDebugEventCategory.ToolCall: {
				const tc = event as IToolCallEvent;
				const toolContent = new vscode.ChatDebugEventToolCallContent(tc.toolName);
				toolContent.input = tc.argsSummary;
				toolContent.output = tc.resultSummary ?? tc.errorMessage;
				toolContent.result = tc.status === 'failure'
					? vscode.ChatDebugToolCallResult.Error
					: tc.status === 'success'
						? vscode.ChatDebugToolCallResult.Success
						: undefined;
				toolContent.durationInMillis = tc.durationMs;
				return toolContent;
			}

			case AgentDebugEventCategory.LLMRequest: {
				const lr = event as ILLMRequestEvent;

				const modelTurnContent = new vscode.ChatDebugEventModelTurnContent(lr.requestName);
				modelTurnContent.model = lr.model;
				modelTurnContent.status = lr.status;
				modelTurnContent.durationInMillis = lr.durationMs;
				modelTurnContent.timeToFirstTokenInMillis = lr.timeToFirstTokenMs;
				modelTurnContent.maxInputTokens = lr.maxInputTokens;
				modelTurnContent.maxOutputTokens = lr.maxOutputTokens;
				modelTurnContent.inputTokens = lr.promptTokens;
				modelTurnContent.outputTokens = lr.completionTokens;
				modelTurnContent.cachedTokens = lr.cachedTokens;
				modelTurnContent.totalTokens = lr.totalTokens;
				modelTurnContent.errorMessage = lr.errorMessage;

				// If we have a request log entry ID, resolve sections from the logged request
				if (lr.requestLogEntryId) {
					try {
						const loggedEntry = this._requestLogger.getRequests().find(e => e.id === lr.requestLogEntryId);
						if (loggedEntry && loggedEntry.kind === LoggedInfoKind.Request) {
							modelTurnContent.sections = this._buildModelTurnSections(loggedEntry.entry);
						}
					} catch (e) {
						this._logService.warn(`[ChatDebugLogProvider] Failed to resolve request log entry ${lr.requestLogEntryId}: ${e}`);
					}
				}

				return modelTurnContent;
			}

			case AgentDebugEventCategory.Error: {
				const ee = event as IErrorEvent;
				parts.push(vscode.l10n.t('Error type: {0}', ee.errorType));
				if (ee.toolName) {
					parts.push(vscode.l10n.t('Tool: {0}', ee.toolName));
				}
				if (ee.originalError) {
					parts.push(`\n[${vscode.l10n.t('Original Error')}]\n${ee.originalError}`);
				}
				break;
			}

			case AgentDebugEventCategory.Discovery: {
				const de = event as IDiscoveryEvent;
				if (de.details['skillName']) {
					parts.push(vscode.l10n.t('Skill Name: {0}', de.details['skillName']));
				}
				parts.push(vscode.l10n.t('Path: {0}', vscode.workspace.asRelativePath(de.resourcePath)));
				break;
			}
		}

		if (parts.length === 0) {
			// Absolute fallback — dump the raw details
			if (Object.keys(event.details).length > 0) {
				parts.push(safeJsonStringify(event.details, 2));
			}
		}

		if (parts.length === 0) {
			return undefined;
		}
		return new vscode.ChatDebugEventTextContent(parts.join('\n'));
	}

	/**
	 * Build structured sections from a logged request entry for display
	 * in the model turn detail view.
	 */
	private _buildModelTurnSections(entry: LoggedRequest): vscode.ChatDebugMessageSection[] {
		if (entry.type === LoggedRequestKind.MarkdownContentRequest) {
			return [new vscode.ChatDebugMessageSection('Content', entry.markdownContent)];
		}

		const sections: vscode.ChatDebugMessageSection[] = [];

		// Metadata section
		const metaParts: string[] = [];
		if (typeof entry.chatEndpoint.urlOrRequestMetadata === 'string') {
			metaParts.push(`url: ${entry.chatEndpoint.urlOrRequestMetadata}`);
		} else if (entry.chatEndpoint.urlOrRequestMetadata) {
			metaParts.push(`requestType: ${entry.chatEndpoint.urlOrRequestMetadata?.type}`);
		}
		metaParts.push(`model: ${entry.chatParams.model}`);
		metaParts.push(`maxPromptTokens: ${entry.chatEndpoint.modelMaxPromptTokens}`);
		metaParts.push(`maxResponseTokens: ${entry.chatParams.body?.max_tokens ?? entry.chatParams.body?.max_output_tokens ?? entry.chatParams.body?.max_completion_tokens}`);
		metaParts.push(`location: ${entry.chatParams.location}`);
		metaParts.push(`intent: ${entry.chatParams.intent}`);
		const durationMs = entry.endTime.getTime() - entry.startTime.getTime();
		metaParts.push(`startTime: ${entry.startTime.toJSON()}`);
		metaParts.push(`endTime: ${entry.endTime.toJSON()}`);
		metaParts.push(`duration: ${durationMs}ms`);
		metaParts.push(`ourRequestId: ${entry.chatParams.ourRequestId}`);
		if (entry.type === LoggedRequestKind.ChatMLSuccess) {
			metaParts.push(`requestId: ${entry.result.requestId}`);
			metaParts.push(`serverRequestId: ${entry.result.serverRequestId}`);
			metaParts.push(`timeToFirstToken: ${entry.timeToFirstToken}ms`);
			metaParts.push(`resolvedModel: ${entry.result.resolvedModel}`);
			metaParts.push(`usage: ${JSON.stringify(entry.usage)}`);
		} else if (entry.type === LoggedRequestKind.ChatMLFailure) {
			metaParts.push(`requestId: ${entry.result.requestId}`);
			metaParts.push(`serverRequestId: ${entry.result.serverRequestId}`);
		}
		if (entry.customMetadata) {
			for (const [key, value] of Object.entries(entry.customMetadata)) {
				if (value !== undefined) {
					metaParts.push(`${key}: ${value}`);
				}
			}
		}
		sections.push(new vscode.ChatDebugMessageSection('Metadata', metaParts.join('\n')));

		// Tools section
		if (entry.chatParams.body?.tools?.length) {
			const toolNames = entry.chatParams.body.tools.map(t => isOpenAiFunctionTool(t) ? t.function.name : t.name);
			const toolsSummary = `Tools (${toolNames.length}): ${toolNames.join(', ')}`;
			const toolsDetail = JSON.stringify(entry.chatParams.body.tools, undefined, 2);
			sections.push(new vscode.ChatDebugMessageSection('Tools', `${toolsSummary}\n\n${toolsDetail}`));
		}

		// System Prompt section — collect all system-role messages
		const systemMessages = entry.chatParams.messages.filter(m => m.role === Raw.ChatRole.System);
		if (systemMessages.length > 0) {
			const systemContent = systemMessages.map(m => messageToMarkdown(m, entry.chatParams.ignoreStatefulMarker)).join('\n');
			sections.push(new vscode.ChatDebugMessageSection('System Prompt', systemContent));
		}

		// User Prompt section — collect user-role messages
		const userMessages = entry.chatParams.messages.filter(m => m.role === Raw.ChatRole.User);
		if (userMessages.length > 0) {
			const userContent = userMessages.map(m => messageToMarkdown(m, entry.chatParams.ignoreStatefulMarker)).join('\n');
			sections.push(new vscode.ChatDebugMessageSection('User Prompt', userContent));
		}

		// Assistant / Tool messages (conversation history context)
		const otherMessages = entry.chatParams.messages.filter(m => m.role === Raw.ChatRole.Assistant || m.role === Raw.ChatRole.Tool);
		if (otherMessages.length > 0) {
			const otherContent = otherMessages.map(m => messageToMarkdown(m, entry.chatParams.ignoreStatefulMarker)).join('\n');
			sections.push(new vscode.ChatDebugMessageSection('Conversation History', otherContent));
		}

		// Response section
		if (entry.type === LoggedRequestKind.ChatMLSuccess) {
			let responseContent: string;
			if (entry.deltas?.length) {
				responseContent = entry.deltas.map(d => d.text ?? '').join('');
			} else {
				const messages = entry.result.value;
				if (Array.isArray(messages)) {
					responseContent = messages.length === 1 ? messages[0] : messages.map(v => `<<${v}>>`).join(', ');
				} else {
					responseContent = '';
				}
			}
			sections.push(new vscode.ChatDebugMessageSection('Response', responseContent));
		} else if (entry.type === LoggedRequestKind.ChatMLFailure) {
			if (entry.result.type === ChatFetchResponseType.Length) {
				sections.push(new vscode.ChatDebugMessageSection('Response (Truncated)', entry.result.truncatedValue));
			} else {
				sections.push(new vscode.ChatDebugMessageSection('Error', `FAILED: ${entry.result.reason}`));
			}
		} else if (entry.type === LoggedRequestKind.ChatMLCancelation) {
			sections.push(new vscode.ChatDebugMessageSection('Response', 'CANCELED'));
		}

		return sections;
	}
}
