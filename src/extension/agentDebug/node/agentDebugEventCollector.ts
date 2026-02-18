/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger, LoggedInfoKind, LoggedRequestKind } from '../../../platform/requestLogger/node/requestLogger';
import { ITrajectoryLogger } from '../../../platform/trajectory/common/trajectoryLogger';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IAgentDebugEventService } from '../common/agentDebugEventService';
import { AgentDebugEventCategory, IDiscoveryEvent, IErrorEvent, ILLMRequestEvent, ILoopControlEvent, IToolCallEvent } from '../common/agentDebugTypes';
import { RedundancyDetector } from '../common/redundancyDetector';

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
	private readonly _redundancyDetectors = new Map<string, RedundancyDetector>();
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

		// --- ICustomInstructionsService: emit discovery events for known instructions ---
		this._emitInstructionDiscoveryEvents();
	}

	// ────────────────────────────────────────────────────────────────
	// Request Logger sync
	// ────────────────────────────────────────────────────────────────

	private _syncFromRequestLogger(): void {
		// Safety valve: prevent unbounded growth of tracking set
		if (this._processedEntries.size > 10000) {
			const entries = [...this._processedEntries];
			this._processedEntries.clear();
			for (const e of entries.slice(-5000)) {
				this._processedEntries.add(e);
			}
		}

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
				const sessionId = rawSessionId ?? this._lastKnownSessionId ?? 'unknown';

				switch (entry.kind) {
					case LoggedInfoKind.ToolCall: {
						// Resolve session: if this is a child of a subagent, inherit the parent session
						const invId = (entry.token as CapturingToken | undefined)?.subAgentInvocationId;
						const resolvedSession = (invId && this._subAgentSessionId.get(invId)) ?? sessionId;
						this._emitToolCallEvent(entry, resolvedSession, entry.token as CapturingToken | undefined, entry.toolMetadata);
						break;
					}
					case LoggedInfoKind.Request: {
						const req = entry.entry;
						if (req.type === LoggedRequestKind.ChatMLSuccess || req.type === LoggedRequestKind.ChatMLFailure) {
							this._emitLLMRequestEvent(req, sessionId);
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
				// Individual iteration events are noisy; we only emit the loop-start below.
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



	// ────────────────────────────────────────────────────────────────
	// Instruction/Skill Discovery
	// ────────────────────────────────────────────────────────────────

	private async _emitInstructionDiscoveryEvents(): Promise<void> {
		try {
			const instructionUris = await this._customInstructionsService.getAgentInstructions();
			for (const uri of instructionUris) {
				const path = uri.path;
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

	private _emitToolCallEvent(entry: { name: string; args: unknown; time: number; response: { content: Iterable<unknown> }; toolMetadata?: unknown }, sessionId: string, token?: CapturingToken, toolMetadata?: unknown): void {
		let argsSummary: string;
		try {
			argsSummary = truncate(JSON.stringify(entry.args) ?? '(undefined)', 200);
		} catch {
			argsSummary = '(unserializable)';
		}

		// entry.time is a timestamp (Date.now()), not a duration
		const timestamp = entry.time;

		// Detect failure by checking if response content contains error indicators
		let status: 'success' | 'failure' = 'success';
		let errorMessage: string | undefined;
		for (const part of entry.response.content) {
			if (part && typeof part === 'object' && 'value' in part && typeof part.value === 'string') {
				if (part.value.startsWith('Error:') || part.value.startsWith('error:') || part.value.includes('ENOENT') || part.value.includes('EACCES')) {
					status = 'failure';
					errorMessage = truncate(part.value, 200);
					break;
				}
			}
		}

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
			status,
			errorMessage,
			isSubAgent: isSubAgent || undefined,
			parentEventId,
			subAgentName,
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

		// --- Redundancy detection ---
		let detector = this._redundancyDetectors.get(sessionId);
		if (!detector) {
			detector = new RedundancyDetector();
			this._redundancyDetectors.set(sessionId, detector);
		}
		const patterns = detector.addToolCall(event);
		for (const pattern of patterns) {
			const partial = RedundancyDetector.toPartialErrorEvent(pattern, sessionId);
			this._debugEventService.addEvent({
				...partial,
				id: generateUuid(),
				timestamp: Date.now(),
			});
		}
	}

	private _emitLLMRequestEvent(req: { startTime: Date; endTime: Date; debugName: string; type: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }, sessionId: string): void {
		const durationMs = req.endTime.getTime() - req.startTime.getTime();
		const promptTokens = req.usage?.prompt_tokens ?? 0;
		const completionTokens = req.usage?.completion_tokens ?? 0;
		const cachedTokens = req.usage?.prompt_tokens_details?.cached_tokens ?? 0;
		const totalTokens = req.usage?.total_tokens ?? (promptTokens + completionTokens);
		const isSuccess = req.type === LoggedRequestKind.ChatMLSuccess;

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
			parentEventId: this._loopStartEventId.get(sessionId),
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

function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return idx >= 0 ? path.substring(idx + 1) : path;
}
