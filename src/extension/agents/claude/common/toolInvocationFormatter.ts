/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import * as l10n from '@vscode/l10n';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatToolInvocationPart, MarkdownString } from '../../../../vscodeTypes';
import { ClaudeToolNames } from './constants';

/**
 * Creates a formatted tool invocation part based on the tool type and input
 */
export function createFormattedToolInvocation(
	toolUse: Anthropic.ToolUseBlock,
	toolResult?: Anthropic.ToolResultBlockParam
): ChatToolInvocationPart {
	const invocation = new ChatToolInvocationPart(toolUse.name, toolUse.id, false);
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
	} else if (toolUse.name === ClaudeToolNames.Edit) {
		formatEditInvocation(invocation, toolUse);
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
	const filePath = (toolUse.input as any)?.file_path;
	invocation.invocationMessage = new MarkdownString(l10n.t(`Read ${filePath ? formatUriForMessage(filePath) : 'file'}`));
}

function formatGlobInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = new MarkdownString(l10n.t(`Searched for files matching \`${(toolUse.input as any)?.pattern}\``));
}

function formatGrepInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = new MarkdownString(l10n.t(`Searched text for \`${(toolUse.input as any)?.pattern}\``));
}

function formatLSInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const path = (toolUse.input as any)?.path;
	invocation.invocationMessage = new MarkdownString(l10n.t(`Read ${path ? formatUriForMessage(path) : 'dir'}`));
}

function formatEditInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const filePath = (toolUse.input as any)?.file_path;
	invocation.invocationMessage = new MarkdownString(l10n.t(`Edited ${filePath ? formatUriForMessage(filePath) : 'file'}`));
}

function formatGenericInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = l10n.t(`Used tool: ${toolUse.name}`);
}

function formatUriForMessage(path: string): string {
	return `[](${URI.file(path).toString()})`;
}