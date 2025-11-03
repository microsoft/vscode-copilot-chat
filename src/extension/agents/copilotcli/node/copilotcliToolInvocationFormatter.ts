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
	Edit = 'edit',
	Create = 'create',
	View = 'view',
	Bash = 'bash',
	Think = 'think',
	/**
	 * This is meant to be part of thinking, still WIP.
	 * Plan is to ignore these and support streaming of responses.
	 */
	ReportIntent = 'report_intent'
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

// @ts-ignore Will be used later.
interface CreateArgs {
	path: string;
	file_text?: string;
}

// @ts-ignore Will be used later.
interface ViewArgs {
	path: string;
	view_range?: [number, number];
}

// @ts-ignore Will be used later.
interface EditArgs {
	path: string;
	old_str?: string;
	new_str?: string;
}

interface BashArgs {
	command: string;
	description?: string;
	sessionId?: string;
	async?: boolean;
}

export function isCopilotCliEditToolCall(toolName: string, toolArgs: unknown): toolArgs is StrReplaceEditorArgs | EditArgs | CreateArgs {
	if (toolName === CopilotCLIToolNames.StrReplaceEditor && typeof toolArgs === 'object' && toolArgs !== null) {
		const args = toolArgs as StrReplaceEditorArgs;
		if (args.command && args.command !== 'view') {
			return true;
		}
	} else if (toolName === CopilotCLIToolNames.Edit || toolName === CopilotCLIToolNames.Create) {
		return true;
	}
	return false;
}

export function getAffectedUrisForEditTool(toolName: string, toolArgs: unknown): URI[] {
	if (isCopilotCliEditToolCall(toolName, toolArgs) && toolArgs.path) {
		return [URI.file(toolArgs.path)];
	}

	return [];
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
				const responsePart = processToolExecutionStart(event, pendingToolInvocations);
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

export function processToolExecutionStart(event: ToolExecutionStartEvent, pendingToolInvocations: Map<string, ChatToolInvocationPart | ChatResponseThinkingProgressPart>): ChatToolInvocationPart | ChatResponseThinkingProgressPart | undefined {
	const toolInvocation = createCopilotCLIToolInvocation(
		event.data.toolName,
		event.data.toolCallId,
		event.data.arguments
	);
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
	if (toolName === CopilotCLIToolNames.ReportIntent) {
		return undefined; // Ignore these for now
	}
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
	} else if (toolName === CopilotCLIToolNames.View) {
		formatViewToolInvocation(invocation, args as StrReplaceEditorArgs);
	} else if (toolName === CopilotCLIToolNames.Edit) {
		formatEditToolInvocation(invocation, args as EditArgs | CreateArgs);
	} else if (toolName === CopilotCLIToolNames.Create) {
		formatCreateToolInvocation(invocation, args as EditArgs | CreateArgs);
	} else {
		formatGenericInvocation(invocation, toolName, args);
	}

	return invocation;
}

function formatViewToolInvocation(invocation: ChatToolInvocationPart, args: StrReplaceEditorArgs): void {
	const path = args.path ?? '';
	const display = path ? formatUriForMessage(path) : '';

	invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
}

function formatStrReplaceEditorInvocation(invocation: ChatToolInvocationPart, args: StrReplaceEditorArgs): void {
	const command = args.command;
	const path = args.path ?? '';
	const display = path ? formatUriForMessage(path) : '';

	switch (command) {
		case 'view':
			if (args.view_range && args.view_range[1] > args.view_range[0]) {
				invocation.invocationMessage = new MarkdownString(l10n.t("Read {0} (lines {1}-{2})", display, args.view_range[0], args.view_range[1]));
			} else {
				invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
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

function formatEditToolInvocation(invocation: ChatToolInvocationPart, args: EditArgs): void {
	const display = args.path ? formatUriForMessage(args.path) : '';

	if (display) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Edited {0}", display));
	}
}


function formatCreateToolInvocation(invocation: ChatToolInvocationPart, args: EditArgs | CreateArgs): void {
	const display = args.path ? formatUriForMessage(args.path) : '';

	if (display) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Created {0}", display));
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
