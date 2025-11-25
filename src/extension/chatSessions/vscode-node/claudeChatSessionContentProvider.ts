/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-code';
import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { ClaudeToolNames, IExitPlanModeInput } from '../../agents/claude/common/claudeTools';
import { createFormattedToolInvocation } from '../../agents/claude/common/toolInvocationFormatter';
import { IClaudeCodeSession, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';

interface ToolContext {
	unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

export class ClaudeChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		@IClaudeCodeSessionService private readonly sessionService: IClaudeCodeSessionService,
	) { }

	async provideChatSessionContent(sessionResource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const existingSession = await this.sessionService.getSession(sessionResource, token);
		const toolContext = this._createToolContext();
		const history = existingSession ?
			this._buildChatHistory(existingSession, toolContext) :
			[];

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
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

	private _assistantMessageToResponse(message: SDKAssistantMessage['message'], toolContext: ToolContext): vscode.ChatResponseTurn2 {
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