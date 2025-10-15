/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IEnvService } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import * as path from '../../../util/vs/base/common/path';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';

export interface ICopilotBundledCLITerminalIntegration {
	createTerminal(options: vscode.TerminalOptions): Promise<vscode.Terminal>;
}

export class CopilotBundledCLITerminalIntegration implements ICopilotBundledCLITerminalIntegration {
	private readonly completedSetup: Promise<void>;
	constructor(
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,

	) {
		this.completedSetup = this.setupCopilotCLIPath();
	}

	private async setupCopilotCLIPath(): Promise<void> {
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
		const copilotPackageIndexJs = path.join(this.context.extensionPath, 'node_modules', '@github', 'copilot', 'index.js');

		try {
			await fs.access(copilotPackageIndexJs);
			await fs.mkdir(storageLocation, { recursive: true });

			// Note: node-pty shim is created in agent manager before first SDK import
			// This allows @github/copilot to import node-pty before extension activation

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

	public async createTerminal(options: vscode.TerminalOptions) {
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.CopilotCLIEnabled);
		if (enabled) {
			await this.completedSetup;
			const session = await this._authenticationService.getAnyGitHubSession();
			if (session) {
				this.context.environmentVariableCollection.replace('GH_TOKEN', session.accessToken);
			}
		}

		return vscode.window.createTerminal(options);
	}
}

// * Note that the possible values for shells are currently defined as any of the following (from vscode.d.ts):
// * 'bash', 'cmd', 'csh', 'fish', 'gitbash', 'julia', 'ksh', 'node', 'nu', 'pwsh', 'python',
// * 'sh', 'wsl', 'zsh'.
// Here w have a list of the shells and default is `bash`
// This is a mapping of the files that need to be copied for each shell into the storage folder with the name of the shell.
const scriptLocations = [
	{
		shell: 'pwsh',
		files: {
			'copilot.ps1': 'copilot.ps1',
			'copilot.pwsh': 'copilot.pwsh',
			'copilot.cmd': 'copilot.cmd'
		}
	},
	{
		shell: 'fish',
		files: {
			'copilot': 'copilot.fish'
		}
	},
	{
		shell: 'cmd',
		files: {
			'copilot.cmd': 'copilot.cmd',
			'copilot.ps1': 'copilot.ps1'
		}
	},
	{
		shell: 'nu',
		files: {
			'copilot': 'copilot.nu'
		}
	},
	{
		shell: 'csh',
		files: {
			'copilot': 'copilot.csh'
		}
	},
	{
		shell: 'bash',
		files: {
			'copilot': 'copilot.sh'
		}
	},
];


export class CopilotExternalCLINodeTerminalIntegration implements ICopilotBundledCLITerminalIntegration {
	private readonly completedSetup: Promise<void>;
	constructor(
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		this.completedSetup = this.setupCopilotCLIPath();
	}

	private async setupCopilotCLIPath(): Promise<void> {
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.CopilotCLIEnabled);
		if (!enabled) {
			return;
		}
		const globalStorageUri = this.context.globalStorageUri;
		if (!globalStorageUri) {
			// globalStorageUri is not available in extension tests
			return;
		}

		const storageLocation = path.join(globalStorageUri.fsPath, 'copilotCli', 'node');
		const scriptLocation = path.join(this.context.extensionPath, 'resources', 'scripts');

		await fs.mkdir(storageLocation, { recursive: true });

		// Copy the scripts to the storage location
		const sourcePath = path.join(scriptLocation, 'copilot');
		const targetPath = path.join(storageLocation, 'copilot');
		await fs.copyFile(sourcePath, targetPath);
		if (process.platform !== 'win32') {
			await fs.chmod(targetPath, 0o755);
		}
	}

	public async createTerminal(options: vscode.TerminalOptions) {
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.CopilotCLIEnabled);
		if (enabled) {
			await this.completedSetup;
			const session = await this._authenticationService.getAnyGitHubSession();
			if (session) {
				this.context.environmentVariableCollection.replace('GH_TOKEN', session.accessToken);
			}

			const globalStorageUri = this.context.globalStorageUri;
			if (globalStorageUri) {
				// Figure out the default shell (look at the settings for default profile)
				// If extensions create terminals, then this might not work as expected as the shell might be different
				// from the default one.
				// However this is a best effort attempt.
				// If we cannot figure out the shell, we will add bash scripts to the PATH
				const storageLocation = path.join(globalStorageUri.fsPath, 'copilotCli', 'node');
				this.context.environmentVariableCollection.prepend('PATH', `${storageLocation}${path.delimiter}`);
			}
		}

		return vscode.window.createTerminal(options);
	}
}

export class CopilotExternalCLIScriptsTerminalIntegration implements ICopilotBundledCLITerminalIntegration {
	private readonly completedSetup: Promise<void>;
	constructor(
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvService private readonly envService: IEnvService,
	) {
		this.completedSetup = this.setupCopilotCLIPath();
	}

	private async setupCopilotCLIPath(): Promise<void> {
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
		const scriptLocation = path.join(this.context.extensionPath, 'resources', 'scripts');

		await fs.mkdir(storageLocation, { recursive: true });
		await Promise.all(scriptLocations.map(scripts => fs.mkdir(path.join(storageLocation, scripts.shell), { recursive: true })));

		// Copy the scripts to the storage location
		await Promise.all(scriptLocations.map(async scripts => {
			await Promise.all(Object.entries(scripts.files).map(async ([targetFile, sourceFile]) => {
				const sourcePath = path.join(scriptLocation, sourceFile);
				const targetPath = path.join(storageLocation, scripts.shell, targetFile);
				await fs.copyFile(sourcePath, targetPath);
				if (process.platform !== 'win32') {
					await fs.chmod(targetPath, 0o755);
				}
			}));
		}));
	}

	public async createTerminal(options: vscode.TerminalOptions) {
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.CopilotCLIEnabled);
		if (enabled) {
			await this.completedSetup;
			const session = await this._authenticationService.getAnyGitHubSession();
			if (session) {
				this.context.environmentVariableCollection.replace('GH_TOKEN', session.accessToken);
			}

			const globalStorageUri = this.context.globalStorageUri;
			if (globalStorageUri) {
				// Figure out the default shell (look at the settings for default profile)
				// If extensions create terminals, then this might not work as expected as the shell might be different
				// from the default one.
				// However this is a best effort attempt.
				// If we cannot figure out the shell, we will add bash scripts to the PATH
				const storageLocation = path.join(globalStorageUri.fsPath, 'copilotCli', this.getDefaultShell());
				this.context.environmentVariableCollection.prepend('PATH', `${storageLocation}${path.delimiter}`);
			}
		}

		return vscode.window.createTerminal(options);
	}

	private getDefaultShell(): string {
		const defaultPlatformShell = process.platform === 'win32' ? 'pwsh' : 'bash';
		const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
		const setting = `integrated.defaultProfile.${platform}`;
		const shell = vscode.workspace.getConfiguration('terminal').get<string>(setting) ?? this.envService.shell ?? (process.platform === 'win32' ? 'pwsh' : 'bash');

		if (scriptLocations.some(s => s.shell === shell)) {
			return shell;
		}
		if (scriptLocations.some(s => s.shell === this.envService.shell)) {
			return shell;
		}

		return defaultPlatformShell;
	}
}
