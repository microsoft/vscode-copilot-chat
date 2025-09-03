/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SDKMessage } from '@anthropic-ai/claude-code';
import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { ClaudeToolNames, IExitPlanModeInput } from '../../agents/claude/common/claudeTools';
import { createFormattedToolInvocation } from '../../agents/claude/common/toolInvocationFormatter';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { IClaudeCodeSession, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';
import { ClaudeSessionDataStore } from './claudeChatSessionItemProvider';

interface ToolContext {
	unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

export class ClaudeChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly claudeAgentManager: ClaudeAgentManager,
		private readonly sessionStore: ClaudeSessionDataStore,
		@IClaudeCodeSessionService private readonly sessionService: IClaudeCodeSessionService,
		@ILogService private readonly logService: ILogService
	) { }

	async provideChatSessionContent(internalSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const initialRequest = this.sessionStore.getAndConsumeInitialRequest(internalSessionId);
		const claudeSessionId = this.sessionStore.getSessionId(internalSessionId) ?? internalSessionId;
		const existingSession = claudeSessionId && await this.sessionService.getSession(claudeSessionId, token);
		const toolContext = this._createToolContext();
		const history = existingSession ?
			this._buildChatHistory(existingSession, toolContext) :
			[];
		if (initialRequest) {
			history.push(new ChatRequestTurn2(initialRequest.prompt, undefined, [], '', [], undefined));
		}
		return {
			history,
			// This is called to attach to a previous or new session- send a request if it's a new session
			activeResponseCallback: initialRequest ?
				async (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
					this._log(`Starting activeResponseCallback, internalID: ${internalSessionId}`);
					const request = this._createInitialChatRequest(initialRequest, internalSessionId);
					const result = await this.claudeAgentManager.handleRequest(undefined, request, { history: [] }, stream, token);
					if (result.claudeSessionId) {
						this._log(`activeResponseCallback, setClaudeSessionId: ${internalSessionId} -> ${result.claudeSessionId}`);
						this.sessionStore.setClaudeSessionId(internalSessionId, result.claudeSessionId);
					}
				} :
				undefined,
			requestHandler: async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
				const claudeSessionId = this.sessionStore.getSessionId(internalSessionId);
				this._log(`requestHandler, internalID: ${internalSessionId}, claudeID: ${claudeSessionId}`);
				const result = await this.claudeAgentManager.handleRequest(claudeSessionId, request, context, stream, token);
				if (result.claudeSessionId) {
					this.sessionStore.setClaudeSessionId(internalSessionId, result.claudeSessionId);
				}
				return result;
			}
		};
	}

	private _log(message: string): void {
		this.logService.debug(`[ClaudeChatSessionContentProvider] ${message}`);
	}

	private _userMessageToRequest(message: Anthropic.MessageParam, toolContext: ToolContext): vscode.ChatRequestTurn2 | undefined {
		const textContent = this._extractTextContent(message.content);
		this._processToolResults(message.content, toolContext);

		// If the user message only contains tool results and no visible text, don't create a request turn
		if (!textContent.trim()) {
			return;
		}

		return new ChatRequestTurn2(textContent, undefined, [], '', [], undefined);
	}

	private _assistantMessageToResponse(message: Anthropic.Message, toolContext: ToolContext): vscode.ChatResponseTurn2 {
		const responseParts = coalesce(message.content.map(block => {
			if (block.type === 'text') {
				return new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(block.text));
			} else if (block.type === 'tool_use') {
				if (block.name === ClaudeToolNames.ExitPlanMode) {
					return new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(`\`\`\`\`\n${(block.input as IExitPlanModeInput).plan}\`\`\`\n\n`));
				}

				toolContext.unprocessedToolCalls.set(block.id, block);
				const toolInvocation = createFormattedToolInvocation(block);
				if (toolInvocation) {
					toolContext.pendingToolInvocations.set(block.id, toolInvocation);
				}
				return toolInvocation;
			}
		}));

		return new vscode.ChatResponseTurn2(responseParts, {}, '');
	}

	private _createToolContext(): ToolContext {
		return {
			unprocessedToolCalls: new Map(),
			pendingToolInvocations: new Map()
		};
	}

	private _buildChatHistory(existingSession: IClaudeCodeSession | undefined, toolContext: ToolContext): (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] {
		if (!existingSession) {
			return [];
		}

		return coalesce(existingSession.messages.map((m: SDKMessage) => {
			if (m.type === 'user') {
				return this._userMessageToRequest(m.message, toolContext);
			} else if (m.type === 'assistant') {
				return this._assistantMessageToResponse(m.message, toolContext);
			}
		}));
	}

	private _createInitialChatRequest(initialRequest: vscode.ChatRequest, internalSessionId: string): vscode.ChatRequest {
		return {
			...initialRequest,
			// TODO this does not work
			toolInvocationToken: { sessionId: internalSessionId } as vscode.ChatParticipantToolToken
		};
	}

	private _extractTextContent(content: string | Anthropic.ContentBlockParam[]): string {
		if (typeof content === 'string') {
			return content;
		}

		return content
			.filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
			.map(block => block.text)
			.join('');
	}

	private _processToolResults(content: string | Anthropic.ContentBlockParam[], toolContext: ToolContext): void {
		if (typeof content === 'string') {
			return;
		}

		for (const block of content) {
			if (block.type === 'tool_result') {
				const toolResultBlock = block as Anthropic.ToolResultBlockParam;
				const toolUse = toolContext.unprocessedToolCalls.get(toolResultBlock.tool_use_id);
				if (toolUse) {
					toolContext.unprocessedToolCalls.delete(toolResultBlock.tool_use_id);
					const pendingInvocation = toolContext.pendingToolInvocations.get(toolResultBlock.tool_use_id);
					if (pendingInvocation) {
						createFormattedToolInvocation(toolUse, toolResultBlock, pendingInvocation);
						toolContext.pendingToolInvocations.delete(toolResultBlock.tool_use_id);
					}
				}
			}
		}
	}

}