/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { INSTRUCTION_FILE_EXTENSION } from '../../../platform/customInstructions/common/promptTypes';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger, LoggedInfoKind, LoggedRequestKind } from '../../../platform/requestLogger/node/requestLogger';
import { ITrajectoryLogger } from '../../../platform/trajectory/common/trajectoryLogger';
import type { ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryTypes';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/path';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IAgentDebugEventService } from '../common/agentDebugEventService';
import { AgentDebugEventCategory, IDiscoveryEvent, IErrorEvent, ILLMRequestEvent, ILoopControlEvent, IToolCallEvent } from '../common/agentDebugTypes';
import { IToolResultContentRenderer } from '../common/toolResultRenderer';

/**
 * Subscribes to data sources and normalizes them into agent debug events.
 * Stays in extension permanently — never migrates to core.
 *
 * Subscribes to:
 * - IRequestLogger: tool calls, LLM requests, token usage, errors
 * - ITrajectoryLogger: loop control (start/iteration/stop), per-step timing and token metrics
 * - ICustomInstructionsService: instruction/skill discovery
 */
export class AgentDebugEventCollector extends Disposable {

	private readonly _processedEntries = new Set<string>();
	private readonly _processedTrajectorySteps = new Set<string>();
	private _lastKnownSessionId: string | undefined;
	/** Maps subAgentInvocationId → the debug event id of the parent subagent tool call. */
	private readonly _subAgentEventId = new Map<string, string>();
	/** Maps subAgentInvocationId → sessionId of the parent, so children inherit it. */
	private readonly _subAgentSessionId = new Map<string, string>();
	/** Maps subAgentInvocationId → name of the subagent tool (e.g. 'runSubagent'). */
	private readonly _subAgentNames = new Map<string, string>();
	/** Tracks which subagent invocations have had their "started" marker emitted. */
	private readonly _subAgentStarted = new Set<string>();
	/** Maps sessionId → the debug event id of the loop-start event, so children can reference it. */
	private readonly _loopStartEventId = new Map<string, string>();

	constructor(
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@IAgentDebugEventService private readonly _debugEventService: IAgentDebugEventService,
		@ITrajectoryLogger private readonly _trajectoryLogger: ITrajectoryLogger,
		@ICustomInstructionsService private readonly _customInstructionsService: ICustomInstructionsService,
		@IToolResultContentRenderer private readonly _toolResultRenderer: IToolResultContentRenderer,
	) {
		super();

		// --- IRequestLogger subscription ---
		this._register(this._requestLogger.onDidChangeRequests(() => {
			this._syncFromRequestLogger();
		}));

		// --- ITrajectoryLogger subscription ---
		this._register(this._trajectoryLogger.onDidUpdateTrajectory(() => {
			this._syncFromTrajectoryLogger();
		}));

		// --- Clear session-tracking maps when events are cleared to prevent unbounded growth ---
		this._register(this._debugEventService.onDidClearEvents(() => {
			this._processedEntries.clear();
			this._processedTrajectorySteps.clear();
			this._subAgentEventId.clear();
			this._subAgentSessionId.clear();
			this._subAgentNames.clear();
			this._subAgentStarted.clear();
			this._loopStartEventId.clear();
			this._lastKnownSessionId = undefined;
		}));

		// --- ICustomInstructionsService: emit discovery events for known instructions ---
		this._emitInstructionDiscoveryEvents();

		// --- Initial sync: pick up any data that arrived before we subscribed ---
		this._syncFromRequestLogger();
		this._syncFromTrajectoryLogger();
	}

	// ────────────────────────────────────────────────────────────────
	// Request Logger sync
	// ────────────────────────────────────────────────────────────────

