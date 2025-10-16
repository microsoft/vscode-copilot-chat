/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { TerminalOptions, ThemeIcon, ViewColumn, workspace } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { createServiceIdentifier } from '../../../util/common/services';
import { disposableTimeout } from '../../../util/vs/base/common/async';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';

//@ts-ignore
import powershellScript from './copilotCLIShim.ps1';
import { IEnvService } from '../../../platform/env/common/envService';

const COPILOT_CLI_SHIM_JS = 'copilotCLIShim.js';
const COPILOT_CLI_COMMAND = 'copilot';

export interface ICopilotCLITerminalIntegration extends Disposable {
	readonly _serviceBrand: undefined;
	openTerminal(name: string, cliArgs?: string[]): Promise<void>;
}

export const ICopilotCLITerminalIntegration = createServiceIdentifier<ICopilotCLITerminalIntegration>('ICopilotCLITerminalIntegration');

export class CopilotCLITerminalIntegration extends Disposable implements ICopilotCLITerminalIntegration {
	declare _serviceBrand: undefined;
	private readonly initialization: Promise<void>;
	private shellScriptPath: string | undefined;
	private powershellScriptPath: string | undefined;
	constructor(
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEnvService private readonly envService: IEnvService,
	) {
		super();
		this.initialization = this.initialize();
	}

	private async initialize(): Promise<void> {
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.CopilotCLIEnabled);
		if (!enabled) {
			return;
		}
		const globalStorageUri = this.context.globalStorageUri;
		if (!globalStorageUri) {
			// globalStorageUri is not available in extension tests
			return;
		}

		const storageLocation = path.join(globalStorageUri.fsPath, 'copilotCli');
		this.terminalService.contributePath('copilot-cli', storageLocation, 'Enables use of the `copilot` command in the terminal.', true);

		await fs.mkdir(storageLocation, { recursive: true });

