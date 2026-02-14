/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../platform/log/common/logService';
import { DeferredPromise } from '../../../util/vs/base/common/async';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IToolCallRound } from '../../prompt/common/intents';
import { IAgentBreakpointService } from './agentBreakpointService';
import { AgentBreakpointServiceImpl } from './agentBreakpointServiceImpl';
import { AgentBreakpointType, BreakpointResumeAction, IAgentBreakpoint, IAgentBreakpointHitContext } from './agentBreakpointTypes';

/**
 * The checkpoint is the bridge between the tool calling loop and the breakpoint
 * service. It evaluates breakpoint conditions and pauses the loop by awaiting
 * a {@link DeferredPromise} when a breakpoint is hit.
 *
 * Usage in the tool calling loop:
 * ```ts
 * // At the start of each iteration (between rounds):
 * const action = await checkpoint.evaluate(iteration, lastRound);
 * if (action === BreakpointResumeAction.Abort) { throw new CancellationError(); }
 * ```
 *
 * The checkpoint is designed to be created per tool-calling-loop invocation
 * and disposed when the loop ends.
 */
export class AgentBreakpointCheckpoint extends Disposable {
	private _pendingResume: DeferredPromise<BreakpointResumeAction> | undefined;
	private _loopStartTime: number;
	private _sessionId: string;
	private _forceStepNext = false;

	constructor(
		sessionId: string,
		private readonly _breakpointService: IAgentBreakpointService,
		private readonly _logService: ILogService,
	) {
		super();
		this._sessionId = sessionId;
		this._loopStartTime = Date.now();
	}

	/**
	 * Evaluate all breakpoint conditions at a given iteration.
	 * If a breakpoint matches, this method suspends (awaits a DeferredPromise)
	 * until the user chooses to continue, step, or abort.
	 *
	 * @param iteration The current 0-based iteration index.
	 * @param lastRound The most recent tool call round (undefined on first iteration).
	 * @param hadError Whether any tool call in the last round failed.
	 * @returns The user's chosen resume action, or {@link BreakpointResumeAction.Continue}
	 *          if no breakpoint matched.
	 */
	async evaluate(
		iteration: number,
		lastRound: IToolCallRound | undefined,
		hadError: boolean,
	): Promise<BreakpointResumeAction> {
		const service = this._breakpointService;
		if (!this._hasActiveBreakpoints(service)) {
			return BreakpointResumeAction.Continue;
		}

		const matchedBp = this._findMatchingBreakpoint(service, iteration, lastRound, hadError);
		if (!matchedBp) {
			return BreakpointResumeAction.Continue;
		}

		// Build the hit context
		const tokenUsage = service.getTokenUsage();
		const hitContext: IAgentBreakpointHitContext = {
			breakpoint: matchedBp,
			iteration,
			totalPromptTokens: tokenUsage.promptTokens,
			totalCompletionTokens: tokenUsage.completionTokens,
			lastRound,
			lastToolCalls: lastRound?.toolCalls,
			hadError,
			sessionId: this._sessionId,
			elapsedMs: Date.now() - this._loopStartTime,
		};

		// Notify listeners that a breakpoint was hit
		(service as AgentBreakpointServiceImpl).fireBreakpointHit(hitContext);

		// Create a deferred promise and wait for the user to resume
		this._pendingResume = new DeferredPromise<BreakpointResumeAction>();
		this._logService.info(
			`[AgentBreakpoints] Paused at iteration ${iteration} — breakpoint: ${matchedBp.label}`
		);

		let action: BreakpointResumeAction;
		try {
			action = await this._pendingResume.p;
		} finally {
			this._pendingResume = undefined;
		}

		// If the user chose "step", arm a one-shot step for the next iteration
		this._forceStepNext = action === BreakpointResumeAction.Step;

		// Notify listeners
		(service as AgentBreakpointServiceImpl).fireResumed(action);

		if (action === BreakpointResumeAction.Abort) {
			throw new CancellationError();
		}

		return action;
	}

	/**
	 * Resume the loop from an external trigger (e.g., a command or confirmation button).
	 * This resolves the pending DeferredPromise created in {@link evaluate}.
	 */
	resume(action: BreakpointResumeAction): void {
		if (this._pendingResume && !this._pendingResume.isSettled) {
			this._pendingResume.complete(action);
		} else {
			this._logService.warn('[AgentBreakpoints] resume() called but no pending checkpoint');
		}
	}

	/**
	 * Whether the checkpoint is currently paused (waiting for user input).
	 */
	get isPaused(): boolean {
		return this._pendingResume !== undefined && !this._pendingResume.isSettled;
	}

	/**
	 * Cancel any pending pause (e.g., when the session is being disposed).
	 */
	cancelPending(): void {
		if (this._pendingResume && !this._pendingResume.isSettled) {
			this._pendingResume.complete(BreakpointResumeAction.Continue);
		}
	}

	override dispose(): void {
		this.cancelPending();
		super.dispose();
	}

	// ── Private ─────────────────────────────────────────────────────────

	private _hasActiveBreakpoints(service: IAgentBreakpointService): boolean {
		if (this._forceStepNext) {
			return true;
		}
		if (service.isStepMode) {
			return true;
		}
		return service.breakpoints.some(bp => bp.enabled);
	}

	private _findMatchingBreakpoint(
		service: IAgentBreakpointService,
		iteration: number,
		lastRound: IToolCallRound | undefined,
		hadError: boolean,
	): IAgentBreakpoint | undefined {
		// Step mode (or one-shot step from previous "Step" action)
		if (this._forceStepNext || service.isStepMode) {
			this._forceStepNext = false;
			return {
				id: '__step__',
				type: AgentBreakpointType.Step,
				enabled: true,
				label: `Step — iteration ${iteration}`,
			};
		}

		const tokenUsage = service.getTokenUsage();
		const totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens;
		const lastToolCalls = lastRound?.toolCalls ?? [];

		for (const bp of service.breakpoints) {
			if (!bp.enabled) {
				continue;
			}

			switch (bp.type) {
				case AgentBreakpointType.Tool:
					if (bp.toolName && lastToolCalls.some(tc => tc.name === bp.toolName)) {
						return bp;
					}
					break;

				case AgentBreakpointType.Error:
					if (hadError) {
						return bp;
					}
					break;

				case AgentBreakpointType.Iteration:
					if (bp.iteration !== undefined && iteration >= bp.iteration) {
						return bp;
					}
					break;

				case AgentBreakpointType.TokenThreshold:
					if (bp.tokenThreshold !== undefined && totalTokens >= bp.tokenThreshold) {
						return bp;
					}
					break;

				case AgentBreakpointType.Step:
					return bp;
			}
		}

		return undefined;
	}
}
