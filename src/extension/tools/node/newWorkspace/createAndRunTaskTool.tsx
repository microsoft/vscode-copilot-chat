/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { ITasksService, TaskStatus } from '../../../../platform/tasks/common/tasksService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import * as path from '../../../../util/vs/base/common/path';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString, Uri } from '../../../../vscodeTypes';
import { ToolName } from '../../common/toolNames';
import { ToolRegistry } from '../../common/toolsRegistry';
import { getTaskRepresentation } from '../toolUtils.task';

interface ICreateAndRunTaskToolInput {
	workspaceFolder: string;
	task: {
		label: string;
		type: string;
		command: string;
		args?: string[];
		isBackground?: boolean;
		problemMatcher?: string[];
		group?: string;
	};
}

export class CreateAndRunTaskTool implements vscode.LanguageModelTool<ICreateAndRunTaskToolInput> {

	public static readonly toolName = ToolName.CreateAndRunTask;

	constructor(
		@ITasksService private readonly tasksService: ITasksService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ICreateAndRunTaskToolInput>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const workspaceFolderRaw = this.promptPathRepresentationService.resolveFilePath(options.input.workspaceFolder);
		const workspaceFolder = (workspaceFolderRaw && this.workspaceService.getWorkspaceFolder(workspaceFolderRaw)) || this.workspaceService.getWorkspaceFolders()[0];

		if (!workspaceFolder) {
			return new LanguageModelToolResult([new LanguageModelTextPart(l10n.t`The user has not opened a workspace folder in VS Code. Ask them to open an empty folder before continuing.`)]);
		}

		try {
			const vscodeFolderPath = joinPath(workspaceFolder, '.vscode');
			const tasksFilePath = joinPath(vscodeFolderPath, 'tasks.json');
			await this.fileSystemService.stat(tasksFilePath);
			return new LanguageModelToolResult([new LanguageModelTextPart(l10n.t`A \`tasks.json\` file already exists in the workspace folder. Guide the user to provide the name of the task they'd like to run.`)]);
		} catch {
		}

		const task = options.input.task;
		if (this.tasksService.isTaskActive(task)) {
			return new LanguageModelToolResult([new LanguageModelTextPart(l10n.t`The task is already running.`)]);
		}

		// Execute the task
		this.logService.logger.debug(`CreateAndRunTaskTool: Starting task \`${task.label}\``);
		await this.tasksService.ensureTask(workspaceFolder, task, true);
		const result = await this.tasksService.executeTask(task, token, workspaceFolder);
		let succeeded = false;
		let output: string = '';
		switch (result.status) {
			case TaskStatus.Started:
				output = 'Task was run';
				succeeded = true;
				break;
			case TaskStatus.Error:
				output = `Error running task: ${result.error?.message || 'Unknown'}`;
				break;
			case TaskStatus.Finished:
				output = 'Task succeeded';
				succeeded = true;
				break;
		}
		this.telemetryService.sendMSFTTelemetryEvent('tool/createAndRunTask', {
			toolName: CreateAndRunTaskTool.toolName,
			outcome: succeeded ? 'succeeded' : 'failed',
		});
		this.logService.logger.debug(`CreateAndRunTaskTool: Task \`${options.input.task.label}\` finished with status \`${result.status}\``);
		return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ICreateAndRunTaskToolInput>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const workspaceFolderRaw = this.promptPathRepresentationService.resolveFilePath(options.input.workspaceFolder);
		const task = options.input.task;
		const workspaceFolder = (workspaceFolderRaw && this.workspaceService.getWorkspaceFolder(workspaceFolderRaw)) || this.workspaceService.getWorkspaceFolders()[0];
		const vscodeFolderPath = path.join(workspaceFolder.fsPath, '.vscode');
		const tasksFilePath = path.join(vscodeFolderPath, 'tasks.json');

		if (this.tasksService.isTaskActive(task)) {
			return {
				invocationMessage: new MarkdownString(l10n.t`Task \`${task.label}\` is already running.`),
				pastTenseMessage: new MarkdownString(l10n.t`Task \`${task.label}\` is already running.`),
				confirmationMessages: undefined
			};
		}
		if (this.tasksService.hasTask(workspaceFolder, task)) {
			const position = workspaceFolder && task && await this.tasksService.getTaskConfigPosition(workspaceFolder, task);
			const link = (s: string) => position ? `[${s}](${position.uri.toString()}#${position.range.startLineNumber}-${position.range.endLineNumber})` : s;
			const trustedMark = (value: string) => {
				const s = new MarkdownString(value);
				s.isTrusted = true;
				return s;
			};

			return {
				invocationMessage: trustedMark(l10n.t`Running ${link(task.label)}`),
				pastTenseMessage: trustedMark(task?.isBackground ? l10n.t`Started ${link(task.label)}` : l10n.t`Ran ${link(task.label)}`),
				confirmationMessages: task && task.group !== 'build'
					? { title: l10n.t`Allow task run?`, message: trustedMark(l10n.t`Allow Copilot to run the \`${task.type}\` task ${link(`\`${getTaskRepresentation(task)}\``)}?`) }
					: undefined
			};
		}
		try {
			await this.fileSystemService.stat(Uri.parse(tasksFilePath));
			return {
				invocationMessage: new MarkdownString(l10n.t`A \`tasks.json\` file already exists in the workspace folder.`),
				pastTenseMessage: new MarkdownString(l10n.t`A \`tasks.json\` file already exists.`),
				confirmationMessages: undefined
			};
		} catch {
			return {
				invocationMessage: new MarkdownString(l10n.t`Created task \`${task.label}\``),
				pastTenseMessage: new MarkdownString(l10n.t`Created task \`${task.label}\``),
				confirmationMessages: {
					title: l10n.t('Allow task creation and execution?'),
					message: new MarkdownString(
						l10n.t`Copilot will create the task \`${task.label}\` with command \`${task.command}\`${task.args?.length ? ` and args \`${task.args.join(' ')}\`` : ''}.`
					)
				}
			};
		}
	}
}

ToolRegistry.registerTool(CreateAndRunTaskTool);
