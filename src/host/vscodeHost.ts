/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CopilotChatHost, Disposable, WebviewHandle, WebviewOptions } from './host';

type WebviewListener = (message: unknown) => void;

export class VsCodeHost implements CopilotChatHost {
	private webviewHandles = new Map<WebviewHandle, vscode.WebviewView | vscode.WebviewPanel>();
	private webviewSubscriptions = new Map<WebviewHandle, vscode.Disposable>();
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	async getVersion(): Promise<string> {
		return vscode.version;
	}

	async getLocale(): Promise<string> {
		return vscode.env.language;
	}

	async showMessage(level: 'info' | 'warn' | 'error', text: string): Promise<void> {
		if (level === 'error') {
			await vscode.window.showErrorMessage(text);
			return;
		}
		if (level === 'warn') {
			await vscode.window.showWarningMessage(text);
			return;
		}
		await vscode.window.showInformationMessage(text);
	}

	async readFile(uri: string): Promise<string> {
		const data = await vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
		return Buffer.from(data).toString('utf8');
	}

	async listWorkspaceRoots(): Promise<string[]> {
		return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString());
	}

	async storageGet(scope: 'global' | 'workspace', key: string): Promise<unknown> {
		return scope === 'global' ? this.context.globalState.get(key) : this.context.workspaceState.get(key);
	}

	async storageSet(scope: 'global' | 'workspace', key: string, value: unknown): Promise<void> {
		if (scope === 'global') {
			await this.context.globalState.update(key, value);
			return;
		}
		await this.context.workspaceState.update(key, value);
	}

	async createWebview(viewId: string, options?: WebviewOptions): Promise<WebviewHandle> {
		const handle = `webview_${viewId}_${Date.now()}`;
		const panel = vscode.window.createWebviewPanel(viewId, viewId, vscode.ViewColumn.Active, {
			enableScripts: options?.enableScripts ?? true
		});
		this.webviewHandles.set(handle, panel);
		return handle;
	}

	async postWebviewMessage(handle: WebviewHandle, message: unknown): Promise<boolean> {
		const target = this.webviewHandles.get(handle);
		if (!target) {
			return false;
		}
		return target.webview.postMessage(message);
	}

	onWebviewMessage(handle: WebviewHandle, listener: WebviewListener): Disposable {
		const target = this.webviewHandles.get(handle);
		if (!target) {
			return { dispose() { /* noop */ } };
		}
		const subscription = target.webview.onDidReceiveMessage(listener);
		this.webviewSubscriptions.set(handle, subscription);
		return subscription;
	}
}
