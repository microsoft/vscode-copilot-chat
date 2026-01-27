/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentInput, BashInput, FileReadInput, GlobInput, GrepInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import Anthropic from '@anthropic-ai/sdk';
import * as l10n from '@vscode/l10n';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatToolInvocationPart, MarkdownString } from '../../../../vscodeTypes';
import { ClaudeToolNames, ExitPlanModeInput, LSInput } from './claudeTools';

/**
 * Creates a formatted tool invocation part based on the tool type and input
 */
export function createFormattedToolInvocation(
	toolUse: Anthropic.ToolUseBlock,
	complete?: boolean
): ChatToolInvocationPart | undefined {
	const invocation = new ChatToolInvocationPart(toolUse.name, toolUse.id, false);
	if (complete !== undefined) {
		invocation.isConfirmed = complete;
		invocation.isComplete = complete;
	}

	switch (toolUse.name as ClaudeToolNames) {
		case ClaudeToolNames.Bash:
			formatBashInvocation(invocation, toolUse);
			break;
		case ClaudeToolNames.Read:
			formatReadInvocation(invocation, toolUse);
			break;
		case ClaudeToolNames.Glob:
			formatGlobInvocation(invocation, toolUse);
			break;
		case ClaudeToolNames.Grep:
			formatGrepInvocation(invocation, toolUse);
			break;
		case ClaudeToolNames.LS:
			formatLSInvocation(invocation, toolUse);
			break;
		case ClaudeToolNames.Edit:
		case ClaudeToolNames.MultiEdit:
		case ClaudeToolNames.Write:
			return; // edit diff is shown
		case ClaudeToolNames.ExitPlanMode:
			formatExitPlanModeInvocation(invocation, toolUse);
			break;
		case ClaudeToolNames.Task:
			formatTaskInvocation(invocation, toolUse);
			break;
		case ClaudeToolNames.TodoWrite:
			// Suppress this, it's too common
			return;
		default:
			formatGenericInvocation(invocation, toolUse);
			break;
	}

	return invocation;
}

function formatBashInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = '';
	invocation.toolSpecificData = {
		commandLine: {
			original: (toolUse.input as BashInput)?.command,
		},
		language: 'bash'
	};
}

function formatReadInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const filePath: string = (toolUse.input as FileReadInput)?.file_path ?? '';
	const display = filePath ? formatUriForMessage(filePath) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
}

function formatGlobInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const pattern: string = (toolUse.input as GlobInput)?.pattern ?? '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Searched for files matching `{0}`", pattern));
}

function formatGrepInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const pattern: string = (toolUse.input as GrepInput)?.pattern ?? '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Searched for regex `{0}`", pattern));
}

function formatLSInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const path: string = (toolUse.input as LSInput)?.path ?? '';
	const display = path ? formatUriForMessage(path) : '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Read {0}", display));
}

function formatExitPlanModeInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = l10n.t("Here is Claude's plan:\n\n{0}", (toolUse.input as ExitPlanModeInput)?.plan ?? '');
}

function formatTaskInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	const description = (toolUse.input as AgentInput)?.description ?? '';
	invocation.invocationMessage = new MarkdownString(l10n.t("Completed Task: \"{0}\"", description));
}

function formatGenericInvocation(invocation: ChatToolInvocationPart, toolUse: Anthropic.ToolUseBlock): void {
	invocation.invocationMessage = l10n.t("Used tool: {0}", toolUse.name);
}

function formatUriForMessage(path: string): string {
	return `[](${URI.file(path).toString()})`;
}