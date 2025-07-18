/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as l10n from '@vscode/l10n';
import { ChatCompletionContentPartKind, ChatRole } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import type * as vscode from 'vscode';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITasksService, TaskResult, TaskStatus } from '../../../platform/tasks/common/tasksService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { timeout } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { ChatLocation, LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';
import { getTaskRepresentation } from './toolUtils.task';

interface IRunTaskToolInput {
	id: string;
	workspaceFolder: string;
}

class RunTaskTool implements vscode.LanguageModelTool<IRunTaskToolInput> {

	public static readonly toolName = ToolName.RunTask;
	private _lastBufferLength: number | undefined;

	constructor(
		@ITasksService private readonly tasksService: ITasksService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@ITelemetryService private readonly telemetryService: ITelemetryService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IRunTaskToolInput>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const task = this.getTaskDefinition(options.input)?.task;
		if (task && this.tasksService.isTaskActive(task)) {
			return new LanguageModelToolResult([new LanguageModelTextPart(l10n.t`The task is already running.`)]);
		}

		const workspaceFolderRaw = this.promptPathRepresentationService.resolveFilePath(options.input.workspaceFolder);
		const workspaceFolder = (workspaceFolderRaw && this.workspaceService.getWorkspaceFolder(workspaceFolderRaw)) || this.workspaceService.getWorkspaceFolders()[0];

		const totalStartTime = Date.now();
		const taskStartTime = totalStartTime;
		const result: TaskResult = task ? await this.tasksService.executeTask(task, token, workspaceFolder) : { status: TaskStatus.Error, error: new Error('Task not found') };
		const taskEndTime = Date.now();
		const taskRunDurationMs = taskEndTime - taskStartTime;
		let totalDurationMs: number | undefined;

		// Start with 500 to ensure the buffer has content
		const checkIntervals = [1000, 100, 100, 100, 100, 100];

		let pollStartTime: number | undefined;
		let pollEndTime: number | undefined;
		let pollDurationMs: number | undefined;
		let idleOrInactive: 'idle' | 'inactive' | undefined;

		let lastEvalDurationMs: number | undefined;
		if (task) {
			let terminal: vscode.Terminal | undefined;
			let idleCount = 0;
			pollStartTime = Date.now();
			for (const interval of checkIntervals) {
				await timeout(interval);
				if (!terminal) {
					terminal = this.tasksService.getTerminalForTask(task);
					if (!terminal) {
						continue;
					}
				}
				const buffer = this.terminalService.getBufferForTerminal(terminal, 16000);
				const inactive = !this.tasksService.isTaskActive(task);

				const currentBufferLength = buffer.length;
				this._lastBufferLength = currentBufferLength;

				if (currentBufferLength === this._lastBufferLength) {
					idleCount++;
				} else {
					idleCount = 0;
				}

				// If buffer is idle for threshold or task is inactive, evaluate output
				if (idleCount >= 2 || inactive) {
					pollEndTime = Date.now();
					pollDurationMs = pollEndTime - (pollStartTime ?? pollEndTime);
					idleOrInactive = inactive ? 'inactive' : 'idle';
					const evalStartTime = Date.now();
					const evalResult = await this._evaluateOutputForErrors(buffer, token);
					const evalEndTime = Date.now();
					const evalDurationMs = evalEndTime - evalStartTime;
					lastEvalDurationMs = evalDurationMs;
					totalDurationMs = Date.now() - totalStartTime;
					this.telemetryService.sendMSFTTelemetryEvent?.('copilotChat.runTaskTool.run', {
						taskType: task.type,
						taskLabel: task.label,
						reason: idleOrInactive,
						bufferLength: String(buffer.length)
					}, { taskRunDurationMs, pollDurationMs, totalDuration: totalDurationMs, evalDurationMs });
					return new LanguageModelToolResult([new LanguageModelTextPart(l10n.t`${evalResult}`)]);
				}
			}
		}

		if (!pollDurationMs) {
			totalDurationMs = Date.now() - totalStartTime;
			this.telemetryService.sendMSFTTelemetryEvent?.('copilotChat.runTaskTool.run', {
				taskType: task?.type,
				taskLabel: task?.label,
				result: 'running',
			}, { taskRunDurationMs, totalDuration: totalDurationMs, evalDurationMs: lastEvalDurationMs });
		}

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

	private async _evaluateOutputForErrors(output: string, token: CancellationToken): Promise<string> {
		const endpoint = await this._endpointProvider.getChatEndpoint('gpt-4o-mini');

		const fetchResult = await endpoint.makeChatRequest(
			'taskOutputEvaluation',
			[{ role: ChatRole.User, content: [{ type: ChatCompletionContentPartKind.Text, text: `Review this output to determine if the task exited or if there are errors ${output}. If it has exited, explain why.` }] }],
			undefined,
			token,
			ChatLocation.Panel
		);
		if (fetchResult.type !== 'success') {
			return 'Error evaluating task output';
		}
		return fetchResult.value;
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
				? { title: l10n.t`Allow task run?`, message: trustedMark(l10n.t`Allow Copilot to run the \`${task.type}\` task ${link(`\`${getTaskRepresentation(task)}\``)}?`) }
				: undefined
		};
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
		return { workspaceFolder, task, taskLabel: task.label || taskLabel };
	}
}

ToolRegistry.registerTool(RunTaskTool);
