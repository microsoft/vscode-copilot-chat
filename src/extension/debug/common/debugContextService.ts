/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentTrajectory, ITrajectoryStep } from '../../../platform/trajectory/common/trajectoryTypes';
import { createServiceIdentifier } from '../../../util/common/services';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { DebugSession } from './debugTypes';
import { IHierarchyNode } from './hierarchyRenderer';

export const IDebugContextService = createServiceIdentifier<IDebugContextService>('IDebugContextService');

/**
 * Event data for debug subagent responses
 */
export interface IDebugSubagentResponse {
	/** The original query that was sent */
	readonly query: string;
	/** The response from the debug subagent */
	readonly response: string;
	/** Whether the query was successful */
	readonly success: boolean;
	/** Timestamp of the response */
	readonly timestamp: Date;
}

/**
 * Represents a node in the trajectory hierarchy
 */
export interface ITrajectoryNode extends IHierarchyNode {
	/** The trajectory data */
	readonly trajectory: IAgentTrajectory;
	/** Parent node (undefined for root) */
	readonly parent?: ITrajectoryNode;
	/** Child nodes (sub-agent invocations) */
	readonly children: ITrajectoryNode[];
}

/**
 * Represents a failure found in a trajectory
 */
export interface ITrajectoryFailure {
	/** Session ID where the failure occurred */
	readonly sessionId: string;
	/** Agent name */
	readonly agentName: string;
	/** The step where the failure occurred */
	readonly step: ITrajectoryStep;
	/** Step ID (for convenience) */
	readonly stepId: number;
	/** Timestamp of the failure */
	readonly timestamp?: string;
	/** Failure type classification */
	readonly type: string;
	/** The tool call that failed (if applicable) */
	readonly toolCallId?: string;
	/** The tool name that failed (if applicable) */
	readonly toolName?: string;
	/** Error message or failure description */
	readonly message: string;
	/** Additional context about the failure */
	readonly context?: Record<string, unknown>;
	/** Parent chain (session IDs from root to this failure) */
	readonly parentChain: string[];
}

/**
 * Represents a tool call with all relevant information
 */
export interface IToolCallInfo {
	/** Session ID where the tool call occurred */
	readonly sessionId: string;
	/** Agent name */
	readonly agentName: string;
	/** Step ID where the tool call occurred */
	readonly stepId: number;
	/** Timestamp of the tool call */
	readonly timestamp?: string;
	/** Tool call ID */
	readonly toolCallId: string;
	/** Name of the tool */
	readonly toolName: string;
	/** Arguments passed to the tool */
	readonly arguments: Record<string, unknown>;
	/** Result content from the tool */
	readonly result?: string;
	/** Error message if the tool failed */
	readonly error?: string;
	/** Whether the tool call failed */
	readonly failed: boolean;
	/** Duration of the tool call in milliseconds */
	readonly durationMs?: number;
	/** If this tool call spawned a sub-agent, its session ID */
	readonly subAgentSessionId?: string;
}

/**
 * Service for managing debug context including loaded trajectories
 */
export interface IDebugContextService {
	readonly _serviceBrand: undefined;

	/**
	 * Event fired when the debug context changes
	 */
	readonly onDidChange: Event<void>;

	/**
	 * Load trajectories into the debug context
	 * @param trajectories Map of session IDs to trajectories
	 */
	loadTrajectories(trajectories: Map<string, IAgentTrajectory>): void;

	/**
	 * Add a single trajectory to the context
	 * @param trajectory The trajectory to add
	 */
	addTrajectory(trajectory: IAgentTrajectory): void;

	/**
	 * Clear all loaded trajectories
	 */
	clearTrajectories(): void;

	/**
	 * Get all loaded trajectories
	 */
	getTrajectories(): Map<string, IAgentTrajectory>;

	/**
	 * Get a specific trajectory by session ID
	 */
	getTrajectory(sessionId: string): IAgentTrajectory | undefined;

	/**
	 * Build the trajectory hierarchy from loaded trajectories
	 */
	buildHierarchy(): ITrajectoryNode[];

	/**
	 * Find all failures across all trajectories
	 * @param sessionId Optional session ID to scope to
	 */
	findFailures(sessionId?: string): ITrajectoryFailure[];

	/**
	 * Get all tool calls across all trajectories
	 * @param filter Optional filter by tool name, session, or status
	 */
	getToolCalls(filter?: { sessionId?: string; toolName?: string; failedOnly?: boolean }): IToolCallInfo[];

	/**
	 * Check if any trajectories are loaded
	 */
	hasTrajectories(): boolean;

	/**
	 * Event fired when a debug subagent completes its response
	 */
	readonly onDebugSubagentResponse: Event<IDebugSubagentResponse>;

