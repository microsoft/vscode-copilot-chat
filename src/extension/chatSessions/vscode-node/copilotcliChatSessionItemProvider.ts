/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';
import { ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';

export class CopilotCLIChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {
	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;

	constructor(
		@ICopilotCLISessionService private readonly copilotcliSessionService: ICopilotCLISessionService,
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
	) {
		super();
		this.setupCopilotCLIPath();
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public swap(original: vscode.ChatSessionItem, modified: vscode.ChatSessionItem): void {
		this._onDidCommitChatSessionItem.fire({ original, modified });
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this.copilotcliSessionService.getAllSessions(token);
		const diskSessions = sessions.map(session => ({
			id: session.id,
			label: session.label,
			tooltip: `CopilotCLI session: ${session.label}`,
			timing: {
				startTime: session.timestamp.getTime()
			},
			iconPath: new vscode.ThemeIcon('terminal')
		} satisfies vscode.ChatSessionItem));

		return diskSessions;
	}

	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || 'Copilot CLI';
		await this.createAndExecuteInTerminal(terminalName, 'copilot');
	}

	public async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const terminalName = `Copilot CLI - ${sessionItem.label || sessionItem.id}`;
		const command = `copilot --resume ${sessionItem.id}`;
		await this.createAndExecuteInTerminal(terminalName, command);
	}

	private async setupCopilotCLIPath(): Promise<void> {
		const globalStorageUri = this.context.globalStorageUri;
		if (!globalStorageUri) {
			// globalStorageUri is not available in extension tests
			return;
		}

		const storageLocation = path.join(globalStorageUri.fsPath, 'copilotCli');
		const copilotPackageIndexJs = path.join(this.context.extensionPath, 'node_modules', '@github', 'copilot', 'index.js');

		try {
			await fs.access(copilotPackageIndexJs);
			await fs.mkdir(storageLocation, { recursive: true });

			if (process.platform === 'win32') {
				// Windows: Create batch file
				const batPath = path.join(storageLocation, 'copilot.bat');
				const batScript = `@echo off\nnode "${copilotPackageIndexJs}" %*`;
				await fs.writeFile(batPath, batScript);
			} else {
				// Unix: Create shell script
				const shPath = path.join(storageLocation, 'copilot');
				const shScript = `#!/bin/sh\nnode "${copilotPackageIndexJs}" "$@"`;
				await fs.writeFile(shPath, shScript);
				await fs.chmod(shPath, 0o755);
			}

			// Contribute the storage location to PATH
			this.terminalService.contributePath('copilot-cli', storageLocation, 'Enables use of the `copilot` command in the terminal.');
		} catch {
			// @github/copilot package not found, no need to add to PATH
		}
	}

	private async createAndExecuteInTerminal(terminalName: string, command: string): Promise<void> {
		const existingTerminal = vscode.window.terminals.find(t => t.name === terminalName);
		if (existingTerminal) {
			existingTerminal.show();
			return;
		}

		const session = await this._authenticationService.getAnyGitHubSession();
		if (session) {
			this.context.environmentVariableCollection.replace('GH_TOKEN', session.accessToken);
		}

		const terminal = vscode.window.createTerminal({
			name: terminalName,
			iconPath: new vscode.ThemeIcon('terminal'),
			location: { viewColumn: vscode.ViewColumn.Active }
		});

		// Wait for shell integration to be available
		const shellIntegrationTimeout = 3000;
		let shellIntegrationAvailable = false;

		const integrationPromise = new Promise<void>((resolve) => {
			const disposable = vscode.window.onDidChangeTerminalShellIntegration(e => {
				if (e.terminal === terminal && e.shellIntegration) {
					shellIntegrationAvailable = true;
					disposable.dispose();
					resolve();
				}
			});

			setTimeout(() => {
				disposable.dispose();
				resolve();
			}, shellIntegrationTimeout);
		});

		terminal.show();
		await integrationPromise;

		if (shellIntegrationAvailable && terminal.shellIntegration) {
			// TODO@rebornix fix in VS Code
			await new Promise(resolve => setTimeout(resolve, 500)); // Wait a bit to ensure the terminal is ready
			terminal.shellIntegration.executeCommand(command);
		} else {
			terminal.sendText(command);
		}
	}
}
