/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent, ToolExecutionCompleteEvent, ToolExecutionStartEvent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type { ChatPromptReference, ChatTerminalToolInvocationData, ExtendedChatResponsePart } from 'vscode';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponsePullRequestPart, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatToolInvocationPart, MarkdownString, Uri } from '../../../../vscodeTypes';
import { formatUriForFileWidget } from '../../../tools/common/toolUtils';
import { extractChatPromptReferences } from './copilotCLIPrompt';


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
	toolName: 'edit' | 'str_replace';
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

type SearchTool = {
	toolName: 'search';
	arguments: {
		question: string;
		reason: string;
		searchCommand: string;
	};
};

type SearchBashTool = {
	toolName: 'search_bash';
	arguments: {
		command: string;
	};
};

type SemanticCodeSearchTool = {
	toolName: 'semantic_code_search';
	arguments: {
		question: string;
	};
};

type ReplyToCommentTool = {
	toolName: 'reply_to_comment';
	arguments: {
		reply: string;
		comment_id: string;
	};
};

type CodeReviewTool = {
	toolName: 'code_review';
	arguments: {
		prTitle: string;
		prDescription: string;
	};
};


type StringReplaceArgumentTypes = CreateTool | ViewTool | StrReplaceTool | EditTool | InsertTool | UndoEditTool;
type ToStringReplaceEditorArguments<T extends StringReplaceArgumentTypes> = {
	command: T['toolName'];
} & T['arguments'];
type StringReplaceEditorTool = {
	toolName: 'str_replace_editor';
	arguments: ToStringReplaceEditorArguments<CreateTool> | ToStringReplaceEditorArguments<ViewTool> | ToStringReplaceEditorArguments<EditTool> | ToStringReplaceEditorArguments<StrReplaceTool> |
	ToStringReplaceEditorArguments<UndoEditTool> | ToStringReplaceEditorArguments<InsertTool>;
};
export type ToolInfo = StringReplaceEditorTool | EditTool | CreateTool | ViewTool | UndoEditTool | InsertTool |
	ShellTool | WriteShellTool | ReadShellTool | StopShellTool |
	GrepTool | GLobTool |
	ReportIntentTool | ThinkTool | ReportProgressTool |
	SearchTool | SearchBashTool | SemanticCodeSearchTool |
	ReplyToCommentTool | CodeReviewTool;

export type ToolCall = ToolInfo & { toolCallId: string };
export type UnknownToolCall = { toolName: string; arguments: unknown; toolCallId: string };

function isInstructionAttachmentPath(path: string): boolean {
	const normalizedPath = path.replace(/\\/g, '/');
	return normalizedPath.endsWith('/.github/copilot-instructions.md')
		|| (normalizedPath.includes('/.github/instructions/') && normalizedPath.endsWith('.md'));
}

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
		.replace(/<attachments>[\s\S]*?<\/attachments>\s*/g, '')
		.replace(/<userRequest>[\s\S]*?<\/userRequest>\s*/g, '')
		.replace(/<context>[\s\S]*?<\/context>\s*/g, '')
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
				// Filter out vscode instruction files from references when building session history
				// TODO@rebornix filter instructions should be rendered as "references" in chat response like normal chat.
				const references: ChatPromptReference[] = ((event.data.attachments || []) as Attachment[])
					.filter(attachment => !isInstructionAttachmentPath(attachment.path))
					.map(attachment => {
						const range = attachment.displayName ? getRangeInPrompt(event.data.content || '', attachment.displayName) : undefined;
						return ({
							id: attachment.path,
							name: attachment.displayName,
							value: Uri.file(attachment.path), range
						} satisfies ChatPromptReference);
					});

				try {
					const pomptReferences = extractChatPromptReferences(event.data.content || '');
					references.push(...pomptReferences.references);
				} catch (ex) {
					// ignore errors from parsing references
				}
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

