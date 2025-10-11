/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { buildChatHistoryFromEvents, parseChatMessagesToEvents } from '../../agents/copilotcli/node/copilotcliToolInvocationFormatter';

export class CopilotCLIChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) { }

	async provideChatSessionContent(copilotcliSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const existingSession = copilotcliSessionId && await this.sessionService.getSession(copilotcliSessionId, token);
		const sdkSession = existingSession ? existingSession.sdkSession : undefined;
		const chatMessages = sdkSession?.chatMessages || [];
		const events = parseChatMessagesToEvents(chatMessages);

		const history = existingSession ? buildChatHistoryFromEvents(events) : [];

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
		};
	}
}
