/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatLocation } from 'vscode';
import { ClaudeAgentManager } from '../../agents/claude/vscode-node/claudeCodeAgent';
import { ClaudeSessionStore } from './claudeChatSessionItemProvider';

export class ChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly claudeAgentManager: ClaudeAgentManager,
		private readonly sessionStore: ClaudeSessionStore
	) { }

	async provideChatSessionContent(internalSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const initialPrompt = this.sessionStore.getAndConsumeInitialPrompt(internalSessionId);
		return {
			history: [
				new vscode.ChatRequestTurn2(initialPrompt ?? '', undefined, [], '', [], undefined)
			],
			activeResponseCallback: async (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
				const request: vscode.ChatRequest = {
					attempt: 0,
					command: undefined,
					enableCommandDetection: false,
					id: '',
					isParticipantDetected: false,
					location: ChatLocation.Panel,
					location2: undefined,
					model: null!,
					prompt: initialPrompt ?? '',
					references: [],
					toolReferences: [],
					tools: new Map(),
					acceptedConfirmationData: undefined,
					editedFileEvents: undefined,
					toolInvocationToken: {} as never
				};
				const result = await this.claudeAgentManager.handleRequest(undefined, request, { history: [] }, stream, token);
				if (result.claudeSessionId) {
					this.sessionStore.setClaudeSessionId(internalSessionId, result.claudeSessionId);
				}
			},
			requestHandler: (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
				const claudeSessionId = this.sessionStore.getSessionId(internalSessionId);
				return this.claudeAgentManager.handleRequest(claudeSessionId, request, context, stream, token);
			}
		};
	}
}