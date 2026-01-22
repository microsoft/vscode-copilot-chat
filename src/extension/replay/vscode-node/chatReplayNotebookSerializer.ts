/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, NotebookCellData, NotebookCellKind, NotebookData, NotebookSerializer } from 'vscode';
import { ChatReplayExport, ExportedLogEntry, ExportedPrompt, getChatMLSuccessMessage, isChatMLSuccessEntry, isChatMLSuccessResponse } from '../common/chatReplayTypes';

/** The notebook type identifier for chat replay notebooks */
export const CHAT_REPLAY_NOTEBOOK_TYPE = 'copilot-chat-replay';

/** Cell metadata for collapsible cells */
interface CellMetadata {
	collapsed?: boolean;
}

/**
 * Creates a notebook cell with optional collapse metadata.
 */
function createCell(content: string, collapsed: boolean): NotebookCellData {
	const cell = new NotebookCellData(NotebookCellKind.Markup, content, 'markdown');
	if (collapsed) {
		cell.metadata = { collapsed: true } satisfies CellMetadata;
	}
	return cell;
}

/**
 * NotebookSerializer for .chatreplay.json files exported from the request logger.
 *
 * Converts exported chat logs into a notebook format where:
 * - User queries are displayed as markdown cells with ### User header
 * - Log entries (elements, requests, tool calls) are displayed as markdown cells with #### headers
 *
 * This provides a read-only view of the chat log for review and debugging.
 */
export class ChatReplayNotebookSerializer implements NotebookSerializer {

	deserializeNotebook(content: Uint8Array, _token: CancellationToken): NotebookData {
		const text = new TextDecoder().decode(content);
		const cells: NotebookCellData[] = [];

		try {
			const parsed = JSON.parse(text) as ChatReplayExport;

			// Add header cell with export metadata (collapsed)
			cells.push(createCell(this.formatExportHeader(parsed), true));

			// Process each prompt and its logs
			for (const prompt of parsed.prompts) {
				// Add user query cell (not collapsed - user content)
				cells.push(createCell(this.formatUserQuery(prompt), false));

				// Add cells for each log entry
				for (const log of prompt.logs) {
					const result = this.formatLogEntry(log);
					if (result) {
						// Response content is not collapsed, everything else is
						cells.push(createCell(result.content, result.collapsed));
					}
				}
			}
		} catch (error) {
			// If parsing fails, show error in a single cell
			cells.push(createCell(
				`### Error Parsing Chat Replay\n\nFailed to parse the chat replay file:\n\n\`\`\`\n${error}\n\`\`\``,
				false
			));
		}

		return new NotebookData(cells);
	}

	serializeNotebook(_data: NotebookData, _token: CancellationToken): Uint8Array {
		// Read-only - return empty content
		// The original JSON should not be modified through the notebook interface
		return new Uint8Array();
	}

	private formatExportHeader(parsed: ChatReplayExport): string {
		const lines: string[] = [
			'## Chat Replay Export',
			'',
			`**Exported:** ${parsed.exportedAt}`,
			`**Total Prompts:** ${parsed.totalPrompts}`,
			`**Total Log Entries:** ${parsed.totalLogEntries}`,
		];

		if (parsed.mcpServers && parsed.mcpServers.length > 0) {
			lines.push(`**MCP Servers:** ${parsed.mcpServers.length}`);
		}

		lines.push('', '---');
		return lines.join('\n');
	}

	private formatUserQuery(prompt: ExportedPrompt): string {
		// User query cell contains only the header and the actual prompt
		return `### User\n\n${prompt.prompt}`;
	}

	/**
	 * Format a log entry and return both content and whether it should be collapsed.
	 */
	private formatLogEntry(log: ExportedLogEntry): { content: string; collapsed: boolean } | undefined {
		switch (log.kind) {
			case 'element':
				return { content: this.formatElementEntry(log), collapsed: true };
			case 'request': {
				// Check for content to display directly:
				// 1. MarkdownContentRequest entries have a 'content' field
				// 2. ChatMLSuccess entries have response.message
				if (log.content !== undefined) {
					// This is user-facing response content - not collapsed
					return { content: log.content, collapsed: false };
				}
				// Check for ChatMLSuccess response with message using type guard
				if (isChatMLSuccessEntry(log) && isChatMLSuccessResponse(log.response)) {
					// This is user-facing response content - not collapsed
					return { content: getChatMLSuccessMessage(log.response), collapsed: false };
				}
				return { content: this.formatRequestEntry(log), collapsed: true };
			}
			case 'toolCall':
				return { content: this.formatToolCallEntry(log), collapsed: true };
			case 'error':
				return { content: this.formatErrorEntry(log), collapsed: true };
			default:
				return undefined;
		}
	}

