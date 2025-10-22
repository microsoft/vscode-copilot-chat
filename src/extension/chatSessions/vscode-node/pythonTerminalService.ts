/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { PythonEnvironmentApi } from './pythonEnvironmentApi';

export class PythonTerminalService {
	constructor(@ILogService private readonly logService: ILogService,
	) { }

	private async getEnvExtApi(): Promise<PythonEnvironmentApi | undefined> {
		const extension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
		if (!extension) {
			return undefined;
		}
		if (!extension.isActive) {
			await extension.activate();
		}

		return extension.exports;
	}

	private async getPythonEnvironmentForWorkspace() {
		const workspaceUri = vscode.workspace.workspaceFolders?.length ? vscode.workspace.workspaceFolders[0].uri : undefined;
		if (!workspaceUri) {
			return;
		}

		try {
			const api = await this.getEnvExtApi();
			if (!api) {
				return;
			}
			const env = await api.getEnvironment(workspaceUri);
			if (!env || !env.sysPrefix.toLowerCase().startsWith(workspaceUri.fsPath.toLowerCase())) {
				return;
			}
			return { api, env };
		} catch (ex) {
			this.logService.error('Failed to get Python environment', ex.toString());
		}

	}
	public async shouldUsePythonTerminal(): Promise<boolean> {
		const info = await this.getPythonEnvironmentForWorkspace();
		return !!info;
	}

	public async createTerminal(options: vscode.TerminalOptions) {
		const info = await this.getPythonEnvironmentForWorkspace();
		if (!info) {
			return;
		}

		try {
			const terminal = await info.api.createTerminal(info.env, { ...options, hideFromUser: true });
			terminal.show();
			return terminal;
		} catch (ex) {
			this.logService.error('Failed to create terminal with Python environment', ex.toString());
		}
	}
}