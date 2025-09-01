/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import * as l10n from '@vscode/l10n';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatToolInvocationPart, MarkdownString } from '../../../../vscodeTypes';
import { ClaudeToolNames, IExitPlanModeInput, ITaskToolInput } from './claudeTools';

/**
 * Creates a formatted tool invocation part based on the tool type and input
 */
export function createFormattedToolInvocation(
	toolUse: Anthropic.ToolUseBlock,
	toolResult?: Anthropic.ToolResultBlockParam,
	incompleteToolInvocation?: ChatToolInvocationPart
): ChatToolInvocationPart | undefined {
	const invocation = incompleteToolInvocation ?? new ChatToolInvocationPart(toolUse.name, toolUse.id, false);
	invocation.isConfirmed = true;

	if (toolResult) {
		invocation.isError = toolResult.is_error; // Currently unused!
	}

	if (toolUse.name === ClaudeToolNames.Bash) {
		formatBashInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.Read) {
		formatReadInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.Glob) {
		formatGlobInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.Grep) {
		formatGrepInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.LS) {
		formatLSInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.Edit || toolUse.name === ClaudeToolNames.MultiEdit) {
		formatEditInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.Write) {
		formatWriteInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.ExitPlanMode) {
		formatExitPlanModeInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.Task) {
		formatTaskInvocation(invocation, toolUse);
	} else if (toolUse.name === ClaudeToolNames.TodoWrite) {
		// Suppress this, it's too common
		return;
	} else {
		formatGenericInvocation(invocation, toolUse);
	}

	return invocation;
}

function formatBashInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = '';
	invocation.toolSpecificData = {
		commandLine: {
			original: (toolUse.input as any)?.command,
		},
		language: 'bash'
	};
}

function formatReadInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const filePath: string = (toolUse.input as any)?.file_path ?? '';
	const display = filePath ? formatUriForMessage(filePath) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
}

function formatGlobInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const pattern: string = (toolUse.input as any)?.pattern ?? '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Searched for files matching `{0}`", pattern));
}

function formatGrepInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const pattern: string = (toolUse.input as any)?.pattern ?? '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Searched text for `{0}`", pattern));
}

function formatLSInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const path: string = (toolUse.input as any)?.path ?? '';
	const display = path ? formatUriForMessage(path) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
}

function formatEditInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const filePath: string = (toolUse.input as any)?.file_path ?? '';
	const display = filePath ? formatUriForMessage(filePath) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Edited {0}", display));
}

function formatWriteInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const filePath: string = (toolUse.input as any)?.file_path ?? '';
	const display = filePath ? formatUriForMessage(filePath) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Wrote {0}", display));
}

function formatExitPlanModeInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = `Here is Claude's plan:\n\n${(toolUse.input as IExitPlanModeInput)?.plan}`;
}

function formatTaskInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const description = (toolUse.input as ITaskToolInput)?.description ?? '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Completed Task: \"{0}\"", description));
}

function formatGenericInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = l10n.t("Used tool: {0}", toolUse.name);
}

function formatUriForMessage(path: string): string {
	return `[](${URI.file(path).toString()})`;
}