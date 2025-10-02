/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from '../../../../vscodeTypes';

/**
 * Creates a formatted tool invocation part for VS Code chat display
 * Converts CopilotCLI tool calls into VS Code's ChatToolInvocationPart format
 */
export function createFormattedToolInvocation(
	toolCall: CopilotCLIToolCall,
	toolResult?: CopilotCLIToolResult,
	existingInvocation?: vscode.ChatToolInvocationPart
): vscode.ChatToolInvocationPart | undefined {
	if (!toolCall || !toolCall.type) {
		return undefined;
	}

	const invocation = existingInvocation || new vscode.ChatToolInvocationPart(
		toolCall.type,
		formatToolCallForDisplay(toolCall).value
	);

	// Update with result if provided
	if (toolResult) {
		updateInvocationWithResult(invocation, toolResult);
	}

	return invocation;
}

/**
 * Formats a CopilotCLI tool call for display in VS Code
 */
function formatToolCallForDisplay(toolCall: CopilotCLIToolCall): vscode.MarkdownString {
	switch (toolCall.type) {
		case 'command':
			return formatCommandToolCall(toolCall as CopilotCLICommandCall);
		case 'explain':
			return formatExplainToolCall(toolCall as CopilotCLIExplainCall);
		case 'suggest':
			return formatSuggestToolCall(toolCall as CopilotCLISuggestCall);
		case 'file_operation':
			return formatFileOperationToolCall(toolCall as CopilotCLIFileOperationCall);
		default:
			return formatGenericToolCall(toolCall);
	}
}

/**
 * Formats a command tool call
 */
function formatCommandToolCall(toolCall: CopilotCLICommandCall): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = true;

	markdown.appendMarkdown(`**Command Execution**\n\n`);
	markdown.appendCodeblock(toolCall.input.command, toolCall.input.shell || 'bash');

	if (toolCall.input.description) {
		markdown.appendMarkdown(`\n*${toolCall.input.description}*`);
	}

	if (toolCall.input.workingDirectory) {
		markdown.appendMarkdown(`\n\n**Working Directory:** \`${toolCall.input.workingDirectory}\``);
	}

	return markdown;
}

/**
 * Formats an explain tool call
 */
function formatExplainToolCall(toolCall: CopilotCLIExplainCall): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = true;

	markdown.appendMarkdown(`**Command Explanation**\n\n`);
	markdown.appendCodeblock(toolCall.input.command, 'bash');

	return markdown;
}

/**
 * Formats a suggest tool call
 */
function formatSuggestToolCall(toolCall: CopilotCLISuggestCall): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = true;

	markdown.appendMarkdown(`**Command Suggestion**\n\n`);
	markdown.appendMarkdown(`*Query:* ${toolCall.input.query}\n\n`);

	if (toolCall.input.context) {
		markdown.appendMarkdown(`*Context:* ${toolCall.input.context}\n\n`);
	}

	return markdown;
}

/**
 * Formats a file operation tool call
 */
function formatFileOperationToolCall(toolCall: CopilotCLIFileOperationCall): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = true;

	markdown.appendMarkdown(`**File Operation: ${toolCall.input.operation}**\n\n`);
	markdown.appendMarkdown(`**File:** \`${toolCall.input.filePath}\`\n\n`);

	if (toolCall.input.content) {
		markdown.appendMarkdown(`**Content:**\n`);
		markdown.appendCodeblock(toolCall.input.content, toolCall.input.language || '');
	}

	return markdown;
}

/**
 * Formats a generic tool call
 */
function formatGenericToolCall(toolCall: CopilotCLIToolCall): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = true;

	markdown.appendMarkdown(`**Tool: ${toolCall.type}**\n\n`);

	if (toolCall.input) {
		markdown.appendCodeblock(JSON.stringify(toolCall.input, null, 2), 'json');
	}

	return markdown;
}

/**
 * Updates an existing invocation with tool result
 */
function updateInvocationWithResult(
	invocation: vscode.ChatToolInvocationPart,
	result: CopilotCLIToolResult
): void {
	const resultMarkdown = new vscode.MarkdownString();

	if (result.success) {
		invocation.isComplete = true;
		invocation.isConfirmed = true;

		if (result.output) {
			resultMarkdown.appendMarkdown(`**Result:**\n`);
			resultMarkdown.appendCodeblock(result.output, 'text');
		}

		if (result.suggestions && result.suggestions.length > 0) {
			resultMarkdown.appendMarkdown(`\n**Suggestions:**\n`);
			result.suggestions.forEach((suggestion, index) => {
				resultMarkdown.appendMarkdown(`${index + 1}. \`${suggestion}\`\n`);
			});
		}
	} else {
		invocation.isComplete = true;
		invocation.isConfirmed = false;
		invocation.isError = true;

		resultMarkdown.appendMarkdown(`**Error:** ${result.error || 'Unknown error'}\n`);

		if (result.output) {
			resultMarkdown.appendCodeblock(result.output, 'text');
		}
	}

	if (resultMarkdown.value) {
		invocation.pastTenseMessage = resultMarkdown;
	}
}

// Type definitions for CopilotCLI tool interactions

export interface CopilotCLIToolCall {
	readonly id: string;
	readonly type: string;
	readonly input: any;
	readonly timestamp?: Date;
}

export interface CopilotCLICommandCall extends CopilotCLIToolCall {
	readonly type: 'command';
	readonly input: {
		readonly command: string;
		readonly shell?: string;
		readonly workingDirectory?: string;
		readonly description?: string;
		readonly requiresConfirmation?: boolean;
	};
}

export interface CopilotCLIExplainCall extends CopilotCLIToolCall {
	readonly type: 'explain';
	readonly input: {
		readonly command: string;
		readonly verbose?: boolean;
	};
}

export interface CopilotCLISuggestCall extends CopilotCLIToolCall {
	readonly type: 'suggest';
	readonly input: {
		readonly query: string;
		readonly context?: string;
		readonly maxSuggestions?: number;
	};
}

export interface CopilotCLIFileOperationCall extends CopilotCLIToolCall {
	readonly type: 'file_operation';
	readonly input: {
		readonly operation: 'read' | 'write' | 'create' | 'delete';
		readonly filePath: string;
		readonly content?: string;
		readonly language?: string;
	};
}

export interface CopilotCLIToolResult {
	readonly id: string;
	readonly success: boolean;
	readonly output?: string;
	readonly error?: string;
	readonly suggestions?: readonly string[];
	readonly timestamp: Date;
}