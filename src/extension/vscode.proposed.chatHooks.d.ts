/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 1

declare module 'vscode' {

	/**
	 * The type of hook to execute.
	 */
	export type ChatHookType = 'sessionStart' | 'sessionEnd' | 'userPromptSubmitted' | 'preToolUse' | 'postToolUse' | 'errorOccurred';

	/**
	 * Options for executing a hook command.
	 */
	export interface ChatHookExecutionOptions {
		/**
		 * The type of hook to execute.
		 */
		readonly hookType: ChatHookType;
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
	 * Result of executing a hook command.
	 */
	export interface ChatHookResult {
		/**
		 * Exit code from the process.
		 */
		readonly exitCode: number;
		/**
		 * Standard output from the process.
		 */
		readonly stdout: string;
		/**
		 * Standard error from the process.
		 */
		readonly stderr: string;
	}

	export namespace chat {
		/**
		 * Execute all hooks of the specified type for the current chat session.
		 * Hooks are configured in hooks.json files in the workspace.
		 *
		 * @param options Hook execution options including the hook type and input data.
		 * @param token Optional cancellation token.
		 * @returns A promise that resolves to an array of hook execution results.
		 */
		export function executeHook(options: ChatHookExecutionOptions, token?: CancellationToken): Thenable<ChatHookResult[]>;
	}
}
