/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { localize } from '../../../util/vs/nls';
import { OpenCodeAgentManager } from '../../agents/opencode/node/opencodeAgentManager';
import { OpenCodeChatSessionItemProvider } from './opencodeChatSessionItemProvider';

export class OpenCodeChatSessionParticipant {
	constructor(
		private readonly sessionType: string,
		private readonly opencodeAgentManager: OpenCodeAgentManager,
		private readonly sessionItemProvider: OpenCodeChatSessionItemProvider,
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		const create = async () => {
			const result = await this.opencodeAgentManager.handleRequest(undefined, request, context, stream, token);
			const opencodeSessionId = result.sessionId;
			if (!opencodeSessionId) {
				stream.warning(localize('opencode.failedToCreateSession', "Failed to create a new OpenCode session."));
				return undefined;
			}
			return opencodeSessionId;
		};

		const { chatSessionContext } = context;
		if (chatSessionContext) {
			if (chatSessionContext.isUntitled) {
				/* New, empty session */
				const opencodeSessionId = await create();
				if (opencodeSessionId) {
					// Tell UI to replace with opencode-backed session
					this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { id: opencodeSessionId, label: request.prompt ?? 'OpenCode' });
				}
				return {};
			}

			/* Existing session */
			const { id } = chatSessionContext.chatSessionItem;
			await this.opencodeAgentManager.handleRequest(id, request, context, stream, token);
			return {};
		}

		/* Via @opencode */
		// TODO: Think about how this should work
		stream.markdown(localize('opencode.viaAtOpencode', "Start a new OpenCode session"));
		stream.button({ command: `workbench.action.chat.openNewSessionEditor.${this.sessionType}`, title: localize('opencode.startNewSession', "Start Session") });
		return {};
	}
}