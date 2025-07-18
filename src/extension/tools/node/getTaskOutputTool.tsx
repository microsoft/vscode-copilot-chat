/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
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
		@ILogService private readonly logService: ILogService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ITaskOptions>, token: vscode.CancellationToken) {
		const taskDefinition = this.getTaskDefinition(options.input);
		if (!taskDefinition) {
			this.logService.logger.debug('getTaskOutputTool returning undefined: no matching label for task ' + options.input.id);
			return;
		}
		const terminal = taskDefinition.terminal ?? this.tasksService.getTerminalForTask(taskDefinition.task);
		if (!terminal) {
			this.logService.logger.debug('getTaskOutputTool returning undefined: no terminal for task: ' + options.input.id + ' label: ' + taskDefinition.taskLabel + ' terminal names: ' + this.terminalService.terminals.map(t => t.name).join(', '));
			return;
		}
		const buffer = this.terminalService.getBufferForTerminal(terminal, Math.min(options.input.maxCharsToRetrieve ?? 16000, 16000));
		this.logService.logger.debug('getTaskOutputTool task is still running with buffer length: ' + buffer.length + ' for terminal: ' + terminal.name);
		return new LanguageModelToolResult([
			new LanguageModelTextPart(`Output for task ${terminal.name}: ${buffer}`)
		]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ITaskOptions>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const { task, workspaceFolder, taskLabel } = this.getTaskDefinition(options.input) || {};
		const position = workspaceFolder && task && await this.tasksService.getTaskConfigPosition(workspaceFolder, task);
		const link = (s: string) => position ? `[${s}](${position.uri.toString()}#${position.range.startLineNumber}-${position.range.endLineNumber})` : s;
		const trustedMark = (value: string) => {
			const s = new MarkdownString(value);
			s.isTrusted = true;
			return s;
		};

		return {
			invocationMessage: trustedMark(l10n.t`Getting output for ${link(taskLabel ?? options.input.id)}`),
			pastTenseMessage: trustedMark(task?.isBackground ? l10n.t`Got output for ${link(taskLabel ?? options.input.id)}` : l10n.t`Got output for ${link(taskLabel ?? options.input.id)}`),
		};
	}

	private getTaskDefinition(input: ITaskOptions) {
		const idx = input.id.indexOf(': ');
		const taskType = input.id.substring(0, idx);
		let taskLabel = input.id.substring(idx + 2);

		const workspaceFolderRaw = this.promptPathRepresentationService.resolveFilePath(input.workspaceFolder);
		const workspaceFolder = (workspaceFolderRaw && this.workspaceService.getWorkspaceFolder(workspaceFolderRaw)) || this.workspaceService.getWorkspaceFolders()[0];
		const task = this.tasksService.getTasks(workspaceFolder).find((t, i) => t.type === taskType && (t.label || String(i)) === taskLabel);
		if (!task) {
			this.logService.logger.debug('getTaskOutputTool returning undefined: no task for type: ' + taskType + ' label: ' + taskLabel + ' inputId: ' + input.id);
			return undefined;
		}
		try {
			if (typeof parseInt(taskLabel) === 'number') {
				taskLabel = input.id;
			}
		} catch { }
		return { workspaceFolder, task, taskLabel: task.label || taskLabel, terminal: task.terminal ?? this.tasksService.getTerminalForTask(task) };
	}
}

ToolRegistry.registerTool(GetTaskOutputTool);
