/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatToolInvocationPart, MarkdownString } from '../../../../vscodeTypes';

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