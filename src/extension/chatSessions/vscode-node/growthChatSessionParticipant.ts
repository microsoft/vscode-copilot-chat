/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';

/**
 * Chat participant for product growth and user education.
 * Sends educational messages to teach users how to use Copilot features.
 */
export class GrowthChatSessionParticipant {
	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		this.logService.info(`[GrowthChatSessionParticipant] Handling request: ${request.prompt}`);

		// For now, just send a simple educational message
		stream.markdown(vscode.l10n.t('Welcome! This is an educational message from Copilot Growth.'));

		return {};
	}

	/**
	 * Sends a "needs-input" educational message to help users understand how to use Copilot.
	 * This is the key method for product growth - it can be called to proactively teach users.
	 */
	public async sendNeedsInputMessage(message: string, actionButton?: { command: string; title: string }): Promise<void> {
		// To send a message from the growth participant, we would need to:
		// 1. Get or create a chat session
		// 2. Send the message through the chat API
		// 
		// For now, this is a placeholder that can be expanded when the chat API
		// supports sending messages from extensions outside of request handlers.
		
		this.logService.info(`[GrowthChatSessionParticipant] Would send needs-input message: ${message}`);
		
		// Display as an information message for now (temporary for testing)
		if (actionButton) {
			const selection = await vscode.window.showInformationMessage(message, actionButton.title);
			if (selection === actionButton.title) {
				await vscode.commands.executeCommand(actionButton.command);
			}
		} else {
			await vscode.window.showInformationMessage(message);
		}
	}

	/**
	 * Sends a feature tip educational message.
	 */
	public async sendFeatureTip(tip: string): Promise<void> {
		this.logService.info(`[GrowthChatSessionParticipant] Sending feature tip: ${tip}`);
		
		// Display as an information message for now (temporary for testing)
		await vscode.window.showInformationMessage(tip);
	}
}
