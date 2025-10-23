/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { IEnvService } from '../../../platform/env/common/envService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

const CodexPlaceholderKey = 'github.copilot.chat.codex.notInstalled';

export class PlaceholderViewContribution extends Disposable {
	constructor(
		@IRunCommandExecutionService private readonly _commandService: IRunCommandExecutionService,
		@IEnvService private readonly envService: IEnvService,
	) {
		super();

		const updateContextKey = () => {
			const codexExtension = vscode.extensions.getExtension('openai.chatgpt');
			void vscode.commands.executeCommand('setContext', CodexPlaceholderKey, !codexExtension);
		};

		updateContextKey();
		this._register(vscode.extensions.onDidChange(updateContextKey));

		this._register(vscode.commands.registerCommand('github.copilot.chat.installAgent', this.installAgentCommand, this));
	}

	private async installAgentCommand(args: unknown) {
		const typedArgs = isInstallAgentCommandArgs(args) ? args : undefined;
		if (!typedArgs) {
			return;
		}

		const insiders = this.envService.getBuildType() === 'dev' || this.envService.getEditorInfo().version.includes('insider');
		const extensionId = typedArgs.agent === 'codex' ?
			'openai.chatgpt' : undefined;
		if (extensionId) {
			const installArgs = [extensionId, { enable: true, installPreReleaseVersion: insiders }];
			await this._commandService.executeCommand('workbench.extensions.installExtension', ...installArgs);
			await this._commandService.executeCommand('chatgpt.newCodexPanel');
		}
	}
}

interface IInstallAgentCommandArgs {
	agent?: string;
}
function isInstallAgentCommandArgs(args: unknown): args is IInstallAgentCommandArgs {
	return typeof args === 'object' && args !== null && 'agent' in args;
}