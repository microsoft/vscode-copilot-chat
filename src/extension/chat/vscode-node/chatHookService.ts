/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatHookService } from '../../../platform/chat/common/chatHookService';

export class ChatHookService implements IChatHookService {
	declare readonly _serviceBrand: undefined;

	async executeHook(hookType: vscode.ChatHookType, options: vscode.ChatHookExecutionOptions, token?: vscode.CancellationToken): Promise<vscode.ChatHookResult[]> {
		// Just be nice to vscode devs with this API change
		return vscode.chat.executeHook?.(hookType, options, token);
	}
}
