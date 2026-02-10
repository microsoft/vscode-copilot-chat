/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unified debug session model that normalizes data from different sources
 * (IRequestLogger live data, .chatreplay.json exports, or ATIF trajectory files)
 */

/**
 * Status of a tool call or request
 */
export const enum DebugItemStatus {
	Success = 'success',
	Failure = 'failure',
	Cancelled = 'cancelled',
	InProgress = 'in-progress',
}

/**
 * A single tool call in the debug session
 */
export interface DebugToolCall {
	/** Unique identifier for this tool call */
	readonly id: string;
	/** Name of the tool/function called */
	readonly name: string;
	/** Arguments passed to the tool */
	readonly args: Record<string, unknown>;
	/** Result/response from the tool (may be truncated for display) */
	readonly result?: string;
	/** Full result content */
	readonly fullResult?: string;
	/** Duration of the tool call in milliseconds */
	readonly durationMs?: number;
	/** Timestamp when the tool call started */
	readonly timestamp?: Date;
	/** Status of the tool call */
	readonly status: DebugItemStatus;
	/** Error message if failed */
	readonly error?: string;
	/** ID of the parent turn this tool call belongs to */
	readonly turnId: string;
	/** ID of the sub-agent session if this tool invoked a sub-agent */
	readonly subAgentSessionId?: string;
	/** Thinking/reasoning content if available */
	readonly thinking?: string;
}

/**
 * A model request in the debug session
 */
export interface DebugRequest {
	/** Unique identifier for this request */
	readonly id: string;
	/** Debug name or description */
	readonly name: string;
	/** Model used for this request */
	readonly model?: string;
	/** Number of input tokens */
	readonly promptTokens?: number;
	/** Number of output tokens */
	readonly completionTokens?: number;
	/** Duration of the request in milliseconds */
	readonly durationMs?: number;
	/** Timestamp when the request started */
	readonly timestamp?: Date;
	/** Status of the request */
	readonly status: DebugItemStatus;
	/** Error message if failed */
	readonly error?: string;
	/** Response type (e.g., 'ChatMLSuccess', 'ChatMLFailure') */
	readonly responseType?: string;
	/** ID of the parent turn this request belongs to */
	readonly turnId: string;
	/** Whether this was the main conversation request */
	readonly isConversationRequest?: boolean;
}

/**
 * A turn in the conversation (user prompt + agent response cycle)
 */
export interface DebugTurn {
	/** Unique identifier for this turn */
	readonly id: string;
	/** The user's prompt/message */
	readonly prompt: string;
	/** The agent's final response */
	readonly response?: string;
	/** Tool calls made during this turn */
	readonly toolCalls: DebugToolCall[];
	/** Model requests made during this turn */
	readonly requests: DebugRequest[];
	/** Timestamp when the turn started */
	readonly timestamp?: Date;
	/** Total duration of the turn in milliseconds */
	readonly durationMs?: number;
	/** Status of the turn */
	readonly status: DebugItemStatus;
	/** Index of this turn (0-based) */
	readonly index: number;
}

/**
 * A sub-agent invocation
 */
export interface DebugSubAgent {
	/** Session ID of the sub-agent */
	readonly sessionId: string;
	/** Name of the sub-agent (e.g., 'search', 'research') */
	readonly name: string;
	/** ID of the tool call that invoked this sub-agent */
	readonly parentToolCallId: string;
	/** ID of the parent session */
	readonly parentSessionId: string;
	/** Nested sub-agent invocations */
	readonly children: DebugSubAgent[];
	/** Tool calls made by this sub-agent */
	readonly toolCalls: DebugToolCall[];
	/** Total depth in the sub-agent tree (0 = root) */
	readonly depth: number;
	/** Summary or final result from the sub-agent */
	readonly summary?: string;
}

/**
 * Aggregate metrics for a debug session
 */
export interface DebugSessionMetrics {
	/** Total number of turns */
	readonly totalTurns: number;
	/** Total number of tool calls */
	readonly totalToolCalls: number;
	/** Total number of model requests */
	readonly totalRequests: number;
	/** Total number of sub-agent invocations */
	readonly totalSubAgents: number;
	/** Maximum sub-agent nesting depth */
	readonly maxSubAgentDepth: number;
	/** Total duration in milliseconds */
	readonly totalDurationMs?: number;
	/** Total prompt tokens */
	readonly totalPromptTokens?: number;
	/** Total completion tokens */
	readonly totalCompletionTokens?: number;
	/** Number of failed tool calls */
	readonly failedToolCalls: number;
	/** Number of failed requests */
	readonly failedRequests: number;
	/** Tool call counts by name */
	readonly toolCallsByName: Map<string, number>;
	/** Error types encountered */
	readonly errorTypes: Map<string, number>;
}

