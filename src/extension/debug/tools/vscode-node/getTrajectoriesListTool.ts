/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ITrajectoryLogger } from '../../../../platform/trajectory/common/trajectoryLogger';
import { IAgentTrajectory, ITrajectoryStep } from '../../../../platform/trajectory/common/trajectoryTypes';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import { IDebugContextService } from '../../common/debugContextService';

interface IGetTrajectoriesParams {
	/** Optional: only return trajectories matching this agent name */
	agentName?: string;
}

/**
 * Tool to list all available trajectories (live session or loaded)
 */
class GetTrajectoriesList implements ICopilotTool<IGetTrajectoriesParams> {
	public static readonly toolName = ToolName.DebugGetTrajectories;

	constructor(
		@ITrajectoryLogger private readonly trajectoryLogger: ITrajectoryLogger,
		@IDebugContextService private readonly debugContext: IDebugContextService,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IGetTrajectoriesParams>,
		token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		// Merge live trajectories with loaded ones
		const allTrajectories = new Map(this.debugContext.getTrajectories());

		// Add live trajectories if available
		const liveTrajectories = this.trajectoryLogger.getAllTrajectories();
		for (const [id, traj] of liveTrajectories) {
			if (!allTrajectories.has(id)) {
				allTrajectories.set(id, traj);
			}
		}

		if (allTrajectories.size === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No trajectories available. Run an agent task to generate a live trajectory, or use debug_loadTrajectoryFile to load a trajectory file.')
			]);
		}

		// Filter by agent name if specified
		const filtered = options.input.agentName
			? [...allTrajectories.entries()].filter(([, t]: [string, IAgentTrajectory]) => t.agent.name.toLowerCase().includes(options.input.agentName!.toLowerCase()))
			: [...allTrajectories.entries()];

		// Format response
		const lines: string[] = [];
		lines.push(`## Available Trajectories (${filtered.length})\n`);
		lines.push('| Session ID | Agent | Steps | Tool Calls | Model |');
		lines.push('|------------|-------|-------|------------|-------|');

		for (const [sessionId, trajectory] of filtered as [string, IAgentTrajectory][]) {
			const toolCallCount = trajectory.steps.reduce((sum: number, s: ITrajectoryStep) => sum + (s.tool_calls?.length || 0), 0);
			const shortId = sessionId.length > 20 ? sessionId.substring(0, 17) + '...' : sessionId;
			lines.push(`| ${shortId} | ${trajectory.agent.name} | ${trajectory.steps.length} | ${toolCallCount} | ${trajectory.agent.model_name || '-'} |`);
		}

		lines.push('\n*Use `debug_getTrajectory` with a session ID to get full details.*');

		return new LanguageModelToolResult([new LanguageModelTextPart(lines.join('\n'))]);
	}

	prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<IGetTrajectoriesParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: new MarkdownString(l10n.t`Listing available trajectories...`),
			pastTenseMessage: new MarkdownString(l10n.t`Listed available trajectories`),
		};
	}
}

ToolRegistry.registerTool(GetTrajectoriesList);
