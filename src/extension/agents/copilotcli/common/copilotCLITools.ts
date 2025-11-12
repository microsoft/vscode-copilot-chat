/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent, ToolExecutionCompleteEvent, ToolExecutionStartEvent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type { ChatPromptReference, ChatTerminalToolInvocationData, ExtendedChatResponsePart } from 'vscode';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponsePullRequestPart, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatToolInvocationPart, MarkdownString, Uri } from '../../../../vscodeTypes';


interface CreateTool {
	toolName: 'create';
	arguments: {
		path: string;
		file_text?: string;
	};
}

interface ViewTool {
	toolName: 'view';
	arguments: {
		path: string;
		view_range?: [number, number];
	};
}

interface EditTool {
	toolName: 'edit';
	arguments: {
		path: string;
		old_str?: string;
		new_str?: string;
	};
}

interface UndoEditTool {
	toolName: 'undo_edit';
	arguments: {
		path: string;
	};
}

interface StrReplaceTool {
	toolName: 'str_replace';
	arguments: {
		path: string;
		old_str?: string;
		new_str?: string;
	};
}

interface InsertTool {
	toolName: 'insert';
	arguments: {
		path: string;
		insert_line?: number;
		new_str: string;
	};
}

interface ShellTool {
	toolName: 'bash' | 'powershell';
	arguments: {
		command: string;
		description: string;
		sessionId?: string;
		async?: boolean;
		timeout?: number;
	};
}

interface WriteShellTool {
	toolName: 'write_bash' | 'write_powershell';
	arguments: {
		sessionId: string;
		input: string;
		delay?: number;
	};
}

interface ReadShellTool {
	toolName: 'read_bash' | 'read_powershell';
	arguments: {
		sessionId: string;
		delay: number;
	};
}

interface StopShellTool {
	toolName: 'stop_bash' | 'stop_powershell';
	arguments: unknown;
}

interface GrepTool {
	toolName: 'grep';
	arguments: {
		pattern: string;
		path?: string;
		output_mode: 'content' | 'files_with_matches' | 'count';
		glob?: string;
		type?: string;
		'-i'?: boolean;
		'-A'?: boolean;
		'-B'?: boolean;
		'-C'?: boolean;
		'-n'?: boolean;
		head_limit?: number;
		multiline?: boolean;
	};
}

interface GLobTool {
	toolName: 'glob';
	arguments: {
		pattern: string;
		path?: string;
	};
}

type ReportIntentTool = {
	toolName: 'report_intent';
	arguments: {
		intent: string;
	};
};
type ThinkTool = {
	toolName: 'think';
	arguments: {
		thought: string;
	};
};

type ReportProgressTool = {
	toolName: 'report_progress';
	arguments: {
		commitMessage: string;
		prDescription: string;
	};
};


type StringReplaceArgumentTypes = CreateTool | ViewTool | StrReplaceTool | EditTool | InsertTool | UndoEditTool;
type ToStringReplaceEditorArguments<T extends StringReplaceArgumentTypes> = {
	command: T['toolName'];
} & T['arguments'];
export type ToolInfo = {
	toolName: 'str_replace_editor';
	arguments: ToStringReplaceEditorArguments<CreateTool> | ToStringReplaceEditorArguments<ViewTool> | ToStringReplaceEditorArguments<EditTool> | ToStringReplaceEditorArguments<StrReplaceTool> |
	ToStringReplaceEditorArguments<UndoEditTool> | ToStringReplaceEditorArguments<InsertTool>;
} | EditTool | CreateTool | ViewTool | UndoEditTool | InsertTool |
	ShellTool | WriteShellTool | ReadShellTool | StopShellTool |
	GrepTool | GLobTool |
	ReportIntentTool | ThinkTool | ReportProgressTool;

type ToolCall = ToolInfo & { toolCallId: string };
type UnknownToolCall = { toolName: string; arguments: unknown; toolCallId: string };

export function isCopilotCliEditToolCall(data: { toolName: string; arguments?: unknown }): boolean {
	const toolCall = data as ToolCall;
	if (toolCall.toolName === 'str_replace_editor') {
		return toolCall.arguments.command !== 'view';
	}
	return toolCall.toolName === 'create' || toolCall.toolName === 'edit';
}

