/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';
import type {
	IAgentInfo,
	IAgentTrajectory,
	IObservationResult,
	IStepMetrics,
	ISubagentTrajectoryRef,
	IToolCall,
	ITrajectoryStep
} from './trajectoryTypes';

export type {
	IAgentInfo,
	IAgentTrajectory,
	IObservationResult,
	IStepMetrics,
	ISubagentTrajectoryRef,
	IToolCall,
	ITrajectoryStep
};

/**
 * Service for building and managing agent trajectories.
 * This service tracks agent execution steps, tool calls, and observations
 * to construct a complete trajectory that can be exported and analyzed.
 */
export const ITrajectoryLogger = createServiceIdentifier<ITrajectoryLogger>('ITrajectoryLogger');

export interface ITrajectoryLogger {
	readonly _serviceBrand: undefined;

	/**
	 * Event fired when the trajectory is updated
	 */
	readonly onDidUpdateTrajectory: Event<void>;

	/**
	 * Start a new trajectory session
	 * @param sessionId Unique identifier for this session
	 * @param agentInfo Agent configuration information
	 */
	startTrajectory(sessionId: string, agentInfo: IAgentInfo): void;

	/**
	 * Add a system message step (e.g., initial system prompt)
	 * @param message The system message content
	 * @param timestamp Optional ISO 8601 timestamp
	 */
	addSystemStep(message: string, timestamp?: string): void;

	/**
	 * Add a user message step
	 * @param message The user's message content
	 * @param timestamp Optional ISO 8601 timestamp
	 */
	addUserStep(message: string, timestamp?: string): void;

	/**
	 * Begin an agent step (LLM inference)
	 * @param message The agent's response message
	 * @param modelName The model used for this step
	 * @param reasoningContent Optional internal reasoning content
	 * @param timestamp Optional ISO 8601 timestamp
	 * @returns A step context for adding tool calls and observations
	 */
	beginAgentStep(
		message: string,
		modelName?: string,
		reasoningContent?: string,
		timestamp?: string
	): IAgentStepContext;

	/**
	 * Get the complete trajectory for the current session
	 * @returns The complete trajectory or undefined if no session is active
	 */
	getTrajectory(): IAgentTrajectory | undefined;

	/**
	 * Get all trajectories (main and subagent) for export
	 * @returns Map of session IDs to trajectories
	 */
	getAllTrajectories(): Map<string, IAgentTrajectory>;

	/**
	 * Clear the current trajectory session
	 */
	clearTrajectory(): void;

	/**
	 * Check if a trajectory is currently being tracked
	 */
	hasActiveTrajectory(): boolean;

	/**
	 * Get the current session ID
	 */
	getCurrentSessionId(): string | undefined;
}

/**
 * Context for building an agent step with tool calls and observations
 */
export interface IAgentStepContext {
	/**
	 * Add tool calls to this step
	 * @param toolCalls Array of tool calls made by the agent
	 */
	addToolCalls(toolCalls: IToolCall[]): void;

	/**
	 * Add observations (tool results) to this step
	 * @param results Array of observation results
	 */
	addObservation(results: IObservationResult[]): void;

	/**
	 * Add a subagent trajectory reference
	 * @param toolCallId The tool call ID that spawned the subagent
	 * @param subagentRef Reference to the subagent's trajectory
	 */
	addSubagentReference(toolCallId: string, subagentRef: ISubagentTrajectoryRef): void;

	/**
	 * Set metrics for this step
	 * @param metrics Step metrics including token counts and costs
	 */
	setMetrics(metrics: IStepMetrics): void;

	/**
	 * Finalize this step and add it to the trajectory
	 */
	complete(): void;
}

/**
 * Options for exporting trajectories
 */
export interface ITrajectoryExportOptions {
	/** Whether to include subagent trajectories inline */
	includeSubagents?: boolean;
	/** Whether to pretty-print the JSON output */
	prettyPrint?: boolean;
	/** Optional notes to include in the trajectory */
	notes?: string;
}
