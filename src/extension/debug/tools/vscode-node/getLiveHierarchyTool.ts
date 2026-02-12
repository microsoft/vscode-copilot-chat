/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IAgentTrajectory, ITrajectoryLogger } from '../../../../platform/trajectory/common/trajectoryLogger';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import {
	findHierarchyNode,
	IHierarchyNode,
	renderHierarchyDetailed,
	renderHierarchyMermaid,
	renderHierarchyTree
} from '../../common/hierarchyRenderer';

interface IGetLiveHierarchyParams {
	/** Optional session ID to get hierarchy from a specific root. If not provided, shows all hierarchies. */
	sessionId?: string;
	/** Output format: 'tree' (default), 'mermaid', or 'detailed' */
	format?: 'tree' | 'mermaid' | 'detailed';
}

/**
 * Node in the live trajectory hierarchy tree.
 * Extends IHierarchyNode to allow use of shared rendering functions.
 */
interface ILiveHierarchyNode extends IHierarchyNode {
	readonly trajectory: IAgentTrajectory;
	readonly parent?: ILiveHierarchyNode;
	readonly children: ILiveHierarchyNode[];
	readonly parentToolCallId?: string;
}

/**
 * Tool to get the live sub-agent hierarchy from ITrajectoryLogger.
 * Unlike debug_getHierarchy which works with loaded trajectory files,
 * this tool works with live in-memory trajectories from the current session.
 */
class GetLiveHierarchyTool implements ICopilotTool<IGetLiveHierarchyParams> {
	public static readonly toolName = ToolName.DebugGetLiveHierarchy;

	constructor(
		@ITrajectoryLogger private readonly trajectoryLogger: ITrajectoryLogger,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetLiveHierarchyParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { sessionId, format = 'tree' } = options.input;

		// Get all live trajectories from ITrajectoryLogger
		const allTrajectories = this.trajectoryLogger.getAllTrajectories();

		if (allTrajectories.size === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No live trajectories found. Sub-agent trajectories are captured when sub-agents complete their execution during the current session.')
			]);
		}

		// Build hierarchy from live trajectories
		const roots = this.buildHierarchy(allTrajectories);

		if (roots.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No hierarchy could be built from live trajectories.')
			]);
		}

		let targetRoots: readonly ILiveHierarchyNode[] = roots;
		if (sessionId) {
			const node = findHierarchyNode(roots, sessionId);
			if (node) {
				targetRoots = [node];
			} else {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Session ID ${sessionId} not found in live hierarchy. Available roots:\n${roots.map(r => `- ${r.sessionId} (${r.agentName})`).join('\n')}`)
				]);
			}
		}

		// Use shared rendering functions
		const renderOptions = {
			title: 'Live Agent Hierarchy',
			subtitle: 'Real-time sub-agent tree from current session',
			showModel: true,
			showMetrics: true
		};

		let output: string;
		switch (format) {
			case 'mermaid':
				output = renderHierarchyMermaid(targetRoots, renderOptions);
				break;
			case 'detailed':
				output = renderHierarchyDetailed(targetRoots, renderOptions);
				break;
			default:
				output = renderHierarchyTree(targetRoots, renderOptions);
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	/**
	 * Build hierarchy tree from trajectories map
	 */
	private buildHierarchy(trajectories: Map<string, IAgentTrajectory>): ILiveHierarchyNode[] {
		// Find parent-child relationships via subagent_trajectory_ref
		const childToParent = new Map<string, { parentSessionId: string; toolCallId: string }>();

		for (const [sessionId, trajectory] of trajectories) {
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
		const rootSessionIds = [...trajectories.keys()].filter(id => !childToParent.has(id));

		// Build nodes recursively
		const buildNode = (sessionId: string, parent: ILiveHierarchyNode | undefined, depth: number): ILiveHierarchyNode | undefined => {
			const trajectory = trajectories.get(sessionId);
			if (!trajectory) {
				return undefined;
			}

			const parentInfo = childToParent.get(sessionId);
			const node: ILiveHierarchyNode = {
				trajectory,
				sessionId,
				agentName: trajectory.agent.name,
				modelName: trajectory.agent.model_name,
				parent,
				children: [],
				parentToolCallId: parentInfo?.toolCallId,
				depth,
				stepCount: trajectory.steps.length,
				toolCallCount: this.countToolCalls(trajectory),
				hasFailures: this.hasFailures(trajectory),
				metrics: this.extractMetrics(trajectory)
			};

			// Find children
			for (const step of trajectory.steps) {
				if (step.observation?.results) {
					for (const result of step.observation.results) {
						if (result.subagent_trajectory_ref) {
							for (const ref of result.subagent_trajectory_ref) {
								const childNode = buildNode(ref.session_id, node, depth + 1);
								if (childNode) {
									node.children.push(childNode);
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
			.filter((node): node is ILiveHierarchyNode => node !== undefined);
	}

	private countToolCalls(trajectory: IAgentTrajectory): number {
		return trajectory.steps.reduce((sum, s) => sum + (s.tool_calls?.length || 0), 0);
	}

	private hasFailures(trajectory: IAgentTrajectory): boolean {
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
	}

	private extractMetrics(trajectory: IAgentTrajectory): ILiveHierarchyNode['metrics'] {
		if (trajectory.final_metrics) {
			return {
				promptTokens: trajectory.final_metrics.total_prompt_tokens,
				completionTokens: trajectory.final_metrics.total_completion_tokens,
			};
		}

		// Calculate from steps if no final metrics
		let promptTokens = 0;
		let completionTokens = 0;
		for (const step of trajectory.steps) {
			if (step.metrics) {
				promptTokens += step.metrics.prompt_tokens || 0;
				completionTokens += step.metrics.completion_tokens || 0;
			}
		}
		return promptTokens || completionTokens ? { promptTokens, completionTokens } : undefined;
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IGetLiveHierarchyParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const formatLabel = options.input.format || 'tree';
		return {
			invocationMessage: new MarkdownString(l10n.t`Building live agent hierarchy (${formatLabel})...`),
			pastTenseMessage: new MarkdownString(l10n.t`Built live agent hierarchy`),
		};
	}
}

ToolRegistry.registerTool(GetLiveHierarchyTool);
