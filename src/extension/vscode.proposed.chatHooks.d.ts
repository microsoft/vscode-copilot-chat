/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 1

declare module 'vscode' {

	/**
	 * The type of hook to execute.
	 */
	export type ChatHookType = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'SubagentStart' | 'SubagentStop' | 'Stop';

	/**
	 * Options for executing a hook command.
	 */
	export interface ChatHookExecutionOptions {
		/**
		 * Input data to pass to the hook via stdin (will be JSON-serialized).
		 */
		readonly input?: unknown;
		/**
		 * The tool invocation token from the chat request context,
		 * used to associate the hook execution with the current chat session.
		 */
		readonly toolInvocationToken: ChatParticipantToolToken;
	}

	/**
	 * The kind of result from a hook execution.
	 */
	export enum ChatHookResultKind {
		/**
		 * Hook executed successfully (exit code 0).
		 */
		Success = 1,
		/**
		 * Hook returned an error (any non-zero exit code).
		 */
		Error = 2
	}

	/**
	 * Result of executing a hook command.
	 */
	export interface ChatHookResult {
		/**
		 * The kind of result.
		 */
		readonly kind: ChatHookResultKind;
		/**
		 * The result from the hook. For success, this is stdout parsed as JSON.
		 * For errors, this is stderr.
		 */
		readonly result: string | object;
	}

	export namespace chat {
		/**
		 * Execute all hooks of the specified type for the current chat session.
		 * Hooks are configured in hooks.json files in the workspace.
		 *
		 * @param hookType The type of hook to execute.
		 * @param options Hook execution options including the input data.
		 * @param token Optional cancellation token.
		 * @returns A promise that resolves to an array of hook execution results.
		 */
		export function executeHook(hookType: ChatHookType, options: ChatHookExecutionOptions, token?: CancellationToken): Thenable<ChatHookResult[]>;
	}
}
