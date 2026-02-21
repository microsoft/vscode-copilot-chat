/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Debug Event Types
 *
 * All types are designed as a future proposed API shape — serializable,
 * no internal service references, no `URI` objects (use string paths),
 * no `Disposable` fields. When creating `ChatAgentDebugEventProvider`
 * later, these types become the API contract directly.
 */

export const enum AgentDebugEventCategory {
	Discovery = 'discovery',
	ToolCall = 'toolCall',
	LLMRequest = 'llmRequest',
	Error = 'error',
	LoopControl = 'loopControl',
}

/**
 * Base event that all debug events extend. Fully serializable.
 */
export interface IAgentDebugEvent {
	readonly id: string;
	readonly timestamp: number;
	readonly category: AgentDebugEventCategory;
	readonly sessionId: string;
	readonly summary: string;
	readonly details: Record<string, unknown>;
	/** When set, this event is a child of the event with the given id. */
	readonly parentEventId?: string;
}

export type DiscoveryResourceType = 'instruction' | 'skill' | 'agent' | 'prompt';
export type DiscoverySource = 'workspace' | 'user' | 'org' | 'extension';

export interface IDiscoveryEvent extends IAgentDebugEvent {
	readonly category: AgentDebugEventCategory.Discovery;
	readonly resourceType: DiscoveryResourceType;
	readonly source: DiscoverySource;
	readonly resourcePath: string;
	readonly matched: boolean;
	readonly applyToPattern?: string;
	readonly discoveryDurationMs?: number;
}

export type ToolCallStatus = 'pending' | 'success' | 'failure';

export interface IToolCallEvent extends IAgentDebugEvent {
	readonly category: AgentDebugEventCategory.ToolCall;
	readonly toolName: string;
	readonly argsSummary: string;
	readonly status: ToolCallStatus;
	readonly durationMs?: number;
	readonly resultSummary?: string;
	readonly errorMessage?: string;
	/** True when this tool call is a subagent invocation (runSubagent or search_subagent). */
	readonly isSubAgent?: boolean;
	/** Number of child tool calls within this subagent invocation. Updated as children arrive. */
	readonly childCount?: number;
	/** When set, this tool call was made from within a subagent with this name. */
	readonly subAgentName?: string;
}

export interface ILLMRequestEvent extends IAgentDebugEvent {
	readonly category: AgentDebugEventCategory.LLMRequest;
	readonly requestName: string;
	readonly durationMs: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
	readonly totalTokens: number;
	readonly status: 'success' | 'failure' | 'canceled';
	readonly errorMessage?: string;
}

export type ErrorType = 'toolFailure' | 'rateLimit' | 'contextOverflow' | 'timeout' | 'networkError' | 'redundancy';

export interface IErrorEvent extends IAgentDebugEvent {
	readonly category: AgentDebugEventCategory.Error;
	readonly errorType: ErrorType;
	readonly originalError?: string;
	readonly toolName?: string;
}

export type LoopAction = 'start' | 'iteration' | 'yield' | 'stop';

export interface ILoopControlEvent extends IAgentDebugEvent {
	readonly category: AgentDebugEventCategory.LoopControl;
	readonly loopAction: LoopAction;
	readonly iterationIndex?: number;
	readonly reason?: string;
}

export type AgentDebugEvent =
	| IDiscoveryEvent
	| IToolCallEvent
	| ILLMRequestEvent
	| IErrorEvent
	| ILoopControlEvent;

export interface IAgentDebugEventFilter {
	readonly categories?: readonly AgentDebugEventCategory[];
	readonly sessionId?: string;
	readonly timeRange?: { readonly start: number; readonly end: number };
	readonly statusFilter?: string;
}

export interface ISessionSummary {
	readonly toolCount: number;
	readonly totalTokens: number;
	readonly durationMs: number;
	readonly errorCount: number;
	readonly cachedTokenRatio: number;
}