	/**
	 * Fire an event when a debug subagent completes its response
	 * @param response The response data
	 */
	fireDebugSubagentResponse(response: IDebugSubagentResponse): void;

	// ========== Loaded Session Support ==========

	/**
	 * Load a debug session from a file (chat replay or transcript)
	 * @param session The session to load
	 * @param sourceFile Optional source file path
	 */
	loadSession(session: DebugSession, sourceFile?: string): void;

	/**
	 * Get the currently loaded session
	 */
	getLoadedSession(): DebugSession | undefined;

	/**
	 * Clear the loaded session
	 */
	clearLoadedSession(): void;

	/**
	 * Check if a session is loaded
	 */
	hasLoadedSession(): boolean;
}

export class DebugContextService extends Disposable implements IDebugContextService {
	declare readonly _serviceBrand: undefined;

	private readonly _trajectories = new Map<string, IAgentTrajectory>();
	private _loadedSession: DebugSession | undefined;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDebugSubagentResponse = this._register(new Emitter<IDebugSubagentResponse>());
	readonly onDebugSubagentResponse = this._onDebugSubagentResponse.event;

	fireDebugSubagentResponse(response: IDebugSubagentResponse): void {
		this._onDebugSubagentResponse.fire(response);
	}

	// ========== Loaded Session Support ==========

	loadSession(session: DebugSession, sourceFile?: string): void {
		this._loadedSession = {
			...session,
			sourceFile: sourceFile || session.sourceFile
		};
		this._onDidChange.fire();
	}

	getLoadedSession(): DebugSession | undefined {
		return this._loadedSession;
	}

	clearLoadedSession(): void {
		this._loadedSession = undefined;
		this._onDidChange.fire();
	}

	hasLoadedSession(): boolean {
		return this._loadedSession !== undefined;
	}

	// ========== Trajectory Support ==========

	loadTrajectories(trajectories: Map<string, IAgentTrajectory>): void {
		this._trajectories.clear();
		for (const [id, traj] of trajectories) {
			this._trajectories.set(id, traj);
		}
		this._onDidChange.fire();
	}

	addTrajectory(trajectory: IAgentTrajectory): void {
		this._trajectories.set(trajectory.session_id, trajectory);
		this._onDidChange.fire();
	}

	clearTrajectories(): void {
		this._trajectories.clear();
		this._onDidChange.fire();
	}

	getTrajectories(): Map<string, IAgentTrajectory> {
		return new Map(this._trajectories);
	}

	getTrajectory(sessionId: string): IAgentTrajectory | undefined {
		return this._trajectories.get(sessionId);
	}

	hasTrajectories(): boolean {
		return this._trajectories.size > 0;
	}

	buildHierarchy(): ITrajectoryNode[] {
		// Find all subagent references to determine parent-child relationships
		const childToParent = new Map<string, { parentSessionId: string; toolCallId: string }>();

		for (const [sessionId, trajectory] of this._trajectories) {
			for (const step of trajectory.steps) {
				if (step.observation?.results) {
					for (const result of step.observation.results) {
						if (result.subagent_trajectory_ref) {
							for (const ref of result.subagent_trajectory_ref) {
								childToParent.set(ref.session_id, {
									parentSessionId: sessionId,
									toolCallId: result.source_call_id || ''
								});
							}
						}
					}
				}
			}
		}

		// Find root trajectories (those without parents)
		const rootSessionIds = [...this._trajectories.keys()].filter(id => !childToParent.has(id));

		// Helper to check if a trajectory has failures
		const hasFailures = (trajectory: IAgentTrajectory): boolean => {
			for (const step of trajectory.steps) {
				if (step.observation?.results) {
					for (const result of step.observation.results) {
						if (result.content) {
							const content = result.content.toLowerCase();
							if (content.includes('error') || content.includes('failed') || content.includes('exception')) {
								return true;
							}
						}
					}
				}
			}
			return false;
		};

		// Helper to count tool calls
		const countToolCalls = (trajectory: IAgentTrajectory): number => {
			return trajectory.steps.reduce((sum, s) => sum + (s.tool_calls?.length || 0), 0);
		};

		// Build hierarchy recursively
		const buildNode = (sessionId: string, parent: ITrajectoryNode | undefined, depth: number): ITrajectoryNode | undefined => {
			const trajectory = this._trajectories.get(sessionId);
			if (!trajectory) {
				return undefined;
			}

			const parentInfo = childToParent.get(sessionId);
			const node: ITrajectoryNode = {
				trajectory,
				sessionId,
				agentName: trajectory.agent.name,
				parent,
				children: [],
				parentToolCallId: parentInfo?.toolCallId,
				depth,
				stepCount: trajectory.steps.length,
				toolCallCount: countToolCalls(trajectory),
				hasFailures: hasFailures(trajectory)
			};

			// Find children of this node
			for (const step of trajectory.steps) {
				if (step.observation?.results) {
					for (const result of step.observation.results) {
						if (result.subagent_trajectory_ref) {
							for (const ref of result.subagent_trajectory_ref) {
								const childNode = buildNode(ref.session_id, node, depth + 1);
								if (childNode) {
									(node.children as ITrajectoryNode[]).push(childNode);
								}
							}
						}
					}
				}
			}

			return node;
		};

		return rootSessionIds
			.map(id => buildNode(id, undefined, 0))
			.filter((node): node is ITrajectoryNode => node !== undefined);
	}

