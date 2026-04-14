/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { existsSync, promises as fs } from 'fs';
import { ILogService } from '../../../platform/log/common/logService';
import { IExtensionContribution } from '../../common/contributions';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { configureWorkspaceDeepSeekCriticApi, inspectWorkspaceDeepSeekCriticHook, isWorkspaceDeepSeekCriticEnabled } from '../../prompt/node/workspaceDeepSeekCriticHook';

const INSTALL_COMMAND = 'github.copilot.chat.deepseekCritic.install';
const MANAGE_COMMAND = 'github.copilot.chat.deepseekCritic.manage';
const HOOKS_DIR = '.copilot/hooks';
const HOOK_SCRIPT_NAME = 'deepseek-critic.py';
const HOOK_CONFIG_NAME = 'deepseek-critic.json';
const HOOK_RUNTIME_CONFIG_NAME = 'deepseek-critic.config.json';

export class DeepSeekCriticContribution extends Disposable implements IExtensionContribution {
	readonly id = 'deepseekCriticContribution';
	private readonly statusBarItem: vscode.StatusBarItem;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
		configureWorkspaceDeepSeekCriticApi(vscode.workspace);
		this.statusBarItem = this._register(vscode.window.createStatusBarItem('github.copilot.chat.deepseekCritic', vscode.StatusBarAlignment.Right, 910));