	private formatElementEntry(log: ExportedLogEntry): string {
		const lines: string[] = [
			`#### Element: ${log.name ?? 'Unknown'}`,
			'',
		];

		if (log.tokens !== undefined && log.maxTokens !== undefined) {
			const percentage = ((log.tokens / log.maxTokens) * 100).toFixed(1);
			lines.push(`**Tokens:** ${log.tokens.toLocaleString()} / ${log.maxTokens.toLocaleString()} (${percentage}%)`);
		}

		return lines.join('\n');
	}

	private formatRequestEntry(log: ExportedLogEntry): string {
		const lines: string[] = [
			`#### Request: ${log.name ?? log.type ?? 'Unknown'}`,
			'',
		];

		const metadata = log.metadata;
		if (metadata) {
			if (metadata.model) {
				lines.push(`**Model:** ${metadata.model}`);
			}
			if (metadata.duration !== undefined) {
				lines.push(`**Duration:** ${metadata.duration.toLocaleString()}ms`);
			}
			if (metadata.usage) {
				const usage = metadata.usage;
				if (usage.prompt_tokens !== undefined) {
					lines.push(`**Prompt Tokens:** ${usage.prompt_tokens.toLocaleString()}`);
				}
				if (usage.completion_tokens !== undefined) {
					lines.push(`**Completion Tokens:** ${usage.completion_tokens.toLocaleString()}`);
				}
			}
			if (metadata.startTime) {
				lines.push(`**Start Time:** ${metadata.startTime}`);
			}
		}

		// Show request messages if available
		if (log.requestMessages?.messages && log.requestMessages.messages.length > 0) {
			const messagesStr = JSON.stringify(log.requestMessages.messages, null, 2);
			lines.push('', '<details>', '<summary>Request Messages</summary>', '', '```json', messagesStr, '```', '</details>');
		}

		// Show response summary if available (for non-success cases)
		if (log.response && !isChatMLSuccessResponse(log.response)) {
			lines.push('');
			const response = log.response as { type?: string; message?: string | string[] };
			if (response.type) {
				lines.push(`**Response Type:** ${response.type}`);
			}
			if (response.message) {
				const messageText = Array.isArray(response.message) ? response.message.join('\n') : response.message;
				if (messageText.length > 500) {
					lines.push('', '<details>', '<summary>Response (truncated)</summary>', '', '```', messageText.substring(0, 500) + '...', '```', '</details>');
				} else {
					lines.push('', '<details>', '<summary>Response</summary>', '', '```', messageText, '```', '</details>');
				}
			}
		}

		return lines.join('\n');
	}

	private formatToolCallEntry(log: ExportedLogEntry): string {
		const toolName = log.tool ?? log.name ?? 'Unknown';
		const lines: string[] = [
			`#### Tool Call: ${toolName}`,
			'',
		];

		if (log.time) {
			lines.push(`**Time:** ${log.time}`);
		}

		// Show thinking if present
		if (log.thinking?.text) {
			lines.push('', '<details>', '<summary>Thinking</summary>', '', '```', log.thinking.text, '```', '</details>');
		}

		// Show arguments
		if (log.args !== undefined) {
			const argsStr = typeof log.args === 'string' ? log.args : JSON.stringify(log.args, null, 2);
			lines.push('', '<details>', '<summary>Arguments</summary>', '', '```json', argsStr, '```', '</details>');
		}

		// Show response
		if (log.response !== undefined) {
			const response = log.response;
			const responseStr = Array.isArray(response)
				? response.join('\n')
				: typeof response === 'string'
					? response
					: JSON.stringify(response, null, 2);

			if (responseStr.length > 1000) {
				lines.push('', '<details>', '<summary>Response (truncated)</summary>', '', '```', responseStr.substring(0, 1000) + '...', '```', '</details>');
			} else {
				lines.push('', '<details>', '<summary>Response</summary>', '', '```', responseStr, '```', '</details>');
			}
		}

		// Show edits if present
		if (log.edits && log.edits.length > 0) {
			lines.push('', `**Edits:** ${log.edits.length} file(s) modified`);
		}

		return lines.join('\n');
	}

	private formatErrorEntry(log: ExportedLogEntry): string {
		return [
			`#### Error`,
			'',
			`**ID:** ${log.id}`,
			'',
			'An error occurred while processing this log entry.',
		].join('\n');
	}
}
