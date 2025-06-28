/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';

export interface ITaskOptions {
	name: string;
	maxLinesToRetrieve: number;
}

/**
 * Tool to provide output for a given task terminal.
 */
export class GetTaskOutputTool implements vscode.LanguageModelTool<ITaskOptions> {
	public static readonly toolName = ToolName.GetTaskOutput;

	constructor(@ITerminalService private readonly terminalService: ITerminalService) {

	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ITaskOptions>, token: vscode.CancellationToken) {
		// TODO:@meganrogge when there's API to determine if a terminal is a task, improve this vscode#234440
		const terminal = this.terminalService.terminals.find(t => t.name === options.input.name);
		if (!terminal) {
			return;
		}
		// 40 chars per line and 60k chars is about 1500 lines
		const buffer = this.terminalService.getBufferForTerminal(terminal, Math.min(options.input.maxLinesToRetrieve, 1500));
		return new LanguageModelToolResult([
			new LanguageModelTextPart(`Output for task terminal ${terminal.name}: ${buffer}`)
		]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ITaskOptions>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: l10n.t("Checking output for task terminal {0}", options.input.name),
			pastTenseMessage: l10n.t("Checked output for task terminal {0}", options.input.name)
		};
	}
}

ToolRegistry.registerTool(GetTaskOutputTool);