		this._register(vscode.commands.registerCommand(INSTALL_COMMAND, async () => {
			await this.installWorkspaceHook(await this.pickWorkspaceFolder());
		}));
		this._register(vscode.commands.registerCommand(MANAGE_COMMAND, async () => {
			await this.manageWorkspaceHook(await this.pickWorkspaceFolder());
		}));
		this._register(vscode.workspace.onDidChangeWorkspaceFolders(() => this.updateStatusBar()));
		this._register(vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()));
		this._register(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('github.copilot.chat.deepseekCritic.enabled')) {
				this.updateStatusBar();
			}
		}));
		for (const pattern of ['**/.copilot/hooks/deepseek-critic.json', '**/.copilot/hooks/deepseek-critic.config.json', '**/.copilot/hooks/deepseek-critic.py']) {
			const watcher = this._register(vscode.workspace.createFileSystemWatcher(pattern));
			this._register(watcher.onDidCreate(() => this.updateStatusBar()));
			this._register(watcher.onDidChange(() => this.updateStatusBar()));
			this._register(watcher.onDidDelete(() => this.updateStatusBar()));
		}
		this.updateStatusBar();
	}

	private async installWorkspaceHook(workspaceFolder: vscode.WorkspaceFolder | undefined): Promise<void> {
		if (!workspaceFolder) {
			void vscode.window.showWarningMessage('Open a workspace folder first to install the DeepSeek critic hook.');
			return;
		}

		const extension = vscode.extensions.getExtension('GitHub.copilot-chat') ?? vscode.extensions.getExtension('github.copilot-chat');
		if (!extension) {
			void vscode.window.showErrorMessage('Could not resolve the Copilot Chat extension assets.');
			return;
		}

		const { hooksDir, scriptUri, configUri, hookUri } = this.getHookUris(workspaceFolder);
		await vscode.workspace.fs.createDirectory(hooksDir);

		const assetScriptUri = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'hooks', HOOK_SCRIPT_NAME);
		const assetConfigUri = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'hooks', HOOK_RUNTIME_CONFIG_NAME);

		const [scriptTemplate, configTemplate] = await Promise.all([
			vscode.workspace.fs.readFile(assetScriptUri),
			vscode.workspace.fs.readFile(assetConfigUri),
		]);

		await Promise.all([
			vscode.workspace.fs.writeFile(scriptUri, scriptTemplate),
			vscode.workspace.fs.writeFile(configUri, configTemplate),
		]);

		const hookJson = {
			hooks: {
				UserPromptSubmit: [
					{
						matcher: '*',
						hooks: [
							{
								type: 'command',
								command: JSON.stringify(scriptUri.fsPath),
							},
						],
					},
				],
			},
		};
		await vscode.workspace.fs.writeFile(hookUri, Buffer.from(JSON.stringify(hookJson, null, 2), 'utf8'));

		await makeExecutable(scriptUri.fsPath, this.logService);
		this.updateStatusBar();

		const openChoice = 'Open config';
		const openHookChoice = 'Open hook';
		const choice = await vscode.window.showInformationMessage(
			'DeepSeek critic hook installed. It will now be auto-detected by this workspace when present.',
			openChoice,
			openHookChoice,
		);

		if (choice === openChoice) {
			await vscode.window.showTextDocument(configUri);
		} else if (choice === openHookChoice) {
			await vscode.window.showTextDocument(hookUri);
		}
	}

	private async manageWorkspaceHook(workspaceFolder: vscode.WorkspaceFolder | undefined): Promise<void> {
		if (!workspaceFolder) {
			void vscode.window.showWarningMessage('Open a workspace folder first to manage the DeepSeek critic hook.');
			return;
		}

		if (!this.isWorkspaceHookInstalled(workspaceFolder)) {
			await this.installWorkspaceHook(workspaceFolder);
			return;
		}

		const { scriptUri, configUri, hookUri } = this.getHookUris(workspaceFolder);
		const choice = await vscode.window.showQuickPick([
			{ label: 'Open config', uri: configUri },
			{ label: 'Open hook JSON', uri: hookUri },
			{ label: 'Open critic script', uri: scriptUri },
			{ label: 'Reinstall from extension assets', uri: undefined as vscode.Uri | undefined, reinstall: true },
		], {
			title: 'DeepSeek Critic',
			placeHolder: 'Choose what to open or refresh',
		});

		if (!choice) {
			return;
		}

		if (choice.reinstall) {
			await this.installWorkspaceHook(workspaceFolder);
			return;
		}

		if (choice.uri) {
			await vscode.window.showTextDocument(choice.uri);
		}
	}

	private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			return vscode.workspace.getWorkspaceFolder(activeEditor.document.uri) ?? vscode.workspace.workspaceFolders?.[0];
		}
		return vscode.workspace.workspaceFolders?.[0];
	}

	private async pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
		const preferred = this.getWorkspaceFolder();
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (preferred || folders.length <= 1) {
			return preferred ?? folders[0];
		}

		const choice = await vscode.window.showWorkspaceFolderPick({
			placeHolder: 'Select the workspace folder for the DeepSeek critic hook',
		});
		return choice ?? preferred;
	}

	private getHookUris(workspaceFolder: vscode.WorkspaceFolder) {
		const hooksDir = vscode.Uri.joinPath(workspaceFolder.uri, HOOKS_DIR);
		return {
			hooksDir,
			scriptUri: vscode.Uri.joinPath(hooksDir, HOOK_SCRIPT_NAME),
			configUri: vscode.Uri.joinPath(hooksDir, HOOK_RUNTIME_CONFIG_NAME),
			hookUri: vscode.Uri.joinPath(hooksDir, HOOK_CONFIG_NAME),
		};
	}

	private isWorkspaceHookInstalled(workspaceFolder: vscode.WorkspaceFolder): boolean {
		const { scriptUri, configUri, hookUri } = this.getHookUris(workspaceFolder);
		return existsSync(scriptUri.fsPath) && existsSync(configUri.fsPath) && existsSync(hookUri.fsPath);
	}

	private updateStatusBar(): void {
		void this.updateStatusBarAsync();
	}

	private async updateStatusBarAsync(): Promise<void> {
		if (!isWorkspaceDeepSeekCriticEnabled()) {
			this.statusBarItem.hide();
			return;
		}

		const workspaceFolder = this.getWorkspaceFolder();
		if (!workspaceFolder) {
			this.statusBarItem.hide();
			return;
		}

		const inspection = await inspectWorkspaceDeepSeekCriticHook(workspaceFolder.uri);
		this.statusBarItem.command = { command: MANAGE_COMMAND, title: 'Manage DeepSeek Critic Hook' };

		if (!inspection.installed) {
			this.statusBarItem.text = '$(tools) Install Critic';
			this.statusBarItem.tooltip = 'Install the DeepSeek critic hook into this workspace so Copilot Chat can receive critic context automatically.';
			this.statusBarItem.backgroundColor = undefined;
			this.statusBarItem.show();
			return;
		}

		if (inspection.issue) {
			this.statusBarItem.text = '$(warning) Critic Issue';
			this.statusBarItem.tooltip = `${inspection.issue.message} Click to inspect or reinstall the DeepSeek critic hook.`;
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.statusBarItem.show();
			return;
		}

		this.statusBarItem.text = '$(hubot) DeepSeek Critic';
		this.statusBarItem.tooltip = 'DeepSeek critic hook is installed for this workspace. Click to open or refresh it.';
		this.statusBarItem.backgroundColor = undefined;
		this.statusBarItem.show();
	}
}

async function makeExecutable(path: string, logService: ILogService): Promise<void> {
	try {
		await fs.chmod(path, 0o755);
	} catch (error) {
		logService.debug(`[DeepSeekCriticContribution] Failed to chmod hook script: ${String(error)}`);
	}
}
