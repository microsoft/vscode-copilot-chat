/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatHookService, IPostToolUseHookResult, IPreToolUseHookResult } from '../../../platform/chat/common/chatHookService';
import { ISessionTranscriptService } from '../../../platform/chat/common/sessionTranscriptService';
import { ILogService } from '../../../platform/log/common/logService';
import { raceTimeout } from '../../../util/vs/base/common/async';

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
	) { }

	async executeHook(hookType: vscode.ChatHookType, options: vscode.ChatHookExecutionOptions, sessionId?: string, token?: vscode.CancellationToken): Promise<vscode.ChatHookResult[]> {
		// Check if the proposed API is available
		if (typeof vscode.chat?.executeHook !== 'function') {
			return [];
		}

		try {
			if (sessionId) {
				await raceTimeout(this._sessionTranscriptService.flush(sessionId), 500);

				const transcriptUri = this._sessionTranscriptService.getTranscriptPath(sessionId);
				if (transcriptUri && typeof options.input === 'object' && options.input !== null) {
					(options.input as Record<string, unknown>).transcriptPath = transcriptUri;
				}
			}

			return await vscode.chat.executeHook(hookType, options, token) ?? [];
		} catch (e) {
			this._logService.error(`[ChatHookService] Error executing ${hookType} hook`, e);
			return [];
		}
	}

	async executePreToolUseHook(toolName: string, toolInput: unknown, toolCallId: string, toolInvocationToken: vscode.ChatParticipantToolToken | undefined, sessionId?: string, token?: vscode.CancellationToken): Promise<IPreToolUseHookResult | undefined> {
		const hookInput = {
			tool_name: toolName,
			tool_input: toolInput,
			tool_use_id: toolCallId,
		};
		const results = await this.executeHook(
			'PreToolUse',
			{ input: hookInput, toolInvocationToken: toolInvocationToken! },
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

	async executePostToolUseHook(toolName: string, toolInput: unknown, toolResponseText: string, toolCallId: string, toolInvocationToken: vscode.ChatParticipantToolToken | undefined, sessionId?: string, token?: vscode.CancellationToken): Promise<IPostToolUseHookResult | undefined> {
		const hookInput = {
			tool_name: toolName,
			tool_input: toolInput,
			tool_response: toolResponseText,
			tool_use_id: toolCallId,
		};
		const results = await this.executeHook(
			'PostToolUse',
			{ input: hookInput, toolInvocationToken: toolInvocationToken! },
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
