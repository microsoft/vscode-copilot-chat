/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, Uri } from 'vscode';

export async function startReplayInChat() {
	await commands.executeCommand('workbench.panel.chat.view.copilot.focus');
	await commands.executeCommand('type', {
		text: `\@chatReplay`,
	});
	await commands.executeCommand('workbench.action.chat.submit');
}

export function showFileDiff(path: string, newContentPath: string, title: string) {
	const left = Uri.file(path);
	const right = Uri.file(newContentPath);
	void commands.executeCommand('vscode.diff', left, right, title, { inline: true, preview: true });
}
