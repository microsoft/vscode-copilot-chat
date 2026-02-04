/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Content provider for growth/educational chat sessions.
 * Provides the chat history and content for educational messages.
 */
export class GrowthChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {

	constructor() {
		super();
	}

	public async provideChatSessionContent(resource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		// Return a session with empty history since this is for showing new educational messages
		return {
			history: [],
			requestHandler: undefined, // Read-only session
		};
	}
}
