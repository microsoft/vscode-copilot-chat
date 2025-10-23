/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { localize } from '../../../util/vs/nls';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { ClaudeChatSessionItemProvider, ClaudeSessionUri } from './claudeChatSessionItemProvider';

export class ClaudeChatSessionParticipant {
	constructor(
		private readonly sessionType: string,
		private readonly claudeAgentManager: ClaudeAgentManager,
		private readonly sessionItemProvider: ClaudeChatSessionItemProvider,
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		const create = async () => {
			const { claudeSessionId } = await this.claudeAgentManager.handleRequest(undefined, request, context, stream, token);
			if (!claudeSessionId) {
				stream.warning(localize('claude.failedToCreateSession', "Failed to create a new Claude Code session."));
				return undefined;
			}
			return claudeSessionId;
		};
		const { chatSessionContext } = context;
		if (chatSessionContext) {
			if (chatSessionContext.isUntitled) {
				/* New, empty session */
				const claudeSessionId = await create();
				if (claudeSessionId) {
					// Tell UI to replace with claude-backed session
					this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, {
						resource: ClaudeSessionUri.forSessionId(claudeSessionId),
						label: request.prompt ?? 'Claude Code'
					});
				}
				return {};
			}

			/* Existing session */
			const id = ClaudeSessionUri.getId(chatSessionContext.chatSessionItem.resource);
			await this.claudeAgentManager.handleRequest(id, request, context, stream, token);
			return {};
		}
		/* Via @claude */
		// TODO: Think about how this should work
		stream.markdown(localize('claude.viaAtClaude', "Start a new Claude Code session"));
		stream.button({ command: `workbench.action.chat.openNewSessionEditor.${this.sessionType}`, title: localize('claude.startNewSession', "Start Session") });
		return {};
	}
}