export function getAffectedUrisForEditTool(data: { toolName: string; arguments?: unknown }): URI[] {
	const toolCall = data as ToolCall;
	// Old versions used str_replace_editor
	// This should be removed eventually
	// TODO @DonJayamanne verify with SDK & Padawan folk.
	if (toolCall.toolName === 'str_replace_editor' && toolCall.arguments.command !== 'view' && typeof toolCall.arguments.path === 'string') {
		return [URI.file(toolCall.arguments.path)];
	}

	if ((toolCall.toolName === 'create' || toolCall.toolName === 'edit' || toolCall.toolName === 'undo_edit') && typeof toolCall.arguments.path === 'string') {
		return [URI.file(toolCall.arguments.path)];
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
	const toolInvocation = createCopilotCLIToolInvocation(event.data as ToolCall);
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
export function createCopilotCLIToolInvocation(data: { toolCallId: string; toolName: string; arguments?: unknown }): ChatToolInvocationPart | ChatResponseThinkingProgressPart | undefined {
	const toolCall = data as ToolCall;
	if (toolCall.toolName === 'report_intent') {
		return undefined; // Ignore these for now
	}
	if (toolCall.toolName === 'think') {
		if (toolCall.arguments && typeof toolCall.arguments.thought === 'string') {
			return new ChatResponseThinkingProgressPart(toolCall.arguments.thought);
		}
		return undefined;
	}

	const invocation = new ChatToolInvocationPart(friendlyToolName(toolCall.toolName), toolCall.toolCallId ?? '', false);
	invocation.isConfirmed = false;
	invocation.isComplete = false;

	// Format based on tool name
	if (toolCall.toolName === 'str_replace_editor') {
		formatStrReplaceEditorInvocation(invocation, toolCall.arguments);
	} else if (toolCall.toolName === 'bash' || toolCall.toolName === 'powershell') {
		formatShellInvocation(invocation, toolCall.arguments, toolCall.toolName);
	} else if (toolCall.toolName === 'read_bash' || toolCall.toolName === 'read_powershell') {
		invocation.invocationMessage = l10n.t('Read logs from shell session');
	} else if (toolCall.toolName === 'write_bash' || toolCall.toolName === 'write_powershell') {
		invocation.invocationMessage = l10n.t('Send input to shell session');
	} else if (toolCall.toolName === 'stop_bash' || toolCall.toolName === 'stop_powershell') {
		invocation.invocationMessage = l10n.t('Stop shell session');
	} else if (toolCall.toolName === 'view') {
		formatViewToolInvocation(invocation, toolCall.arguments);
	} else if (toolCall.toolName === 'edit') {
		formatEditToolInvocation(invocation, toolCall.arguments);
	} else if (toolCall.toolName === 'create') {
		formatCreateToolInvocation(invocation, toolCall.arguments);
	} else if (toolCall.toolName === 'report_progress') {
		formatProgressToolInvocation(invocation, toolCall.arguments);
	} else {
		formatGenericInvocation(invocation, toolCall);
	}

	return invocation;
}

const FriendlyToolNames: Record<ToolCall['toolName'], string> = {
	'edit': l10n.t('Edit File'),
	'create': l10n.t('Create File'),
	'bash': l10n.t('Run Shell Command'),
	'powershell': l10n.t('Run Powershell Command'),
	'write_bash': l10n.t('Write to Bash'),
	'write_powershell': l10n.t('Write to PowerShell'),
	'read_bash': l10n.t('Read Terminal'),
	'read_powershell': l10n.t('Read Terminal'),
	'stop_bash': l10n.t('Stop Terminal Session'),
	'stop_powershell': l10n.t('Stop Terminal Session'),
	'grep': l10n.t('Grep Tool'),
	'glob': l10n.t('Glob Tool'),
	'report_intent': l10n.t('Report Intent'),
	'think': l10n.t('Thinking'),
	'report_progress': l10n.t('Progress Update'),
	'undo_edit': l10n.t('Undo Edit'),
	'str_replace_editor': l10n.t('String Replace Editor'),
	'view': l10n.t('View File'),
	'insert': l10n.t('Insert Text')
};

function friendlyToolName(toolName: ToolCall['toolName']): string {
	return FriendlyToolNames[toolName] || toolName || 'unknown';
}

function formatProgressToolInvocation(invocation: ChatToolInvocationPart, args: ReportProgressTool['arguments']): void {
	invocation.invocationMessage = args.prDescription?.trim() || 'Progress Update';
	if (args.commitMessage) {
		invocation.originMessage = `Commit: ${args.commitMessage}`;
	}
}
function formatViewToolInvocation(invocation: ChatToolInvocationPart, args: ViewTool['arguments']): void {
	const path = args.path ?? '';
	const display = path ? formatUriForMessage(path) : '';

	if (args.view_range && args.view_range[1] >= args.view_range[0]) {
		const [start, end] = args.view_range;
		const localizedMessage = start === end
			? l10n.t("Read {0} (line {1})", display, start)
			: l10n.t("Read {0} (lines {1} to {2})", display, start, end);
		invocation.invocationMessage = new MarkdownString(localizedMessage);
		return;
	}

	invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
}

function formatStrReplaceEditorInvocation(invocation: ChatToolInvocationPart, args: Extract<ToolCall, { toolName: 'str_replace_editor' }>['arguments']): void {
	const command = args.command;
	const path = args.path ?? '';
	const display = path ? formatUriForMessage(path) : '';
	switch (command) {
		case 'view':
			formatViewToolInvocation(invocation, args);
			break;
		case 'str_replace':
			invocation.invocationMessage = new MarkdownString(l10n.t("Edited {0}", display));
			break;
		case 'edit':
			formatEditToolInvocation(invocation, args);
			break;
		case 'insert':
			invocation.invocationMessage = new MarkdownString(l10n.t("Inserted text in {0}", display));
			break;
		case 'create':
			formatCreateToolInvocation(invocation, args);
			break;
		case 'undo_edit':
			invocation.invocationMessage = new MarkdownString(l10n.t("Undid edit in {0}", display));
			break;
		default:
			invocation.invocationMessage = new MarkdownString(l10n.t("Modified {0}", display));
	}
}

function formatEditToolInvocation(invocation: ChatToolInvocationPart, args: EditTool['arguments']): void {
	const display = args.path ? formatUriForMessage(args.path) : '';

	invocation.invocationMessage = display
		? new MarkdownString(l10n.t("Edited {0}", display))
		: new MarkdownString(l10n.t("Edited file"));
}


function formatCreateToolInvocation(invocation: ChatToolInvocationPart, args: CreateTool['arguments']): void {
	const display = args.path ? formatUriForMessage(args.path) : '';

	if (display) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Created {0}", display));
	} else {
		invocation.invocationMessage = new MarkdownString(l10n.t("Created file"));
	}
}

function formatShellInvocation(invocation: ChatToolInvocationPart, args: ShellTool['arguments'], toolName: ShellTool['toolName']): void {
	const command = args.command ?? '';
	// TODO @DonJayamanne This is the code in copilot cloud, discuss and decide if we want to use it.
	// Not for Cli as we want users to see the exact command being run so they can review and approve it.
	// const MAX_CONTENT_LENGTH = 200;
	// if (command.length > MAX_CONTENT_LENGTH) {
	// 	// Check if content contains EOF marker (heredoc pattern)
	// 	const hasEOF = (command && /<<\s*['"]?EOF['"]?/.test(command));
	// 	if (hasEOF) {
	// 		// show the command line up to EOL
	// 		const firstLineEnd = command.indexOf('\n');
	// 		if (firstLineEnd > 0) {
	// 			const firstLine = command.substring(0, firstLineEnd);
	// 			const remainingChars = command.length - firstLineEnd - 1;
	// 			command = firstLine + `\n... [${remainingChars} characters of heredoc content]`;
	// 		}
	// 	} else {
	// 		command = command.substring(0, MAX_CONTENT_LENGTH) + `\n... [${command.length - MAX_CONTENT_LENGTH} more characters]`;
	// 	}
	// }

	invocation.invocationMessage = args.description ? new MarkdownString(args.description) : '';
	invocation.toolSpecificData = {
		commandLine: {
			original: command,
		},
		language: toolName === 'bash' ? 'bash' : 'powershell'
	} as ChatTerminalToolInvocationData;
}

function formatGenericInvocation(invocation: ChatToolInvocationPart, toolCall: UnknownToolCall): void {
	invocation.invocationMessage = l10n.t("Used tool: {0}", toolCall.toolName);
}

function formatUriForMessage(path: string): string {
	return `[](${URI.file(path).toString()})`;
}
