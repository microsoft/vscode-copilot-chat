/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatHookService } from '../../../platform/chat/common/chatHookService';
import { ILogService } from '../../../platform/log/common/logService';

export class ChatHookService implements IChatHookService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	async executeHook(options: vscode.ChatHookExecutionOptions, token?: vscode.CancellationToken): Promise<vscode.ChatHookResult[]> {
		this._logService.debug(`[ChatHookService] Executing hook: ${options.hookType}`);
		this._logService.trace(`[ChatHookService] Hook input: ${JSON.stringify(options)}`);

		const results = await vscode.chat.executeHook(options, token);

		this._logService.debug(`[ChatHookService] Hook '${options.hookType}' completed with ${results.length} result(s)`);
		this._logService.trace(`[ChatHookService] Hook output: ${JSON.stringify(results)}`);

		return results;
	}
}
