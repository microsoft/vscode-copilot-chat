/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { localize } from '../../../util/vs/nls';
import { CopilotCLIAgentManager } from '../../agents/copilotcli/node/copilotcliAgentManager';
import { CopilotCLIChatSessionItemProvider } from './copilotcliChatSessionItemProvider';

export class CopilotCLIChatSessionParticipant {
	constructor(
		private readonly sessionType: string,
		private readonly copilotcliAgentManager: CopilotCLIAgentManager,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		const create = async () => {
			const { copilotcliSessionId } = await this.copilotcliAgentManager.handleRequest(undefined, request, context, stream, token);
			if (!copilotcliSessionId) {
				stream.warning(localize('copilotcli.failedToCreateSession', "Failed to create a new CopilotCLI session."));
				return undefined;
			}
			return copilotcliSessionId;
		};
		const { chatSessionContext } = context;
		if (chatSessionContext) {
			if (chatSessionContext.isUntitled) {
				const copilotcliSessionId = await create();
				if (copilotcliSessionId) {
					this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { id: copilotcliSessionId, label: request.prompt ?? 'CopilotCLI' });
				}
				return {};
			}

			const { id } = chatSessionContext.chatSessionItem;
			await this.copilotcliAgentManager.handleRequest(id, request, context, stream, token);
			return {};
		}

		stream.markdown(localize('copilotcli.viaAtCopilotcli', "Start a new CopilotCLI session"));
		stream.button({ command: `workbench.action.chat.openNewSessionEditor.${this.sessionType}`, title: localize('copilotcli.startNewSession', "Start Session") });
		return {};
	}
}
