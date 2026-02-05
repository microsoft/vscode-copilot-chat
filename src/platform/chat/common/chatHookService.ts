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
	 * @param hookType The type of hook to execute.
	 * @param options Hook execution options including the input data.
	 * @param token Optional cancellation token.
	 * @returns A promise that resolves to an array of hook execution results.
	 */
	executeHook(hookType: vscode.ChatHookType, options: vscode.ChatHookExecutionOptions, token?: vscode.CancellationToken): Promise<vscode.ChatHookResult[]>;
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

//#endregion
