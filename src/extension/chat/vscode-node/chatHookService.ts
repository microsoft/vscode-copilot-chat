/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IChatHookService, IPostToolUseHookResult, IPreToolUseHookResult } from '../../../platform/chat/common/chatHookService';
import { HookCommandResultKind, IHookCommandResult, IHookExecutor } from '../../../platform/chat/common/hookExecutor';
import { ISessionTranscriptService } from '../../../platform/chat/common/sessionTranscriptService';
import { ILogService } from '../../../platform/log/common/logService';
import { raceTimeout } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';

interface IPreToolUseHookSpecificOutput {
	hookEventName?: string;
	permissionDecision?: 'allow' | 'deny' | 'ask';
	permissionDecisionReason?: string;
	updatedInput?: object;
	additionalContext?: string;
}

const permissionPriority: Record<string, number> = { 'deny': 2, 'ask': 1, 'allow': 0 };

interface IPostToolUseHookSpecificOutput {
	hookEventName?: string;
	additionalContext?: string;
}

export class ChatHookService implements IChatHookService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISessionTranscriptService private readonly _sessionTranscriptService: ISessionTranscriptService,
		@ILogService private readonly _logService: ILogService,
		@IHookExecutor private readonly _hookExecutor: IHookExecutor,
	) { }

	async executeHook(hookType: vscode.ChatHookType, hooks: vscode.ChatRequestHooks | undefined, input: unknown, sessionId?: string, token?: vscode.CancellationToken): Promise<vscode.ChatHookResult[]> {
		if (!hooks) {
			return [];
		}

		const hookCommands = hooks[hookType];
		if (!hookCommands || hookCommands.length === 0) {
			return [];
		}

		try {
			// Flush transcript before running hooks so scripts see up-to-date content
			let transcriptPath: vscode.Uri | undefined;
			if (sessionId) {
				await raceTimeout(this._sessionTranscriptService.flush(sessionId), 500);
				transcriptPath = this._sessionTranscriptService.getTranscriptPath(sessionId);
			}

			// Build common input properties merged with caller-specific input
			const commonInput = {
				timestamp: new Date().toISOString(),
				hookEventName: hookType,
				...(sessionId ? { sessionId } : undefined),
				...(transcriptPath ? { transcript_path: transcriptPath } : undefined),
			};
			const fullInput = (typeof input === 'object' && input !== null)
				? { ...commonInput, ...input }
				: commonInput;

			const results: vscode.ChatHookResult[] = [];
			const effectiveToken = token ?? CancellationToken.None;

			this._logService.debug(`[ChatHookService] Executing ${hookCommands.length} hook(s) for type '${hookType}'`);

			for (const hookCommand of hookCommands) {
				try {
					// Include per-command cwd in the input
					const commandInput = hookCommand.cwd
						? { ...fullInput, cwd: hookCommand.cwd }
						: fullInput;
					const commandResult = await this._hookExecutor.executeCommand(hookCommand, commandInput, effectiveToken);
					const result = this._toHookResult(commandResult);
					results.push(result);

					// If stopReason is set (including empty string for "stop without message"), stop processing remaining hooks
					if (result.stopReason !== undefined) {
						this._logService.debug(`[ChatHookService] Stopping after hook: ${result.stopReason}`);
						break;
					}
				} catch (err) {
					const errMessage = err instanceof Error ? err.message : String(err);
					this._logService.error(`[ChatHookService] Error running hook command: ${errMessage}`);
					results.push({
						resultKind: 'warning',
						output: undefined,
						warningMessage: errMessage,
					});
				}
			}

			return results;
		} catch (e) {
			this._logService.error(`[ChatHookService] Error executing ${hookType} hook`, e);
			return [];
		}
	}

	private _toHookResult(commandResult: IHookCommandResult): vscode.ChatHookResult {
		switch (commandResult.kind) {
			case HookCommandResultKind.Error: {
				// Exit code 2 - blocking error, stop processing
				const message = typeof commandResult.result === 'string' ? commandResult.result : JSON.stringify(commandResult.result);
				return {
					resultKind: 'error',
					stopReason: message,
					output: undefined,
				};
			}
			case HookCommandResultKind.NonBlockingError: {
				// Non-blocking error - shown to user only as warning
				const errorMessage = typeof commandResult.result === 'string' ? commandResult.result : JSON.stringify(commandResult.result);
				return {
					resultKind: 'warning',
					output: undefined,
					warningMessage: errorMessage,
				};
			}
			case HookCommandResultKind.Success: {
				if (typeof commandResult.result !== 'object') {
					return {
						resultKind: 'success',
						output: commandResult.result,
					};
				}

				// Extract common fields (continue, stopReason, systemMessage)
				const resultObj = commandResult.result as Record<string, unknown>;
				const stopReason = typeof resultObj['stopReason'] === 'string' ? resultObj['stopReason'] : undefined;
				const continueFlag = resultObj['continue'];
				const systemMessage = typeof resultObj['systemMessage'] === 'string' ? resultObj['systemMessage'] : undefined;

				// Handle continue field: when false, stopReason is effective
				let effectiveStopReason = stopReason;
				if (continueFlag === false && !effectiveStopReason) {
					effectiveStopReason = '';
				}

				// Extract hook-specific output (everything except common fields)
				const commonFields = new Set(['continue', 'stopReason', 'systemMessage']);
				const hookOutput: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(resultObj)) {
					if (value !== undefined && !commonFields.has(key)) {
						hookOutput[key] = value;
					}
				}

				return {
					resultKind: 'success',
					stopReason: effectiveStopReason,
					warningMessage: systemMessage,
					output: Object.keys(hookOutput).length > 0 ? hookOutput : undefined,
				};
			}
			default:
				return {
					resultKind: 'warning',
					warningMessage: `Unexpected hook command result kind: ${(commandResult as IHookCommandResult).kind}`,
					output: undefined,
				};
		}
	}

	async executePreToolUseHook(toolName: string, toolInput: unknown, toolCallId: string, hooks: vscode.ChatRequestHooks | undefined, sessionId?: string, token?: vscode.CancellationToken): Promise<IPreToolUseHookResult | undefined> {
		const hookInput = {
			tool_name: toolName,
			tool_input: toolInput,
			tool_use_id: toolCallId,
		};
		const results = await this.executeHook(
			'PreToolUse',
			hooks,
			hookInput,
			sessionId,
			token
		);

		if (results.length === 0) {
			return undefined;
		}

		// Collapse results: deny > ask > allow (most restrictive wins),
		// collect all additionalContext, last updatedInput wins
		let mostRestrictiveDecision: 'allow' | 'deny' | 'ask' | undefined;
		let winningReason: string | undefined;
		let lastUpdatedInput: object | undefined;
		const allAdditionalContext: string[] = [];

		for (const result of results) {
			if (result.resultKind !== 'success' || typeof result.output !== 'object' || result.output === null) {
				continue;
			}

			const output = result.output as { hookSpecificOutput?: IPreToolUseHookSpecificOutput };
			const hookSpecificOutput = output.hookSpecificOutput;
			if (!hookSpecificOutput) {
				continue;
			}

			// Skip results from other hook event types
			if (hookSpecificOutput.hookEventName !== undefined && hookSpecificOutput.hookEventName !== 'PreToolUse') {
				continue;
			}

			if (hookSpecificOutput.additionalContext) {
				allAdditionalContext.push(hookSpecificOutput.additionalContext);
			}

			if (hookSpecificOutput.updatedInput) {
				lastUpdatedInput = hookSpecificOutput.updatedInput;
			}

			const decision = hookSpecificOutput.permissionDecision;
			if (decision && (mostRestrictiveDecision === undefined || (permissionPriority[decision] ?? 0) > (permissionPriority[mostRestrictiveDecision] ?? 0))) {
				mostRestrictiveDecision = decision;
				winningReason = hookSpecificOutput.permissionDecisionReason;
			}
		}

		if (!mostRestrictiveDecision && !lastUpdatedInput && allAdditionalContext.length === 0) {
			return undefined;
		}

		return {
			permissionDecision: mostRestrictiveDecision,
			permissionDecisionReason: winningReason,
			updatedInput: lastUpdatedInput,
			additionalContext: allAdditionalContext.length > 0 ? allAdditionalContext : undefined,
		};
	}

	async executePostToolUseHook(toolName: string, toolInput: unknown, toolResponseText: string, toolCallId: string, hooks: vscode.ChatRequestHooks | undefined, sessionId?: string, token?: vscode.CancellationToken): Promise<IPostToolUseHookResult | undefined> {
		const hookInput = {
			tool_name: toolName,
			tool_input: toolInput,
			tool_response: toolResponseText,
			tool_use_id: toolCallId,
		};
		const results = await this.executeHook(
			'PostToolUse',
			hooks,
			hookInput,
			sessionId,
			token
		);

		if (results.length === 0) {
			return undefined;
		}

		// Collapse results: first block wins, collect all additionalContext
		let hasBlock = false;
		let blockReason: string | undefined;
		const allAdditionalContext: string[] = [];

		for (const result of results) {
			if (result.resultKind !== 'success' || typeof result.output !== 'object' || result.output === null) {
				continue;
			}

			const output = result.output as {
				decision?: string;
				reason?: string;
				hookSpecificOutput?: IPostToolUseHookSpecificOutput;
			};

			// Skip results from other hook event types
			if (output.hookSpecificOutput?.hookEventName !== undefined && output.hookSpecificOutput.hookEventName !== 'PostToolUse') {
				continue;
			}

			// Collect additionalContext from hookSpecificOutput
			if (output.hookSpecificOutput?.additionalContext) {
				allAdditionalContext.push(output.hookSpecificOutput.additionalContext);
			}

			// Track the first block decision
			if (output.decision === 'block' && !hasBlock) {
				hasBlock = true;
				blockReason = output.reason;
			}
		}

		if (!hasBlock && allAdditionalContext.length === 0) {
			return undefined;
		}

		return {
			decision: hasBlock ? 'block' : undefined,
			reason: blockReason,
			additionalContext: allAdditionalContext.length > 0 ? allAdditionalContext : undefined,
		};
	}
}