function getRangeInPrompt(prompt: string, referencedName: string): [number, number] | undefined {
	referencedName = `#${referencedName}`;
	const index = prompt.indexOf(referencedName);
	if (index >= 0) {
		return [index, index + referencedName.length];
	}
	return undefined;
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
	if (!Object.hasOwn(ToolFriendlyNameAndHandlers, data.toolName)) {
		const invocation = new ChatToolInvocationPart(data.toolName ?? 'unknown', data.toolCallId ?? '', false);
		invocation.isConfirmed = false;
		invocation.isComplete = false;
		formatGenericInvocation(invocation, data as ToolCall);
		return invocation;
	}

	const toolCall = data as ToolCall;
	// Ensures arguments is at least an empty object
	toolCall.arguments = toolCall.arguments ?? {};
	if (toolCall.toolName === 'report_intent') {
		return undefined; // Ignore these for now
	}
	if (toolCall.toolName === 'think') {
		if (toolCall.arguments && typeof toolCall.arguments.thought === 'string') {
			return new ChatResponseThinkingProgressPart(toolCall.arguments.thought);
		}
		return undefined;
	}

	const [friendlyToolName, formatter] = ToolFriendlyNameAndHandlers[toolCall.toolName];
	const invocation = new ChatToolInvocationPart(friendlyToolName ?? toolCall.toolName ?? 'unknown', toolCall.toolCallId ?? '', false);
	invocation.isConfirmed = false;
	invocation.isComplete = false;

	(formatter as Formatter)(invocation, toolCall);
	return invocation;
}

type Formatter = (invocation: ChatToolInvocationPart, toolCall: ToolCall) => void;
type ToolCallFor<T extends ToolCall['toolName']> = Extract<ToolCall, { toolName: T }>;

const ToolFriendlyNameAndHandlers: { [K in ToolCall['toolName']]: [string, (invocation: ChatToolInvocationPart, toolCall: ToolCallFor<K>) => void] } = {
	'str_replace_editor': [l10n.t('Edit File'), formatStrReplaceEditorInvocation],
	'edit': [l10n.t('Edit File'), formatEditToolInvocation],
	'str_replace': [l10n.t('Edit File'), formatEditToolInvocation],
	'create': [l10n.t('Create File'), formatCreateToolInvocation],
	'insert': [l10n.t('Edit File'), formatInsertToolInvocation],
	'undo_edit': [l10n.t('Edit File'), formatUndoEdit],
	'view': [l10n.t('Read'), formatViewToolInvocation],
	'bash': [l10n.t('Run Shell Command'), formatShellInvocation],
	'powershell': [l10n.t('Run Shell Command'), formatShellInvocation],
	'write_bash': [l10n.t('Write to Bash'), emptyInvocation],
	'write_powershell': [l10n.t('Write to PowerShell'), emptyInvocation],
	'read_bash': [l10n.t('Read Terminal'), emptyInvocation],
	'read_powershell': [l10n.t('Read Terminal'), emptyInvocation],
	'stop_bash': [l10n.t('Stop Terminal Session'), emptyInvocation],
	'stop_powershell': [l10n.t('Stop Terminal Session'), emptyInvocation],
	'search': [l10n.t('Search'), formatSearchToolInvocation],
	'grep': [l10n.t('Search'), formatSearchToolInvocation],
	'glob': [l10n.t('Search'), formatSearchToolInvocation],
	'search_bash': [l10n.t('Search'), formatSearchToolInvocation],
	'semantic_code_search': [l10n.t('Search'), formatSearchToolInvocation],
	'reply_to_comment': [l10n.t('Reply to Comment'), formatReplyToCommentInvocation],
	'code_review': [l10n.t('Review Code'), formatCodeReviewInvocation],
	'report_intent': [l10n.t('Report Intent'), emptyInvocation],
	'think': [l10n.t('Thinking'), emptyInvocation],
	'report_progress': [l10n.t('Progress Update'), formatProgressToolInvocation],
};


function formatProgressToolInvocation(invocation: ChatToolInvocationPart, toolCall: ReportProgressTool): void {
	const args = toolCall.arguments;
	invocation.invocationMessage = args.prDescription?.trim() || 'Progress Update';
	if (args.commitMessage) {
		invocation.originMessage = `Commit: ${args.commitMessage}`;
	}
}
function formatViewToolInvocation(invocation: ChatToolInvocationPart, toolCall: ViewTool): void {
	const args = toolCall.arguments;

	if (!args.path) {
		return;
	} else if (args.view_range && args.view_range[1] >= args.view_range[0]) {
		const display = formatUriForFileWidget(Uri.file(args.path));
		const [start, end] = args.view_range;
		const localizedMessage = start === end
			? l10n.t("Read {0}, line {1}", display, start)
			: l10n.t("Read {0}, lines {1} to {2}", display, start, end);
		invocation.invocationMessage = new MarkdownString(localizedMessage);
	} else {
		const display = formatUriForFileWidget(Uri.file(args.path));
		invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
	}
}

