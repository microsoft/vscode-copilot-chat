/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Trajectory Format
 *
 * This format is inspired by the Harbor ATIF (Agent Trajectory Interchange Format)
 * specification, adapted for VS Code Copilot Chat's multi-agent, parallel tool calling,
 * and MCP integration capabilities.
 *
 * Key design goals:
 * - Capture hierarchical agent/subagent relationships
 * - Support parallel tool calling with proper correlation
 * - Include MCP tool calls with server context
 * - Enable trajectory replay and visualization
 * - Maintain compatibility with existing logging infrastructure
 */

/**
 * Root trajectory object representing a complete agent session
 */
export interface IAgentTrajectory {
	/** Schema version for compatibility tracking */
	readonly schema_version: string;
	/** Unique identifier for this trajectory session */
	readonly session_id: string;
	/** Agent configuration and metadata */
	readonly agent: IAgentInfo;
	/** Sequential steps in the agent's execution */
	readonly steps: ITrajectoryStep[];
	/** Optional aggregate metrics for the entire trajectory */
	readonly final_metrics?: IFinalMetrics;
	/** Optional notes or metadata about this trajectory */
	readonly notes?: string;
	/** Optional reference to continuation trajectory if split */
	readonly continued_trajectory_ref?: string;
	/** Custom metadata not covered by core schema */
	readonly extra?: Record<string, unknown>;
}

/**
 * Agent information and configuration
 */
export interface IAgentInfo {
	/** Name of the agent system (e.g., "copilot-agent", "search-subagent") */
	readonly name: string;
	/** Version of the agent system */
	readonly version: string;
	/** Default model used for this trajectory */
	readonly model_name?: string;
	/** Tool definitions available to the agent (OpenAI function calling format) */
	readonly tool_definitions?: IToolDefinition[];
	/** Custom agent configuration */
	readonly extra?: Record<string, unknown>;
}

/**
 * Tool definition in OpenAI function calling format
 */
export interface IToolDefinition {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters?: Record<string, unknown>;
	};
}

/**
 * A single step in the trajectory, representing one interaction turn
 */
export interface ITrajectoryStep {
	/** Ordinal step number starting from 1 */
	readonly step_id: number;
	/** ISO 8601 timestamp for this step */
	readonly timestamp?: string;
	/** Source of this step: system, user, or agent */
	readonly source: 'system' | 'user' | 'agent';
	/** Model used for this step (only for agent steps) */
	readonly model_name?: string;
	/** The message content for this step */
	readonly message: string;
	/** Agent's internal reasoning (only for agent steps) */
	readonly reasoning_content?: string;
	/** Tool calls made in this step (only for agent steps) */
	readonly tool_calls?: IToolCall[];
	/** Results from tool calls or system events */
	readonly observation?: IObservation;
	/** Metrics for this step (only for agent steps) */
	readonly metrics?: IStepMetrics;
	/** Custom step metadata */
	readonly extra?: Record<string, unknown>;
}

/**
 * A tool call made by the agent
 */
export interface IToolCall {
	/** Unique identifier for this tool call */
	readonly tool_call_id: string;
	/** Name of the function/tool being called */
	readonly function_name: string;
	/** Arguments passed to the tool (structured object) */
	readonly arguments: Record<string, unknown>;
	/** Optional MCP server context if this is an MCP tool */
	readonly mcp_server?: string;
	/** Execution mode for parallel calls */
	readonly execution_mode?: 'sequential' | 'parallel';
}

/**
 * Observation containing results from tool calls or system events
 */
export interface IObservation {
	/** Array of results from tool executions */
	readonly results: IObservationResult[];
}

/**
 * Result from a single tool call or system event
 */
export interface IObservationResult {
	/** The tool_call_id this result corresponds to (null for non-tool events) */
	readonly source_call_id?: string;
	/** Textual content of the result */
	readonly content?: string;
	/** Reference to subagent trajectory if this was a subagent invocation */
	readonly subagent_trajectory_ref?: ISubagentTrajectoryRef[];
	/** Error information if the tool call failed */
	readonly error?: {
		readonly message: string;
		readonly code?: string;
	};
}

/**
 * Reference to a subagent trajectory
 */
export interface ISubagentTrajectoryRef {
	/** Session ID of the subagent */
	readonly session_id: string;
	/** Optional path to the subagent's trajectory file */
	readonly trajectory_path?: string;
	/** Summary or metadata about the subagent execution */
	readonly extra?: Record<string, unknown>;
}

/**
 * Metrics for a single step
 */
export interface IStepMetrics {
	/** Total input tokens (including cached) */
	readonly prompt_tokens?: number;
	/** Tokens generated by the model */
	readonly completion_tokens?: number;
	/** Cached input tokens (subset of prompt_tokens) */
	readonly cached_tokens?: number;
	/** Cost in USD for this step */
	readonly cost_usd?: number;
	/** Time to first token in milliseconds */
	readonly time_to_first_token_ms?: number;
	/** Total duration of the step in milliseconds */
	readonly duration_ms?: number;
	/** Provider-specific metrics */
	readonly extra?: Record<string, unknown>;
}

/**
 * Aggregate metrics for the entire trajectory
 */
export interface IFinalMetrics {
	/** Total prompt tokens across all steps */
	readonly total_prompt_tokens?: number;
	/** Total completion tokens across all steps */
	readonly total_completion_tokens?: number;
	/** Total cached tokens across all steps */
	readonly total_cached_tokens?: number;
	/** Total cost in USD */
	readonly total_cost_usd?: number;
	/** Total number of steps */
	readonly total_steps?: number;
	/** Total number of tool calls */
	readonly total_tool_calls?: number;
	/** Custom aggregate metrics */
	readonly extra?: Record<string, unknown>;
}

/**
 * Current trajectory format version
 */
export const TRAJECTORY_SCHEMA_VERSION = 'VSCode-Copilot-Trajectory-v1.0';

/**
 * File extension for trajectory files
 */
export const TRAJECTORY_FILE_EXTENSION = '.trajectory.json';

/**
 * File extension for a trajectory bundle file (contains multiple trajectories).
 */
export const TRAJECTORY_BUNDLE_FILE_EXTENSION = '.trajectory.bundle.json';
