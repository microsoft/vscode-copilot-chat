/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatToolInvocationPart } from '../../../../vscodeTypes';
import { OpenCodeToolInvocation, OpenCodeToolNames, OpenCodeToolResult, getToolConfig } from './opencodeTools';

/**
 * Creates a formatted tool invocation for display in the VS Code chat interface
 */
export function createFormattedToolInvocation(
	toolInvocation: OpenCodeToolInvocation,
	toolResult?: OpenCodeToolResult
): ChatToolInvocationPart | undefined {
	const config = getToolConfig(toolInvocation.name);
	
	// Create the base tool invocation part
	const invocationPart: ChatToolInvocationPart = {
		toolName: toolInvocation.name,
		input: toolInvocation.input,
		result: undefined // Will be set below if result is available
	};

	// Format the result if available
	if (toolResult) {
		invocationPart.result = formatToolResult(toolInvocation.name, toolResult);
	}

	return invocationPart;
}

/**
 * Formats a tool result for display in the chat interface
 */
function formatToolResult(toolName: OpenCodeToolNames, result: OpenCodeToolResult): any {
	if (!result.success) {
		return {
			error: true,
			message: result.error || 'Tool execution failed',
			duration: result.duration
		};
	}

	// Format results based on tool type
	switch (toolName) {
		case OpenCodeToolNames.ReadFile:
			return formatFileReadResult(result);
		
		case OpenCodeToolNames.WriteFile:
		case OpenCodeToolNames.CreateFile:
		case OpenCodeToolNames.EditFile:
			return formatFileWriteResult(result);
		
		case OpenCodeToolNames.ListFiles:
			return formatFileListResult(result);
		
		case OpenCodeToolNames.FindFiles:
		case OpenCodeToolNames.FindText:
		case OpenCodeToolNames.FindSymbols:
		case OpenCodeToolNames.GrepSearch:
			return formatSearchResult(result);
		
		case OpenCodeToolNames.Shell:
		case OpenCodeToolNames.RunCommand:
			return formatCommandResult(result);
		
		case OpenCodeToolNames.GitStatus:
		case OpenCodeToolNames.GitDiff:
		case OpenCodeToolNames.GitLog:
			return formatGitResult(result);
		
		case OpenCodeToolNames.WebSearch:
			return formatWebSearchResult(result);
		
		case OpenCodeToolNames.SystemInfo:
		case OpenCodeToolNames.Environment:
			return formatSystemInfoResult(result);
		
		default:
			return formatGenericResult(result);
	}
}

/**
 * Format file read results
 */
function formatFileReadResult(result: OpenCodeToolResult): any {
	const data = result.result;
	
	if (typeof data === 'string') {
		return {
			content: data,
			lines: data.split('\n').length,
			size: data.length,
			duration: result.duration
		};
	}
	
	if (data && typeof data === 'object') {
		return {
			content: data.content || data.text || JSON.stringify(data),
			metadata: {
				path: data.path,
				size: data.size,
				encoding: data.encoding
			},
			duration: result.duration
		};
	}
	
	return formatGenericResult(result);
}

/**
 * Format file write results
 */
function formatFileWriteResult(result: OpenCodeToolResult): any {
	const data = result.result;
	
	return {
		success: true,
		message: 'File operation completed successfully',
		metadata: data && typeof data === 'object' ? {
			path: data.path,
			bytesWritten: data.bytesWritten,
			linesWritten: data.linesWritten
		} : undefined,
		duration: result.duration
	};
}

/**
 * Format file list results
 */
function formatFileListResult(result: OpenCodeToolResult): any {
	const data = result.result;
	
	if (Array.isArray(data)) {
		return {
			files: data,
			count: data.length,
			duration: result.duration
		};
	}
	
	if (data && typeof data === 'object' && Array.isArray(data.files)) {
		return {
			files: data.files,
			count: data.files.length,
			path: data.path,
			duration: result.duration
		};
	}
	
	return formatGenericResult(result);
}

/**
 * Format search results
 */
function formatSearchResult(result: OpenCodeToolResult): any {
	const data = result.result;
	
	if (Array.isArray(data)) {
		return {
			matches: data,
			count: data.length,
			duration: result.duration
		};
	}
	
	if (data && typeof data === 'object') {
		return {
			matches: data.matches || data.results || [],
			count: (data.matches || data.results || []).length,
			query: data.query,
			pattern: data.pattern,
			duration: result.duration
		};
	}
	
	return formatGenericResult(result);
}

