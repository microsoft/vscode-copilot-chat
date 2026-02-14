/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { DeferredPromise } from '../../../util/vs/base/common/async';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IAgentBreakpointService } from './agentBreakpointService';
import { AgentBreakpointType, BreakpointResumeAction, IAgentBreakpoint, IAgentBreakpointHitContext, IToolCallBreakpointHitContext } from './agentBreakpointTypes';

export class AgentBreakpointServiceImpl extends Disposable implements IAgentBreakpointService {
	declare readonly _serviceBrand: undefined;

	private readonly _breakpoints: IAgentBreakpoint[] = [];
	private _isStepMode = false;

	// Token tracking per-session
	private _promptTokens = 0;
	private _completionTokens = 0;

	// ── Events ──────────────────────────────────────────────────────────

	private readonly _onDidChangeBreakpoints = this._register(new Emitter<void>());
	readonly onDidChangeBreakpoints = this._onDidChangeBreakpoints.event;

	private readonly _onDidHitBreakpoint = this._register(new Emitter<IAgentBreakpointHitContext>());
	readonly onDidHitBreakpoint = this._onDidHitBreakpoint.event;

	private readonly _onDidResumeFromBreakpoint = this._register(new Emitter<BreakpointResumeAction>());
	readonly onDidResumeFromBreakpoint = this._onDidResumeFromBreakpoint.event;

	private readonly _onDidHitToolCallBreakpoint = this._register(new Emitter<IToolCallBreakpointHitContext>());
	readonly onDidHitToolCallBreakpoint = this._onDidHitToolCallBreakpoint.event;

	// Pending tool-call-level breakpoint resume
	private _pendingToolCallResume: DeferredPromise<BreakpointResumeAction> | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	// ── Breakpoint Management ───────────────────────────────────────────

	get breakpoints(): readonly IAgentBreakpoint[] {
		return this._breakpoints;
	}

	addBreakpoint(type: AgentBreakpointType, options?: {
		toolName?: string;
		iteration?: number;
		tokenThreshold?: number;
		label?: string;
		enabled?: boolean;
	}): IAgentBreakpoint {
		const bp: IAgentBreakpoint = {
			id: generateUuid(),
			type,
			enabled: options?.enabled ?? true,
			toolName: options?.toolName,
			iteration: options?.iteration,
			tokenThreshold: options?.tokenThreshold,
			label: options?.label ?? this._generateLabel(type, options),
		};
		this._breakpoints.push(bp);
		this._logService.info(`[AgentBreakpoints] Added breakpoint: ${bp.label} (${bp.id})`);
		this._onDidChangeBreakpoints.fire();
		return bp;
	}

	removeBreakpoint(id: string): boolean {
		const index = this._breakpoints.findIndex(bp => bp.id === id);
		if (index === -1) {
			return false;
		}
		const removed = this._breakpoints.splice(index, 1)[0];
		this._logService.info(`[AgentBreakpoints] Removed breakpoint: ${removed.label} (${removed.id})`);
		this._onDidChangeBreakpoints.fire();
		return true;
	}

	removeAllBreakpoints(): void {
		const hadContent = this._breakpoints.length > 0 || this._isStepMode;
		this._breakpoints.length = 0;
		this._isStepMode = false;
		if (!hadContent) {
			return;
		}
		this._logService.info('[AgentBreakpoints] All breakpoints removed');
		this._onDidChangeBreakpoints.fire();
	}

	setBreakpointEnabled(id: string, enabled: boolean): void {
		const bp = this._breakpoints.find(b => b.id === id);
		if (bp) {
			(bp as { enabled: boolean }).enabled = enabled;
			this._logService.info(`[AgentBreakpoints] Breakpoint ${bp.label} ${enabled ? 'enabled' : 'disabled'}`);
			this._onDidChangeBreakpoints.fire();
		}
	}

	// ── Step Mode ───────────────────────────────────────────────────────

	get isStepMode(): boolean {
		return this._isStepMode;
	}

	setStepMode(enabled: boolean): void {
		if (this._isStepMode !== enabled) {
			this._isStepMode = enabled;
			this._logService.info(`[AgentBreakpoints] Step mode ${enabled ? 'enabled' : 'disabled'}`);
			this._onDidChangeBreakpoints.fire();
		}
	}

	// ── Breakpoint Hit / Resume (used by checkpoint) ────────────────────

	/**
	 * Notify that a breakpoint was hit. Called by the checkpoint logic.
	 */
	fireBreakpointHit(context: IAgentBreakpointHitContext): void {
		this._logService.info(`[AgentBreakpoints] Breakpoint hit: ${context.breakpoint.label} at iteration ${context.iteration}`);
		this._onDidHitBreakpoint.fire(context);
	}

	/**
	 * Notify that the agent resumed. Called by the checkpoint logic.
	 */
	fireResumed(action: BreakpointResumeAction): void {
		this._logService.info(`[AgentBreakpoints] Resumed with action: ${action}`);
		this._onDidResumeFromBreakpoint.fire(action);
	}

	// ── Per-Tool-Call Breakpoints ────────────────────────────────────────

	/** Well-known tool names that represent subagent invocations. */
	private static readonly _subagentToolNames = new Set(['runSubagent', 'search_subagent', 'debug_subagent']);

