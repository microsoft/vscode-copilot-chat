/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent, ToolExecutionCompleteEvent, ToolExecutionStartEvent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type { ChatPromptReference, ChatTerminalToolInvocationData, ChatTodoStatus, ChatTodoToolInvocationData, ExtendedChatResponsePart } from 'vscode';
import { ILogger } from '../../../../platform/log/common/logService';
import { isLocation } from '../../../../util/common/types';
import { decodeBase64 } from '../../../../util/vs/base/common/buffer';
import { ResourceSet } from '../../../../util/vs/base/common/map';
import { isAbsolutePath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatMcpToolInvocationData, ChatRequestTurn2, ChatResponseCodeblockUriPart, ChatResponseMarkdownPart, ChatResponsePullRequestPart, ChatResponseTextEditPart, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatToolInvocationPart, Location, MarkdownString, McpToolInvocationContentData, Range, Uri } from '../../../../vscodeTypes';
import type { MCP } from '../../../common/modelContextProtocol';
import { formatUriForFileWidget } from '../../../tools/common/toolUtils';
import { extractChatPromptReferences, getFolderAttachmentPath } from './copilotCLIPrompt';
import { IChatDelegationSummaryService } from './delegationSummaryService';


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
	toolName: 'grep' | 'rg';
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

type UpdateTodoTool = {
	toolName: 'update_todo';
	arguments: {
		todos: string;
	};
};

type ReportProgressTool = {
	toolName: 'report_progress';
	arguments: {
		commitMessage: string;
		prDescription: string;
	};
};

type WebFetchTool = {
	toolName: 'web_fetch';
	arguments: {
		url: string;
	};
};

