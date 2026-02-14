/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAgentBreakpointService } from '../common/agentBreakpointService';
import { AgentBreakpointServiceImpl } from '../common/agentBreakpointServiceImpl';
import { BreakpointResumeAction } from '../common/agentBreakpointTypes';

/**
 * Contribution that registers resume commands for agent breakpoints.
 * Breakpoints are configured via VS Code settings (not commands):
 * - `github.copilot.chat.agent.breakBeforeToolCall`
 * - `github.copilot.chat.agent.breakAfterToolCall`
 * - `github.copilot.chat.agent.breakBeforeSubagent`
 * - `github.copilot.chat.agent.breakAfterSubagent`
 *
 * Resume commands are used by inline chat buttons to continue/skip/abort.
 */
export class AgentBreakpointsContribution extends Disposable {
	constructor(
		@IAgentBreakpointService private readonly _breakpointService: IAgentBreakpointService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._registerCommands();
		this._registerEventListeners();
	}

	private _registerCommands(): void {
		// Resume commands — invoked by inline chat buttons
		this._register(vscode.commands.registerCommand(
			'github.copilot.agentBreakpoints.continue',
			() => this._resumeActiveCheckpoint(BreakpointResumeAction.Continue),
		));

		this._register(vscode.commands.registerCommand(
			'github.copilot.agentBreakpoints.step',
			() => this._resumeActiveCheckpoint(BreakpointResumeAction.Step),
		));

		this._register(vscode.commands.registerCommand(
			'github.copilot.agentBreakpoints.abort',
			() => this._resumeActiveCheckpoint(BreakpointResumeAction.Abort),
		));

		this._register(vscode.commands.registerCommand(
			'github.copilot.agentBreakpoints.skip',
			() => this._resumeActiveCheckpoint(BreakpointResumeAction.Skip),
		));
	}

	private _registerEventListeners(): void {
		// Iteration-level breakpoints
		this._register(this._breakpointService.onDidHitBreakpoint(ctx => {
			this._logService.info(
				`[AgentBreakpoints] Hit: ${ctx.breakpoint.label} | iter=${ctx.iteration} `
				+ `| tokens=${ctx.totalPromptTokens + ctx.totalCompletionTokens} `
				+ `| elapsed=${ctx.elapsedMs}ms`
			);
		}));

		// Per-tool-call breakpoints — info is shown inline in chat via stream.markdown()
		this._register(this._breakpointService.onDidHitToolCallBreakpoint(ctx => {
			const tokenUsage = this._breakpointService.getTokenUsage();
			const totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens;
			this._logService.info(
				`[AgentBreakpoints] Tool call breakpoint: ${ctx.timing} ${ctx.toolName}`
				+ ` | tokens=${totalTokens}`
				+ (ctx.durationMs !== undefined ? ` | duration=${ctx.durationMs}ms` : '')
				+ (ctx.resultSizeBytes !== undefined ? ` | resultSize=${ctx.resultSizeBytes}B` : '')
			);
		}));
	}

	/**
	 * Resume the currently active checkpoint. The checkpoint is stored on the
	 * service via the `activeCheckpoint` property set by the tool calling loop
	 * integration.
	 */
	private _resumeActiveCheckpoint(action: BreakpointResumeAction): void {
		// First try the iteration-level checkpoint (only if it's actually paused)
		const checkpoint = (this._breakpointService as IAgentBreakpointService & { activeCheckpoint?: { isPaused: boolean; resume(action: BreakpointResumeAction): void } }).activeCheckpoint;
		if (checkpoint?.isPaused) {
			checkpoint.resume(action);
			return;
		}

		// Then try tool-call-level breakpoint
		const impl = this._breakpointService as AgentBreakpointServiceImpl;
		if (typeof impl.resumeToolCallBreakpoint === 'function') {
			impl.resumeToolCallBreakpoint(action);
			return;
		}

		this._logService.warn('[AgentBreakpoints] No active checkpoint to resume');
	}
}