function formatStrReplaceEditorInvocation(invocation: ChatToolInvocationPart, toolCall: StringReplaceEditorTool): void {
	if (!toolCall.arguments.path) {
		return;
	}
	const args = toolCall.arguments;
	const display = formatUriForFileWidget(Uri.file(args.path));
	switch (args.command) {
		case 'view':
			formatViewToolInvocation(invocation, { toolName: 'view', arguments: args } as ViewTool);
			break;
		case 'edit':
			formatEditToolInvocation(invocation, { toolName: 'edit', arguments: args } as EditTool);
			break;
		case 'insert':
			formatInsertToolInvocation(invocation, { toolName: 'insert', arguments: args } as InsertTool);
			break;
		case 'create':
			formatCreateToolInvocation(invocation, { toolName: 'create', arguments: args } as CreateTool);
			break;
		case 'undo_edit':
			formatUndoEdit(invocation, { toolName: 'undo_edit', arguments: args } as UndoEditTool);
			break;
		default:
			invocation.invocationMessage = new MarkdownString(l10n.t("Modified {0}", display));
	}
}

function formatInsertToolInvocation(invocation: ChatToolInvocationPart, toolCall: InsertTool): void {
	const args = toolCall.arguments;
	if (args.path) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Inserted text in {0}", formatUriForFileWidget(Uri.file(args.path))));
	}
}

function formatUndoEdit(invocation: ChatToolInvocationPart, toolCall: UndoEditTool): void {
	const args = toolCall.arguments;
	if (args.path) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Undid edit in {0}", formatUriForFileWidget(Uri.file(args.path))));
	}
}

function formatEditToolInvocation(invocation: ChatToolInvocationPart, toolCall: EditTool): void {
	const args = toolCall.arguments;
	const display = args.path ? formatUriForFileWidget(Uri.file(args.path)) : '';

	invocation.invocationMessage = display
		? new MarkdownString(l10n.t("Edited {0}", display))
		: new MarkdownString(l10n.t("Edited file"));
}


function formatCreateToolInvocation(invocation: ChatToolInvocationPart, toolCall: CreateTool): void {
	const args = toolCall.arguments;
	const display = args.path ? formatUriForFileWidget(Uri.file(args.path)) : '';

	if (display) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Created {0}", display));
	} else {
		invocation.invocationMessage = new MarkdownString(l10n.t("Created file"));
	}
}

function formatShellInvocation(invocation: ChatToolInvocationPart, toolCall: ShellTool): void {
	const args = toolCall.arguments;
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
		language: toolCall.toolName === 'bash' ? 'bash' : 'powershell'
	} as ChatTerminalToolInvocationData;
}
function formatSearchToolInvocation(invocation: ChatToolInvocationPart, toolCall: SearchTool | GLobTool | GrepTool | SearchBashTool | SemanticCodeSearchTool): void {
	if (toolCall.toolName === 'search') {
		invocation.invocationMessage = `Criteria: ${toolCall.arguments.question}  \nReason: ${toolCall.arguments.reason}`;
	} else if (toolCall.toolName === 'semantic_code_search') {
		invocation.invocationMessage = `Criteria: ${toolCall.arguments.question}`;
	} else if (toolCall.toolName === 'search_bash') {
		invocation.invocationMessage = `Command: ${toolCall.arguments.command}`;
	} else if (toolCall.toolName === 'glob') {
		const searchInPath = toolCall.arguments.path ? ` in ${toolCall.arguments.path}` : '';
		invocation.invocationMessage = `Pattern: ${toolCall.arguments.pattern}${searchInPath}`;
	} else if (toolCall.toolName === 'grep') {
		const searchInPath = toolCall.arguments.path ? ` in ${toolCall.arguments.path}` : '';
		invocation.invocationMessage = `Pattern: ${toolCall.arguments.pattern}${searchInPath}`;
	}
}

function formatCodeReviewInvocation(invocation: ChatToolInvocationPart, toolCall: CodeReviewTool): void {
	invocation.invocationMessage = `**${toolCall.arguments.prTitle}**  \n${toolCall.arguments.prDescription}`;
}

function formatReplyToCommentInvocation(invocation: ChatToolInvocationPart, toolCall: ReplyToCommentTool): void {
	invocation.invocationMessage = toolCall.arguments.reply;
}

function formatGenericInvocation(invocation: ChatToolInvocationPart, toolCall: UnknownToolCall): void {
	invocation.invocationMessage = l10n.t("Used tool: {0}", toolCall.toolName ?? 'unknown');
}

/**
 * No-op formatter for tool invocations that do not require custom formatting.
 * The `toolCall` parameter is unused and present for interface consistency.
 */
function emptyInvocation(_invocation: ChatToolInvocationPart, _toolCall: UnknownToolCall): void {
	//
}