	findFailures(sessionId?: string): ITrajectoryFailure[] {
		const failures: ITrajectoryFailure[] = [];
		const hierarchy = this.buildHierarchy();

		const findParentChain = (node: ITrajectoryNode): string[] => {
			const chain: string[] = [];
			let current: ITrajectoryNode | undefined = node;
			while (current) {
				chain.unshift(current.trajectory.session_id);
				current = current.parent;
			}
			return chain;
		};

		const processNode = (node: ITrajectoryNode): void => {
			const trajectory = node.trajectory;

			// Skip if filtering by sessionId and this isn't it
			if (sessionId && trajectory.session_id !== sessionId) {
				// Still process children
				for (const child of node.children) {
					processNode(child);
				}
				return;
			}

			const parentChain = findParentChain(node);

			for (const step of trajectory.steps) {
				// Check tool call results for failures
				if (step.observation?.results) {
					for (const result of step.observation.results) {
						if (result.content) {
							const content = result.content.toLowerCase();
							if (content.includes('error') || content.includes('failed') || content.includes('exception')) {
								// Find the corresponding tool call
								const toolCall = step.tool_calls?.find(tc => tc.tool_call_id === result.source_call_id);

								// Determine failure type
								let type = 'unknown_error';
								if (content.includes('tool') || toolCall) {
									type = 'tool_error';
								} else if (content.includes('api') || content.includes('request')) {
									type = 'api_error';
								} else if (content.includes('validation') || content.includes('invalid')) {
									type = 'validation_error';
								}

								failures.push({
									sessionId: trajectory.session_id,
									agentName: trajectory.agent.name,
									step,
									stepId: step.step_id,
									timestamp: step.timestamp,
									type,
									toolCallId: result.source_call_id,
									toolName: toolCall?.function_name,
									message: result.content.substring(0, 500),
									context: toolCall?.arguments,
									parentChain
								});
							}
						}
					}
				}
			}

			// Process children
			for (const child of node.children) {
				processNode(child);
			}
		};

		for (const root of hierarchy) {
			processNode(root);
		}

		return failures;
	}

	getToolCalls(filter?: { sessionId?: string; toolName?: string; failedOnly?: boolean }): IToolCallInfo[] {
		const toolCalls: IToolCallInfo[] = [];

		for (const [sessId, trajectory] of this._trajectories) {
			// Skip if filtering by sessionId and this isn't it
			if (filter?.sessionId && sessId !== filter.sessionId) {
				continue;
			}

			for (const step of trajectory.steps) {
				if (step.tool_calls) {
					for (const tc of step.tool_calls) {
						// Apply tool name filter
						if (filter?.toolName && !tc.function_name.toLowerCase().includes(filter.toolName.toLowerCase())) {
							continue;
						}

						// Find the result for this tool call
						const result = step.observation?.results?.find((r: { source_call_id?: string }) => r.source_call_id === tc.tool_call_id);
						const resultContent = result?.content;
						const failed = resultContent
							? resultContent.toLowerCase().includes('error') ||
							resultContent.toLowerCase().includes('failed')
							: false;

						// Apply failed filter
						if (filter?.failedOnly && !failed) {
							continue;
						}

						// Check for sub-agent reference
						let subAgentSessionId: string | undefined;
						if (result?.subagent_trajectory_ref?.length) {
							subAgentSessionId = result.subagent_trajectory_ref[0].session_id;
						}

						toolCalls.push({
							sessionId: sessId,
							agentName: trajectory.agent.name,
							stepId: step.step_id,
							timestamp: step.timestamp,
							toolCallId: tc.tool_call_id,
							toolName: tc.function_name,
							arguments: tc.arguments,
							result: resultContent,
							error: failed ? resultContent : undefined,
							failed,
							durationMs: step.metrics?.duration_ms,
							subAgentSessionId
						});
					}
				}
			}
		}

		return toolCalls;
	}
}
