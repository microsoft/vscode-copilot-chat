/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Trajectory Interchange Format (ATIF) v1.6
 *
 * Standardized JSON format for logging agent execution traces.
 * Based on the Harbor ATIF specification, adapted for VS Code Copilot Chat's
 * multi-agent, parallel tool calling, and MCP integration capabilities.
 *
 * @see https://github.com/refreshdotdev/harbor-mm/blob/main/docs/rfcs/0001-trajectory-format.md
 */

// ── Root ────────────────────────────────────────────────────────────────────────

export interface IAgentTrajectory {
	readonly schema_version: string;
	readonly session_id: string;
	readonly agent: IAgentInfo;
	readonly steps: ITrajectoryStep[];
	readonly final_metrics?: IFinalMetrics;
	readonly notes?: string;
	readonly continued_trajectory_ref?: string;
	readonly extra?: Record<string, unknown>;
}

// ── Agent ───────────────────────────────────────────────────────────────────────

export interface IAgentInfo {
	readonly name: string;
	readonly version: string;
	readonly model_name?: string;
	readonly tool_definitions?: IToolDefinition[];
	readonly extra?: Record<string, unknown>;
}

export interface IToolDefinition {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters?: Record<string, unknown>;
	};
}

// ── Steps ───────────────────────────────────────────────────────────────────────

export interface ITrajectoryStep {
	readonly step_id: number;
	readonly timestamp?: string;
	readonly source: 'system' | 'user' | 'agent';
	readonly model_name?: string;
	/** Text-only string, or array of ContentPart for multimodal (v1.6+). */
	readonly message: string | IContentPart[];
	readonly reasoning_content?: string;
	/** Qualitative or quantitative reasoning effort (v1.6+). */
	readonly reasoning_effort?: string | number;
	readonly tool_calls?: IToolCall[];
	readonly observation?: IObservation;
	readonly metrics?: IStepMetrics;
	readonly extra?: Record<string, unknown>;
}

// ── Tool Calls ──────────────────────────────────────────────────────────────────

export interface IToolCall {
	readonly tool_call_id: string;
	readonly function_name: string;
	readonly arguments: Record<string, unknown>;
}

// ── Observations ────────────────────────────────────────────────────────────────

export interface IObservation {
	readonly results: IObservationResult[];
}

export interface IObservationResult {
	readonly source_call_id?: string;
	/** Text-only string, or array of ContentPart for multimodal (v1.6+). */
	readonly content?: string | IContentPart[];
	readonly subagent_trajectory_ref?: ISubagentTrajectoryRef[];
}

export interface ISubagentTrajectoryRef {
	readonly session_id: string;
	readonly trajectory_path?: string;
	readonly extra?: Record<string, unknown>;
}

// ── Metrics ─────────────────────────────────────────────────────────────────────

export interface IStepMetrics {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly cached_tokens?: number;
	readonly cost_usd?: number;
	readonly time_to_first_token_ms?: number;
	readonly duration_ms?: number;
	readonly extra?: Record<string, unknown>;
}

export interface IFinalMetrics {
	readonly total_prompt_tokens?: number;
	readonly total_completion_tokens?: number;
	readonly total_cached_tokens?: number;
	readonly total_cost_usd?: number;
	readonly total_steps?: number;
	readonly total_tool_calls?: number;
	readonly extra?: Record<string, unknown>;
}

// ── Multimodal Content (v1.6+) ──────────────────────────────────────────────────

export type IContentPart = ITextContentPart | IImageContentPart;

export interface ITextContentPart {
	readonly type: 'text';
	readonly text: string;
}

export interface IImageContentPart {
	readonly type: 'image';
	readonly source: IImageSource;
}

export interface IImageSource {
	readonly media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
	readonly path: string;
}

// ── Constants ───────────────────────────────────────────────────────────────────

export const TRAJECTORY_SCHEMA_VERSION = 'ATIF-v1.6';
export const TRAJECTORY_FILE_EXTENSION = '.trajectory.json';
export const TRAJECTORY_BUNDLE_FILE_EXTENSION = '.trajectory.bundle.json';