/**
 * Token budget breakdown for prompt elements
 */
export interface DebugTokenBudget {
	/** Element name/label */
	readonly name: string;
	/** Actual tokens used */
	readonly tokens: number;
	/** Maximum tokens allocated */
	readonly maxTokens?: number;
	/** Usage percentage */
	readonly percentage?: number;
	/** Child elements */
	readonly children?: DebugTokenBudget[];
}

/**
 * Thinking/reasoning content block
 */
export interface DebugThinking {
	/** Unique ID for this thinking block */
	readonly id: string;
	/** Thinking content (may be multiple segments) */
	readonly text: string;
	/** Token count for thinking */
	readonly tokens?: number;
	/** Associated turn ID */
	readonly turnId: string;
	/** Associated tool call ID if during tool execution */
	readonly toolCallId?: string;
	/** Whether this is encrypted/opaque thinking */
	readonly encrypted?: boolean;
}

/**
 * Session transcript event (from JSONL logs)
 */
export interface DebugTranscriptEvent {
	/** Event type */
	readonly type: 'session.start' | 'user.message' | 'assistant.turn_start' | 'assistant.message' | 'tool.execution_start' | 'tool.execution_complete' | 'assistant.turn_end';
	/** Event ID */
	readonly id: string;
	/** Timestamp */
	readonly timestamp: Date;
	/** Parent event ID (for linking) */
	readonly parentId?: string;
	/** Event-specific data */
	readonly data: Record<string, unknown>;
}

/**
 * Complete debug session data
 */
export interface DebugSession {
	/** Session identifier */
	readonly sessionId: string;
	/** Source of the data ('live', 'chatreplay', 'trajectory', 'transcript') */
	readonly source: 'live' | 'chatreplay' | 'trajectory' | 'transcript';
	/** Turns in the session */
	readonly turns: DebugTurn[];
	/** All tool calls (flattened for easy access) */
	readonly toolCalls: DebugToolCall[];
	/** All requests (flattened for easy access) */
	readonly requests: DebugRequest[];
	/** Sub-agent hierarchy (root-level sub-agents) */
	readonly subAgents: DebugSubAgent[];
	/** Aggregate metrics */
	readonly metrics: DebugSessionMetrics;
	/** When the session started */
	readonly startTime?: Date;
	/** When the session ended or was last updated */
	readonly endTime?: Date;
	/** Model used for the session */
	readonly model?: string;
	/** Original filename if loaded from file */
	readonly sourceFile?: string;
	/** Thinking/reasoning blocks (if available) */
	readonly thinking?: DebugThinking[];
	/** Token budget breakdown (if available) */
	readonly tokenBudget?: DebugTokenBudget[];
	/** Raw transcript events (for transcript source) */
	readonly transcriptEvents?: DebugTranscriptEvent[];
	/** Session context (cwd, version info, etc.) */
	readonly sessionContext?: {
		readonly cwd?: string;
		readonly copilotVersion?: string;
		readonly vscodeVersion?: string;
	};
}

/**
 * Query types supported by the debug panel
 */
export const enum DebugQueryType {
	Summary = 'summary',
	Tools = 'tools',
	Errors = 'errors',
	Timeline = 'timeline',
	SubAgents = 'subagents',
	Search = 'search',
	Flow = 'flow',
	DataFlow = 'dataflow',
	Tree = 'tree',
	Sequence = 'sequence',
	Load = 'load',
	Help = 'help',
	Refresh = 'refresh',
	Thinking = 'thinking',
	Tokens = 'tokens',
	Transcript = 'transcript',
}

/**
 * Parsed debug query from user input
 */
export interface DebugQuery {
	/** Type of query */
	readonly type: DebugQueryType;
	/** Search term or filter (for search queries) */
	readonly searchTerm?: string;
	/** Additional options/flags */
	readonly options: {
		/** Show detailed/expanded output */
		detailed?: boolean;
		/** Limit number of results */
		limit?: number;
		/** Filter by tool name */
		toolName?: string;
		/** Filter by status */
		status?: DebugItemStatus;
	};
}

/**
 * Result from a debug query
 */
export interface DebugQueryResult {
	/** Whether the query succeeded */
	readonly success: boolean;
	/** Markdown content to display */
	readonly markdown?: string;
	/** Mermaid diagram code (if applicable) */
	readonly mermaid?: string;
	/** Error message if failed */
	readonly error?: string;
	/** Title/header for the result */
	readonly title?: string;
}
