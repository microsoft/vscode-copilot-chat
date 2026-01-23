/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	HookCallback,
	HookCallbackMatcher,
	HookInput,
	HookJSONOutput,
	NotificationHookInput,
	PermissionRequestHookInput,
	PreCompactHookInput,
	StopHookInput,
	UserPromptSubmitHookInput
} from '@anthropic-ai/claude-agent-sdk';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CapturingToken } from '../../../../../platform/requestLogger/common/capturingToken';
import { IClaudeSessionStateService } from '../claudeSessionStateService';
import { registerClaudeHook } from './claudeHookRegistry';

/**
 * Logging hook for Notification events.
 */
export class NotificationLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput): Promise<HookJSONOutput> {
		const hookInput = input as NotificationHookInput;
		this.logService.trace(`[ClaudeCodeSession] Notification Hook: title=${hookInput.title}, message=${hookInput.message}`);
		return { continue: true };
	}
}
registerClaudeHook('Notification', NotificationLoggingHook);

/**
 * Logging hook for UserPromptSubmit events.
 * Also sets up the capturing token for request logging grouping.
 */
export class UserPromptSubmitLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput): Promise<HookJSONOutput> {
		const hookInput = input as UserPromptSubmitHookInput;
		this.logService.trace(`[ClaudeCodeSession] UserPromptSubmit Hook: prompt=${hookInput.prompt}`);

		// Create a capturing token for this request to group tool calls under the request
		const capturingToken = new CapturingToken(hookInput.prompt, 'sparkle', false);
		this.sessionStateService.setCapturingTokenForSession(hookInput.session_id, capturingToken);
		return { continue: true };
	}
}
registerClaudeHook('UserPromptSubmit', UserPromptSubmitLoggingHook);

/**
 * Logging hook for Stop events.
 */
export class StopLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput): Promise<HookJSONOutput> {
		const hookInput = input as StopHookInput;
		this.logService.trace(`[ClaudeCodeSession] Stop Hook: stopHookActive=${hookInput.stop_hook_active}`);
		return { continue: true };
	}
}
registerClaudeHook('Stop', StopLoggingHook);

/**
 * Logging hook for PreCompact events.
 */
export class PreCompactLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput): Promise<HookJSONOutput> {
		const hookInput = input as PreCompactHookInput;
		this.logService.trace(`[ClaudeCodeSession] PreCompact Hook: trigger=${hookInput.trigger}, customInstructions=${hookInput.custom_instructions}`);
		return { continue: true };
	}
}
registerClaudeHook('PreCompact', PreCompactLoggingHook);

/**
 * Logging hook for PermissionRequest events.
 */
export class PermissionRequestLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput): Promise<HookJSONOutput> {
		const hookInput = input as PermissionRequestHookInput;
		this.logService.trace(`[ClaudeCodeSession] PermissionRequest Hook: tool=${hookInput.tool_name}, input=${JSON.stringify(hookInput.tool_input)}`);
		return { continue: true };
	}
}
registerClaudeHook('PermissionRequest', PermissionRequestLoggingHook);
