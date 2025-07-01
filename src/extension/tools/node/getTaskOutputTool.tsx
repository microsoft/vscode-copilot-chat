/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITasksService } from '../../../platform/tasks/common/tasksService';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';

export interface ITaskOptions {
	id: string;
	maxCharsToRetrieve?: number;
	workspaceFolder: string;
}

/**
 * Tool to provide output for a given task.
 */
export class GetTaskOutputTool implements vscode.LanguageModelTool<ITaskOptions> {
	public static readonly toolName = ToolName.GetTaskOutput;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITasksService private readonly tasksService: ITasksService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ITaskOptions>, token: vscode.CancellationToken) {
		const label = this.getTaskDefinition(options.input)?.taskLabel;
		if (!label) {
			return;
		}
		// TODO:@meganrogge when there's API to determine if a terminal is a task, improve this vscode#234440
		const terminal = this.terminalService.terminals.find(t => t.name === label);
		if (!terminal) {
			return;
		}
		const buffer = this.terminalService.getBufferForTerminal(terminal, Math.min(options.input.maxCharsToRetrieve ?? 16000, 16000));
		return new LanguageModelToolResult([
			new LanguageModelTextPart(`Output for task ${terminal.name}: ${buffer}`)
		]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ITaskOptions>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const { task, workspaceFolder } = this.getTaskDefinition(options.input) || {};
		const position = workspaceFolder && task && await this.tasksService.getTaskConfigPosition(workspaceFolder, task);
		const link = (s: string) => position ? `[${s}](${position.uri.toString()}#${position.range.startLineNumber}-${position.range.endLineNumber})` : s;
		const trustedMark = (value: string) => {
			const s = new MarkdownString(value);
			s.isTrusted = true;
			return s;
		};

		return {
			invocationMessage: trustedMark(l10n.t`Getting output for ${link(options.input.id)}`),
			pastTenseMessage: trustedMark(task?.isBackground ? l10n.t`Got output for ${link(options.input.id)}` : l10n.t`Got output for ${link(options.input.id)}`),
		};
	}

	private getTaskDefinition(input: ITaskOptions) {
		const idx = input.id.indexOf(': ');
		const taskType = input.id.substring(0, idx);
		const taskLabel = input.id.substring(idx + 2);

		const workspaceFolderRaw = this.promptPathRepresentationService.resolveFilePath(input.workspaceFolder);
		const workspaceFolder = (workspaceFolderRaw && this.workspaceService.getWorkspaceFolder(workspaceFolderRaw)) || this.workspaceService.getWorkspaceFolders()[0];
		const task = this.tasksService.getTasks(workspaceFolder).find((t, i) => t.type === taskType && (t.label || String(i)) === taskLabel);
		if (!task) {
			return undefined;
		}

		return { workspaceFolder, task, taskLabel };
	}
}

ToolRegistry.registerTool(GetTaskOutputTool);
