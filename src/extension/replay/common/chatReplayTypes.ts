/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Type for a log entry in a .chatreplay.json file.
 * These types correspond to LoggedInfoKind from the request logger.
 */
export type ExportedLogKind = 'element' | 'request' | 'toolCall' | 'error';

/**
 * Response structure for ChatMLSuccess entries.
 */
export interface ChatMLSuccessResponse {
	type: 'success';
	message: string | string[];
}

/**
 * Response structure for failed/cancelled entries.
 */
export interface ChatMLFailureResponse {
	type: 'failure' | 'cancelled';
	reason?: string;
}

/**
 * Union of possible response types in log entries.
 */
export type ExportedLogResponse = ChatMLSuccessResponse | ChatMLFailureResponse | object;

/**
 * Metadata attached to request entries.
 */
export interface ExportedLogMetadata {
	model?: string;
	duration?: number;
	startTime?: string;
	endTime?: string;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

/**
 * Exported log entry from a .chatreplay.json file.
 * This is the serialized form of LoggedInfo.
 */
export interface ExportedLogEntry {
	id: string;
	kind: ExportedLogKind;
	/** Name of the element or request */
	name?: string;
	/** Tool name for tool call entries */
	tool?: string;
	/** Request type (e.g., 'ChatMLSuccess', 'ChatMLFailure', 'MarkdownContentRequest') */
	type?: string;
	/** Token count for element entries */
	tokens?: number;
	/** Max tokens for element entries */
	maxTokens?: number;
	/** Arguments for tool call entries */
	args?: Record<string, unknown>;
	/** Response from tool or model */
	response?: ExportedLogResponse;
	/** Markdown content for MarkdownContentRequest entries - displayed directly to user */
	content?: string;
	/** Metadata for request entries */
	metadata?: ExportedLogMetadata;
	/** Raw request messages */
	requestMessages?: {
		messages?: unknown[];
	};
	/** Timestamp */
	time?: string;
	/** Thinking content for reasoning models */
	thinking?: {
		id?: string;
		text?: string;
	};
	/** File edits made by the entry */
	edits?: unknown[];
	/** Error message for error entries */
	error?: string;
	/** Timestamp for when the entry occurred */
	timestamp?: string;
}

/**
 * Structure of an exported prompt in a .chatreplay.json file.
 * Each prompt represents a user query and its associated log entries.
 */
export interface ExportedPrompt {
	/** The user's prompt text */
	prompt: string;
	/** Unique identifier for the prompt */
	promptId?: string;
	/** Whether this is a continuation of a previous conversation */
	hasSeen?: boolean;
	/** Number of log entries in this prompt */
	logCount: number;
	/** The log entries for this prompt */
	logs: ExportedLogEntry[];
}

/**
 * Root structure of a .chatreplay.json export file.
 */
export interface ChatReplayExport {
	/** ISO timestamp of when the export was created */
	exportedAt: string;
	/** Total number of prompts in the export */
	totalPrompts: number;
	/** Total number of log entries across all prompts */
	totalLogEntries: number;
	/** Array of exported prompts */
	prompts: ExportedPrompt[];
	/** MCP server definitions active during the session */
	mcpServers?: object[];
}

// Type guards for response types

/**
 * Type guard for ChatMLSuccess response.
 */
export function isChatMLSuccessResponse(response: unknown): response is ChatMLSuccessResponse {
	return (
		typeof response === 'object' &&
		response !== null &&
		'type' in response &&
		(response as ChatMLSuccessResponse).type === 'success' &&
		'message' in response
	);
}

/**
 * Checks if a log entry is a ChatMLSuccess that should be displayed as plain markdown.
 */
export function isChatMLSuccessEntry(log: ExportedLogEntry): boolean {
	return log.type === 'ChatMLSuccess' && isChatMLSuccessResponse(log.response);
}

/**
 * Extracts the message text from a ChatMLSuccess response.
 */
export function getChatMLSuccessMessage(response: ChatMLSuccessResponse): string {
	return Array.isArray(response.message) ? response.message.join('\n') : response.message;
}
