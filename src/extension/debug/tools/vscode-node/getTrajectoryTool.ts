/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ITrajectoryLogger } from '../../../../platform/trajectory/common/trajectoryLogger';
import { IObservationResult } from '../../../../platform/trajectory/common/trajectoryTypes';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import { IDebugContextService } from '../../common/debugContextService';

interface IGetTrajectoryParams {
	/** The session ID of the trajectory to retrieve */
	sessionId: string;
	/** Whether to include full tool call results (may be large) */
	includeFullResults?: boolean;
}

/**
 * Tool to get details of a specific trajectory by session ID
 */
class GetTrajectoryTool implements ICopilotTool<IGetTrajectoryParams> {
	public static readonly toolName = ToolName.DebugGetTrajectory;

	constructor(
		@ITrajectoryLogger private readonly trajectoryLogger: ITrajectoryLogger,
		@IDebugContextService private readonly debugContext: IDebugContextService,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetTrajectoryParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { sessionId, includeFullResults } = options.input;

		// Try to find trajectory in loaded context first, then live
		let trajectory = this.debugContext.getTrajectory(sessionId);
		if (!trajectory) {
			trajectory = this.trajectoryLogger.getAllTrajectories().get(sessionId);
		}

		if (!trajectory) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`Trajectory not found with session ID: ${sessionId}\n\nUse debug_getTrajectories to list available trajectories.`)
			]);
		}

		const lines: string[] = [];
		lines.push(`## Trajectory: ${trajectory.agent.name}\n`);
		lines.push(`**Session ID:** \`${trajectory.session_id}\``);
		lines.push(`**Model:** ${trajectory.agent.model_name || 'Not specified'}`);
		lines.push(`**Steps:** ${trajectory.steps.length}`);
		lines.push(`**Schema:** ${trajectory.schema_version}\n`);

		// Final metrics if available
		if (trajectory.final_metrics) {
			lines.push('### Metrics');
			const m = trajectory.final_metrics;
			if (m.total_prompt_tokens) {
				lines.push(`- Prompt tokens: ${m.total_prompt_tokens}`);
			}
			if (m.total_completion_tokens) {
				lines.push(`- Completion tokens: ${m.total_completion_tokens}`);
			}
			if (m.total_tool_calls) {
				lines.push(`- Total tool calls: ${m.total_tool_calls}`);
			}
			if (m.total_cost_usd) {
				lines.push(`- Cost: $${m.total_cost_usd.toFixed(4)}`);
			}
			lines.push('');
		}

		// Steps
		lines.push('### Steps\n');
		for (const step of trajectory.steps) {
			const icon = step.source === 'user' ? '👤' : step.source === 'agent' ? '🤖' : '⚙️';
			lines.push(`#### ${icon} Step ${step.step_id} (${step.source})`);

			if (step.timestamp) {
				lines.push(`*${new Date(step.timestamp).toLocaleTimeString()}*`);
			}

			// Message preview
			const msgPreview = step.message.length > 200 ? step.message.substring(0, 200) + '...' : step.message;
			lines.push(`\n${msgPreview}\n`);

			// Reasoning content
			if (step.reasoning_content) {
				lines.push('<details><summary>Reasoning/Thinking</summary>\n');
				const reasoningPreview = step.reasoning_content.length > 500
					? step.reasoning_content.substring(0, 500) + '...'
					: step.reasoning_content;
				lines.push('```');
				lines.push(reasoningPreview);
				lines.push('```\n</details>\n');
			}

			// Tool calls
			if (step.tool_calls && step.tool_calls.length > 0) {
				lines.push(`**Tool Calls (${step.tool_calls.length}):**`);
				for (const tc of step.tool_calls) {
					const argsPreview = JSON.stringify(tc.arguments).substring(0, 100);
					lines.push(`- \`${tc.function_name}\` (${tc.tool_call_id.substring(0, 8)}...)`);
					lines.push(`  Args: ${argsPreview}${JSON.stringify(tc.arguments).length > 100 ? '...' : ''}`);

					// Find result
					const result = step.observation?.results?.find((r: IObservationResult) => r.source_call_id === tc.tool_call_id);
					if (result?.content) {
						const resultPreview = includeFullResults
							? result.content
							: result.content.substring(0, 200) + (result.content.length > 200 ? '...' : '');
						lines.push(`  Result: ${resultPreview}`);
					}

					// Check for subagent ref
					if (result?.subagent_trajectory_ref) {
						for (const ref of result.subagent_trajectory_ref) {
							lines.push(`  **Sub-agent:** ${ref.session_id}`);
						}
					}
				}
				lines.push('');
			}

			// Step metrics
			if (step.metrics) {
				lines.push(`*Metrics: ${step.metrics.prompt_tokens || 0} prompt, ${step.metrics.completion_tokens || 0} completion, ${step.metrics.duration_ms || 0}ms*\n`);
			}

			lines.push('---\n');
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(lines.join('\n'))]);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IGetTrajectoryParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const shortId = options.input.sessionId.length > 20
			? options.input.sessionId.substring(0, 17) + '...'
			: options.input.sessionId;
		return {
			invocationMessage: new MarkdownString(l10n.t`Getting trajectory ${shortId}...`),
			pastTenseMessage: new MarkdownString(l10n.t`Retrieved trajectory ${shortId}`),
		};
	}
}

ToolRegistry.registerTool(GetTrajectoryTool);
