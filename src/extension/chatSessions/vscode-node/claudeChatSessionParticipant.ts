/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { NoClaudeModelsAvailableError } from '../../agents/claude/node/claudeCodeModels';
import { IClaudeSlashCommandService } from '../../agents/claude/vscode-node/claudeSlashCommandService';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider, ClaudeSessionUri } from './claudeChatSessionItemProvider';

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

		const create = async (modelId: string, permissionMode?: PermissionMode) => {
			const result = await this.claudeAgentManager.handleRequest(undefined, request, context, stream, token, modelId, permissionMode);
			if (!result.claudeSessionId) {
				// Only show generic warning if we didn't already show a specific error
				if (!result.errorDetails) {
					stream.warning(vscode.l10n.t("Failed to create a new Claude Code session."));
				}
				return { claudeSessionId: undefined, errorDetails: result.errorDetails };
			}
			return { claudeSessionId: result.claudeSessionId, errorDetails: undefined };
		};
		const { chatSessionContext } = context;
		if (chatSessionContext) {
			const sessionId = ClaudeSessionUri.getId(chatSessionContext.chatSessionItem.resource);
			let modelId: string;
			try {
				modelId = await this.contentProvider.getModelIdForSession(sessionId);
			} catch (e) {
				if (e instanceof NoClaudeModelsAvailableError) {
					return { errorDetails: { message: e.message } };
				}
				throw e;
			}
			const permissionMode = this.contentProvider.getPermissionModeForSession(sessionId);

			if (chatSessionContext.isUntitled) {
				/* New, empty session */
				const result = await create(modelId, permissionMode);
				if (result.claudeSessionId) {
					// Tell UI to replace with claude-backed session
					this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, {
						resource: ClaudeSessionUri.forSessionId(result.claudeSessionId),
						label: request.prompt ?? 'Claude Code'
					});
				}
				return result.errorDetails ? { errorDetails: result.errorDetails } : {};
			}

			/* Existing session */
			const result = await this.claudeAgentManager.handleRequest(sessionId, request, context, stream, token, modelId, permissionMode);
			return result.errorDetails ? { errorDetails: result.errorDetails } : {};
		}
		/* Via @claude */
		// TODO: Think about how this should work
		stream.markdown(vscode.l10n.t("Start a new Claude Code session"));
		stream.button({ command: `workbench.action.chat.openNewSessionEditor.${this.sessionType}`, title: vscode.l10n.t("Start Session") });
		return {};
	}
}
