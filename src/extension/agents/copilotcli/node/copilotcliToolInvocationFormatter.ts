/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponseTurn2, ChatToolInvocationPart, MarkdownString } from '../../../../vscodeTypes';
import type { SDKEvent } from './copilotcliClient';

/**
 * CopilotCLI tool names
 */
const enum CopilotCLIToolNames {
	StrReplaceEditor = 'str_replace_editor',
	Bash = 'bash'
}

interface StrReplaceEditorArgs {
	command: 'view' | 'str_replace' | 'insert' | 'create' | 'undo_edit';
	path: string;
	view_range?: [number, number];
	old_str?: string;
	new_str?: string;
	insert_line?: number;
	file_text?: string;
}

interface BashArgs {
	command: string;
	description?: string;
	sessionId?: string;
	async?: boolean;
}

/**
 * Parse chat messages from the CopilotCLI SDK into SDKEvent format
 * Used when loading session history from disk
 */
export function parseChatMessagesToEvents(chatMessages: any[]): SDKEvent[] {
	const events: SDKEvent[] = [];

	for (const msg of chatMessages) {
		// Handle regular messages (user or assistant)
		if (msg.role === 'user' || msg.role === 'assistant') {
			if (msg.content) {
				events.push({
					type: 'message' as const,
					content: msg.content,
					role: msg.role
				});
			}

			// Handle tool calls in assistant messages
			if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
				for (const toolCall of msg.tool_calls) {
					if (toolCall.type === 'function' && toolCall.function) {
						events.push({
							type: 'tool_use' as const,
							toolName: toolCall.function.name,
							args: toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {},
							toolCallId: toolCall.id
						});
					}
				}
			}
		}

		// Handle tool results
		if (msg.role === 'tool') {
			events.push({
				type: 'tool_result' as const,
				toolName: 'unknown', // Tool name isn't in the message, would need to match with tool_call_id
				result: {
					textResultForLlm: msg.content || '',
					resultType: 'success',
					toolTelemetry: {
						properties: {},
						restrictedProperties: {},
						metrics: {}
					}
				},
				toolCallId: msg.tool_call_id
			});
		}
	}

	return events;
}

/**
 * Build chat history from SDK events for VS Code chat session
 * Converts SDKEvents into ChatRequestTurn2 and ChatResponseTurn2 objects
 */
export function buildChatHistoryFromEvents(events: readonly SDKEvent[]): (ChatRequestTurn2 | ChatResponseTurn2)[] {
	const turns: (ChatRequestTurn2 | ChatResponseTurn2)[] = [];
	let currentResponseParts: any[] = [];
	const pendingToolInvocations = new Map<string, ChatToolInvocationPart>();

	for (const event of events) {
		if (event.type === 'message') {
			if (event.role === 'user') {
				// Flush any pending response parts before adding user message
				if (currentResponseParts.length > 0) {
					turns.push(new ChatResponseTurn2(currentResponseParts, {}, ''));
					currentResponseParts = [];
				}
				turns.push(new ChatRequestTurn2(event.content || '', undefined, [], '', [], undefined));
			} else if (event.role === 'assistant' && event.content) {
				currentResponseParts.push(
					new ChatResponseMarkdownPart(new MarkdownString(event.content))
				);
			}
		} else if (event.type === 'tool_use') {
			// Use the formatter to create properly formatted tool invocation
			const toolInvocation = createCopilotCLIToolInvocation(
				event.toolName,
				event.toolCallId,
				event.args
			);
			if (toolInvocation) {
				toolInvocation.isConfirmed = false;
				// Store pending invocation to update with result later
				if (event.toolCallId) {
					pendingToolInvocations.set(event.toolCallId, toolInvocation);
				}
				currentResponseParts.push(toolInvocation);
			}
		} else if (event.type === 'tool_result') {
			// Update the pending tool invocation with the result
			if (event.toolCallId) {
				const invocation = pendingToolInvocations.get(event.toolCallId);
				if (invocation) {
					invocation.isConfirmed = true;
					invocation.isError = event.result.resultType === 'failure' || event.result.resultType === 'denied';
					pendingToolInvocations.delete(event.toolCallId);
				}
			}
			// Tool results themselves are not displayed - they update the invocation state
		}
	}

	// Flush any remaining response parts
	if (currentResponseParts.length > 0) {
		turns.push(new ChatResponseTurn2(currentResponseParts, {}, ''));
	}

	return turns;
}

/**
 * Creates a formatted tool invocation part for CopilotCLI tools
 */
export function createCopilotCLIToolInvocation(
	toolName: string,
	toolCallId: string | undefined,
	args: unknown,
	resultType?: 'success' | 'failure' | 'rejected' | 'denied',
	error?: string
): ChatToolInvocationPart | undefined {
	const invocation = new ChatToolInvocationPart(toolName, toolCallId ?? '', false);
	invocation.isConfirmed = true;

	if (resultType) {
		invocation.isError = resultType === 'failure' || resultType === 'denied';
	}

	// Format based on tool name
	if (toolName === CopilotCLIToolNames.StrReplaceEditor) {
		formatStrReplaceEditorInvocation(invocation, args as StrReplaceEditorArgs);
	} else if (toolName === CopilotCLIToolNames.Bash) {
		formatBashInvocation(invocation, args as BashArgs);
	} else {
		formatGenericInvocation(invocation, toolName, args);
	}

	return invocation;
}

function formatStrReplaceEditorInvocation(invocation: ChatToolInvocationPart, args: StrReplaceEditorArgs): void {
	const command = args.command;
	const path = args.path ?? '';
	const display = path ? formatUriForMessage(path) : '';

	switch (command) {
		case 'view':
			if (args.view_range) {
				invocation.invocationMessage = new MarkdownString(l10n.t("Viewed {0} (lines {1}-{2})", display, args.view_range[0], args.view_range[1]));
			} else {
				invocation.invocationMessage = new MarkdownString(l10n.t("Viewed {0}", display));
			}
			break;
		case 'str_replace':
			invocation.invocationMessage = new MarkdownString(l10n.t("Edited {0}", display));
			break;
		case 'insert':
			invocation.invocationMessage = new MarkdownString(l10n.t("Inserted text in {0}", display));
			break;
		case 'create':
			invocation.invocationMessage = new MarkdownString(l10n.t("Created {0}", display));
			break;
		case 'undo_edit':
			invocation.invocationMessage = new MarkdownString(l10n.t("Undid edit in {0}", display));
			break;
		default:
			invocation.invocationMessage = new MarkdownString(l10n.t("Modified {0}", display));
	}
}

function formatBashInvocation(invocation: ChatToolInvocationPart, args: BashArgs): void {
	const command = args.command ?? '';
	const description = args.description;

	invocation.invocationMessage = '';
	invocation.toolSpecificData = {
		commandLine: {
			original: command,
		},
		language: 'bash'
	};

	// Add description as a tooltip if available
	if (description) {
		invocation.invocationMessage = new MarkdownString(description);
	}
}

function formatGenericInvocation(invocation: ChatToolInvocationPart, toolName: string, args: unknown): void {
	invocation.invocationMessage = l10n.t("Used tool: {0}", toolName);
}

function formatUriForMessage(path: string): string {
	return `[](${URI.file(path).toString()})`;
}