		if (process.platform === 'win32') {
			this.shellScriptPath = path.join(storageLocation, `${COPILOT_CLI_COMMAND}.ps1`);
			await fs.writeFile(this.shellScriptPath, powershellScript);
			const copilotPowershellScript = `@echo off
powershell -ExecutionPolicy Bypass -File "${this.shellScriptPath}" %*
`;
			await fs.writeFile(path.join(storageLocation, `${COPILOT_CLI_COMMAND}.bat`), copilotPowershellScript);
		} else {
			const copilotShellScript = `#!/bin/sh
unset NODE_OPTIONS
ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${path.join(storageLocation, COPILOT_CLI_SHIM_JS)}" "$@"`;
			await fs.copyFile(path.join(__dirname, COPILOT_CLI_SHIM_JS), path.join(storageLocation, COPILOT_CLI_SHIM_JS));
			this.shellScriptPath = path.join(storageLocation, COPILOT_CLI_COMMAND);
			this.powershellScriptPath = path.join(storageLocation, `copilotCLIShim.ps1`);
			await fs.writeFile(this.shellScriptPath, copilotShellScript);
			await fs.writeFile(this.powershellScriptPath, powershellScript);
			await fs.chmod(this.shellScriptPath, 0o750);
		}
	}

	public async openTerminal(name: string, cliArgs: string[] = []) {
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.CopilotCLIEnabled);
		if (enabled) {
			await this.initialization;
			const session = await this._authenticationService.getAnyGitHubSession();
			if (session) {
				this.context.environmentVariableCollection.replace('GH_TOKEN', session.accessToken);
			}
		}

		const shellPathAndArgs = this.getShellPathAndArgs(cliArgs);
		if (shellPathAndArgs) {
			const options = getCommonTerminalOptions(name);
			options.shellPath = shellPathAndArgs.shellPath;
			options.shellArgs = shellPathAndArgs.shellArgs;
			const terminal = this.terminalService.createTerminal(options);
			terminal.show();
		} else {
			await this.openTerminalAndSendCommand(name, cliArgs);
		}
	}

	private async openTerminalAndSendCommand(name: string, cliArgs: string[] = []) {
		const options = getCommonTerminalOptions(name);
		const terminal = this._register(this.terminalService.createTerminal(options));
		terminal.show();

		// Wait for shell integration to be available
		const shellIntegrationTimeout = 3000;
		let shellIntegrationAvailable = false;
		const integrationPromise = new Promise<void>((resolve) => {
			const disposable = this._register(this.terminalService.onDidChangeTerminalShellIntegration(e => {
				if (e.terminal === terminal && e.shellIntegration) {
					shellIntegrationAvailable = true;
					disposable.dispose();
					resolve();
				}
			}));

			this._register(disposableTimeout(() => {
				disposable.dispose();
				resolve();
			}, shellIntegrationTimeout));
		});

		await integrationPromise;

		const command = `${COPILOT_CLI_COMMAND} ${cliArgs.join(' ')}`;
		if (shellIntegrationAvailable && terminal.shellIntegration) {
			// TODO@rebornix fix in VS Code
			await new Promise<void>(resolve => this._register(disposableTimeout(resolve, 500))); // Wait a bit to ensure the terminal is ready
			terminal.shellIntegration.executeCommand(command);
		} else {
			terminal.sendText(command);
		}
	}

	private getShellPathAndArgs(cliArgs: string[]): { shellPath: string; shellArgs: string[] } | undefined {
		const configPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
		const defaultProfile = this.getDefaultShellProfile();
		if (!defaultProfile) {
			return;
		}
		const profile = workspace.getConfiguration('terminal').get<Record<string, { args: string[] }>>(`integrated.profiles.${configPlatform}`);
		if (!profile || !profile[defaultProfile] || !Array.isArray(profile[defaultProfile].args)) {
			return;
		}
		const shellArgs = profile[defaultProfile].args;
		if (defaultProfile === 'zsh' && this.shellScriptPath) {
			return {
				shellPath: 'zsh',
				shellArgs: [`-ci${shellArgs.includes('-l') ? 'l' : ''}`, quoteArgsForShell(this.shellScriptPath, cliArgs)]
			};
		} else if (defaultProfile === 'bash' && this.shellScriptPath) {
			return {
				shellPath: 'bash',
				shellArgs: [`-${shellArgs.includes('-l') ? 'l' : ''}ic`, quoteArgsForShell(this.shellScriptPath, cliArgs)]
			};
		} else if (defaultProfile === 'pwsh' && this.powershellScriptPath && configPlatform !== 'windows') {
			return {
				shellPath: 'pwsh',
				shellArgs: ['-File', this.powershellScriptPath, ...cliArgs]
			};
		}
	}
	private getDefaultShellProfile() {
		const configPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
		const defaultProfile = workspace.getConfiguration('terminal').get<string | undefined>(`integrated.defaultProfile.${configPlatform}`);
		if (defaultProfile) {
			return defaultProfile;
		}
		const shell = this.envService.shell;
		switch (configPlatform) {
			case 'osx':
			case 'linux':
				return shell.includes('zsh') ? 'zsh' : shell.includes('bash') ? 'bash' : undefined;
			case 'windows':
				return shell.includes('pwsh') ? 'pwsh' : shell.includes('powershell') ? 'powershell' : undefined;
		}
	}
}

function quoteArgsForShell(shellScript: string, args: string[]): string {
	const escapeArg = (arg: string): string => {
		// If argument contains spaces, quotes, or special characters, wrap in quotes and escape internal quotes
		if (/[\s"'$`\\|&;()<>]/.test(arg)) {
			return `"${arg.replace(/["\\]/g, '\\$&')}"`;
		}
		return arg;
	};

	const escapedArgs = args.map(escapeArg);
	return `${escapeArg(shellScript)} ${escapedArgs.join(' ')}`;
}

function getCommonTerminalOptions(name: string): TerminalOptions {
	return {
		name,
		iconPath: new ThemeIcon('terminal'),
		location: { viewColumn: ViewColumn.Active }
	};
}