type WebSearchTool = {
	toolName: 'web_search';
	arguments: {
		query: string;
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
	ReplyToCommentTool | CodeReviewTool | WebFetchTool | UpdateTodoTool | WebSearchTool;

export type ToolCall = ToolInfo & {
	toolCallId: string;
	mcpServerName?: string | undefined;
	mcpToolName?: string | undefined;
};
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
		.replace(/<user_query[^>]*\/?>\s*/g, '')
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
			.replace(/&apos;/g, `'`)
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
export function buildChatHistoryFromEvents(sessionId: string, events: readonly SessionEvent[], getVSCodeRequestId: (sdkRequestId: string) => { requestId: string; toolIdEditMap: Record<string, string> } | undefined, delegationSummaryService: IChatDelegationSummaryService, logger: ILogger, workingDirectory?: URI): (ChatRequestTurn2 | ChatResponseTurn2)[] {
	const turns: (ChatRequestTurn2 | ChatResponseTurn2)[] = [];
	let currentResponseParts: ExtendedChatResponsePart[] = [];
	const pendingToolInvocations = new Map<string, [ChatToolInvocationPart, toolData: ToolCall]>();

	let details: { requestId: string; toolIdEditMap: Record<string, string> } | undefined;
	let isFirstUserMessage = true;
	const currentAssistantMessage: { chunks: string[] } = { chunks: [] };
	const processedMessages = new Set<string>();

	function processAssistantMessage(content: string) {
		// Extract PR metadata if present
		const { cleanedContent, prPart } = extractPRMetadata(content);
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

	function flushPendingAssistantMessage() {
		if (currentAssistantMessage.chunks.length > 0) {
			const content = currentAssistantMessage.chunks.join('');
			currentAssistantMessage.chunks = [];
			processAssistantMessage(content);
		}
	}

	for (const event of events) {
		details = getVSCodeRequestId(event.id) ?? details;
		if (event.type !== 'assistant.message') {
			flushPendingAssistantMessage();
		}

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
					type: 'file' | 'directory';
					displayName: string;
				};
				// Filter out vscode instruction files from references when building session history
				// TODO@rebornix filter instructions should be rendered as "references" in chat response like normal chat.
				const references: ChatPromptReference[] = [];

				try {
					references.push(...extractChatPromptReferences(event.data.content || ''));
				} catch (ex) {
					// ignore errors from parsing references
				}
				const existingReferences = new ResourceSet();
				references.forEach(ref => {
					if (URI.isUri(ref.value)) {
						existingReferences.add(ref.value);
					} else if (isLocation(ref.value)) {
						existingReferences.add(ref.value.uri);
					}
				});
				((event.data.attachments || []) as Attachment[])
					.filter(attachment => !isInstructionAttachmentPath(attachment.path))
					.forEach(attachment => {
						const range = attachment.displayName ? getRangeInPrompt(event.data.content || '', attachment.displayName) : undefined;
						const attachmentPath = attachment.type === 'directory' ?
							getFolderAttachmentPath(attachment.path) :
							attachment.path;
						const uri = Uri.file(attachmentPath);
						if (existingReferences.has(uri)) {
							return; // Skip duplicates
						}
						references.push({
							id: attachment.path,
							name: attachment.displayName,
							value: uri,
							range
						});
					});

				let prompt = stripReminders(event.data.content || '');
				const info = isFirstUserMessage ? delegationSummaryService.extractPrompt(sessionId, prompt) : undefined;
				if (info) {
					prompt = info.prompt;
					references.push(info.reference);
				}
				isFirstUserMessage = false;
				turns.push(new ChatRequestTurn2(prompt, undefined, references, '', [], undefined, details?.requestId));
				break;
			}
			case 'assistant.message_delta': {
				if (typeof event.data.deltaContent === 'string') {
					processedMessages.add(event.data.messageId);
					currentAssistantMessage.chunks.push(event.data.deltaContent);
				}
				break;
			}
			case 'session.error': {
				currentResponseParts.push(new ChatResponseMarkdownPart(`\n\n❌ Error: (${event.data.errorType}) ${event.data.message}`));
				break;
			}
			case 'assistant.message': {
				if (event.data.content && !processedMessages.has(event.data.messageId)) {
					processAssistantMessage(event.data.content);
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
				const [responsePart, toolCall] = processToolExecutionComplete(event, pendingToolInvocations, logger, workingDirectory) ?? [undefined, undefined];
				if (responsePart && toolCall && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
					const editId = details?.toolIdEditMap ? details.toolIdEditMap[toolCall.toolCallId] : undefined;
					const editedUris = getAffectedUrisForEditTool(toolCall);
					if (isCopilotCliEditToolCall(toolCall) && editId && editedUris.length > 0) {
						responsePart.presentation = 'hidden';
						currentResponseParts.push(responsePart);
						for (const uri of editedUris) {
							currentResponseParts.push(new ChatResponseMarkdownPart('\n````\n'));
							currentResponseParts.push(new ChatResponseCodeblockUriPart(uri, true, editId));
							currentResponseParts.push(new ChatResponseTextEditPart(uri, []));
							currentResponseParts.push(new ChatResponseTextEditPart(uri, true));
							currentResponseParts.push(new ChatResponseMarkdownPart('\n````\n'));
						}
					} else {
						currentResponseParts.push(responsePart);
					}
				}
				break;
			}
		}
	}

	flushPendingAssistantMessage();

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

/**
 * Converts MCP {@link MCP.ContentBlock}[] values produced by MCP tool execution into
 * VS Code {@link McpToolInvocationContentData}[] objects for rendering in the chat UI.
 *
 * MCP ContentBlocks represent heterogeneous pieces of tool output such as text, images,
 * audio, embedded resources, or resource links. This helper normalizes those different
 * content shapes into a common binary+MIME-type representation that the VS Code chat
 * tool invocation renderer understands, so that MCP tool results can be displayed
 * consistently alongside other chat responses.
 */
function convertMcpContentToToolInvocationData(blocks: MCP.ContentBlock[], logger: ILogger): McpToolInvocationContentData[] {
	const output: McpToolInvocationContentData[] = [];
	const encoder = new TextEncoder();

	for (const block of blocks) {
		try {
			switch (block.type) {
				case 'text':
					// Convert text to UTF-8 bytes with text/plain mime type
					output.push(new McpToolInvocationContentData(
						encoder.encode(block.text),
						'text/plain'
					));
					break;

				case 'image':
					// Decode base64 image data and preserve mime type
					output.push(new McpToolInvocationContentData(
						decodeBase64(block.data).buffer,
						block.mimeType
					));
					break;

				case 'audio':
					// Decode base64 audio data and preserve mime type
					output.push(new McpToolInvocationContentData(
						decodeBase64(block.data).buffer,
						block.mimeType
					));
					break;

				case 'resource': {
					// Handle embedded resource (text or blob)
					const resource = block.resource;
					if ('text' in resource) {
						// TextResourceContents
						const mimeType = resource.mimeType || 'text/plain';
						output.push(new McpToolInvocationContentData(
							encoder.encode(resource.text),
							mimeType
						));
					} else if ('blob' in resource) {
						// BlobResourceContents
						const mimeType = resource.mimeType || 'application/octet-stream';
						output.push(new McpToolInvocationContentData(
							decodeBase64(resource.blob).buffer,
							mimeType
						));
					}
					break;
				}

				case 'resource_link': {
					// Format resource link as readable text with name and URI
					const displayName = block.title || block.name;
					const linkText = displayName ? `Resource: ${displayName}\nURI: ${block.uri}` : block.uri;
					output.push(new McpToolInvocationContentData(
						encoder.encode(linkText),
						'text/plain'
					));
					break;
				}
			}
		} catch (error) {
			// Log conversion errors but continue processing other blocks
			logger.error(error, `Failed to convert MCP content block of type ${block.type}:`);
		}
	}

	return output;
}

export function processToolExecutionStart(event: ToolExecutionStartEvent, pendingToolInvocations: Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>): ChatToolInvocationPart | ChatResponseThinkingProgressPart | undefined {
	const toolInvocation = createCopilotCLIToolInvocation(event.data as ToolCall);
	if (toolInvocation) {
		// Store pending invocation to update with result later
		pendingToolInvocations.set(event.data.toolCallId, [toolInvocation, event.data as ToolCall]);
	}
	return toolInvocation;
}

export function processToolExecutionComplete(event: ToolExecutionCompleteEvent, pendingToolInvocations: Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>, logger: ILogger, workingDirectory?: URI): [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall] | undefined {
	const invocation = pendingToolInvocations.get(event.data.toolCallId);
	pendingToolInvocations.delete(event.data.toolCallId);

	if (invocation && invocation[0] instanceof ChatToolInvocationPart) {
		invocation[0].isComplete = true;
		invocation[0].isError = !!event.data.error;
		invocation[0].invocationMessage = event.data.error?.message || invocation[0].invocationMessage;
		if (!event.data.success && (event.data.error?.code === 'rejected' || event.data.error?.code === 'denied')) {
			invocation[0].isConfirmed = false;
		} else {
			invocation[0].isConfirmed = true;
		}
		const toolCall = invocation[1];

		// Convert MCP content to VS Code ChatMcpToolInvocationData format
		if ('mcpContent' in event.data) {
			const mcpContent = event.data.mcpContent as MCP.ContentBlock[] | undefined;
			if (mcpContent && mcpContent.length > 0) {
				const output = convertMcpContentToToolInvocationData(mcpContent, logger);
				// Use tool arguments as input, formatted as JSON
				const input = toolCall.arguments ? JSON.stringify(toolCall.arguments, null, 2) : '';

				invocation[0].toolSpecificData = {
					input,
					output
				} satisfies ChatMcpToolInvocationData;
			}
		}

		if (Object.hasOwn(ToolFriendlyNameAndHandlers, toolCall.toolName)) {
			const [, , postFormatter] = ToolFriendlyNameAndHandlers[toolCall.toolName];
			(postFormatter as PostInvocationFormatter)(invocation[0], toolCall, event.data, workingDirectory);
		} else if (toolCall.mcpServerName && toolCall.mcpToolName) {
			const toolCall = invocation[1];
			// Use tool arguments as input, formatted as JSON
			const input = toolCall.arguments ? JSON.stringify(toolCall.arguments, null, 2) : '';
			const mimeType = 'text/plain';
			const output: McpToolInvocationContentData[] = [new McpToolInvocationContentData(
				new TextEncoder().encode(event.data.result?.content || ''),
				mimeType
			)];

			invocation[0].toolSpecificData = {
				input,
				output
			} satisfies ChatMcpToolInvocationData;
		} else {
			genericToolInvocationCompleted(invocation[0], toolCall, event.data);
		}
	}

	return invocation;
}

/**
 * Creates a formatted tool invocation part for CopilotCLI tools
 */
export function createCopilotCLIToolInvocation(data: {
	toolCallId: string; toolName: string; arguments?: unknown; mcpServerName?: string | undefined;
	mcpToolName?: string | undefined;
}, editId?: string): ChatToolInvocationPart | ChatResponseThinkingProgressPart | undefined {
	if (!Object.hasOwn(ToolFriendlyNameAndHandlers, data.toolName)) {
		const mcpServer = l10n.t('MCP Server');
		const toolName = data.mcpServerName && data.mcpToolName ? `${data.mcpServerName}, ${data.mcpToolName} (${mcpServer})` : data.toolName;
		const invocation = new ChatToolInvocationPart(toolName ?? 'unknown', data.toolCallId ?? '', false);
		invocation.isConfirmed = false;
		invocation.isComplete = false;
		invocation.invocationMessage = l10n.t("Using tool: {0}", toolName ?? 'unknown');
		invocation.pastTenseMessage = l10n.t("Used tool: {0}", toolName ?? 'unknown');
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

	(formatter as Formatter)(invocation, toolCall, editId);
	return invocation;
}

type Formatter = (invocation: ChatToolInvocationPart, toolCall: ToolCall, editId?: string) => void;
type PostInvocationFormatter = (invocation: ChatToolInvocationPart, toolCall: ToolCall, result: ToolCallResult, workingDirectory?: URI) => void;
type ToolCallFor<T extends ToolCall['toolName']> = Extract<ToolCall, { toolName: T }>;
type ToolCallResult = ToolExecutionCompleteEvent['data'];


const ToolFriendlyNameAndHandlers: { [K in ToolCall['toolName']]: [title: string, pre: (invocation: ChatToolInvocationPart, toolCall: ToolCallFor<K>) => void, post: (invocation: ChatToolInvocationPart, toolCall: ToolCallFor<K>, result: ToolCallResult, workingDirectory?: URI) => void] } = {
	'str_replace_editor': [l10n.t('Edit File'), formatStrReplaceEditorInvocation, genericToolInvocationCompleted],
	'edit': [l10n.t('Edit File'), formatEditToolInvocation, genericToolInvocationCompleted],
	'str_replace': [l10n.t('Edit File'), formatEditToolInvocation, genericToolInvocationCompleted],
	'create': [l10n.t('Create File'), formatCreateToolInvocation, genericToolInvocationCompleted],
	'insert': [l10n.t('Edit File'), formatInsertToolInvocation, genericToolInvocationCompleted],
	'undo_edit': [l10n.t('Edit File'), formatUndoEdit, genericToolInvocationCompleted],
	'view': [l10n.t('Read'), formatViewToolInvocation, genericToolInvocationCompleted],
	'bash': [l10n.t('Run Shell Command'), formatShellInvocation, formatShellInvocationCompleted],
	'powershell': [l10n.t('Run Shell Command'), formatShellInvocation, formatShellInvocationCompleted],
	'write_bash': [l10n.t('Write to Bash'), emptyInvocation, genericToolInvocationCompleted],
	'write_powershell': [l10n.t('Write to PowerShell'), emptyInvocation, genericToolInvocationCompleted],
	'read_bash': [l10n.t('Read Terminal'), emptyInvocation, genericToolInvocationCompleted],
	'read_powershell': [l10n.t('Read Terminal'), emptyInvocation, genericToolInvocationCompleted],
	'stop_bash': [l10n.t('Stop Terminal Session'), emptyInvocation, genericToolInvocationCompleted],
	'stop_powershell': [l10n.t('Stop Terminal Session'), emptyInvocation, genericToolInvocationCompleted],
	'search': [l10n.t('Search'), formatSearchToolInvocation, genericToolInvocationCompleted],
	'grep': [l10n.t('Search'), formatSearchToolInvocation, formatSearchToolInvocationCompleted],
	'rg': [l10n.t('Search'), formatSearchToolInvocation, formatSearchToolInvocationCompleted],
	'glob': [l10n.t('Search'), formatSearchToolInvocation, formatSearchToolInvocationCompleted],
	'search_bash': [l10n.t('Search'), formatSearchToolInvocation, genericToolInvocationCompleted],
	'semantic_code_search': [l10n.t('Search'), formatSearchToolInvocation, genericToolInvocationCompleted],
	'reply_to_comment': [l10n.t('Reply to Comment'), formatReplyToCommentInvocation, genericToolInvocationCompleted],
	'code_review': [l10n.t('Code Review'), formatCodeReviewInvocation, genericToolInvocationCompleted],
	'report_intent': [l10n.t('Report Intent'), emptyInvocation, genericToolInvocationCompleted],
	'think': [l10n.t('Thinking'), emptyInvocation, genericToolInvocationCompleted],
	'report_progress': [l10n.t('Progress update'), formatProgressToolInvocation, genericToolInvocationCompleted],
	'web_fetch': [l10n.t('Fetch Web Content'), emptyInvocation, genericToolInvocationCompleted],
	'web_search': [l10n.t('Web Search'), emptyInvocation, genericToolInvocationCompleted],
	'update_todo': [l10n.t('Update Todo'), formatUpdateTodoInvocation, formatUpdateTodoInvocationCompleted],
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
		const [start, end] = args.view_range;
		const location = new Location(Uri.file(args.path), new Range(start === 0 ? start : start - 1, 0, end, 0));
		const display = formatUriForFileWidget(location);
		const localizedMessage = start === end
			? l10n.t("Reading {0}, line {1}", display, start)
			: l10n.t("Reading {0}, lines {1} to {2}", display, start, end);
		const localizedPastTenseMessage = start === end
			? l10n.t("Read {0}, line {1}", display, start)
			: l10n.t("Read {0}, lines {1} to {2}", display, start, end);
		invocation.invocationMessage = new MarkdownString(localizedMessage);
		invocation.pastTenseMessage = new MarkdownString(localizedPastTenseMessage);
	} else {
		const display = formatUriForFileWidget(Uri.file(args.path));
		invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
	}
}

function formatStrReplaceEditorInvocation(invocation: ChatToolInvocationPart, toolCall: StringReplaceEditorTool, editId?: string): void {
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
		invocation.invocationMessage = new MarkdownString(l10n.t("Undoing edit in {0}", formatUriForFileWidget(Uri.file(args.path))));
		invocation.pastTenseMessage = new MarkdownString(l10n.t("Undid edit in {0}", formatUriForFileWidget(Uri.file(args.path))));
	}
}

function formatEditToolInvocation(invocation: ChatToolInvocationPart, toolCall: EditTool, editId?: string): void {
	const args = toolCall.arguments;
	const display = args.path ? formatUriForFileWidget(Uri.file(args.path)) : '';

	invocation.invocationMessage = display
		? new MarkdownString(l10n.t("Editing {0}", display))
		: new MarkdownString(l10n.t("Editing file"));
	invocation.pastTenseMessage = display
		? new MarkdownString(l10n.t("Edited {0}", display))
		: new MarkdownString(l10n.t("Edited file"));
}


function formatCreateToolInvocation(invocation: ChatToolInvocationPart, toolCall: CreateTool, editId?: string): void {
	const args = toolCall.arguments;
	const display = args.path ? formatUriForFileWidget(Uri.file(args.path)) : '';

	if (display) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Creating {0}", display));
		invocation.pastTenseMessage = new MarkdownString(l10n.t("Created {0}", display));
	} else {
		invocation.invocationMessage = new MarkdownString(l10n.t("Creating file"));
		invocation.pastTenseMessage = new MarkdownString(l10n.t("Created file"));
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

	invocation.toolSpecificData = {
		commandLine: {
			original: command,
		},
		language: toolCall.toolName === 'bash' ? 'bash' : 'powershell'
	} as ChatTerminalToolInvocationData;
}
function formatShellInvocationCompleted(invocation: ChatToolInvocationPart, toolCall: ShellTool, result: ToolCallResult): void {
	const resultContent = result.result?.content || '';
	// Exit code will be at the end of the result in the last line in the form of `<exited with exit code ${output.exitCode}>`,
	const exitCodeStr = resultContent ? /<exited with exit code (\d+)>$/.exec(resultContent)?.[1] : undefined;
	const exitCode = exitCodeStr ? parseInt(exitCodeStr, 10) : undefined;
	// Lets remove the last line containing the exit code from the output.
	const text = (exitCode !== undefined ? resultContent.replace(/<exited with exit code \d+>$/, '').trimEnd() : resultContent).replace(/\n/g, '\r\n');
	const toolSpecificData: ChatTerminalToolInvocationData = {
		commandLine: {
			original: toolCall.arguments.command,
		},
		language: toolCall.toolName === 'bash' ? 'bash' : 'powershell',
		state: {
			exitCode
		},
		output: {
			text
		}
	};
	invocation.toolSpecificData = toolSpecificData;
}
function formatSearchToolInvocation(invocation: ChatToolInvocationPart, toolCall: SearchTool | GLobTool | GrepTool | SearchBashTool | SemanticCodeSearchTool): void {
	if (toolCall.toolName === 'search') {
		invocation.invocationMessage = `Criteria: ${toolCall.arguments.question}  \nReason: ${toolCall.arguments.reason}`;
	} else if (toolCall.toolName === 'semantic_code_search') {
		invocation.invocationMessage = `Criteria: ${toolCall.arguments.question}`;
	} else if (toolCall.toolName === 'search_bash') {
		invocation.invocationMessage = `Command: \`${toolCall.arguments.command}\``;
	} else if (toolCall.toolName === 'glob') {
		const searchInPath = toolCall.arguments.path ? ` in \`${toolCall.arguments.path}\`` : '';
		invocation.invocationMessage = `Search for files matching \`${toolCall.arguments.pattern}\`${searchInPath}`;
		invocation.pastTenseMessage = `Searched for files matching \`${toolCall.arguments.pattern}\`${searchInPath}`;
	} else if (toolCall.toolName === 'grep' || toolCall.toolName === 'rg') {
		const searchInPath = toolCall.arguments.path ? ` in \`${toolCall.arguments.path}\`` : '';
		invocation.invocationMessage = `Search for files matching \`${toolCall.arguments.pattern}\`${searchInPath}`;
		invocation.pastTenseMessage = `Searched for files matching \`${toolCall.arguments.pattern}\`${searchInPath}`;
	}
}

function formatSearchToolInvocationCompleted(invocation: ChatToolInvocationPart, toolCall: SearchTool | GLobTool | GrepTool | SearchBashTool | SemanticCodeSearchTool, result: ToolCallResult, workingDirectory?: URI): void {
	if (toolCall.toolName === 'search') {
		// invocation.invocationMessage = `Criteria: ${toolCall.arguments.question}  \nReason: ${toolCall.arguments.reason}`;
	} else if (toolCall.toolName === 'semantic_code_search') {
		// invocation.invocationMessage = `Criteria: ${toolCall.arguments.question}`;
	} else if (toolCall.toolName === 'search_bash') {
		// invocation.invocationMessage = `Command: \`${toolCall.arguments.command}\``;
	} else if (toolCall.toolName === 'glob' || toolCall.toolName === 'grep' || toolCall.toolName === 'rg') {
		const messagesIndicatingNoMatches = ['Pattern matched but no output generated', 'Pattern matched but no files found', 'No matches found', 'no files matched the pattern'].map(msg => msg.toLowerCase());
		const noMatches = messagesIndicatingNoMatches.some(msg => (result.result?.content || '').toLowerCase().includes(msg));
		const searchInPath = toolCall.arguments.path ? ` in \`${toolCall.arguments.path}\`` : '';
		const files = !noMatches && result.success && typeof result.result?.content === 'string' ? result.result.content.split('\n') : [];
		const successMessage = files.length ? `, ${files.length} result${files.length > 1 ? 's' : ''}` : '.';
		invocation.pastTenseMessage = `Searched for files matching \`${toolCall.arguments.pattern}\`${searchInPath}${successMessage}`;
		let searchPath = toolCall.arguments.path ? Uri.file(toolCall.arguments.path) : workingDirectory;
		if (toolCall.arguments.path && workingDirectory && searchPath && !isAbsolutePath(searchPath)) {
			searchPath = Uri.joinPath(workingDirectory, toolCall.arguments.path);
		}
		invocation.toolSpecificData = {
			values: files.map(file => {
				if (!file.startsWith('./') || !searchPath) {
					return Uri.file(file);
				}
				return Uri.joinPath(searchPath, file.substring(2));
			})
		};
	}
}

function formatCodeReviewInvocation(invocation: ChatToolInvocationPart, toolCall: CodeReviewTool): void {
	invocation.invocationMessage = toolCall.arguments.prTitle;
	invocation.originMessage = toolCall.arguments.prDescription;
}

function formatReplyToCommentInvocation(invocation: ChatToolInvocationPart, toolCall: ReplyToCommentTool): void {
	invocation.invocationMessage = `Replying to comment_id ${toolCall.arguments.comment_id}`;
	invocation.pastTenseMessage = `Replied to comment_id ${toolCall.arguments.comment_id}`;
	invocation.originMessage = toolCall.arguments.reply;
}


/**
 * Parse markdown todo list into structured ChatTodoToolInvocationData.
 * Extracts title from first non-empty line (strips leading #), parses checklist items,
 * and generates sequential numeric IDs.
 */
function parseTodoMarkdown(markdown: string): { title: string; todoList: Array<{ id: number; title: string; status: ChatTodoStatus }> } {
	const lines = markdown.split('\n');
	const todoList: Array<{ id: number; title: string; status: ChatTodoStatus }> = [];
	let title = 'Updated todo list';
	let inCodeBlock = false;
	let currentItem: { title: string; status: ChatTodoStatus } | null = null;

	for (const line of lines) {
		// Track code fences
		if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
			inCodeBlock = !inCodeBlock;
			continue;
		}

		// Skip lines inside code blocks
		if (inCodeBlock) {
			continue;
		}

		// Extract title from first non-empty line
		if (title === 'Updated todo list' && line.trim()) {
			const trimmed = line.trim();
			// Check if it's not a list item
			if (!trimmed.match(/^[-*+]\s+\[.\]/) && !trimmed.match(/^\d+[.)]\s+\[.\]/)) {
				// Strip leading # for headings
				title = trimmed.replace(/^#+\s*/, '');
			}
		}

		// Parse checklist items (unordered and ordered lists)
		const unorderedMatch = line.match(/^\s*[-*+]\s+\[(.?)\]\s*(.*)$/);
		const orderedMatch = line.match(/^\s*\d+[.)]\s+\[(.?)\]\s*(.*)$/);
		const match = unorderedMatch || orderedMatch;

		if (match) {
			// Save previous item if exists
			if (currentItem && currentItem.title.trim()) {
				todoList.push({
					id: todoList.length + 1,
					title: currentItem.title.trim(),
					status: currentItem.status
				});
			}

			const checkboxChar = match[1];
			const itemTitle = match[2];

			// Map checkbox character to status
			let status: ChatTodoStatus;
			if (checkboxChar === 'x' || checkboxChar === 'X') {
				status = 3; // ChatTodoStatus.Completed
			} else if (checkboxChar === '>' || checkboxChar === '~') {
				status = 2; // ChatTodoStatus.InProgress
			} else {
				status = 1; // ChatTodoStatus.NotStarted
			}

			currentItem = { title: itemTitle, status };
		} else if (currentItem && line.trim() && (line.startsWith('  ') || line.startsWith('\t'))) {
			// Continuation line - append to current item
			currentItem.title += ' ' + line.trim();
		}
	}

	// Add the last item
	if (currentItem && currentItem.title.trim()) {
		todoList.push({
			id: todoList.length + 1,
			title: currentItem.title.trim(),
			status: currentItem.status
		});
	}

	return { title, todoList };
}