/**
 * Format command execution results
 */
function formatCommandResult(result: OpenCodeToolResult): any {
	const data = result.result;
	
	if (typeof data === 'string') {
		return {
			output: data,
			exitCode: 0,
			duration: result.duration
		};
	}
	
	if (data && typeof data === 'object') {
		return {
			output: data.stdout || data.output || '',
			error: data.stderr || data.error,
			exitCode: data.exitCode || data.code || 0,
			command: data.command,
			duration: result.duration
		};
	}
	
	return formatGenericResult(result);
}

/**
 * Format Git operation results
 */
function formatGitResult(result: OpenCodeToolResult): any {
	const data = result.result;
	
	if (typeof data === 'string') {
		return {
			output: data,
			duration: result.duration
		};
	}
	
	if (data && typeof data === 'object') {
		return {
			output: data.output || data.result || '',
			metadata: {
				repository: data.repository,
				branch: data.branch,
				commit: data.commit
			},
			duration: result.duration
		};
	}
	
	return formatGenericResult(result);
}

/**
 * Format web search results
 */
function formatWebSearchResult(result: OpenCodeToolResult): any {
	const data = result.result;
	
	if (Array.isArray(data)) {
		return {
			results: data,
			count: data.length,
			duration: result.duration
		};
	}
	
	if (data && typeof data === 'object') {
		return {
			results: data.results || [],
			count: (data.results || []).length,
			query: data.query,
			source: data.source,
			duration: result.duration
		};
	}
	
	return formatGenericResult(result);
}

/**
 * Format system info results
 */
function formatSystemInfoResult(result: OpenCodeToolResult): any {
	const data = result.result;
	
	if (data && typeof data === 'object') {
		return {
			info: data,
			platform: data.platform,
			version: data.version,
			duration: result.duration
		};
	}
	
	return formatGenericResult(result);
}

/**
 * Generic result formatter for unknown tool types
 */
function formatGenericResult(result: OpenCodeToolResult): any {
	return {
		result: result.result,
		success: result.success,
		duration: result.duration
	};
}

/**
 * Creates a markdown representation of a tool invocation for display
 */
export function createToolInvocationMarkdown(
	toolInvocation: OpenCodeToolInvocation,
	toolResult?: OpenCodeToolResult
): vscode.MarkdownString {
	const config = getToolConfig(toolInvocation.name);
	const markdown = new vscode.MarkdownString();
	markdown.isTrusted = true;
	
	// Tool header
	markdown.appendMarkdown(`**${config.description}**\n\n`);
	
	// Input parameters
	if (Object.keys(toolInvocation.input).length > 0) {
		markdown.appendMarkdown('**Input:**\n');
		markdown.appendCodeblock(JSON.stringify(toolInvocation.input, null, 2), 'json');
		markdown.appendMarkdown('\n');
	}
	
	// Result
	if (toolResult) {
		if (toolResult.success) {
			markdown.appendMarkdown('**Result:**\n');
			const formattedResult = formatToolResult(toolInvocation.name, toolResult);
			
			if (typeof formattedResult === 'string') {
				markdown.appendText(formattedResult);
			} else if (formattedResult.content) {
				// Special handling for file content
				markdown.appendCodeblock(formattedResult.content);
			} else if (formattedResult.output) {
				// Special handling for command output
				markdown.appendCodeblock(formattedResult.output);
			} else {
				markdown.appendCodeblock(JSON.stringify(formattedResult, null, 2), 'json');
			}
		} else {
			markdown.appendMarkdown('**Error:**\n');
			markdown.appendText(toolResult.error || 'Unknown error occurred');
		}
		
		// Duration info
		if (toolResult.duration) {
			markdown.appendMarkdown(`\n\n*Execution time: ${toolResult.duration}ms*`);
		}
	}
	
	return markdown;
}

/**
 * Helper function to determine if a tool result should be displayed inline or as a reference
 */
export function shouldDisplayInline(toolName: OpenCodeToolNames, result: OpenCodeToolResult): boolean {
	const config = getToolConfig(toolName);
	
	// Display inline for read-only operations with small results
	if (config.autoApprove && result.success) {
		const formattedResult = formatToolResult(toolName, result);
		
		// Check result size - display inline for small results
		const resultString = JSON.stringify(formattedResult);
		return resultString.length < 1000; // 1KB threshold
	}
	
	// Always display inline for errors (they're usually short)
	if (!result.success) {
		return true;
	}
	
	// Display as reference for large or complex results
	return false;
}