/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SDKMessage } from '@anthropic-ai/claude-code';
import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { IClaudeCodeSession, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';
import { ClaudeAgentManager } from '../../agents/claude/vscode-node/claudeCodeAgent';
import { ClaudeSessionDataStore } from './claudeChatSessionItemProvider';

interface ToolContext {
	unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

export class ClaudeChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly claudeAgentManager: ClaudeAgentManager,
		private readonly sessionStore: ClaudeSessionDataStore,
		@IClaudeCodeSessionService private readonly sessionService: IClaudeCodeSessionService
	) { }

	async provideChatSessionContent(internalSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const initialPrompt = this.sessionStore.getAndConsumeInitialPrompt(internalSessionId);
		const existingSession = await this.sessionService.getSession(internalSessionId, token);
		const toolContext = this._createToolContext();
		const history = this._buildChatHistory(existingSession, toolContext);

		return {
			history,
			activeResponseCallback: async (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
				// This is called to attach to a previous or new session- send a request if it's a new session
				if (initialPrompt) {
					const request = this._createInitialChatRequest(initialPrompt);
					const result = await this.claudeAgentManager.handleRequest(undefined, request, { history: [] }, stream, token);
					if (result.claudeSessionId) {
						this.sessionStore.setClaudeSessionId(internalSessionId, result.claudeSessionId);
					}
				}
			},
			requestHandler: (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
				const claudeSessionId = this.sessionStore.getSessionId(internalSessionId);
				return this.claudeAgentManager.handleRequest(claudeSessionId, request, context, stream, token);
			}
		};
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
				toolContext.unprocessedToolCalls.set(block.id, block);
				const toolInvocation = new vscode.ChatToolInvocationPart(block.name, block.id, false);
				toolInvocation.invocationMessage = new vscode.MarkdownString(`**${block.name}**`);
				toolContext.pendingToolInvocations.set(block.id, toolInvocation);
				return toolInvocation;
			}
		}));

		return new vscode.ChatResponseTurn2(responseParts, {}, '');
	}

	private _createToolInvocationPart(toolUse: Anthropic.ToolUseBlock, toolResult: Anthropic.ToolResultBlockParam): vscode.ChatToolInvocationPart {
		const toolInvocation = new vscode.ChatToolInvocationPart(toolUse.name, toolUse.id, toolResult.is_error ?? false);
		const content = this._extractToolResultContent(toolResult.content);
		toolInvocation.invocationMessage = this._formatToolContent(toolUse.name, content);
		return toolInvocation;
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

	private _createInitialChatRequest(initialPrompt: string | undefined): vscode.ChatRequest {
		return {
			attempt: 0,
			command: undefined,
			enableCommandDetection: false,
			id: '',
			isParticipantDetected: false,
			location: vscode.ChatLocation.Panel,
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
						const completedInvocation = this._createToolInvocationPart(toolUse, toolResultBlock);
						pendingInvocation.invocationMessage = completedInvocation.invocationMessage;
						toolContext.pendingToolInvocations.delete(toolResultBlock.tool_use_id);
					}
				}
			}
		}
	}

	private _extractToolResultContent(content: string | (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] | undefined): string {
		if (typeof content === 'string') {
			return content;
		}

		if (!content) {
			return '';
		}

		return content
			.filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
			.map(block => block.text)
			.join('\n');
	}

	private _formatToolContent(toolName: string, content: string): vscode.MarkdownString {
		return toolName === 'bash'
			? new vscode.MarkdownString(`\`\`\`bash\n${content}\n\`\`\``)
			: new vscode.MarkdownString(content);
	}
}