/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	Message as APIAssistantMessage,
	Usage,
} from '@anthropic-ai/sdk/resources/index';

export type NonNullableUsage = {
	[K in keyof Usage]: NonNullable<Usage[K]>;
};

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary';

export type ConfigScope = 'local' | 'user' | 'project';

export interface McpStdioServerConfig {
	type?: 'stdio'; // Optional for backwards compatibility
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface McpSSEServerConfig {
	type: 'sse';
	url: string;
	headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
	type: 'http';
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig =
	| McpStdioServerConfig
	| McpSSEServerConfig
	| McpHttpServerConfig;

export interface Options {
	abortController?: AbortController;
	allowedTools?: string[];
	appendSystemPrompt?: string;
	customSystemPrompt?: string;
	cwd?: string;
	disallowedTools?: string[];
	maxThinkingTokens?: number;
	maxTurns?: number;
	mcpServers?: Record<string, McpServerConfig>;
	permissionMode?: PermissionMode;
	permissionPromptToolName?: string;
	continue?: boolean;
	resume?: string;
	model?: string;
	fallbackModel?: string;
}

export type PermissionMode =
	| 'default'
	| 'acceptEdits'
	| 'bypassPermissions'
	| 'plan';

export interface MessageContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface SDKUserMessage {
	type: 'user';
	message: MessageContent;
	parent_tool_use_id: string | null;
	session_id: string;
}

export interface SDKAssistantMessage {
	type: 'assistant';
	message: APIAssistantMessage;
	parent_tool_use_id: string | null;
	session_id: string;
}

export type SDKResultMessage =
	| {
		type: 'result';
		subtype: 'success';
		duration_ms: number;
		duration_api_ms: number;
		is_error: boolean;
		num_turns: number;
		result: string;
		session_id: string;
		total_cost_usd: number;
		usage: NonNullableUsage;
	}
	| {
		type: 'result';
		subtype: 'error_max_turns' | 'error_during_execution';
		duration_ms: number;
		duration_api_ms: number;
		is_error: boolean;
		num_turns: number;
		session_id: string;
		total_cost_usd: number;
		usage: NonNullableUsage;
	};

export interface SDKSystemMessage {
	type: 'system';
	subtype: 'init';
	apiKeySource: ApiKeySource;
	cwd: string;
	session_id: string;
	tools: string[];
	mcp_servers: {
		name: string;
		status: string;
	}[];
	model: string;
	permissionMode: PermissionMode;
}

export type SDKMessage =
	| SDKAssistantMessage
	| SDKUserMessage
	| SDKResultMessage
	| SDKSystemMessage;

export interface ClaudeCodeProps {
	prompt: string;
	abortController?: AbortController;
	options?: Options;
}

// /**
//  * Query Claude Code
//  *
//  * Behavior:
//  * - Yields a message at a time
//  * - Uses the tools and commands you give it
//  *
//  * Usage:
//  * ```ts
//  * const response = query({ prompt: "Help me write a function", options: {} })
//  * for await (const message of response) {
//  *   console.log(message)
//  * }
//  * ```
//  */
// export function query({
//   prompt,
//   abortController,
//   options,
// }: Props): AsyncGenerator<SDKMessage>

export class AbortError extends Error { }
