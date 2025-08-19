/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands } from 'vscode';

export async function startReplayInChat(request: string) {
	await commands.executeCommand('workbench.panel.chat.view.copilot.focus');
	await commands.executeCommand('type', {
		text: request,
	});
	await commands.executeCommand('workbench.action.chat.submit');
}