	private _syncFromRequestLogger(): void {

		const requests = this._requestLogger.getRequests();

		for (const entry of requests) {
			if (this._processedEntries.has(entry.id)) {
				continue;
			}
			this._processedEntries.add(entry.id);

			try {
				const rawSessionId = entry.token?.chatSessionId;
				if (rawSessionId) {
					this._lastKnownSessionId = rawSessionId;
				}

				// Resolve session ID: prefer the token's chatSessionId, then subagent mapping,
				// then _lastKnownSessionId as fallback. For LLM requests and errors, we require
				// a definitive session ID (from the token directly) to avoid attributing
				// non-conversation requests to the wrong session.
				const invId = (entry.token as CapturingToken | undefined)?.subAgentInvocationId;
				const subAgentSession = invId ? this._subAgentSessionId.get(invId) : undefined;
				const sessionId = rawSessionId ?? subAgentSession ?? this._lastKnownSessionId ?? 'unknown';
				// A "definitive" session ID comes from the token itself, not the global fallback
				const hasDefinitiveSessionId = !!(rawSessionId || subAgentSession);

				switch (entry.kind) {
					case LoggedInfoKind.ToolCall: {
						// Resolve session: if this is a child of a subagent, inherit the parent session
						const resolvedSession = subAgentSession ?? sessionId;
						this._emitToolCallEvent(entry, resolvedSession, entry.token as CapturingToken | undefined, entry.toolMetadata);
						break;
					}
					case LoggedInfoKind.Request: {
						const req = entry.entry;
						// Only emit LLM request events when we have a definitive session ID
						// to avoid non-conversation requests leaking into the wrong session
						if (!hasDefinitiveSessionId) {
							break;
						}
						if (req.type === LoggedRequestKind.ChatMLSuccess || req.type === LoggedRequestKind.ChatMLFailure) {
							this._emitLLMRequestEvent(req, sessionId, entry.id, entry.token as CapturingToken | undefined);
						}
						if (req.type === LoggedRequestKind.ChatMLFailure) {
							this._emitErrorEvent(req.debugName, req.result.reason, sessionId);
						}
						break;
					}
					default:
						break;
				}
			} catch {
				// Silently skip malformed entries so one bad entry
				// does not block processing of subsequent events.
			}
		}
	}

	// ────────────────────────────────────────────────────────────────
	// Trajectory Logger sync
	// ────────────────────────────────────────────────────────────────

	private _syncFromTrajectoryLogger(): void {
		const allTrajectories = this._trajectoryLogger.getAllTrajectories();

		for (const [sessionId, trajectory] of allTrajectories) {
			for (const step of trajectory.steps) {
				const stepKey = `${sessionId}:${step.step_id}`;
				if (this._processedTrajectorySteps.has(stepKey)) {
					continue;
				}
				this._processedTrajectorySteps.add(stepKey);
				this._emitTrajectoryStepEvent(step, sessionId);
			}

			// Emit loop start/stop based on trajectory state
			const startKey = `${sessionId}:loop-start`;
			if (!this._processedTrajectorySteps.has(startKey) && trajectory.steps.length > 0) {
				this._processedTrajectorySteps.add(startKey);
				const loopStartId = generateUuid();
				const event: ILoopControlEvent = {
					id: loopStartId,
					timestamp: trajectory.steps[0].timestamp ? new Date(trajectory.steps[0].timestamp).getTime() : Date.now(),
					category: AgentDebugEventCategory.LoopControl,
					sessionId,
					summary: `Loop started: ${trajectory.agent.name}`,
					details: { agentName: trajectory.agent.name, model: trajectory.agent.model_name },
					loopAction: 'start',
				};
				this._debugEventService.addEvent(event);
				this._loopStartEventId.set(sessionId, loopStartId);
			}

			// Emit loop stop when trajectory has final_metrics (build() was called)
			const stopKey = `${sessionId}:loop-stop`;
			if (!this._processedTrajectorySteps.has(stopKey) && trajectory.final_metrics) {
				this._processedTrajectorySteps.add(stopKey);
				const lastStep = trajectory.steps[trajectory.steps.length - 1];
				const stopTimestamp = lastStep?.timestamp ? new Date(lastStep.timestamp).getTime() : Date.now();
				const fm = trajectory.final_metrics;
				const totalTokens = (fm.total_prompt_tokens ?? 0) + (fm.total_completion_tokens ?? 0);
				const stopEvent: ILoopControlEvent = {
					id: generateUuid(),
					timestamp: stopTimestamp,
					category: AgentDebugEventCategory.LoopControl,
					sessionId,
					summary: `Loop stopped: ${trajectory.agent.name} — ${fm.total_steps ?? trajectory.steps.length} steps, ${totalTokens} tokens`,
					details: {
						agentName: trajectory.agent.name,
						totalSteps: fm.total_steps ?? trajectory.steps.length,
						totalToolCalls: fm.total_tool_calls ?? 0,
						totalTokens,
					},
					loopAction: 'stop',
				};
				this._debugEventService.addEvent(stopEvent);
			}
		}
	}