function formatUpdateTodoInvocation(invocation: ChatToolInvocationPart, toolCall: UpdateTodoTool): void {
	const args = toolCall.arguments;
	const parsed = args.todos ? parseTodoMarkdown(args.todos) : { title: '', todoList: [] };
	if (!args.todos || !parsed) {
		invocation.invocationMessage = 'Updating todo list';
		invocation.pastTenseMessage = 'Updated todo list';
		return;
	}

	invocation.invocationMessage = parsed.title;
	invocation.toolSpecificData = {
		todoList: parsed.todoList
	} as ChatTodoToolInvocationData;
}

function formatUpdateTodoInvocationCompleted(invocation: ChatToolInvocationPart, toolCall: UpdateTodoTool, result: ToolCallResult): void {
	const parsed = toolCall.arguments.todos ? parseTodoMarkdown(toolCall.arguments.todos) : { title: '', todoList: [] };
	// Re-parse todo markdown on completion to ensure UI has final state
	if (parsed.todoList.length > 0) {
		invocation.invocationMessage = parsed.title;
		invocation.toolSpecificData = {
			todoList: parsed.todoList
		} as ChatTodoToolInvocationData;
	}

}

/**
 * No-op formatter for tool invocations that do not require custom formatting.
 * The `toolCall` parameter is unused and present for interface consistency.
 */
function emptyInvocation(_invocation: ChatToolInvocationPart, _toolCall: UnknownToolCall): void {
	// No custom formatting needed
}

function genericToolInvocationCompleted(invocation: ChatToolInvocationPart, toolCall: UnknownToolCall, result: ToolCallResult): void {
	if (result.success && result.result?.content) {
		invocation.toolSpecificData = {
			output: typeof result.result.content === 'string' ? result.result.content : JSON.stringify(result.result.content, null, 2),
			input: toolCall.arguments ? JSON.stringify(toolCall.arguments, null, 2) : ''
		};
	}

}
