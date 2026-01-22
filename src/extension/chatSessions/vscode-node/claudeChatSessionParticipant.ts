/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { IClaudeSlashCommandService } from '../../agents/claude/vscode-node/claudeSlashCommandService';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider } from './claudeChatSessionItemProvider';

// Import the tool permission handlers
import { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import '../../agents/claude/vscode-node/toolPermissionHandlers/index';

export class ClaudeChatSessionParticipant {
	constructor(
		private readonly sessionType: string,
		private readonly claudeAgentManager: ClaudeAgentManager,
		private readonly sessionItemProvider: ClaudeChatSessionItemProvider,
		private readonly contentProvider: ClaudeChatSessionContentProvider,
		private readonly slashCommandService: IClaudeSlashCommandService,
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		// Try to handle as a slash command first
		const slashResult = await this.slashCommandService.tryHandleCommand(request.prompt, stream, token);
		if (slashResult.handled) {
			return slashResult.result ?? {};
		}

		const create = async (modelId?: string, permissionMode?: PermissionMode) => {
			const { claudeSessionId } = await this.claudeAgentManager.handleRequest(undefined, request, context, stream, token, modelId, permissionMode);
			if (!claudeSessionId) {
				stream.warning(vscode.l10n.t("Failed to create a new Claude Code session."));
				return undefined;
			}
			return claudeSessionId;
		};
		const { chatSessionContext } = context;
		if (chatSessionContext) {
			const sessionId = this.sessionItemProvider.getSessionId(chatSessionContext.chatSessionItem.resource);
			const modelId = sessionId ? await this.contentProvider.getModelIdForSession(sessionId) : undefined;
			const permissionMode = sessionId ? this.contentProvider.getPermissionModeForSession(sessionId) : undefined;

			if (chatSessionContext.isUntitled || !sessionId) {
				/* New, empty session */
				const claudeSessionId = await create(modelId, permissionMode);
				if (claudeSessionId) {
					// Add the new session directly to the controller
					this.sessionItemProvider.addSession(
						claudeSessionId,
						request.prompt,
						new Date(),
						chatSessionContext.chatSessionItem.resource
					);
				}
				return {};
			}

			/* Existing session */
			await this.claudeAgentManager.handleRequest(sessionId, request, context, stream, token, modelId, permissionMode);
			return {};
		}
		/* Via @claude */
		// TODO: Think about how this should work
		stream.markdown(vscode.l10n.t("Start a new Claude Code session"));
		stream.button({ command: `workbench.action.chat.openNewSessionEditor.${this.sessionType}`, title: vscode.l10n.t("Start Session") });
		return {};
	}
}
