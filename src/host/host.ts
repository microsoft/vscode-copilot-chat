/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type Disposable = { dispose(): void };

export type WebviewHandle = string;

export type WebviewOptions = {
	enableScripts?: boolean;
};

export interface CopilotChatHost {
	getVersion(): Promise<string>;
	getLocale(): Promise<string>;

	showMessage(level: 'info' | 'warn' | 'error', text: string): Promise<void>;

	readFile(uri: string): Promise<string>;
	listWorkspaceRoots(): Promise<string[]>;

	storageGet(scope: 'global' | 'workspace', key: string): Promise<unknown>;
	storageSet(scope: 'global' | 'workspace', key: string, value: unknown): Promise<void>;

	createWebview(viewId: string, options?: WebviewOptions): Promise<WebviewHandle>;
	postWebviewMessage(handle: WebviewHandle, message: unknown): Promise<boolean>;
	onWebviewMessage(handle: WebviewHandle, listener: (message: unknown) => void): Disposable;
}

let currentHost: CopilotChatHost | null = null;

export function setHost(host: CopilotChatHost): void {
	currentHost = host;
}

export function getHost(): CopilotChatHost {
	if (!currentHost) {
		throw new Error('Copilot Chat host has not been initialized.');
	}
	return currentHost;
}
