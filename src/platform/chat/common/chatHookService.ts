/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';

export const IChatHookService = createServiceIdentifier<IChatHookService>('IChatHookService');

export interface IChatHookService {
	readonly _serviceBrand: undefined;

	/**
	 * Execute all hooks of the specified type for the current chat session.
	 * Hooks are configured in hooks.json files in the workspace.
	 *
	 * If a `sessionId` is provided, the session transcript is flushed to disk
	 * before the hook runs so that hook scripts see up-to-date content.
	 *
	 * @param hookType The type of hook to execute.
	 * @param options Hook execution options including the input data.
	 * @param sessionId Optional session ID — when provided the transcript is flushed first.
	 * @param token Optional cancellation token.
	 * @returns A promise that resolves to an array of hook execution results.
	 */
	executeHook(hookType: vscode.ChatHookType, options: vscode.ChatHookExecutionOptions, sessionId?: string, token?: vscode.CancellationToken): Promise<vscode.ChatHookResult[]>;
}

//#region Hook Input/Output Types

/**
 * Input passed to the UserPromptSubmit hook.
 */
export interface UserPromptSubmitHookInput {
	/**
	 * The user's prompt text.
	 */
	readonly prompt: string;
}

/**
 * Output from the UserPromptSubmit hook.
 */
export interface UserPromptSubmitHookOutput {
	/**
	 * Set to "block" to prevent the user prompt from being submitted to the agent.
	 */
	readonly decision?: 'block';
	/**
	 * Tells the agent why it should continue.
	 */
	readonly reason?: string;
}

/**
 * Input passed to the Stop hook.
 */
export interface StopHookInput {
	/**
	 * True when the agent is already continuing as a result of a stop hook.
	 * Check this value or process the transcript to prevent the agent from running indefinitely.
	 */
	readonly stop_hook_active: boolean;
}

/**
 * Output from the Stop hook.
 */
export interface StopHookOutput {
	/**
	 * Set to "block" to prevent the agent from stopping.
	 * Omit or set to undefined to allow the agent to stop.
	 */
	readonly decision?: 'block';
	/**
	 * Required when decision is "block". Tells the agent why it should continue.
	 */
	readonly reason?: string;
}

/**
 * Input passed to the SessionStart hook.
 */
export interface SessionStartHookInput {
	/**
	 * The source of the session start. Always "new".
	 */
	readonly source: 'new';
}

/**
 * Output from the SessionStart hook.
 */
export interface SessionStartHookOutput {
	/**
	 * Additional context to add to the agent's context.
	 * Multiple hooks' values are concatenated.
	 */
	readonly additionalContext?: string;
}

/**
 * Input passed to the SubagentStart hook.
 */
export interface SubagentStartHookInput {
	/**
	 * The unique identifier for the subagent.
	 */
	readonly agent_id: string;
	/**
	 * The agent name (built-in agents like "Plan" or custom agent names).
	 */
	readonly agent_type: string;
}

/**
 * Output from the SubagentStart hook.
 */
export interface SubagentStartHookOutput {
	/**
	 * Additional context to add to the subagent's context.
	 */
	readonly additionalContext?: string;
}

/**
 * Input passed to the SubagentStop hook.
 */
export interface SubagentStopHookInput {
	/**
	 * The unique identifier for the subagent.
	 */
	readonly agent_id: string;
	/**
	 * The agent name (built-in agents like "Plan" or custom agent names).
	 */
	readonly agent_type: string;
	/**
	 * True when the agent is already continuing as a result of a stop hook.
	 * Check this value or process the transcript to prevent the agent from running indefinitely.
	 */
	readonly stop_hook_active: boolean;
}

/**
 * Output from the SubagentStop hook.
 */
export interface SubagentStopHookOutput {
	/**
	 * Set to "block" to prevent the agent from stopping.
	 * Omit or set to undefined to allow the agent to stop.
	 */
	readonly decision?: 'block';
	/**
	 * Required when decision is "block". Tells the agent why it should continue.
	 */
	readonly reason?: string;
}

/**
 * Input passed to the PreCompact hook.
 */
export interface PreCompactHookInput {
	/**
	 * How the compaction was triggered.
	 * "auto" when the conversation is too long for the prompt budget.
	 */
	readonly trigger: 'auto';
	/**
	 * Custom instructions for the compaction, if any.
	 */
	readonly custom_instructions?: string;
}

//#endregion
