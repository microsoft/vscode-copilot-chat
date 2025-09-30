/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatToolInvocationPart, MarkdownString } from '../../../../vscodeTypes';

/**
 * OpenCode tool names
 */
export enum OpenCodeToolNames {
	Shell = 'shell',
	Command = 'command',
	FindFiles = 'find_files',
	FindText = 'find_text',
	FindSymbols = 'find_symbols',
	ReadFile = 'read_file',
	WriteFile = 'write_file',
	EditFile = 'edit_file',
	Git = 'git',
	Http = 'http',
	Search = 'search'
}

/**
 * Creates a formatted tool invocation part based on the tool type and input
 */
export function createFormattedToolInvocation(
	toolUse: any,
	toolResult?: any,
	incompleteToolInvocation?: ChatToolInvocationPart
): ChatToolInvocationPart | undefined {
	const toolName = toolUse.name ?? toolUse.tool ?? toolUse.type ?? 'tool';
	const toolId = String(toolUse.id ?? toolUse.callID ?? `oc_${Date.now()}`);

	const invocation = incompleteToolInvocation ?? new ChatToolInvocationPart(String(toolName), toolId, false);
	invocation.isConfirmed = true;

	if (toolResult) {
		invocation.isError = toolResult.is_error ?? false;
	}

	// Try to map known tools with various name variations
	const normalizedToolName = String(toolName).toLowerCase().replace(/[-_]/g, '');

	if (normalizedToolName === 'shell' || normalizedToolName === 'command' || normalizedToolName === 'bash' || normalizedToolName === 'sh') {
		formatShellInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'readfile' || normalizedToolName === 'read' || normalizedToolName === 'cat') {
		formatReadFileInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'writefile' || normalizedToolName === 'write' || normalizedToolName === 'createfile') {
		formatWriteFileInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'editfile' || normalizedToolName === 'edit' || normalizedToolName === 'modify') {
		formatEditFileInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'findfiles' || normalizedToolName === 'glob' || normalizedToolName === 'ls' || normalizedToolName === 'listfiles' || normalizedToolName === 'list') {
		formatFindFilesInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'findtext' || normalizedToolName === 'grep' || normalizedToolName === 'search' || normalizedToolName === 'searchtext') {
		formatFindTextInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'findsymbols' || normalizedToolName === 'symbols' || normalizedToolName === 'searchsymbols') {
		formatFindSymbolsInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'git') {
		formatGitInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'http' || normalizedToolName === 'curl' || normalizedToolName === 'fetch' || normalizedToolName === 'request') {
		formatHttpInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'mkdir' || normalizedToolName === 'createdirectory') {
		formatCreateDirectoryInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'mv' || normalizedToolName === 'move' || normalizedToolName === 'rename') {
		formatMoveFileInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'rm' || normalizedToolName === 'delete' || normalizedToolName === 'remove') {
		formatDeleteFileInvocation(invocation, toolUse);
	} else if (normalizedToolName === 'cp' || normalizedToolName === 'copy') {
		formatCopyFileInvocation(invocation, toolUse);
	} else {
		// Log unknown tools for future improvement
		console.log(`[OpenCode] Unknown tool: '${toolName}' (normalized: '${normalizedToolName}')`, {
			originalToolUse: toolUse,
			input: toolUse.input,
			state: toolUse.state
		});
		formatGenericInvocation(invocation, toolUse);
	}

	return invocation;
}

function formatShellInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	invocation.invocationMessage = '';
	invocation.toolSpecificData = {
		commandLine: {
			original: (toolUse.input as any)?.command ?? (toolUse.state?.input as any)?.command,
		},
		language: 'bash'
	};
}

function formatReadFileInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	// OpenCode stores the file path in different locations - check all possible sources
	const filePath: string = (toolUse.input as any)?.file_path ??
		(toolUse.input as any)?.path ??
		(toolUse.state?.input as any)?.file_path ??
		(toolUse.state?.input as any)?.path ??
		(toolUse.state?.input as any)?.filePath ?? // OpenCode specific location
		'';

	if (filePath) {
		const display = formatUriForMessage(filePath);
		invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
	} else {
		// Handle read operations without specific file paths (e.g., reading from stdin, clipboard, etc.)
		const title = (toolUse.state as any)?.title ?? '';
		if (title) {
			invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", title));
		} else {
			invocation.invocationMessage = new MarkdownString(l10n.t("Read content"));
		}
	}
}

function formatWriteFileInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const filePath: string = (toolUse.input as any)?.file_path ?? (toolUse.input as any)?.path ?? (toolUse.state?.input as any)?.file_path ?? '';
	const display = filePath ? formatUriForMessage(filePath) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Wrote {0}", display));
}

function formatEditFileInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const filePath: string = (toolUse.input as any)?.file_path ?? (toolUse.input as any)?.path ?? (toolUse.state?.input as any)?.file_path ?? '';
	const display = filePath ? formatUriForMessage(filePath) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Edited {0}", display));
}

function formatFindFilesInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const pattern: string = (toolUse.input as any)?.pattern ?? (toolUse.input as any)?.glob ?? (toolUse.state?.input as any)?.pattern ?? '';
	const path: string = (toolUse.input as any)?.path ?? (toolUse.state?.input as any)?.path ?? '';
	const title: string = (toolUse.state as any)?.title ?? '';

	// Handle different types of file listing operations
	if (pattern) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Searched for files matching `{0}`", pattern));
	} else if (path) {
		const display = formatUriForMessage(path);
		invocation.invocationMessage = new MarkdownString(l10n.t("Listed directory {0}", display));
	} else if (title) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Listed {0}", title));
	} else {
		invocation.invocationMessage = new MarkdownString(l10n.t("Listed files"));
	}
}

function formatFindTextInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const pattern: string = (toolUse.input as any)?.pattern ?? (toolUse.input as any)?.query ?? (toolUse.state?.input as any)?.pattern ?? '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Searched text for `{0}`", pattern));
}

function formatFindSymbolsInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const symbol: string = (toolUse.input as any)?.symbol ?? (toolUse.input as any)?.query ?? (toolUse.state?.input as any)?.symbol ?? '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Searched for symbol `{0}`", symbol));
}

function formatGitInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const command: string = (toolUse.input as any)?.command ?? (toolUse.state?.input as any)?.command ?? '';
	if (command) {
		invocation.invocationMessage = new MarkdownString(l10n.t("Ran git command: `{0}`", command));
	} else {
		invocation.invocationMessage = new MarkdownString(l10n.t("Ran git command"));
	}
}

function formatHttpInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const url: string = (toolUse.input as any)?.url ?? (toolUse.state?.input as any)?.url ?? '';
	const method: string = (toolUse.input as any)?.method ?? (toolUse.state?.input as any)?.method ?? 'GET';
	if (url) {
		invocation.invocationMessage = new MarkdownString(l10n.t("{0} {1}", method.toUpperCase(), url));
	} else {
		invocation.invocationMessage = new MarkdownString(l10n.t("Made HTTP request"));
	}
}

function formatCreateDirectoryInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const dirPath: string = (toolUse.input as any)?.path ?? (toolUse.input as any)?.directory ?? (toolUse.state?.input as any)?.path ?? '';
	const display = dirPath ? formatUriForMessage(dirPath) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Created directory {0}", display));
}

function formatMoveFileInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const fromPath: string = (toolUse.input as any)?.from ?? (toolUse.input as any)?.source ?? (toolUse.state?.input as any)?.from ?? '';
	const toPath: string = (toolUse.input as any)?.to ?? (toolUse.input as any)?.destination ?? (toolUse.state?.input as any)?.to ?? '';
	if (fromPath && toPath) {
		const fromDisplay = formatUriForMessage(fromPath);
		const toDisplay = formatUriForMessage(toPath);
		invocation.invocationMessage = new MarkdownString(l10n.t("Moved {0} to {1}", fromDisplay, toDisplay));
	} else if (fromPath) {
		const display = formatUriForMessage(fromPath);
		invocation.invocationMessage = new MarkdownString(l10n.t("Moved {0}", display));
	} else {
		invocation.invocationMessage = new MarkdownString(l10n.t("Moved file"));
	}
}

function formatDeleteFileInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const filePath: string = (toolUse.input as any)?.path ?? (toolUse.input as any)?.file_path ?? (toolUse.state?.input as any)?.path ?? '';
	const display = filePath ? formatUriForMessage(filePath) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Deleted {0}", display));
}

function formatCopyFileInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const fromPath: string = (toolUse.input as any)?.from ?? (toolUse.input as any)?.source ?? (toolUse.state?.input as any)?.from ?? '';
	const toPath: string = (toolUse.input as any)?.to ?? (toolUse.input as any)?.destination ?? (toolUse.state?.input as any)?.to ?? '';
	if (fromPath && toPath) {
		const fromDisplay = formatUriForMessage(fromPath);
		const toDisplay = formatUriForMessage(toPath);
		invocation.invocationMessage = new MarkdownString(l10n.t("Copied {0} to {1}", fromDisplay, toDisplay));
	} else if (fromPath) {
		const display = formatUriForMessage(fromPath);
		invocation.invocationMessage = new MarkdownString(l10n.t("Copied {0}", display));
	} else {
		invocation.invocationMessage = new MarkdownString(l10n.t("Copied file"));
	}
}

function formatGenericInvocation(invocation: ChatToolInvocationPart, toolUse: any): void {
	const toolName = toolUse.name ?? toolUse.tool ?? toolUse.type ?? 'tool';

	// Try to extract meaningful information from the input for generic tools
	const input = toolUse.input ?? toolUse.state?.input;
	let message = l10n.t("Used tool: {0}", toolName);

	if (input) {
		// Look for common patterns in the input
		if (input.file_path || input.path) {
			const filePath = input.file_path ?? input.path;
			const display = formatUriForMessage(filePath);
			message = l10n.t("Used {0} on {1}", toolName, display);
		} else if (input.command) {
			message = l10n.t("Ran {0}: `{1}`", toolName, input.command);
		} else if (input.query || input.pattern) {
			const searchTerm = input.query ?? input.pattern;
			message = l10n.t("Used {0} to search for `{1}`", toolName, searchTerm);
		} else if (input.url) {
			message = l10n.t("Used {0} on {1}", toolName, input.url);
		}
	}

	invocation.invocationMessage = message;

	// Add the raw input as a code block for debugging unknown tools
	if (input && typeof input === 'object') {
		try {
			const md = new MarkdownString();
			md.appendMarkdown(message);
			md.appendMarkdown('\n\n');
			md.appendCodeblock(JSON.stringify(input, null, 2), 'json');
			invocation.invocationMessage = md;
		} catch {
			// Fallback to just the message if JSON serialization fails
			invocation.invocationMessage = message;
		}
	}
}

function formatUriForMessage(path: string): string {
	console.log('[OpenCode formatUriForMessage]', { path, uri: URI.file(path).toString() });
	// Match Claude Code's exact approach for consistent pill rendering
	return `[](${URI.file(path).toString()})`;
}

