/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { completeToolInvocation, createFormattedToolInvocation } from '../../agents/claude/common/toolInvocationFormatter';
import { AssistantMessageContent, ContentBlock, IClaudeCodeSession, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '../../agents/claude/node/sessionParser/claudeSessionSchema';

// #region Types

interface ToolContext {
	unprocessedToolCalls: Map<string, ContentBlock>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

// #endregion

// #region Type Guards

function isTextBlock(block: ContentBlock): block is TextBlock {
	return block.type === 'text';
}

function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
	return block.type === 'thinking';
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
	return block.type === 'tool_use';
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
	return block.type === 'tool_result';
}

// #endregion

// #region Text Content Helpers

/**
 * Checks if a text block contains a system-reminder tag.
 * System-reminders are stored in separate content blocks and should not be rendered.
 */
function isSystemReminderBlock(text: string): boolean {
	return text.includes('<system-reminder>');
}

/**
 * Strips <system-reminder> tags and their content from a string.
 * Used for backwards compatibility with legacy sessions where system-reminders
 * were concatenated with user text in a single string.
 *
 * TODO: Remove this function after a few releases (added in 0.38.x) once legacy
 * sessions with concatenated system-reminders are no longer common.
 */
function stripSystemReminders(text: string): string {
	return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '');
}

/**
 * Extracts visible text content from a user message, filtering out system reminders.
 */
function extractTextContent(content: string | ContentBlock[]): string {
	if (typeof content === 'string') {
		// TODO: Remove this branch when stripSystemReminders is removed (legacy compat)
		return stripSystemReminders(content);
	}

	// For array content (new format), filter out entire blocks that are system-reminders
	return content
		.filter(isTextBlock)
		.filter(block => !isSystemReminderBlock(block.text))
		.map(block => block.text)
		.join('');
}

// #endregion

// #region Tool Result Processing

/**
 * Processes tool result blocks from a user message, matching them to pending
 * tool invocations and marking them as complete.
 */
function processToolResults(content: string | ContentBlock[], toolContext: ToolContext): void {
	if (typeof content === 'string') {
		return;
	}

	for (const block of content) {
		if (isToolResultBlock(block)) {
			const toolUse = toolContext.unprocessedToolCalls.get(block.tool_use_id);
			if (toolUse && isToolUseBlock(toolUse)) {
				toolContext.unprocessedToolCalls.delete(block.tool_use_id);
				const pendingInvocation = toolContext.pendingToolInvocations.get(block.tool_use_id);
				if (pendingInvocation) {
					pendingInvocation.isComplete = true;
					pendingInvocation.isConfirmed = true;
					pendingInvocation.isError = block.is_error;
					// Populate tool output for display in chat UI
					completeToolInvocation(toolUse, block, pendingInvocation);
					toolContext.pendingToolInvocations.delete(block.tool_use_id);
				}
			}
		}
	}
}

// #endregion

// #region Turn Extraction

/**
 * Extracts a request turn from user message contents, ignoring tool results.
 * Returns undefined if the messages contain only tool results or system reminders.
 */
function extractUserRequest(contents: readonly (string | ContentBlock[])[]): vscode.ChatRequestTurn2 | undefined {
	const textParts: string[] = [];
	for (const content of contents) {
		const text = extractTextContent(content);
		if (text.trim()) {
			textParts.push(text);
		}
	}

	const combinedText = textParts.join('\n\n');

	// If no visible text, don't create a request turn
	if (!combinedText.trim()) {
		return;
	}

	// If the message indicates it was interrupted, skip it
	if (combinedText === '[Request interrupted by user]') {
		return;
	}

	return new ChatRequestTurn2(combinedText, undefined, [], '', [], undefined, undefined);
}

/**
 * Extracts response parts from consecutive assistant messages.
 */
function extractAssistantParts(messages: readonly AssistantMessageContent[], toolContext: ToolContext): (vscode.ChatResponseMarkdownPart | vscode.ChatResponseThinkingProgressPart | vscode.ChatToolInvocationPart)[] {
	const allParts: (vscode.ChatResponseMarkdownPart | vscode.ChatResponseThinkingProgressPart | vscode.ChatToolInvocationPart)[] = [];

	for (const message of messages) {
		const parts = coalesce(message.content.map(block => {
			if (isTextBlock(block)) {
				return new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(block.text));
			} else if (isThinkingBlock(block)) {
				return new vscode.ChatResponseThinkingProgressPart(block.thinking);
			} else if (isToolUseBlock(block)) {
				toolContext.unprocessedToolCalls.set(block.id, block);
				const toolInvocation = createFormattedToolInvocation(block);
				if (toolInvocation) {
					toolContext.pendingToolInvocations.set(block.id, toolInvocation);
				}
				return toolInvocation;
			}
		}));
		allParts.push(...parts);
	}

	return allParts;
}

// #endregion

// #region Main Entry Point

/**
 * Converts a Claude Code session into VS Code chat history turns.
 *
 * In the Anthropic API, tool results are sent as user messages, so a single
 * agentic turn (assistant calls tools, gets results, calls more tools, etc.)
 * appears as alternating assistant/user messages in the JSONL. VS Code's chat
 * API expects all of that to be a single ChatResponseTurn2, so we accumulate
 * response parts across tool-result boundaries and only finalize a response
 * when we encounter a user message with actual text (a new user request).
 */
export function buildChatHistory(session: IClaudeCodeSession): (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] {
	const result: (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] = [];
	const toolContext: ToolContext = {
		unprocessedToolCalls: new Map(),
		pendingToolInvocations: new Map()
	};
	let i = 0;
	const messages = session.messages;
	let pendingResponseParts: (vscode.ChatResponseMarkdownPart | vscode.ChatResponseThinkingProgressPart | vscode.ChatToolInvocationPart)[] = [];

	while (i < messages.length) {
		const currentType = messages[i].type;

		if (currentType === 'user') {
			// Collect all consecutive user messages
			const userContents: (string | ContentBlock[])[] = [];
			while (i < messages.length && messages[i].type === 'user' && messages[i].message.role === 'user') {
				userContents.push(messages[i].message.content as string | ContentBlock[]);
				i++;
			}

			// Always process tool results to update pending tool invocations
			for (const content of userContents) {
				processToolResults(content, toolContext);
			}

			// Check if there's actual user text (not just tool results)
			const requestTurn = extractUserRequest(userContents);
			if (requestTurn) {
				// Real user message — finalize any pending response first
				if (pendingResponseParts.length > 0) {
					result.push(new vscode.ChatResponseTurn2(pendingResponseParts, {}, ''));
					pendingResponseParts = [];
				}
				result.push(requestTurn);
			}
			// Otherwise this was a tool-result-only message — don't break the response grouping
		} else if (currentType === 'assistant') {
			// Collect all consecutive assistant messages
			const assistantMessages: AssistantMessageContent[] = [];
			while (i < messages.length && messages[i].type === 'assistant' && messages[i].message.role === 'assistant') {
				assistantMessages.push(messages[i].message as AssistantMessageContent);
				i++;
			}

			// Accumulate parts into the pending response
			const parts = extractAssistantParts(assistantMessages, toolContext);
			pendingResponseParts.push(...parts);
		} else {
			// Skip unknown message types
			i++;
		}
	}

	// Finalize any remaining pending response
	if (pendingResponseParts.length > 0) {
		result.push(new vscode.ChatResponseTurn2(pendingResponseParts, {}, ''));
	}

	return result;
}

// #endregion