	private _emitTrajectoryStepEvent(step: ITrajectoryStep, sessionId: string): void {
		const timestamp = step.timestamp ? new Date(step.timestamp).getTime() : Date.now();
		const parentEventId = this._loopStartEventId.get(sessionId);

		switch (step.source) {
			case 'user': {
				this._debugEventService.addEvent({
					id: generateUuid(),
					timestamp,
					category: AgentDebugEventCategory.LoopControl,
					sessionId,
					summary: 'User message',
					details: { message: step.message },
					loopAction: 'iteration',
					parentEventId,
				} as ILoopControlEvent);
				break;
			}
			case 'system': {
				this._debugEventService.addEvent({
					id: generateUuid(),
					timestamp,
					category: AgentDebugEventCategory.LoopControl,
					sessionId,
					summary: 'System message',
					details: { message: step.message },
					loopAction: 'iteration',
					parentEventId,
				} as ILoopControlEvent);
				break;
			}
			case 'agent': {
				const toolCount = step.tool_calls?.length ?? 0;
				const model = step.model_name ? ` (${step.model_name})` : '';
				let summary: string;
				if (toolCount > 0) {
					const toolNames = step.tool_calls!.map(tc => tc.function_name).join(', ');
					summary = `Agent response${model} → ${toolCount} tool call${toolCount > 1 ? 's' : ''}: ${toolNames}`;
				} else {
					summary = `Agent response${model}`;
				}

				const details: Record<string, unknown> = {};
				if (step.message) {
					details['message'] = step.message;
				}
				if (step.reasoning_content) {
					details['reasoning'] = step.reasoning_content;
				}
				if (step.tool_calls) {
					details['toolCalls'] = step.tool_calls.map(tc => ({
						id: tc.tool_call_id,
						name: tc.function_name,
						args: tc.arguments,
					}));
				}
				if (step.observation?.results) {
					details['observations'] = step.observation.results.map(r => ({
						sourceCallId: r.source_call_id,
						content: r.content,
						subagentRefs: r.subagent_trajectory_ref?.map(ref => ref.session_id),
					}));
				}
				if (step.metrics) {
					details['metrics'] = step.metrics;
				}

				this._debugEventService.addEvent({
					id: generateUuid(),
					timestamp,
					category: AgentDebugEventCategory.LoopControl,
					sessionId,
					summary,
					details,
					loopAction: 'iteration',
					parentEventId,
				} as ILoopControlEvent);
				break;
			}
		}
	}



	// ────────────────────────────────────────────────────────────────
	// Instruction/Skill Discovery
	// ────────────────────────────────────────────────────────────────

	private async _emitInstructionDiscoveryEvents(): Promise<void> {
		try {
			const instructionUris = await this._customInstructionsService.getAgentInstructions();
			for (const uri of instructionUris) {
				const path = uri.fsPath;
				const isSkill = this._customInstructionsService.isSkillFile(uri);
				const event: IDiscoveryEvent = {
					id: generateUuid(),
					timestamp: Date.now(),
					category: AgentDebugEventCategory.Discovery,
					sessionId: 'global',
					summary: `${isSkill ? 'Skill' : 'Instruction'}: ${basename(path)}`,
					details: { path, type: isSkill ? 'skill' : 'instruction' },
					resourceType: isSkill ? 'skill' : 'instruction',
					source: 'workspace',
					resourcePath: path,
					matched: true,
				};
				this._debugEventService.addEvent(event);
			}
		} catch {
			// Instruction discovery is best-effort
		}
	}

	// ────────────────────────────────────────────────────────────────
	// Event emitters (from IRequestLogger)
	// ────────────────────────────────────────────────────────────────

