/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, TextDocumentContentProvider, Uri, workspace } from 'vscode';

export const READONLY_SCHEME = 'copilot-cli-readonly';

const contentStore = new Map<string, string>();

export class ReadonlyContentProvider implements TextDocumentContentProvider {
	provideTextDocumentContent(uri: Uri): string {
		const content = contentStore.get(uri.toString());
		return content ?? '';
	}
}

export function setReadonlyContent(uri: Uri, content: string): void {
	contentStore.set(uri.toString(), content);
}

export function clearReadonlyContent(uri: Uri): void {
	contentStore.delete(uri.toString());
}

export function createReadonlyUri(originalPath: string, suffix: string): Uri {
	return Uri.from({
		scheme: READONLY_SCHEME,
		path: originalPath,
		query: suffix,
	});
}

export function registerReadonlyContentProvider(): Disposable {
	const provider = new ReadonlyContentProvider();
	return workspace.registerTextDocumentContentProvider(READONLY_SCHEME, provider);
}
