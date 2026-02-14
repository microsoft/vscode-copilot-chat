/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';
import { AgentBreakpointType, BreakpointResumeAction, IAgentBreakpoint, IAgentBreakpointHitContext, IToolCallBreakpointHitContext } from './agentBreakpointTypes';

/**
 * Service for managing agent breakpoints. This service is independent of the
 * debug panel and can operate standalone. It lets developers and users set
 * breakpoints that pause the tool calling loop at specific conditions.
 *
 * The service is designed to be consumed by:
 * 1. The tool calling loop (via {@link IAgentBreakpointCheckpoint}) for pause/resume
 * 2. Commands and UI surfaces for breakpoint management
 * 3. Future DAP-based debugging experiences
 */
export interface IAgentBreakpointService {
	readonly _serviceBrand: undefined;

	// ── Breakpoint Management ───────────────────────────────────────────

	/** All currently registered breakpoints. */
	readonly breakpoints: readonly IAgentBreakpoint[];

	/** Fired when the breakpoint list changes (add/remove/toggle). */
	readonly onDidChangeBreakpoints: Event<void>;

	/**
	 * Add a breakpoint. Returns the created breakpoint with a generated ID.
	 */
	addBreakpoint(type: AgentBreakpointType, options?: {
		toolName?: string;
		iteration?: number;
		tokenThreshold?: number;
		label?: string;
		enabled?: boolean;
	}): IAgentBreakpoint;

	/**
	 * Remove a breakpoint by ID.
	 * @returns true if the breakpoint was found and removed.
	 */
	removeBreakpoint(id: string): boolean;

	/**
	 * Remove all breakpoints.
	 */
	removeAllBreakpoints(): void;

	/**
	 * Enable or disable a breakpoint by ID.
	 */
	setBreakpointEnabled(id: string, enabled: boolean): void;

	// ── Step Mode ───────────────────────────────────────────────────────

	/**
	 * Whether step mode is active. In step mode, the loop pauses before
	 * every iteration (equivalent to a "step" breakpoint on every round).
	 */
	readonly isStepMode: boolean;

	/**
	 * Toggle step mode on or off.
	 */
	setStepMode(enabled: boolean): void;

	// ── Breakpoint Hit / Resume ─────────────────────────────────────────

	/**
	 * Fired when a breakpoint is hit during agent execution.
	 * Listeners can use this to update UI or log diagnostics.
	 */
	readonly onDidHitBreakpoint: Event<IAgentBreakpointHitContext>;

	/**
	 * Fired when a per-tool-call breakpoint is hit (before or after a tool call).
	 */
	readonly onDidHitToolCallBreakpoint: Event<IToolCallBreakpointHitContext>;

	/**
	 * Fired when the agent resumes after a breakpoint hit.
	 */
	readonly onDidResumeFromBreakpoint: Event<BreakpointResumeAction>;

	// ── Per-Tool-Call Breakpoints ────────────────────────────────────────

	/**
	 * Whether any before/after tool call breakpoints are active.
	 * Used by tool invocation code to decide whether to call {@link evaluateToolCallBreakpoint}.
	 */
	hasToolCallBreakpoints(): boolean;

	/**
	 * Evaluate whether a tool call should be paused (before or after execution).
	 * If a matching breakpoint exists, this suspends until the user resumes.
	 *
	 * @param timing Whether this is 'before' or 'after' the tool call.
	 * @param toolName The name of the tool being called.
	 * @param toolCallId The tool call ID.
	 * @param toolArguments The raw JSON arguments string.
	 * @param sessionId The conversation session ID.
	 * @param toolResult The tool result (only for 'after' timing).
	 * @param hadError Whether the tool call failed (only for 'after' timing).
	 * @returns The user's chosen resume action.
	 */
	evaluateToolCallBreakpoint(
		timing: 'before' | 'after',
		toolName: string,
		toolCallId: string,
		toolArguments: string,
		sessionId: string,
		toolResult?: unknown,
		hadError?: boolean,
		durationMs?: number,
		resultSizeBytes?: number,
	): Promise<BreakpointResumeAction>;

	// ── Token Tracking ──────────────────────────────────────────────────

	/**
	 * Record token usage for the current session. Called by the tool calling
	 * loop after each model response so threshold breakpoints can evaluate.
	 */
	recordTokenUsage(promptTokens: number, completionTokens: number): void;

	/**
	 * Get cumulative token usage for the current session.
	 */
	getTokenUsage(): { promptTokens: number; completionTokens: number };

	/**
	 * Reset token tracking (called when a new session starts).
	 */
	resetSession(): void;
}

export const IAgentBreakpointService = createServiceIdentifier<IAgentBreakpointService>('IAgentBreakpointService');
