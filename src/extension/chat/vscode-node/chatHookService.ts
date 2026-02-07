/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatHookService } from '../../../platform/chat/common/chatHookService';
import { ISessionTranscriptService } from '../../../platform/chat/common/sessionTranscriptService';
import { raceTimeout } from '../../../util/vs/base/common/async';

export class ChatHookService implements IChatHookService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISessionTranscriptService private readonly _sessionTranscriptService: ISessionTranscriptService,
	) { }

	async executeHook(hookType: vscode.ChatHookType, options: vscode.ChatHookExecutionOptions, sessionId?: string, token?: vscode.CancellationToken): Promise<vscode.ChatHookResult[]> {
		if (sessionId) {
			await raceTimeout(this._sessionTranscriptService.flush(sessionId), 500);

			const transcriptUri = this._sessionTranscriptService.getTranscriptPath(sessionId);
			if (transcriptUri && typeof options.input === 'object' && options.input !== null) {
				(options.input as Record<string, unknown>).transcriptPath = transcriptUri;
			}
		}

		return vscode.chat.executeHook(hookType, options, token) ?? Promise.resolve([]);
	}
}
