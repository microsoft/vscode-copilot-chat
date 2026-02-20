/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { ITrajectoryLogger, ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryLogger';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAgentDebugEventService } from '../../agentDebug/common/agentDebugEventService';
import { AgentDebugEventCategory, IAgentDebugEvent, IDiscoveryEvent, IErrorEvent, ILLMRequestEvent, IToolCallEvent } from '../../agentDebug/common/agentDebugTypes';
import { formatEventDetail } from '../../agentDebug/common/agentDebugViewLogic';
import { IExtensionContribution } from '../../common/contributions';

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
			const names = calls.map(tc => tc.name ?? 'unknown').join(', ');
			parts.push(`Tool calls: ${names}`);
		}

		if (Array.isArray(details['observations'])) {
			const obs = details['observations'] as { content?: string }[];
			const count = obs.filter(o => o.content).length;
			if (count > 0) {
				parts.push(`${count} tool result${count > 1 ? 's' : ''}`);
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
			parts.push('(has reasoning)');
		}

		if (parts.length > 0) {
			return parts.join('\n');
		}

		// Fallback for loop start/stop events
		if (details['agentName']) {
			return `Agent: ${details['agentName']}`;
		}
	}

	const detail = formatEventDetail(event);
	const parts: string[] = [];
	for (const [key, value] of Object.entries(detail)) {
		parts.push(`${key}: ${value}`);
	}

	// Include raw details for additional context
	if (event.category === AgentDebugEventCategory.Error) {
		const ee = event as IErrorEvent;
		if (ee.originalError) {
			parts.push(`\n--- Original Error ---\n${ee.originalError}`);
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
				subagentEvent.sessionId = event.sessionId;
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
			toolEvent.sessionId = event.sessionId;
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
			modelEvent.sessionId = event.sessionId;
			modelEvent.parentEventId = event.parentEventId;
			modelEvent.inputTokens = lr.promptTokens;
			modelEvent.outputTokens = lr.completionTokens;
			modelEvent.totalTokens = lr.totalTokens;
			modelEvent.durationInMillis = lr.durationMs;
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
			genericEvent.sessionId = event.sessionId;
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
			genericEvent.sessionId = event.sessionId;
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
			return 'System message';
		case 'user':
			return 'User message';
		case 'agent': {
			const toolCount = step.tool_calls?.length ?? 0;
			const model = step.model_name ? ` (${step.model_name})` : '';
			if (toolCount > 0) {
				const toolNames = step.tool_calls!.map((tc: { function_name: string }) => tc.function_name).join(', ');
				return `Agent response${model} → ${toolCount} tool call${toolCount > 1 ? 's' : ''}: ${toolNames}`;
			}
			return `Agent response${model}`;
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
			parts.push(`\n--- Tool Call: ${tc.function_name} (${tc.tool_call_id}) ---`);
			parts.push(JSON.stringify(tc.arguments, null, 2));
		}
	}

	if (step.observation?.results) {
		for (const result of step.observation.results) {
			if (result.content) {
				const source = result.source_call_id ? ` (${result.source_call_id})` : '';
				parts.push(`\n--- Tool Result${source} ---`);
				parts.push(result.content);
			}
			if (result.subagent_trajectory_ref) {
				for (const ref of result.subagent_trajectory_ref) {
					parts.push(`\n--- Subagent: ${ref.session_id} ---`);
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
		parts.push(`\n--- Reasoning ---\n${step.reasoning_content}`);
	}

	if (step.tool_calls) {
		for (const tc of step.tool_calls) {
			parts.push(`\n--- Tool Call: ${tc.function_name} (${tc.tool_call_id}) ---`);
			parts.push(JSON.stringify(tc.arguments, null, 2));
		}
	}

	if (step.observation?.results) {
		for (const result of step.observation.results) {
			if (result.content) {
				const source = result.source_call_id ? ` (${result.source_call_id})` : '';
				parts.push(`\n--- Tool Result${source} ---`);
				parts.push(result.content);
			}
			if (result.subagent_trajectory_ref) {
				for (const ref of result.subagent_trajectory_ref) {
					parts.push(`\n--- Subagent: ${ref.session_id} ---`);
				}
			}
		}
	}

	return parts.length > 0 ? parts.join('\n') : undefined;
}

let nextStepEventId = 0;

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
		const nestedPattern = new RegExp(`<${tagName}>|</${tagName}>`, 'g');
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
		sections.push(new vscode.ChatDebugMessageSection('User Request', message));
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
		sections.unshift(new vscode.ChatDebugMessageSection('Other', remaining.trim()));
	}

	return sections;
}

/**
 * Builds structured sections from an agent trajectory step.
 */
function buildAgentResponseSections(step: ITrajectoryStep): vscode.ChatDebugMessageSection[] {
	const sections: vscode.ChatDebugMessageSection[] = [];

	if (step.message) {
		sections.push(new vscode.ChatDebugMessageSection('Response', step.message));
	}

	if (step.reasoning_content) {
		sections.push(new vscode.ChatDebugMessageSection('Reasoning', step.reasoning_content));
	}

	if (step.tool_calls && step.tool_calls.length > 0) {
		const toolParts: string[] = [];
		for (const tc of step.tool_calls) {
			toolParts.push(`--- ${tc.function_name} (${tc.tool_call_id}) ---`);
			toolParts.push(JSON.stringify(tc.arguments, null, 2));
		}
		sections.push(new vscode.ChatDebugMessageSection('Tool Calls', toolParts.join('\n')));
	}

	if (step.observation?.results) {
		const resultParts: string[] = [];
		for (const result of step.observation.results) {
			if (result.content) {
				const source = result.source_call_id ? ` (${result.source_call_id})` : '';
				resultParts.push(`--- Tool Result${source} ---`);
				resultParts.push(result.content);
			}
			if (result.subagent_trajectory_ref) {
				for (const ref of result.subagent_trajectory_ref) {
					resultParts.push(`--- Subagent: ${ref.session_id} ---`);
				}
			}
		}
		if (resultParts.length > 0) {
			sections.push(new vscode.ChatDebugMessageSection('Tool Results', resultParts.join('\n')));
		}
	}

	return sections;
}

function stepToLogEvent(step: ITrajectoryStep, stepMap: Map<string, ITrajectoryStep>): vscode.ChatDebugEvent {
	const created = step.timestamp ? new Date(step.timestamp) : new Date();
	const id = `trajectory-step-${nextStepEventId++}`;
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
	) {
		super();

		this._logService.info('[ChatDebugLogProvider] Registering chat debug log provider');
		try {
			this._register(vscode.chat.registerChatDebugLogProvider({
				provideChatDebugLog: (sessionId, progress, token) =>
					this._provideChatDebugLog(sessionId, progress, token),
				resolveChatDebugLogEvent: (eventId, token) =>
					this._resolveChatDebugLogEvent(eventId, token),
			}));
		} catch (e) {
			this._logService.warn(`[ChatDebugLogProvider] Failed to register: ${e}`);
		}
	}

	private _provideChatDebugLog(
		sessionId: string,
		progress: vscode.Progress<vscode.ChatDebugEvent>,
		token: vscode.CancellationToken,
	): vscode.ChatDebugEvent[] | undefined {
		this._logService.info(`[ChatDebugLogProvider] provideChatDebugLog called for session: ${sessionId}`);

		const initialEvents: vscode.ChatDebugEvent[] = [];

		// 1. Primary source: trajectory steps (always available, uses same session IDs as VS Code)
		const allTrajectories = this._trajectoryLogger.getAllTrajectories();
		const trajectory = allTrajectories.get(sessionId);
		let reportedStepCount = 0;
		if (trajectory) {
			this._logService.info(`[ChatDebugLogProvider] Found trajectory with ${trajectory.steps.length} steps for session ${sessionId}`);
			for (const step of trajectory.steps) {
				// Skip agent steps with tool calls — these are already represented
				// by enriched ToolCall events from the debug event service.
				if (step.source === 'agent' && step.tool_calls && step.tool_calls.length > 0) {
					continue;
				}
				initialEvents.push(stepToLogEvent(step, this._trajectoryStepMap));
			}
			reportedStepCount = trajectory.steps.length;
		} else {
			this._logService.info(`[ChatDebugLogProvider] No trajectory found for session ${sessionId}. Available sessions: [${[...allTrajectories.keys()].join(', ')}]`);
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
				this._logService.info(`[ChatDebugLogProvider] Mapping subagent event: tool=${tc.toolName}, summary=${tc.summary}, status=${tc.status}, isSubAgent=${tc.isSubAgent}, childCount=${tc.childCount}, durationMs=${tc.durationMs}`);
			}
			initialEvents.push(agentEventToLogEvent(event));
		}
		this._logService.info(`[ChatDebugLogProvider] Found ${serviceEvents.length} events from debug event service`);

		// Sort all initial events by timestamp
		initialEvents.sort((a, b) => a.created.getTime() - b.created.getTime());

		this._logService.info(`[ChatDebugLogProvider] Returning ${initialEvents.length} total initial events, setting up live listeners`);

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
				this._logService.info(`[ChatDebugLogProvider] Streaming ${newSteps.length} new trajectory step(s) for session ${sessionId}`);
			}
			for (const step of newSteps) {
				// Skip agent steps with tool calls — covered by ToolCall debug events.
				if (step.source === 'agent' && step.tool_calls && step.tool_calls.length > 0) {
					continue;
				}
				progress.report(stepToLogEvent(step, this._trajectoryStepMap));
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
			this._logService.info(`[ChatDebugLogProvider] Streaming event ${event.summary} for session ${sessionId}`);
			if (event.category === AgentDebugEventCategory.ToolCall && (event as IToolCallEvent).isSubAgent) {
				const tc = event as IToolCallEvent;
				this._logService.info(`[ChatDebugLogProvider] Streaming subagent event: tool=${tc.toolName}, summary=${tc.summary}, status=${tc.status}, isSubAgent=${tc.isSubAgent}, childCount=${tc.childCount}, durationMs=${tc.durationMs}`);
			}
			progress.report(agentEventToLogEvent(event));
		});

		token.onCancellationRequested(() => {
			this._logService.debug(`[ChatDebugLogProvider] Session ${sessionId} cancelled, disposing listeners`);
			trajectoryListener.dispose();
			eventListener.dispose();
		});

		return initialEvents;
	}

	private _resolveChatDebugLogEvent(
		eventId: string,
		_token: vscode.CancellationToken,
	): vscode.ChatDebugResolvedEventContent | undefined {
		// Check trajectory steps first — return structured event types for user/agent
		const step = this._trajectoryStepMap.get(eventId);
		if (step) {
			if (step.source === 'user') {
				const match = step.message?.match(/<userRequest>([\s\S]*?)<\/userRequest>/);
				const summary = match ? match[1].trim() : (step.message || 'User message');
				const truncatedSummary = summary.length > 200 ? summary.slice(0, 200) + '…' : summary;
				const userEvent = new vscode.ChatDebugUserMessageEvent(truncatedSummary, new Date());
				userEvent.sections = buildUserMessageSections(step);
				this._logService.info(`[ChatDebugLogProvider] Resolving user message event=${eventId}, message="${truncatedSummary}", sections=${userEvent.sections.length}: ${userEvent.sections.map(s => `[${s.name}: ${s.content.length} chars]`).join(', ')}`);
				this._logService.info(`[ChatDebugLogProvider] User message sections JSON: ${JSON.stringify(userEvent.sections.map(s => ({ name: s.name, content: s.content.slice(0, 500) })), null, 2)}`);
				return userEvent;
			}
			if (step.source === 'agent') {
				const agentEvent = new vscode.ChatDebugAgentResponseEvent(formatStepName(step), new Date());
				agentEvent.sections = buildAgentResponseSections(step);
				this._logService.info(`[ChatDebugLogProvider] Resolving agent response event=${eventId}, message="${agentEvent.message}", sections=${agentEvent.sections.length}: ${agentEvent.sections.map(s => `[${s.name}: ${s.content.length} chars]`).join(', ')}`);
				this._logService.info(`[ChatDebugLogProvider] Agent response sections JSON: ${JSON.stringify(agentEvent.sections.map(s => ({ name: s.name, content: s.content.slice(0, 500) })), null, 2)}`);
				return agentEvent;
			}
			const text = formatStepFullContents(step);
			return text ? new vscode.ChatDebugEventTextContent(text) : undefined;
		}

		// Then check the debug event service
		const allEvents = this._debugEventService.getEvents();
		const event = allEvents.find(e => e.id === eventId);
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
					parts.push(`\n--- Reasoning ---\n${details['reasoning']}`);
				}

				if (Array.isArray(details['toolCalls'])) {
					for (const tc of details['toolCalls'] as { id?: string; name?: string; args?: unknown }[]) {
						parts.push(`\n--- Tool Call: ${tc.name ?? 'unknown'} (${tc.id ?? ''}) ---`);
						parts.push(JSON.stringify(tc.args, null, 2));
					}
				}

				if (Array.isArray(details['observations'])) {
					for (const obs of details['observations'] as { sourceCallId?: string; content?: string; subagentRefs?: string[] }[]) {
						if (obs.content) {
							const source = obs.sourceCallId ? ` (${obs.sourceCallId})` : '';
							parts.push(`\n--- Tool Result${source} ---`);
							parts.push(obs.content);
						}
						if (obs.subagentRefs) {
							for (const ref of obs.subagentRefs) {
								parts.push(`\n--- Subagent: ${ref} ---`);
							}
						}
					}
				}

				if (details['metrics'] && typeof details['metrics'] === 'object') {
					const metrics = details['metrics'] as Record<string, unknown>;
					const metricParts: string[] = [];
					if (metrics['prompt_tokens'] !== undefined) {
						metricParts.push(`prompt: ${metrics['prompt_tokens']}`);
					}
					if (metrics['completion_tokens'] !== undefined) {
						metricParts.push(`completion: ${metrics['completion_tokens']}`);
					}
					if (metrics['cached_tokens'] !== undefined) {
						metricParts.push(`cached: ${metrics['cached_tokens']}`);
					}
					if (metrics['duration_ms'] !== undefined) {
						metricParts.push(`duration: ${metrics['duration_ms']}ms`);
					}
					if (metrics['time_to_first_token_ms'] !== undefined) {
						metricParts.push(`TTFT: ${metrics['time_to_first_token_ms']}ms`);
					}
					if (metricParts.length > 0) {
						parts.push(`\n--- Metrics ---\n${metricParts.join(' | ')}`);
					}
				}

				// Fallback for loop start/stop: show agent info
				if (parts.length === 0) {
					if (details['agentName']) {
						parts.push(`Agent: ${details['agentName']}`);
					}
					if (details['model']) {
						parts.push(`Model: ${details['model']}`);
					}
					if (details['totalSteps'] !== undefined) {
						parts.push(`Total steps: ${details['totalSteps']}`);
					}
					if (details['totalToolCalls'] !== undefined) {
						parts.push(`Total tool calls: ${details['totalToolCalls']}`);
					}
					if (details['totalTokens'] !== undefined) {
						parts.push(`Total tokens: ${details['totalTokens']}`);
					}
				}
				break;
			}

			case AgentDebugEventCategory.ToolCall: {
				const tc = event as IToolCallEvent;
				parts.push(`Tool: ${tc.toolName}`);
				parts.push(`Status: ${tc.status}`);
				if (tc.subAgentName) {
					parts.push(`SubAgent: ${tc.subAgentName}`);
				}
				if (tc.argsSummary) {
					parts.push(`\n--- Arguments ---\n${tc.argsSummary}`);
				}
				if (tc.durationMs !== undefined) {
					parts.push(`Duration: ${tc.durationMs}ms`);
				}
				if (tc.resultSummary) {
					parts.push(`\n--- Result ---\n${tc.resultSummary}`);
				}
				if (tc.errorMessage) {
					parts.push(`\n--- Error ---\n${tc.errorMessage}`);
				}
				break;
			}

			case AgentDebugEventCategory.LLMRequest: {
				const lr = event as ILLMRequestEvent;
				parts.push(`Request: ${lr.requestName}`);
				parts.push(`Status: ${lr.status}`);
				parts.push(`Duration: ${lr.durationMs}ms`);
				parts.push('');
				parts.push(`Prompt tokens: ${lr.promptTokens}`);
				parts.push(`Completion tokens: ${lr.completionTokens}`);
				parts.push(`Cached tokens: ${lr.cachedTokens}`);
				parts.push(`Total tokens: ${lr.totalTokens}`);
				if (lr.errorMessage) {
					parts.push(`\n--- Error ---\n${lr.errorMessage}`);
				}
				break;
			}

			case AgentDebugEventCategory.Error: {
				const ee = event as IErrorEvent;
				parts.push(`Error type: ${ee.errorType}`);
				if (ee.toolName) {
					parts.push(`Tool: ${ee.toolName}`);
				}
				if (ee.originalError) {
					parts.push(`\n--- Original Error ---\n${ee.originalError}`);
				}
				break;
			}

			case AgentDebugEventCategory.Discovery: {
				const de = event as IDiscoveryEvent;
				if (de.details['skillName']) {
					parts.push(`Skill Name: ${de.details['skillName']}`);
				}
				parts.push(`Path: ${vscode.workspace.asRelativePath(de.resourcePath)}`);
				break;
			}
		}

		if (parts.length === 0) {
			// Absolute fallback — dump the raw details
			if (Object.keys(event.details).length > 0) {
				parts.push(JSON.stringify(event.details, undefined, 2));
			}
		}

		if (parts.length === 0) {
			return undefined;
		}
		return new vscode.ChatDebugEventTextContent(parts.join('\n'));
	}
}
