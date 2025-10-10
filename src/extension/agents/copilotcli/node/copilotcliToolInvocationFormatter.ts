/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKEvent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ExtendedChatResponsePart } from 'vscode';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponseTurn2, ChatToolInvocationPart, MarkdownString } from '../../../../vscodeTypes';

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

function resolveContentToString(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	} else if (Array.isArray(content)) {
		return content.map(part => resolveContentToString(part)).join('');
	} else if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
		return content.text;
	}
	return '';
}

/**
 * Parse chat messages from the CopilotCLI SDK into SDKEvent format
 * Used when loading session history from disk
 */
export function parseChatMessagesToEvents(chatMessages: readonly ChatCompletionMessageParam[]): SDKEvent[] {
	const events: SDKEvent[] = [];

	for (const msg of chatMessages) {
		// Handle regular messages (user or assistant)
		if (msg.role === 'user' || msg.role === 'assistant') {
			if (msg.content) {
				events.push({
					type: 'message' as const,
					content: resolveContentToString(msg.content),
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
					textResultForLlm: resolveContentToString(msg.content),
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
	let currentResponseParts: ExtendedChatResponsePart[] = [];
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

// TODO@rebornix: should come from SDK


type Command = {
	readonly identifier: string;
	readonly readOnly: boolean;
};

type PossiblePath = string;

export type ShellPermissionRequest = {
	readonly kind: "shell";
	/** The full command that the user is being asked to approve, e.g. `echo foo && find -exec ... && git push` */
	readonly fullCommandText: string;
	/** A concise summary of the user's intention, e.g. "Echo foo and find a file and then run git push" */
	readonly intention: string;
	/**
	 * The commands that are being invoked in the shell invocation.
	 *
	 * As a special case, which might be better represented in the type system, if there were no parsed commands
	 * e.g. `export VAR=value`, then this will have a single entry with identifier equal to the fullCommandText.
	 */
	readonly commands: ReadonlyArray<Command>;
	/**
	 * Possible file paths that the command might access.
	 *
	 * This is entirely heuristic, so it's pretty untrustworthy.
	 */
	readonly possiblePaths: ReadonlyArray<PossiblePath>;
	/**
	 * Indicates whether any command in the script has redirection to write to a file.
	 */
	readonly hasWriteFileRedirection: boolean;
	/**
	 * If there are complicated constructs, then persistent approval is not supported.
	 * e.g. `cat $(echo "foo")` should not be persistently approvable because it's hard
	 * for the user to understand the implications.
	 */
	readonly canOfferSessionApproval: boolean;
};

type WritePermissionRequest = {
	readonly kind: "write";
	/** The intention of the edit operation, e.g. "Edit file" or "Create file" */
	readonly intention: string;
	/** The name of the file being edited */
	readonly fileName: string;
	/** The diff of the changes being made */
	readonly diff: string;
};

type MCPPermissionRequest = {
	readonly kind: "mcp";
	/** The name of the MCP Server being targeted e.g. "github-mcp-server" */
	readonly serverName: string;
	/** The name of the tool being targeted e.g. "list_issues" */
	readonly toolName: string;
	/** The title of the tool being targeted e.g. "List Issues" */
	readonly toolTitle: string;
	/**
	 * The _hopefully_ JSON arguments that will be passed to the MCP tool.
	 *
	 * This should be an object, but it's not parsed before this point so we can't guarantee that.
	 * */
	readonly args: unknown;
	/**
	 * Whether the tool is read-only (e.g. a `view` operation) or not (e.g. an `edit` operation).
	 */
	readonly readOnly: boolean;
};

export type PermissionRequest = ShellPermissionRequest | WritePermissionRequest | MCPPermissionRequest;