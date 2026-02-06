/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { Terminal, TerminalOptions, TerminalProfile, ThemeIcon, ViewColumn, window, workspace } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IEnvService } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { createServiceIdentifier } from '../../../util/common/services';
import { disposableTimeout } from '../../../util/vs/base/common/async';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';
import { PythonTerminalService } from './copilotCLIPythonTerminalService';

//@ts-ignore
import powershellScript from './copilotCLIShim.ps1';

const COPILOT_CLI_SHIM_JS = 'copilotCLIShim.js';
const COPILOT_CLI_COMMAND = 'copilot';
const COPILOT_ICON = new ThemeIcon('copilot');

export interface ICopilotCLITerminalIntegration extends Disposable {
	readonly _serviceBrand: undefined;
	openTerminal(name: string, cliArgs?: string[], cwd?: string): Promise<void>;
}

type IShellInfo = {
	shell: 'zsh' | 'bash' | 'pwsh' | 'powershell' | 'cmd';
	shellPath: string;
	shellArgs: string[];
	iconPath?: ThemeIcon;
	copilotCommand: string;
	exitCommand: string | undefined;
};

export const ICopilotCLITerminalIntegration = createServiceIdentifier<ICopilotCLITerminalIntegration>('ICopilotCLITerminalIntegration');

export class CopilotCLITerminalIntegration extends Disposable implements ICopilotCLITerminalIntegration {
	declare _serviceBrand: undefined;
	private readonly initialization: Promise<void>;
	private shellScriptPath: string | undefined;
	private powershellScriptPath: string | undefined;
	private readonly pythonTerminalService: PythonTerminalService;
	constructor(
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEnvService private readonly envService: IEnvService,
		@ILogService logService: ILogService
	) {
		super();
		this.pythonTerminalService = new PythonTerminalService(logService);
		this.initialization = this.initialize();
	}