	private _emitToolCallEvent(entry: { id: string; name: string; args: unknown; time: number; response: { content: Iterable<unknown> } }, sessionId: string, token?: CapturingToken, toolMetadata?: unknown): void {
		let argsSummary: string;
		try {
			const args = typeof entry.args === 'string' ? JSON.parse(entry.args) : entry.args;
			argsSummary = truncate(JSON.stringify(args, null, 2) ?? '(undefined)', 100_000);
		} catch {
			argsSummary = typeof entry.args === 'string' ? truncate(entry.args, 100_000) : '(unserializable)';
		}

		// entry.time is a timestamp (Date.now()), not a duration
		const timestamp = entry.time;

		// Collect response content and detect errors.
		// NOTE: Heuristic failure detection can produce false positives when tool
		// output legitimately contains error-like strings (e.g. grep results,
		// documentation). A proper solution requires the tool protocol to expose
		// a structured status.
		let status: 'success' | 'failure' = 'success';
		let errorMessage: string | undefined;
		let resultParts: string[];
		try {
			resultParts = this._toolResultRenderer.renderToolResultContent(entry.response.content);
		} catch {
			resultParts = [];
		}
		for (const text of resultParts) {
			if (!errorMessage && (text.includes('Error:') || text.includes('error:') || text.includes('ENOENT') || text.includes('EACCES'))) {
				status = 'failure';
				errorMessage = truncate(text, 10_000);
			}
		}
		const resultSummary = resultParts.length > 0 ? truncate(resultParts.join('\n'), 10_000) : undefined;

		// Store the request log entry ID so the resolve path can lazily look up
		// the full tool result from the request logger (like copilotmd does).
		const requestLogEntryId = entry.id;

		// Detect subagent tool calls
		const isSubAgent = entry.name === 'runSubagent' || entry.name === 'search_subagent';

		// Determine parent linkage: child tool calls carry token.subAgentInvocationId
		const childInvId = token?.subAgentInvocationId;

		// Resolve subagent name for child tool calls
		let subAgentName: string | undefined;
		if (childInvId && !isSubAgent) {
			// This is a child of a subagent — try token first, then fallback to map
			subAgentName = token?.subAgentName ?? this._subAgentNames.get(childInvId) ?? 'subagent';
			// Cache the name for later children in the same invocation
			if (token?.subAgentName && !this._subAgentNames.has(childInvId)) {
				this._subAgentNames.set(childInvId, token.subAgentName);
			}

			// Emit a "SubAgent started" marker the first time we see children
			if (!this._subAgentStarted.has(childInvId)) {
				this._subAgentStarted.add(childInvId);
				const startEventId = generateUuid();
				const startEvent: IToolCallEvent = {
					id: startEventId,
					timestamp,
					category: AgentDebugEventCategory.ToolCall,
					sessionId,
					summary: `SubAgent started: ${subAgentName}`,
					details: {},
					toolName: 'runSubagent',
					argsSummary: '',
					status: 'success',
					isSubAgent: true,
					parentEventId: this._loopStartEventId.get(sessionId),
				};
				this._debugEventService.addEvent(startEvent);
				this._subAgentEventId.set(childInvId, startEventId);
				this._subAgentSessionId.set(childInvId, sessionId);
			}
		}

		// For top-level tool calls and subagent completion events, parent to the loop start.
		// Only actual children of a subagent (not the subagent tool itself) parent to the SubAgent started marker.
		let parentEventId: string | undefined;
		if (childInvId && !isSubAgent) {
			// Child tool call inside a subagent
			parentEventId = this._subAgentEventId.get(childInvId);
		} else {
			// Top-level tool call or subagent completion → parent to loop start
			parentEventId = this._loopStartEventId.get(sessionId);
		}
		const eventId = generateUuid();

		const event: IToolCallEvent = {
			id: eventId,
			timestamp,
			category: AgentDebugEventCategory.ToolCall,
			sessionId,
			summary: isSubAgent ? `SubAgent completed: ${entry.name}` : `Tool: ${entry.name}`,
			details: { args: argsSummary },
			toolName: entry.name,
			argsSummary,
			resultSummary,
			status,
			errorMessage,
			isSubAgent: isSubAgent || undefined,
			parentEventId,
			subAgentName,
			requestLogEntryId,
		};
		this._debugEventService.addEvent(event);

		// If this is a subagent, register the invocation id only if not
		// already registered by the "SubAgent started" marker.
		if (isSubAgent) {
			const meta = toolMetadata as { subAgentInvocationId?: string } | undefined;
			const invId = meta?.subAgentInvocationId;
			if (invId && !this._subAgentEventId.has(invId)) {
				this._subAgentEventId.set(invId, eventId);
				this._subAgentSessionId.set(invId, sessionId);
			}
		}

		// --- Skill/Instruction read detection ---
		if (entry.name === 'read_file' && status === 'success') {
			this._emitSkillOrInstructionReadEvent(entry.args, sessionId, timestamp, eventId);
		}
	}

