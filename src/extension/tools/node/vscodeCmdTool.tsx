/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkbenchService } from '../../../platform/workbench/common/workbenchService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';

interface IVSCodeCmdToolToolInput {
	commandId: string;
	name: string;
	args: any[];
}

class VSCodeCmdTool implements vscode.LanguageModelTool<IVSCodeCmdToolToolInput> {

	public static readonly toolName = ToolName.RunVscodeCmd;

	constructor(
		@IRunCommandExecutionService private readonly _commandService: IRunCommandExecutionService,
		@IWorkbenchService private readonly _workbenchService: IWorkbenchService,
		@ILogService private readonly _logService: ILogService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IVSCodeCmdToolToolInput>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const command = options.input.commandId;
		const args = options.input.args ?? [];

		const allcommands = (await this._workbenchService.getAllCommands(/* filterByPreCondition */true));
		const commandItem = allcommands.find(commandItem => commandItem.command === command);
		if (!commandItem) {
			return new LanguageModelToolResult([new LanguageModelTextPart(`Failed to find ${options.input.name} command.`)]);
		}

		try {
			await this._commandService.executeCommand(command, ...args);
			return new LanguageModelToolResult([new LanguageModelTextPart(`Finished running ${options.input.name} command`)]);
		} catch (error) {
			this._logService.error(`[VSCodeCmdTool] ${error}`);
			return new LanguageModelToolResult([new LanguageModelTextPart(`Failed to run ${options.input.name} command.`)]);
		}
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IVSCodeCmdToolToolInput>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const commandId = options.input.commandId;
		if (!commandId) {
			throw new Error('Command ID undefined');
		}

		const query = encodeURIComponent(JSON.stringify([[commandId]]));
		const markdownString = new MarkdownString(l10n.t(`Copilot will execute the [{0}](command:workbench.action.quickOpen?{1}) command.`, options.input.name, query));
		markdownString.isTrusted = { enabledCommands: [commandId] };
		return {
			invocationMessage: l10n.t`Running command \`${options.input.name}\``,
			confirmationMessages: {
				title: l10n.t`Run Command \`${options.input.name}\`?`,
				message: markdownString,
			},
		};
	}
}

ToolRegistry.registerTool(VSCodeCmdTool);
