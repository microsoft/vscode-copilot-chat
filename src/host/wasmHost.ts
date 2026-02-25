/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotChatHost, Disposable, WebviewHandle, WebviewOptions } from './host';

/**
 * WASM host stub. This is a placeholder adapter for Logos WASM extension runtime.
 * Implementation is expected to be provided by the WASM host environment.
 */
export class WasmHost implements CopilotChatHost {
	async getVersion(): Promise<string> {
		throw new Error('WasmHost.getVersion not implemented');
	}

	async getLocale(): Promise<string> {
		throw new Error('WasmHost.getLocale not implemented');
	}

	async showMessage(_level: 'info' | 'warn' | 'error', _text: string): Promise<void> {
		throw new Error('WasmHost.showMessage not implemented');
	}

	async readFile(_uri: string): Promise<string> {
		throw new Error('WasmHost.readFile not implemented');
	}

	async listWorkspaceRoots(): Promise<string[]> {
		throw new Error('WasmHost.listWorkspaceRoots not implemented');
	}

	async storageGet(_scope: 'global' | 'workspace', _key: string): Promise<unknown> {
		throw new Error('WasmHost.storageGet not implemented');
	}

	async storageSet(_scope: 'global' | 'workspace', _key: string, _value: unknown): Promise<void> {
		throw new Error('WasmHost.storageSet not implemented');
	}

	async createWebview(_viewId: string, _options?: WebviewOptions): Promise<WebviewHandle> {
		throw new Error('WasmHost.createWebview not implemented');
	}

	async postWebviewMessage(_handle: WebviewHandle, _message: unknown): Promise<boolean> {
		throw new Error('WasmHost.postWebviewMessage not implemented');
	}

	onWebviewMessage(_handle: WebviewHandle, _listener: (message: unknown) => void): Disposable {
		throw new Error('WasmHost.onWebviewMessage not implemented');
	}
}