	private _isSubagentTool(toolName: string): boolean {
		return AgentBreakpointServiceImpl._subagentToolNames.has(toolName);
	}

	hasToolCallBreakpoints(): boolean {
		// Check settings first
		if (this._configurationService.getConfig(ConfigKey.AgentBreakBeforeToolCall) ||
			this._configurationService.getConfig(ConfigKey.AgentBreakAfterToolCall) ||
			this._configurationService.getConfig(ConfigKey.AgentBreakBeforeSubagent) ||
			this._configurationService.getConfig(ConfigKey.AgentBreakAfterSubagent)) {
			return true;
		}
		// Also check programmatic breakpoints
		return this._breakpoints.some(bp =>
			bp.enabled && (bp.type === AgentBreakpointType.BeforeToolCall || bp.type === AgentBreakpointType.AfterToolCall)
		);
	}

	async evaluateToolCallBreakpoint(
		timing: 'before' | 'after',
		toolName: string,
		toolCallId: string,
		toolArguments: string,
		sessionId: string,
		toolResult?: unknown,
		hadError?: boolean,
		durationMs?: number,
		resultSizeBytes?: number,
	): Promise<BreakpointResumeAction> {
		const targetType = timing === 'before' ? AgentBreakpointType.BeforeToolCall : AgentBreakpointType.AfterToolCall;
		const isSubagent = this._isSubagentTool(toolName);

		// Check settings-based breakpoints — subagent tools use subagent settings,
		// non-subagent tools use tool-call settings
		let settingEnabled: boolean;
		if (isSubagent) {
			settingEnabled = timing === 'before'
				? this._configurationService.getConfig(ConfigKey.AgentBreakBeforeSubagent)
				: this._configurationService.getConfig(ConfigKey.AgentBreakAfterSubagent);
		} else {
			settingEnabled = timing === 'before'
				? this._configurationService.getConfig(ConfigKey.AgentBreakBeforeToolCall)
				: this._configurationService.getConfig(ConfigKey.AgentBreakAfterToolCall);
		}
		const matchedBp = settingEnabled
			? { id: `__setting_${isSubagent ? 'subagent_' : ''}${timing}__`, type: targetType, enabled: true, label: `Break ${timing} ${isSubagent ? 'subagent' : 'tool'} call (setting)` } satisfies IAgentBreakpoint
			: this._breakpoints.find(bp => bp.enabled && bp.type === targetType);
		if (!matchedBp) {
			return BreakpointResumeAction.Continue;
		}

		const hitContext: IToolCallBreakpointHitContext = {
			breakpoint: matchedBp,
			timing,
			toolName,
			toolCallId,
			toolArguments,
			toolResult,
			hadError,
			sessionId,
			durationMs,
			resultSizeBytes,
		};

		this._logService.info(`[AgentBreakpoints] Tool call breakpoint hit: ${timing} ${toolName} (${toolCallId})`);
		this._onDidHitToolCallBreakpoint.fire(hitContext);

		// Pause and wait for user to resume
		this._pendingToolCallResume = new DeferredPromise<BreakpointResumeAction>();

		let action: BreakpointResumeAction;
		try {
			action = await this._pendingToolCallResume.p;
		} finally {
			this._pendingToolCallResume = undefined;
		}

		this._logService.info(`[AgentBreakpoints] Tool call breakpoint resumed: ${action}`);
		this._onDidResumeFromBreakpoint.fire(action);

		if (action === BreakpointResumeAction.Abort) {
			throw new CancellationError();
		}

		return action;
	}

	/**
	 * Resume from a per-tool-call breakpoint. Used by the continue/step/abort commands.
	 */
	resumeToolCallBreakpoint(action: BreakpointResumeAction): void {
		if (this._pendingToolCallResume && !this._pendingToolCallResume.isSettled) {
			this._pendingToolCallResume.complete(action);
		}
	}

	// ── Token Tracking ──────────────────────────────────────────────────

	recordTokenUsage(promptTokens: number, completionTokens: number): void {
		this._promptTokens += promptTokens;
		this._completionTokens += completionTokens;
	}

	getTokenUsage(): { promptTokens: number; completionTokens: number } {
		return {
			promptTokens: this._promptTokens,
			completionTokens: this._completionTokens,
		};
	}

	resetSession(): void {
		this._promptTokens = 0;
		this._completionTokens = 0;
		this._isStepMode = false;
		this._logService.trace('[AgentBreakpoints] Session reset');
	}

	// ── Private ─────────────────────────────────────────────────────────

	private _generateLabel(type: AgentBreakpointType, options?: {
		toolName?: string;
		iteration?: number;
		tokenThreshold?: number;
		label?: string;
	}): string {
		switch (type) {
			case AgentBreakpointType.Tool:
				return `Break on tool: ${options?.toolName ?? 'unknown'}`;
			case AgentBreakpointType.Error:
				return 'Break on tool error';
			case AgentBreakpointType.Iteration:
				return `Break at iteration ${options?.iteration ?? '?'}`;
			case AgentBreakpointType.TokenThreshold:
				return `Break when tokens > ${options?.tokenThreshold ?? '?'}`;
			case AgentBreakpointType.Step:
				return 'Step (break every iteration)';
			case AgentBreakpointType.BeforeToolCall:
				return 'Break before every tool call';
			case AgentBreakpointType.AfterToolCall:
				return 'Break after every tool call';
		}
	}
}
