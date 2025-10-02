/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { ICopilotCLISession, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';

export class CopilotCLIChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) { }

	async provideChatSessionContent(copilotcliSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const existingSession = copilotcliSessionId && await this.sessionService.getSession(copilotcliSessionId, token);
		const history = existingSession ?
			this._buildChatHistory(existingSession) :
			[];

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
		};
	}

	private _buildChatHistory(existingSession: ICopilotCLISession | undefined): (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] {
		if (!existingSession) {
			return [];
		}

		return coalesce(existingSession.events.map((event: any) => {
			if (event.type === 'message') {
				if (event.role === 'user') {
					return new ChatRequestTurn2(event.content || '', undefined, [], '', [], undefined);
				} else if (event.role === 'assistant') {
					const responseParts: vscode.ChatResponseMarkdownPart[] = [
						new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(event.content || ''))
					];
					return new vscode.ChatResponseTurn2(responseParts, {}, '');
				}
			}
			return undefined;
		}));
	}
}
