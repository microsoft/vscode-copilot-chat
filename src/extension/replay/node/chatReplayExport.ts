/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { LoggedInfo, LoggedInfoKind } from '../../../platform/requestLogger/node/requestLogger';
import { ChatReplayExport, ExportedLogEntry, ExportedPrompt } from '../common/chatReplayTypes';

// Re-export types for consumers
export type { ChatReplayExport, ExportedLogEntry, ExportedPrompt } from '../common/chatReplayTypes';

/**
 * Groups logged entries by their capturing token to create prompt groups.
 * Each group represents a user prompt and its associated log entries.
 */
export function groupEntriesByToken(entries: LoggedInfo[]): Map<CapturingToken | undefined, LoggedInfo[]> {
	const groups = new Map<CapturingToken | undefined, LoggedInfo[]>();

	for (const entry of entries) {
		const token = entry.token;
		if (!groups.has(token)) {
			groups.set(token, []);
		}
		groups.get(token)!.push(entry);
	}

	return groups;
}

/**
 * Converts a single log entry to its JSON representation.
 * Handles async toJSON methods for tool calls.
 */
export async function entryToJson(entry: LoggedInfo): Promise<object> {
	if (entry.kind === LoggedInfoKind.ToolCall) {
		// Tool calls have async toJSON
		return await (entry as { toJSON(): Promise<object> }).toJSON();
	} else {
		// Elements and requests have sync toJSON
		return (entry as { toJSON(): object }).toJSON();
	}
}

/**
 * Creates a chat replay export from logged entries.
 * This is the canonical format used by .chatreplay.json files.
 *
 * @param entries - Array of logged info entries to export
 * @param mcpServers - Optional MCP server definitions to include
 * @returns The complete export structure ready to be serialized to JSON
 */
export async function createChatReplayExport(
	entries: LoggedInfo[],
	mcpServers?: object[]
): Promise<ChatReplayExport> {
	const groups = groupEntriesByToken(entries);
	const prompts: ExportedPrompt[] = [];

	for (const [token, groupEntries] of groups) {
		// Skip entries without a token (they don't represent user prompts)
		if (!token) {
			continue;
		}

		const logs: ExportedLogEntry[] = [];
		for (const entry of groupEntries) {
			try {
				logs.push(await entryToJson(entry) as ExportedLogEntry);
			} catch (error) {
				logs.push({
					id: entry.id,
					kind: 'error',
					error: error?.toString() || 'Unknown error',
					timestamp: new Date().toISOString()
				} as unknown as ExportedLogEntry);
			}
		}

		prompts.push({
			prompt: token.label,
			promptId: undefined, // Could be added if needed
			hasSeen: false,
			logCount: logs.length,
			logs
		});
	}

	const totalLogEntries = prompts.reduce((sum, p) => sum + p.logCount, 0);

	return {
		exportedAt: new Date().toISOString(),
		totalPrompts: prompts.length,
		totalLogEntries,
		prompts,
		mcpServers
	};
}

/**
 * Creates an exported prompt from a collection of log entries.
 * Use this when entries are already grouped by prompt (e.g., from tree view).
 *
 * @param label - The prompt label
 * @param entries - The log entries for this prompt
 * @param options - Additional options
 * @returns The exported prompt structure
 */
export async function createExportedPrompt(
	label: string,
	entries: LoggedInfo[],
	options?: { promptId?: string; hasSeen?: boolean }
): Promise<ExportedPrompt> {
	const logs: ExportedLogEntry[] = [];
	for (const entry of entries) {
		try {
			logs.push(await entryToJson(entry) as ExportedLogEntry);
		} catch (error) {
			logs.push({
				id: entry.id,
				kind: 'error',
				error: error?.toString() || 'Unknown error',
				timestamp: new Date().toISOString()
			} as unknown as ExportedLogEntry);
		}
	}

	return {
		prompt: label,
		promptId: options?.promptId,
		hasSeen: options?.hasSeen,
		logCount: logs.length,
		logs
	};
}

/**
 * Assembles a complete ChatReplayExport from exported prompts.
 *
 * @param prompts - Array of exported prompts
 * @param mcpServers - Optional MCP server definitions
 * @returns The complete export structure
 */
export function assembleChatReplayExport(
	prompts: ExportedPrompt[],
	mcpServers?: object[]
): ChatReplayExport {
	const totalLogEntries = prompts.reduce((sum, p) => sum + p.logCount, 0);

	return {
		exportedAt: new Date().toISOString(),
		totalPrompts: prompts.length,
		totalLogEntries,
		prompts,
		mcpServers
	};
}

/**
 * Serializes a chat replay export to a JSON string.
 */
export function serializeChatReplayExport(exportData: ChatReplayExport): string {
	return JSON.stringify(exportData, null, 2);
}
