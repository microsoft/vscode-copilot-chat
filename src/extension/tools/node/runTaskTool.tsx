/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITasksService, TaskResult, TaskStatus } from '../../../platform/tasks/common/tasksService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';

interface IRunTaskToolInput {
	id: string;
	workspaceFolder: string;
}

class RunTaskTool implements vscode.LanguageModelTool<IRunTaskToolInput> {

	public static readonly toolName = ToolName.RunTask;

	constructor(
		@ITasksService private readonly tasksService: ITasksService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IRunTaskToolInput>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const task = this.getTaskDefinition(options.input)?.task;
		if (task && this.tasksService.isTaskActive(task)) {
			return new LanguageModelToolResult([new LanguageModelTextPart(l10n.t`The task is already running.`)]);
		}

		const workspaceFolderRaw = this.promptPathRepresentationService.resolveFilePath(options.input.workspaceFolder);
		const workspaceFolder = (workspaceFolderRaw && this.workspaceService.getWorkspaceFolder(workspaceFolderRaw)) || this.workspaceService.getWorkspaceFolders()[0];

		const result: TaskResult = task ? await this.tasksService.executeTask(task, token, workspaceFolder) : { status: TaskStatus.Error, error: new Error('Task not found') };
		let output: string;
		switch (result.status) {
			case TaskStatus.Started:
				output = 'Task started and will continue to run in the background.';
				break;
			case TaskStatus.Error:
				output = `Error running task: ${result.error?.message || 'Unknown'}`;
				break;
			case TaskStatus.Finished:
				output = 'Task succeedeed';
				break;
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IRunTaskToolInput>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const { task, workspaceFolder, taskLabel } = this.getTaskDefinition(options.input) || {};

		const position = workspaceFolder && task && await this.tasksService.getTaskConfigPosition(workspaceFolder, task);
		const link = (s: string) => position ? `[${s}](${position.uri.toString()}#${position.range.startLineNumber}-${position.range.endLineNumber})` : s;
		const trustedMark = (value: string) => {
			const s = new MarkdownString(value);
			s.isTrusted = true;
			return s;
		};

		if (task && this.tasksService.isTaskActive(task)) {
			return {
				invocationMessage: trustedMark(l10n.t`${link(taskLabel ?? options.input.id)} is already running.`),
				pastTenseMessage: trustedMark(l10n.t`${link(taskLabel ?? options.input.id)} was already running.`),
				confirmationMessages: undefined
			};
		}

		return {
			invocationMessage: trustedMark(l10n.t`Running ${taskLabel ?? link(options.input.id)}`),
			pastTenseMessage: trustedMark(task?.isBackground ? l10n.t`Started ${link(taskLabel ?? options.input.id)}` : l10n.t`Ran ${link(taskLabel ?? options.input.id)}`),
			confirmationMessages: task && task.group !== 'build'
				? { title: l10n.t`Allow task run?`, message: trustedMark(l10n.t`Allow Copilot to run the \`${task.type}\` task ${link(`\`${this.getTaskRepresentation(task)}\``)}?`) }
				: undefined
		};
	}

	private getTaskRepresentation(task: vscode.TaskDefinition): string {
		if ('label' in task) {
			return task.label;
		} else if ('script' in task) {
			return task.script;
		} else if ('command' in task) {
			return task.command;
		}
		return '';
	}

	private getTaskDefinition(input: IRunTaskToolInput) {
		const idx = input.id.indexOf(': ');
		const taskType = input.id.substring(0, idx);
		let taskLabel = input.id.substring(idx + 2);

		const workspaceFolderRaw = this.promptPathRepresentationService.resolveFilePath(input.workspaceFolder);
		const workspaceFolder = (workspaceFolderRaw && this.workspaceService.getWorkspaceFolder(workspaceFolderRaw)) || this.workspaceService.getWorkspaceFolders()[0];
		const task = this.tasksService.getTasks(workspaceFolder).find((t, i) => t.type === taskType && (t.label || String(i)) === taskLabel);
		if (!task) {
			return undefined;
		}
		try {
			if (typeof parseInt(taskLabel) === 'number') {
				taskLabel = input.id;
			}
		} catch { }
		return { workspaceFolder, task, taskLabel };
	}
}

ToolRegistry.registerTool(RunTaskTool);
