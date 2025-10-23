/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent, ToolExecutionCompleteEvent, ToolExecutionStartEvent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type { ChatPromptReference, ExtendedChatResponsePart } from 'vscode';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponsePullRequestPart, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatToolInvocationPart, MarkdownString, Uri } from '../../../../vscodeTypes';

/**
 * CopilotCLI tool names
 */
export const enum CopilotCLIToolNames {
	StrReplaceEditor = 'str_replace_editor',
	Bash = 'bash',
	Think = 'think'
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

export function stripReminders(text: string): string {
	// Remove any <reminder> ... </reminder> blocks, including newlines
	// Also remove <current_datetime> ... </current_datetime> blocks
	// Also remove <pr_metadata .../> tags
	return text
		.replace(/<reminder>[\s\S]*?<\/reminder>\s*/g, '')
		.replace(/<current_datetime>[\s\S]*?<\/current_datetime>\s*/g, '')
		.replace(/<pr_metadata[^>]*\/?>\s*/g, '')
		.trim();
}

/**
 * Extract PR metadata from assistant message content
 */
function extractPRMetadata(content: string): { cleanedContent: string; prPart?: ChatResponsePullRequestPart } {
	const prMetadataRegex = /<pr_metadata\s+uri="([^"]+)"\s+title="([^"]+)"\s+description="([^"]+)"\s+author="([^"]+)"\s+linkTag="([^"]+)"\s*\/?>/;
	const match = content.match(prMetadataRegex);

	if (match) {
		const [fullMatch, uri, title, description, author, linkTag] = match;
		// Unescape XML entities
		const unescapeXml = (text: string) => text
			.replace(/&apos;/g, "'")
			.replace(/&quot;/g, '"')
			.replace(/&gt;/g, '>')
			.replace(/&lt;/g, '<')
			.replace(/&amp;/g, '&');

		const prPart = new ChatResponsePullRequestPart(
			Uri.parse(uri),
			unescapeXml(title),
			unescapeXml(description),
			unescapeXml(author),
			unescapeXml(linkTag)
		);

		const cleanedContent = content.replace(fullMatch, '').trim();
		return { cleanedContent, prPart };
	}

	return { cleanedContent: content };
}

/**
 * Build chat history from SDK events for VS Code chat session
 * Converts SDKEvents into ChatRequestTurn2 and ChatResponseTurn2 objects
 */
export function buildChatHistoryFromEvents(events: readonly SessionEvent[]): (ChatRequestTurn2 | ChatResponseTurn2)[] {
	const turns: (ChatRequestTurn2 | ChatResponseTurn2)[] = [];
	let currentResponseParts: ExtendedChatResponsePart[] = [];
	const pendingToolInvocations = new Map<string, ChatToolInvocationPart>();
	const toolNames = new Map<string, string>();

	for (const event of events) {
		switch (event.type) {
			case 'user.message': {
				// Flush any pending response parts before adding user message
				if (currentResponseParts.length > 0) {
					turns.push(new ChatResponseTurn2(currentResponseParts, {}, ''));
					currentResponseParts = [];
				}
				// TODO @DonJayamanne Temporary work around until we get the zod types.
				type Attachment = {
					path: string;
					type: "file" | "directory";
					displayName: string;
				};
				const references: ChatPromptReference[] = ((event.data.attachments || []) as Attachment[]).map(attachment => ({ id: attachment.path, name: attachment.displayName, value: Uri.file(attachment.path) } as ChatPromptReference));
				turns.push(new ChatRequestTurn2(stripReminders(event.data.content || ''), undefined, references, '', [], undefined));
				break;
			}
			case 'assistant.message': {
				if (event.data.content) {
					// Extract PR metadata if present
					const { cleanedContent, prPart } = extractPRMetadata(event.data.content);

					// Add PR part first if it exists
					if (prPart) {
						currentResponseParts.push(prPart);
					}

					if (cleanedContent) {
						currentResponseParts.push(
							new ChatResponseMarkdownPart(new MarkdownString(cleanedContent))
						);
					}
				}
				break;
			}
			case 'tool.execution_start': {
				const responsePart = processToolExecutionStart(event, toolNames, pendingToolInvocations);
				if (responsePart instanceof ChatResponseThinkingProgressPart) {
					currentResponseParts.push(responsePart);
				}
				break;
			}
			case 'tool.execution_complete': {
				const responsePart = processToolExecutionComplete(event, pendingToolInvocations);
				if (responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
					currentResponseParts.push(responsePart);
				}
				break;
			}
		}
	}


	if (currentResponseParts.length > 0) {
		turns.push(new ChatResponseTurn2(currentResponseParts, {}, ''));
	}

	return turns;
}

export function processToolExecutionStart(event: ToolExecutionStartEvent, toolNames: Map<string, string>, pendingToolInvocations: Map<string, ChatToolInvocationPart | ChatResponseThinkingProgressPart>): ChatToolInvocationPart | ChatResponseThinkingProgressPart | undefined {
	const toolInvocation = createCopilotCLIToolInvocation(
		event.data.toolName,
		event.data.toolCallId,
		event.data.arguments
	);
	toolNames.set(event.data.toolCallId, event.data.toolName);
	if (toolInvocation) {
		// Store pending invocation to update with result later
		pendingToolInvocations.set(event.data.toolCallId, toolInvocation);
	}
	return toolInvocation;
}

export function processToolExecutionComplete(event: ToolExecutionCompleteEvent, pendingToolInvocations: Map<string, ChatToolInvocationPart | ChatResponseThinkingProgressPart>): ChatToolInvocationPart | ChatResponseThinkingProgressPart | undefined {
	const invocation = pendingToolInvocations.get(event.data.toolCallId);
	pendingToolInvocations.delete(event.data.toolCallId);

	if (invocation && invocation instanceof ChatToolInvocationPart) {
		invocation.isComplete = true;
		invocation.isError = !!event.data.error;
		invocation.invocationMessage = event.data.error?.message || invocation.invocationMessage;
		if (!event.data.success && (event.data.error?.code === 'rejected' || event.data.error?.code === 'denied')) {
			invocation.isConfirmed = false;
		} else {
			invocation.isConfirmed = true;
		}
	}

	return invocation;
}

/**
 * Creates a formatted tool invocation part for CopilotCLI tools
 */
export function createCopilotCLIToolInvocation(
	toolName: string,
	toolCallId: string,
	args: unknown,
): ChatToolInvocationPart | ChatResponseThinkingProgressPart | undefined {
	if (toolName === CopilotCLIToolNames.Think) {
		const thought = (args as { thought?: string })?.thought;
		if (thought && typeof thought === 'string') {
			return new ChatResponseThinkingProgressPart(thought);
		}
		return undefined;
	}

	const invocation = new ChatToolInvocationPart(toolName, toolCallId ?? '', false);
	invocation.isConfirmed = false;
	invocation.isComplete = false;

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