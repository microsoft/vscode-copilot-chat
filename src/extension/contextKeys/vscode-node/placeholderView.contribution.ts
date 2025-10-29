/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../platform/env/common/envService';
import { disposableTimeout } from '../../../util/vs/base/common/async';
import { Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

const ShowCodexPlaceholderKey = 'github.copilot.chat.codex.showPlaceholder';

export class PlaceholderViewContribution extends Disposable {
	constructor(
		@IRunCommandExecutionService private readonly _commandService: IRunCommandExecutionService,
		@IEnvService private readonly envService: IEnvService,
		@IAuthenticationService authenticationService: IAuthenticationService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super();

		let curShouldShowPlaceholder: boolean | undefined = undefined;
		const updateContextKey = () => {
			const token = authenticationService.copilotToken;
			const enabledForUser = token && (token.codexAgentEnabled || configurationService.getNonExtensionConfig('chat.experimental.codex.enabled'));
			const codexExtension = vscode.extensions.getExtension('openai.chatgpt');
			const shouldShowPlaceholder = enabledForUser && !codexExtension;
			if (curShouldShowPlaceholder !== shouldShowPlaceholder) {
				curShouldShowPlaceholder = shouldShowPlaceholder;
				void vscode.commands.executeCommand('setContext', ShowCodexPlaceholderKey, shouldShowPlaceholder);
			}
		};

		this._register(vscode.extensions.onDidChange(updateContextKey));
		this._register(Event.runAndSubscribe(authenticationService.onDidAuthenticationChange, updateContextKey));

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
			if (await this.waitForExtension(extensionId)) {
				await this._commandService.executeCommand('chatgpt.newCodexPanel', { source: 'sessionsViewPromotion' });
			}
		}
	}

	private async waitForExtension(extensionId: string, timeout: number = 5000): Promise<boolean> {
		if (vscode.extensions.getExtension(extensionId)) {
			return true;
		}

		return new Promise<boolean>(resolve => {
			const finish = (result: boolean) => {
				timer.dispose();
				listener.dispose();
				resolve(result);
			};

			const timer = disposableTimeout(() => finish(false), timeout);
			const listener = vscode.extensions.onDidChange(() => {
				if (vscode.extensions.getExtension(extensionId)) {
					finish(true);
				}
			});
		});
	}
}

interface IInstallAgentCommandArgs {
	agent?: string;
}
function isInstallAgentCommandArgs(args: unknown): args is IInstallAgentCommandArgs {
	return typeof args === 'object' && args !== null && 'agent' in args;
}