	private async initialize(): Promise<void> {
		const globalStorageUri = this.context.globalStorageUri;
		if (!globalStorageUri) {
			// globalStorageUri is not available in extension tests
			return;
		}

		const storageLocation = path.join(globalStorageUri.fsPath, 'copilotCli');
		this.terminalService.contributePath('copilot-cli', storageLocation, { command: COPILOT_CLI_COMMAND }, true);

		await fs.mkdir(storageLocation, { recursive: true });

		if (process.platform === 'win32') {
			this.powershellScriptPath = path.join(storageLocation, `${COPILOT_CLI_COMMAND}.ps1`);
			await fs.writeFile(this.powershellScriptPath, powershellScript);
			const copilotPowershellScript = `@echo off
powershell -ExecutionPolicy Bypass -File "${this.powershellScriptPath}" %*
`;
			this.shellScriptPath = path.join(storageLocation, `${COPILOT_CLI_COMMAND}.bat`);
			await fs.writeFile(this.shellScriptPath, copilotPowershellScript);
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

		const provideTerminalProfile = async () => {
			const shellInfo = await this.getShellInfo([]);
			if (!shellInfo) {
				return;
			}
			return new TerminalProfile({
				name: 'GitHub Copilot CLI',
				shellPath: shellInfo.shellPath,
				shellArgs: shellInfo.shellArgs,
				iconPath: shellInfo.iconPath,
			});
		};
		this._register(window.registerTerminalProfileProvider('copilot-cli', { provideTerminalProfile }));

	}

	public async openTerminal(name: string, cliArgs: string[] = [], cwd?: string) {
		// Generate another set of shell args, but with --clear to clear the terminal before running the command.
		// We'd like to hide all of the custom shell commands we send to the terminal from the user.
		cliArgs.unshift('--clear');

		let [shellPathAndArgs] = await Promise.all([
			this.getShellInfo(cliArgs),
			this.initialization
		]);

		const options = await getCommonTerminalOptions(name, this._authenticationService);
		options.cwd = cwd;
		if (shellPathAndArgs) {
			options.iconPath = shellPathAndArgs.iconPath ?? options.iconPath;
		}

		if (shellPathAndArgs && (shellPathAndArgs.shell !== 'powershell' && shellPathAndArgs.shell !== 'pwsh')) {
			const terminal = await this.pythonTerminalService.createTerminal(options);
			if (terminal) {
				this._register(terminal);
				const command = this.buildCommandForPythonTerminal(shellPathAndArgs?.copilotCommand, cliArgs, shellPathAndArgs);
				await this.sendCommandToTerminal(terminal, command, true, shellPathAndArgs);
				return;
			}
		}

		if (!shellPathAndArgs) {
			const terminal = this._register(this.terminalService.createTerminal(options));
			cliArgs.shift(); // Remove --clear as we can't run it without a shell integration
			const command = this.buildCommandForTerminal(terminal, COPILOT_CLI_COMMAND, cliArgs);
			await this.sendCommandToTerminal(terminal, command, false, shellPathAndArgs);
			return;
		}

		cliArgs.shift(); // Remove --clear as we are creating a new terminal with our own args.
		shellPathAndArgs = await this.getShellInfo(cliArgs);
		if (shellPathAndArgs) {
			options.shellPath = shellPathAndArgs.shellPath;
			options.shellArgs = shellPathAndArgs.shellArgs;
			const terminal = this._register(this.terminalService.createTerminal(options));
			terminal.show();
		}
	}

	private buildCommandForPythonTerminal(copilotCommand: string, cliArgs: string[], shellInfo: IShellInfo) {
		let commandPrefix = '';
		if (shellInfo.shell === 'zsh' || shellInfo.shell === 'bash') {
			// Starting with empty space to hide from terminal history (only for bash and zsh which use &&)
			commandPrefix = ' ';
		}
		if (shellInfo.shell === 'powershell' || shellInfo.shell === 'pwsh') {
			// Run powershell script
			commandPrefix = '& ';
		}

		const exitCommand = shellInfo.exitCommand || '';

		return `${commandPrefix}${quoteArgsForShell(copilotCommand, [])} ${cliArgs.join(' ')} ${exitCommand}`;
	}

	private buildCommandForTerminal(terminal: Terminal, copilotCommand: string, cliArgs: string[]) {
		return `${quoteArgsForShell(copilotCommand, [])} ${cliArgs.join(' ')}`;
	}

	private async sendCommandToTerminal(terminal: Terminal, command: string, waitForPythonActivation: boolean, shellInfo: IShellInfo | undefined = undefined): Promise<void> {
		// Wait for shell integration to be available
		const shellIntegrationTimeout = 3000;
		let shellIntegrationAvailable = terminal.shellIntegration ? true : false;
		const integrationPromise = shellIntegrationAvailable ? Promise.resolve() : new Promise<void>((resolve) => {
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

		if (waitForPythonActivation) {
			// Wait for python extension to send its initialization commands.
			// Else if we send too early, the copilot command might not get executed properly.
			// Activating powershell scripts can take longer, so wait a bit more.
			const delay = (shellInfo?.shell === 'powershell' || shellInfo?.shell === 'pwsh') ? 3000 : 1000;
			await new Promise<void>(resolve => this._register(disposableTimeout(resolve, delay))); // Wait a bit to ensure the terminal is ready
		}

		if (terminal.shellIntegration) {
			terminal.shellIntegration.executeCommand(command);
		} else {
			terminal.sendText(command);
		}

		terminal.show();
	}

	private async getShellInfo(cliArgs: string[]): Promise<IShellInfo | undefined> {
		const configPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
		const defaultProfile = this.getDefaultShellProfile();
		if (!defaultProfile) {
			return;
		}
		const profiles = workspace.getConfiguration('terminal').get<Record<string, { path: string; args?: string[]; icon?: string }>>(`integrated.profiles.${configPlatform}`);
		const profile = profiles ? profiles[defaultProfile] : undefined;
		if (!profile) {
			return;
		}
		const iconPath = COPILOT_ICON;
		const shellArgs = Array.isArray(profile.args) ? profile.args : [];
		const paths = profile.path ? (Array.isArray(profile.path) ? profile.path : [profile.path]) : [];
		const shellPath = (await getFirstAvailablePath(paths)) || this.envService.shell;
		if (defaultProfile === 'zsh' && this.shellScriptPath) {
			return {
				shell: 'zsh',
				shellPath: shellPath || 'zsh',
				shellArgs: [`-ci${shellArgs.includes('-l') ? 'l' : ''}`, quoteArgsForShell(this.shellScriptPath, cliArgs)],
				iconPath,
				copilotCommand: this.shellScriptPath,
				exitCommand: `&& exit`
			};
		} else if (defaultProfile === 'bash' && this.shellScriptPath) {
			return {
				shell: 'bash',
				shellPath: shellPath || 'bash',
				shellArgs: [`-${shellArgs.includes('-l') ? 'l' : ''}ic`, quoteArgsForShell(this.shellScriptPath, cliArgs)],
				iconPath,
				copilotCommand: this.shellScriptPath,
				exitCommand: `&& exit`
			};
		} else if (defaultProfile === 'pwsh' && this.powershellScriptPath && configPlatform !== 'windows') {
			return {
				shell: 'pwsh',
				shellPath: shellPath || 'pwsh',
				shellArgs: ['-File', this.powershellScriptPath, ...cliArgs],
				iconPath,
				copilotCommand: this.powershellScriptPath,
				exitCommand: `&& exit`
			};
		} else if (defaultProfile === 'PowerShell' && this.powershellScriptPath && configPlatform === 'windows' && shellPath) {
			return {
				shell: 'powershell',
				shellPath,
				shellArgs: ['-File', this.powershellScriptPath, ...cliArgs],
				iconPath,
				copilotCommand: this.powershellScriptPath,
				exitCommand: `&& exit`
			};
		} else if (defaultProfile === 'Command Prompt' && this.shellScriptPath && configPlatform === 'windows') {
			return {
				shell: 'cmd',
				shellPath: shellPath || 'cmd.exe',
				shellArgs: ['/c', this.shellScriptPath, ...cliArgs],
				iconPath,
				copilotCommand: this.shellScriptPath,
				exitCommand: '&& exit'
			};
		}
	}

	private getDefaultShellProfile(): string | undefined {
		const configPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
		const defaultProfile = workspace.getConfiguration('terminal').get<string | undefined>(`integrated.defaultProfile.${configPlatform}`);
		if (defaultProfile) {
			return defaultProfile === 'Windows PowerShell' ? 'PowerShell' : defaultProfile;
		}
		const shell = this.envService.shell;
		switch (configPlatform) {
			case 'osx':
			case 'linux': {
				return shell.includes('zsh') ? 'zsh' : shell.includes('bash') ? 'bash' : undefined;
			}
			case 'windows': {
				return shell.includes('pwsh') ? 'PowerShell' : shell.includes('powershell') ? 'PowerShell' : undefined;
			}
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
	return args.length ? `${escapeArg(shellScript)} ${escapedArgs.join(' ')}` : escapeArg(shellScript);
}

async function getCommonTerminalOptions(name: string, authenticationService: IAuthenticationService): Promise<TerminalOptions> {
	const options: TerminalOptions = {
		name,
		iconPath: new ThemeIcon('terminal'),
		location: { viewColumn: ViewColumn.Active },
		hideFromUser: false
	};
	const session = await authenticationService.getGitHubSession('any', { silent: true });
	if (session) {
		options.env = {
			// Old Token name for GitHub integrations (deprecate once the new variable has been adopted widely)
			GH_TOKEN: session.accessToken,
			// New Token name for Copilot
			COPILOT_GITHUB_TOKEN: session.accessToken
		};
	}
	return options;
}

const pathValidations = new Map<string, boolean>();
async function getFirstAvailablePath(paths: string[]): Promise<string | undefined> {
	for (const p of paths) {
		// Sometimes we can have paths like `${env:HOME}\Systemycmd.exe` which need to be resolved
		const resolvedPath = resolveEnvVariables(p);
		if (pathValidations.get(resolvedPath) === true) {
			return resolvedPath;
		}
		if (pathValidations.get(resolvedPath) === false) {
			continue;
		}
		// Possible its just a command name without path
		if (path.basename(p) === p) {
			return p;
		}
		try {
			const stat = await fs.stat(resolvedPath);
			if (stat.isFile()) {
				pathValidations.set(resolvedPath, true);
				return resolvedPath;
			}
			pathValidations.set(resolvedPath, false);
		} catch {
			// Ignore errors and continue checking other paths
			pathValidations.set(resolvedPath, false);
		}
	}
	return undefined;
}

function resolveEnvVariables(value: string): string {
	return value.replace(/\$\{env:([^}]+)\}/g, (match, envVarName) => {
		const envValue = process.env[envVarName];
		return envValue !== undefined ? envValue : match;
	});
}
