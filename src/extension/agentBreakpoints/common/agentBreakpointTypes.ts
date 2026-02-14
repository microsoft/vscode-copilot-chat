/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IToolCall, IToolCallRound } from '../../prompt/common/intents';

/**
 * The type of condition that triggers the breakpoint.
 */
export const enum AgentBreakpointType {
	/** Break on a specific tool name. */
	Tool = 'tool',
	/** Break on any tool call error / failure. */
	Error = 'error',
	/** Break at a specific iteration count. */
	Iteration = 'iteration',
	/** Break when cumulative token usage exceeds a threshold. */
	TokenThreshold = 'tokenThreshold',
	/** Break unconditionally (step mode — pause before every iteration). */
	Step = 'step',
	/** Break before every individual tool call is executed. */
	BeforeToolCall = 'beforeToolCall',
	/** Break after every individual tool call completes. */
	AfterToolCall = 'afterToolCall',
}

/**
 * A single agent breakpoint definition.
 */
export interface IAgentBreakpoint {
	readonly id: string;
	readonly type: AgentBreakpointType;
	readonly enabled: boolean;
	/** For {@link AgentBreakpointType.Tool} breakpoints: the tool name to match. */
	readonly toolName?: string;
	/** For {@link AgentBreakpointType.Iteration} breakpoints: the iteration number to break at. */
	readonly iteration?: number;
	/** For {@link AgentBreakpointType.TokenThreshold} breakpoints: the token count threshold. */
	readonly tokenThreshold?: number;
	/** Optional human-readable label shown when the breakpoint fires. */
	readonly label?: string;
}

/**
 * Snapshot of agent state at the point a breakpoint fires.
 * Passed to the user for inspection.
 */
export interface IAgentBreakpointHitContext {
	/** The breakpoint that triggered. */
	readonly breakpoint: IAgentBreakpoint;
	/** Current loop iteration index (0-based). */
	readonly iteration: number;
	/** Total prompt tokens consumed so far in this session. */
	readonly totalPromptTokens: number;
	/** Total completion tokens consumed so far in this session. */
	readonly totalCompletionTokens: number;
	/** The most recent tool call round, if any. */
	readonly lastRound?: IToolCallRound;
	/** Tool calls from the most recent round. */
	readonly lastToolCalls?: readonly IToolCall[];
	/** Whether any tool call in the last round produced an error. */
	readonly hadError: boolean;
	/** The session ID of the agent conversation. */
	readonly sessionId: string;
	/** Wall-clock time in ms since the tool calling loop started. */
	readonly elapsedMs: number;
}

/**
 * The user's chosen action when a breakpoint is hit.
 */
export const enum BreakpointResumeAction {
	/** Continue running until the next breakpoint or loop completion. */
	Continue = 'continue',
	/** Execute one more iteration then pause again (step-over). */
	Step = 'step',
	/** Abort the agent session. */
	Abort = 'abort',
	/** Skip this tool call (don't execute it, return empty result). */
	Skip = 'skip',
}

/**
 * Snapshot of state when a per-tool-call breakpoint fires.
 */
export interface IToolCallBreakpointHitContext {
	/** The breakpoint that triggered. */
	readonly breakpoint: IAgentBreakpoint;
	/** Whether this fired before or after the tool call. */
	readonly timing: 'before' | 'after';
	/** The tool name. */
	readonly toolName: string;
	/** The tool call ID. */
	readonly toolCallId: string;
	/** The arguments (raw JSON string). */
	readonly toolArguments: string;
	/** The tool call result (only available for 'after' timing). */
	readonly toolResult?: unknown;
	/** Whether the tool call failed (only available for 'after' timing). */
	readonly hadError?: boolean;
	/** The session ID. */
	readonly sessionId: string;
	/** Duration of the tool call in ms (only available for 'after' timing). */
	readonly durationMs?: number;
	/** Approximate size of the tool result in bytes (only available for 'after' timing). */
	readonly resultSizeBytes?: number;
}
