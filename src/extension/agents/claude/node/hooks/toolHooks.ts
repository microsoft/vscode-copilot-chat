/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	HookCallback,
	HookCallbackMatcher,
	HookInput,
	HookJSONOutput,
	PostToolUseFailureHookInput,
	PostToolUseHookInput,
	PreToolUseHookInput
} from '@anthropic-ai/claude-agent-sdk';
import { ILogService } from '../../../../../platform/log/common/logService';
import { ClaudeToolNames } from '../../common/claudeTools';
import { IClaudeSessionStateService } from '../claudeSessionStateService';
import { registerClaudeHook } from './claudeHookRegistry';

/**
 * Logging hook for PreToolUse events.
 */
export class PreToolUseLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput, toolID: string | undefined): Promise<HookJSONOutput> {
		const hookInput = input as PreToolUseHookInput;
		// Should we log tool input here? It can be large and contain sensitive info.
		this.logService.trace(`[ClaudeCodeSession] PreToolUse Hook: tool=${hookInput.tool_name}, toolUseID=${toolID}`);
		return { continue: true };
	}
}
registerClaudeHook('PreToolUse', PreToolUseLoggingHook);

/**
 * Logging hook for PostToolUse events.
 */
export class PostToolUseLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput, toolID: string | undefined): Promise<HookJSONOutput> {
		const hookInput = input as PostToolUseHookInput;
		// Should we log tool output here? It can be large and contain sensitive info.
		this.logService.trace(`[ClaudeCodeSession] PostToolUse Hook: tool=${hookInput.tool_name}, toolUseID=${toolID}`);
		return { continue: true };
	}
}
registerClaudeHook('PostToolUse', PostToolUseLoggingHook);

/**
 * Logging hook for PostToolUseFailure events.
 */
export class PostToolUseFailureLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput): Promise<HookJSONOutput> {
		const hookInput = input as PostToolUseFailureHookInput;
		this.logService.trace(`[ClaudeCodeSession] PostToolUseFailure Hook: tool=${hookInput.tool_name}, error=${hookInput.error}, isInterrupt=${hookInput.is_interrupt}`);
		return { continue: true };
	}
}
registerClaudeHook('PostToolUseFailure', PostToolUseFailureLoggingHook);

/**
 * Hook to update permission mode when EnterPlanMode/ExitPlanMode tools are invoked.
 * This keeps the UI in sync with the SDK's internal permission mode state.
 */
export class PlanModeHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput): Promise<HookJSONOutput> {
		const hookInput = input as PostToolUseHookInput;

		if (hookInput.tool_name === ClaudeToolNames.EnterPlanMode) {
			this.logService.trace(`[PlanModeHook] EnterPlanMode detected, setting permission mode to 'plan'`);
			this.sessionStateService.setPermissionModeForSession(hookInput.session_id, 'plan');
		} else if (hookInput.tool_name === ClaudeToolNames.ExitPlanMode) {
			this.logService.trace(`[PlanModeHook] ExitPlanMode detected, setting permission mode to 'acceptEdits'`);
			this.sessionStateService.setPermissionModeForSession(hookInput.session_id, 'acceptEdits');
		}

		return { continue: true };
	}
}
registerClaudeHook('PostToolUse', PlanModeHook);