	private _emitSkillOrInstructionReadEvent(args: unknown, sessionId: string, timestamp: number, parentToolEventId: string): void {
		try {
			const parsed = typeof args === 'string' ? JSON.parse(args) : args;
			const filePath = (parsed as { filePath?: string })?.filePath;
			if (!filePath) {
				return;
			}

			const uri = URI.file(filePath);
			const isSkill = this._customInstructionsService.isSkillFile(uri);
			const isInstruction = !isSkill && filePath.endsWith(INSTRUCTION_FILE_EXTENSION);

			if (!isSkill && !isInstruction) {
				return;
			}

			const resourceType = isSkill ? 'skill' : 'instruction';
			const fileName = basename(filePath);
			const skillInfo = isSkill ? this._customInstructionsService.getSkillInfo(uri) : undefined;
			const displayName = skillInfo ? skillInfo.skillName : fileName;

			const event: IDiscoveryEvent = {
				id: generateUuid(),
				timestamp,
				category: AgentDebugEventCategory.Discovery,
				sessionId,
				summary: `${isSkill ? 'Skill' : 'Instruction'} read: ${displayName}`,
				details: { path: filePath, type: resourceType, skillName: skillInfo?.skillName },
				resourceType,
				source: 'workspace',
				resourcePath: filePath,
				matched: true,
				parentEventId: parentToolEventId,
			};
			this._debugEventService.addEvent(event);
		} catch {
			// Best-effort: don't let discovery detection break tool call processing
		}
	}

	private _emitLLMRequestEvent(req: { startTime: Date; endTime: Date; debugName: string; type: string; timeToFirstToken?: number; chatEndpoint?: { model?: string; modelMaxPromptTokens?: number }; chatParams?: { postOptions?: { max_tokens?: number } }; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }, sessionId: string, requestLogEntryId?: string, token?: CapturingToken): void {
		const durationMs = req.endTime.getTime() - req.startTime.getTime();
		const promptTokens = req.usage?.prompt_tokens ?? 0;
		const completionTokens = req.usage?.completion_tokens ?? 0;
		const cachedTokens = req.usage?.prompt_tokens_details?.cached_tokens ?? 0;
		const totalTokens = req.usage?.total_tokens ?? (promptTokens + completionTokens);
		const isSuccess = req.type === LoggedRequestKind.ChatMLSuccess;

		// Resolve parent: if this request is inside a subagent, parent to the subagent event;
		// otherwise parent to the loop start.
		const childInvId = token?.subAgentInvocationId;
		let parentEventId: string | undefined;
		if (childInvId) {
			parentEventId = this._subAgentEventId.get(childInvId);
		}
		if (!parentEventId) {
			parentEventId = this._loopStartEventId.get(sessionId);
		}

		const event: ILLMRequestEvent = {
			id: generateUuid(),
			timestamp: req.startTime.getTime(),
			category: AgentDebugEventCategory.LLMRequest,
			sessionId,
			summary: `${req.debugName} — ${durationMs}ms, ${totalTokens} tokens`,
			details: { debugName: req.debugName, durationMs, promptTokens, completionTokens, cachedTokens, totalTokens },
			requestName: req.debugName,
			durationMs,
			promptTokens,
			completionTokens,
			cachedTokens,
			totalTokens,
			status: isSuccess ? 'success' : 'failure',
			parentEventId,
			model: req.chatEndpoint?.model,
			timeToFirstTokenMs: req.timeToFirstToken,
			maxInputTokens: req.chatEndpoint?.modelMaxPromptTokens,
			maxOutputTokens: req.chatParams?.postOptions?.max_tokens,
			requestLogEntryId: requestLogEntryId,
		};
		this._debugEventService.addEvent(event);
	}

	private _emitErrorEvent(debugName: string, reason: string, sessionId: string): void {
		const event: IErrorEvent = {
			id: generateUuid(),
			timestamp: Date.now(),
			category: AgentDebugEventCategory.Error,
			sessionId,
			summary: `Error: ${debugName} — ${reason}`,
			details: { debugName, reason },
			errorType: 'networkError',
			originalError: reason,
			parentEventId: this._loopStartEventId.get(sessionId),
		};
		this._debugEventService.addEvent(event);
	}
}

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}
