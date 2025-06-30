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
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
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
		const label = this.getTaskLabel(options.input);
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

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ITaskOptions>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const label = this.getTaskLabel(options.input) || {};
		return {
			invocationMessage: l10n.t("Checking output for task {0}", label),
			pastTenseMessage: l10n.t("Checked output for task {0}", label)
		};
	}

	private getTaskLabel(input: ITaskOptions) {
		const idx = input.id.indexOf(': ');
		const taskType = input.id.substring(0, idx);

		const workspaceFolderRaw = this.promptPathRepresentationService.resolveFilePath(input.workspaceFolder);
		const workspaceFolder = (workspaceFolderRaw && this.workspaceService.getWorkspaceFolder(workspaceFolderRaw)) || this.workspaceService.getWorkspaceFolders()[0];
		const task = this.tasksService.getTasks(workspaceFolder).find((t, i) => t.type === taskType && (t.label || String(i)) === input.id);
		if (!task) {
			return undefined;
		}

		return input.id;
	}
}

ToolRegistry.registerTool(GetTaskOutputTool);
