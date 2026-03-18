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
import { CopilotChatAttr, GenAiAttr, GenAiOperationName, IOTelService, ISpanHandle, SpanKind, SpanStatusCode, truncateForOTel } from '../../../../../platform/otel/common/index';
import { IRequestLogger } from '../../../../../platform/requestLogger/node/requestLogger';
import { LanguageModelTextPart } from '../../../../../vscodeTypes';
import { registerClaudeHook } from '../../common/claudeHookRegistry';
import { ClaudeToolNames } from '../../common/claudeTools';
import { IClaudeSessionStateService } from '../claudeSessionStateService';

/**
 * Shared map of active OTel tool spans keyed by tool_use_id.
 * Used to correlate PreToolUse and PostToolUse/PostToolUseFailure hooks.
 * Bounded to prevent unbounded growth if post hooks are missed.
 */
const MAX_ACTIVE_TOOL_SPANS = 500;
const activeToolSpans = new Map<string, ISpanHandle>();

/**
 * Logging and OTel hook for PreToolUse events.
 * Creates an execute_tool span when a tool call starts.
 */
export class PreToolUseLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService,
		@IOTelService private readonly otelService: IOTelService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput, toolID: string | undefined): Promise<HookJSONOutput> {
		const hookInput = input as PreToolUseHookInput;
		this.logService.trace(`[ClaudeCodeSession] PreToolUse Hook: tool=${hookInput.tool_name}, toolUseID=${toolID}`);

		const spanKey = toolID ?? hookInput.tool_use_id;
		const toolSpan = this.otelService.startSpan(`execute_tool ${hookInput.tool_name}`, {
			kind: SpanKind.INTERNAL,
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
				[GenAiAttr.TOOL_NAME]: hookInput.tool_name,
				[GenAiAttr.TOOL_CALL_ID]: spanKey,
				[CopilotChatAttr.CHAT_SESSION_ID]: hookInput.session_id,
			},
		});
		if (hookInput.tool_input !== undefined) {
			try {
				toolSpan.setAttribute(GenAiAttr.TOOL_CALL_ARGUMENTS, truncateForOTel(
					typeof hookInput.tool_input === 'string' ? hookInput.tool_input : JSON.stringify(hookInput.tool_input)
				));
			} catch { /* swallow */ }
		}
		activeToolSpans.set(spanKey, toolSpan);

		// Evict oldest entries if the map grows too large (safety net for missed post hooks)
		if (activeToolSpans.size > MAX_ACTIVE_TOOL_SPANS) {
			const oldest = activeToolSpans.keys().next().value;
			if (oldest) {
				const staleSpan = activeToolSpans.get(oldest);
				staleSpan?.end();
				activeToolSpans.delete(oldest);
			}
		}

		return { continue: true };
	}
}
registerClaudeHook('PreToolUse', PreToolUseLoggingHook);

/**
 * Logging and OTel hook for PostToolUse events.
 * Logs tool calls to the request logger and ends the OTel execute_tool span.
 */
export class PostToolUseLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput, toolID: string | undefined): Promise<HookJSONOutput> {
		const hookInput = input as PostToolUseHookInput;
		const id = toolID ?? hookInput.session_id;
		const response = hookInput.tool_response;

		this.logService.trace(`[ClaudeCodeSession] PostToolUse Hook: tool=${hookInput.tool_name}, toolUseID=${toolID}`);

		// End the OTel span for this tool execution
		const spanKey = toolID ?? hookInput.tool_use_id;
		const toolSpan = activeToolSpans.get(spanKey);
		if (toolSpan) {
			toolSpan.setStatus(SpanStatusCode.OK);
			if (response !== undefined) {
				try {
					const result = typeof response === 'string' ? response : JSON.stringify(response);
					toolSpan.setAttribute(GenAiAttr.TOOL_CALL_RESULT, truncateForOTel(result));
				} catch { /* swallow */ }
			}
			toolSpan.end();
			activeToolSpans.delete(spanKey);
		}

		// Log the tool call to the request logger with the tool response as text content
		const capturingToken = this.sessionStateService.getCapturingTokenForSession(hookInput.session_id);
		const logToolCall = () => {
			this.requestLogger.logToolCall(
				id,
				hookInput.tool_name,
				hookInput.tool_input,
				{
					content: [new LanguageModelTextPart(typeof response === 'string' ? response : JSON.stringify(response, undefined, 2))]
				}
			);
		};

		if (capturingToken) {
			await this.requestLogger.captureInvocation(capturingToken, async () => logToolCall());
		} else {
			logToolCall();
		}

		return { continue: true };
	}
}
registerClaudeHook('PostToolUse', PostToolUseLoggingHook);

/**
 * Logging and OTel hook for PostToolUseFailure events.
 * Logs failed tool calls and ends the OTel execute_tool span with error status.
 */
export class PostToolUseFailureLoggingHook implements HookCallbackMatcher {
	public readonly hooks: HookCallback[];

	constructor(
		@ILogService private readonly logService: ILogService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService
	) {
		this.hooks = [this._handle.bind(this)];
	}

	private async _handle(input: HookInput, toolID: string | undefined): Promise<HookJSONOutput> {
		const hookInput = input as PostToolUseFailureHookInput;
		const id = toolID ?? hookInput.session_id;

		this.logService.trace(`[ClaudeCodeSession] PostToolUseFailure Hook: tool=${hookInput.tool_name}, error=${hookInput.error}, isInterrupt=${hookInput.is_interrupt}`);

		// End the OTel span for this tool execution with error status
		const spanKey = toolID ?? hookInput.tool_use_id;
		const toolSpan = activeToolSpans.get(spanKey);
		if (toolSpan) {
			const errMsg = `${hookInput.error}${hookInput.is_interrupt ? ' (interrupted)' : ''}`;
			toolSpan.setStatus(SpanStatusCode.ERROR, errMsg);
			toolSpan.setAttribute(GenAiAttr.TOOL_CALL_RESULT, truncateForOTel(`ERROR: ${errMsg}`));
			toolSpan.end();
			activeToolSpans.delete(spanKey);
		}

		// Log the failed tool call to the request logger with the error as text content
		const capturingToken = this.sessionStateService.getCapturingTokenForSession(hookInput.session_id);
		const logToolCall = () => {
			this.requestLogger.logToolCall(
				id,
				hookInput.tool_name,
				hookInput.tool_input,
				{
					content: [new LanguageModelTextPart(`Error: ${hookInput.error}${hookInput.is_interrupt ? ' (interrupted)' : ''}`)]
				}
			);
		};

		if (capturingToken) {
			await this.requestLogger.captureInvocation(capturingToken, async () => logToolCall());
		} else {
			logToolCall();
		}

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
