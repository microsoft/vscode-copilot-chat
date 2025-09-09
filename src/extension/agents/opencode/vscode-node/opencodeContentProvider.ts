/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { ChatRequestTurn2 } from '../../../../vscodeTypes';
import { IOpenCodeAgentManager } from '../node/opencodeAgentManager';
import { OpenCodeMessage, IOpenCodeSession, IOpenCodeSessionService } from '../node/opencodeSessionService';
import { OpenCodeToolInvocation, OpenCodeToolResult } from '../common/opencodeTools';
import { createFormattedToolInvocation } from '../common/toolInvocationFormatter';
import { OpenCodeSessionDataStore } from './opencodeItemProvider';

/**
 * Tool context for tracking tool invocations and results
 */
interface ToolContext {
	unprocessedToolCalls: Map<string, any>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

/**
 * Content provider for OpenCode chat sessions
 * Converts OpenCode session data to VS Code chat format
 */
export class OpenCodeChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly opencodeAgentManager: IOpenCodeAgentManager,
		private readonly sessionStore: OpenCodeSessionDataStore,
		@IOpenCodeSessionService private readonly sessionService: IOpenCodeSessionService,
		@ILogService private readonly logService: ILogService
	) { }

	/**
	 * Provides chat session content for VS Code
	 */
	async provideChatSessionContent(internalSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		this._log(`Providing content for session: ${internalSessionId}`);
		
		const initialRequest = this.sessionStore.getAndConsumeInitialRequest(internalSessionId);
		const opencodeSessionId = this.sessionStore.getSessionId(internalSessionId) ?? internalSessionId;
		const existingSession = opencodeSessionId && await this.sessionService.getSession(opencodeSessionId, token);
		const toolContext = this._createToolContext();
		
		// Build chat history from existing session
		const history = existingSession ?
			this._buildChatHistory(existingSession, toolContext) :
			[];
		
		// Add initial request if this is a new session
		if (initialRequest) {
			history.push(new ChatRequestTurn2(initialRequest.prompt, undefined, [], '', [], undefined));
		}
		
		return {
			history,
			// Active response callback for new sessions
			activeResponseCallback: initialRequest ?
				async (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
					this._log(`Starting activeResponseCallback for session: ${internalSessionId}`);
					const request = this._createInitialChatRequest(initialRequest, internalSessionId);
					const result = await this.opencodeAgentManager.handleRequest(undefined, request, { history: [] }, stream, token);
					if (result.sessionId) {
						this._log(`Setting OpenCode session ID: ${internalSessionId} -> ${result.sessionId}`);
						this.sessionStore.setOpenCodeSessionId(internalSessionId, result.sessionId);
					}
				} :
				undefined,
			// Request handler for ongoing conversation
			requestHandler: async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
				const opencodeSessionId = this.sessionStore.getSessionId(internalSessionId);
				this._log(`Handling request for session - internal: ${internalSessionId}, opencode: ${opencodeSessionId}`);
				const result = await this.opencodeAgentManager.handleRequest(opencodeSessionId, request, context, stream, token);
				if (result.sessionId) {
					this.sessionStore.setOpenCodeSessionId(internalSessionId, result.sessionId);
				}
				return result;
			}
		};
	}

	/**
	 * Creates tool context for tracking tool invocations
	 */
	private _createToolContext(): ToolContext {
		return {
			unprocessedToolCalls: new Map(),
			pendingToolInvocations: new Map()
		};
	}

	/**
	 * Builds chat history from OpenCode session
	 */
	private _buildChatHistory(session: IOpenCodeSession, toolContext: ToolContext): (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] {
		const history: (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] = [];
		
		for (const message of session.messages) {
			if (message.role === 'user') {
				const requestTurn = this._userMessageToRequest(message, toolContext);
				if (requestTurn) {
					history.push(requestTurn);
				}
			} else if (message.role === 'assistant') {
				const responseTurn = this._assistantMessageToResponse(message, toolContext);
				if (responseTurn) {
					history.push(responseTurn);
				}
			}
		}
		
		return history;
	}

	/**
	 * Converts OpenCode user message to VS Code chat request turn
	 */
	private _userMessageToRequest(message: OpenCodeMessage, toolContext: ToolContext): vscode.ChatRequestTurn2 | undefined {
		// Extract text content from message
		const textContent = this._extractTextContent(message.content);
		
		// Process any tool results in the message
		this._processToolResults(message, toolContext);
		
		// If the message only contains tool results and no visible text, don't create a request turn
		if (!textContent.trim()) {
			return undefined;
		}
		
		return new ChatRequestTurn2(
			textContent,
			undefined, // command (not used for OpenCode)
			[], // variables (could be extracted from message if needed)
			'', // participant (not used here)
			[], // references (could be extracted from message if needed)
			undefined // toolInvocationToken
		);
	}

	/**
	 * Converts OpenCode assistant message to VS Code chat response turn
	 */
	private _assistantMessageToResponse(message: OpenCodeMessage, toolContext: ToolContext): vscode.ChatResponseTurn2 | undefined {
		const responseParts: vscode.ChatResponsePart[] = [];
		
		// Process message content - OpenCodeMessage.content is always a string
		if (typeof message.content === 'string' && message.content.trim()) {
			responseParts.push(new vscode.ChatResponseMarkdownPart(message.content));
		}
		
		// Add any pending tool invocations
		for (const toolInvocation of toolContext.pendingToolInvocations.values()) {
			responseParts.push(toolInvocation as any); // Cast since ChatToolInvocationPart should be acceptable
		}
		
		if (responseParts.length === 0) {
			return undefined;
		}
		
		return new vscode.ChatResponseTurn2(responseParts, {}, '');
	}

	/**
	 * Processes a content part from OpenCode message
	 */
	private _processContentPart(part: any, toolContext: ToolContext): vscode.ChatResponsePart | undefined {
		if (typeof part === 'string') {
			return new vscode.ChatResponseMarkdownPart(part);
		}
		
		if (!part || typeof part !== 'object') {
			return undefined;
		}
		
		switch (part.type) {
			case 'text':
				const text = part.text || part.content || '';
				return text.trim() ? new vscode.ChatResponseMarkdownPart(text) : undefined;
			
			case 'code':
				const code = part.code || part.content || '';
				const language = part.language || '';
				const markdown = language ? `\`\`\`${language}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``;
				return new vscode.ChatResponseMarkdownPart(markdown);
			
			case 'tool_use':
				return this._processToolUse(part, toolContext);
			
			case 'tool_result':
				return this._processToolResult(part, toolContext);
			
			default:
				// Generic content handling
				if (part.text) {
					return new vscode.ChatResponseMarkdownPart(part.text);
				} else if (part.content) {
					return new vscode.ChatResponseMarkdownPart(part.content);
				}
				return undefined;
		}
	}

	/**
	 * Processes tool use (invocation)
	 */
	private _processToolUse(toolUse: any, toolContext: ToolContext): vscode.ChatResponsePart | undefined {
		const toolInvocation: OpenCodeToolInvocation = {
			id: toolUse.id || `tool_${Date.now()}`,
			name: toolUse.name,
			input: toolUse.input || {},
			timestamp: new Date()
		};
		
		// Create formatted tool invocation
		const formattedInvocation = createFormattedToolInvocation(toolInvocation);
		if (formattedInvocation) {
			// Store for later processing with results
			toolContext.pendingToolInvocations.set(toolInvocation.id, formattedInvocation);
			toolContext.unprocessedToolCalls.set(toolInvocation.id, toolUse);
			return formattedInvocation;
		}
		
		return undefined;
	}

	/**
	 * Processes tool result
	 */
	private _processToolResult(toolResultData: any, toolContext: ToolContext): vscode.ChatResponsePart | undefined {
		const toolCallId = toolResultData.tool_call_id || toolResultData.id;
		if (!toolCallId) {
			return undefined;
		}
		
		// Find the corresponding tool invocation
		const pendingInvocation = toolContext.pendingToolInvocations.get(toolCallId);
		const toolCall = toolContext.unprocessedToolCalls.get(toolCallId);
		
		if (pendingInvocation && toolCall) {
			// Create tool result
			const toolResult: OpenCodeToolResult = {
				id: `result_${Date.now()}`,
				toolInvocationId: toolCallId,
				success: !toolResultData.is_error && !toolResultData.error,
				result: toolResultData.content || toolResultData.result,
				error: toolResultData.error || (toolResultData.is_error ? 'Tool execution failed' : undefined),
				timestamp: new Date(),
				duration: toolResultData.duration
			};
			
			// Create tool invocation with result
			const toolInvocation: OpenCodeToolInvocation = {
				id: toolCallId,
				name: toolCall.name,
				input: toolCall.input || {},
				timestamp: new Date()
			};
			
			const updatedInvocation = createFormattedToolInvocation(toolInvocation, toolResult);
			
			// Remove from pending
			toolContext.pendingToolInvocations.delete(toolCallId);
			toolContext.unprocessedToolCalls.delete(toolCallId);
			
			return updatedInvocation;
		}
		
		// If no pending invocation, create a standalone result display
		const markdown = toolResultData.content || toolResultData.result || 'Tool result';
		return new vscode.ChatResponseMarkdownPart(markdown);
	}

	/**
	 * Extracts text content from message
	 */
	private _extractTextContent(content: any): string {
		if (typeof content === 'string') {
			return content;
		}
		
		if (Array.isArray(content)) {
			return content
				.filter(part => typeof part === 'string' || (part && part.type === 'text'))
				.map(part => typeof part === 'string' ? part : part.text || part.content || '')
				.join('');
		}
		
		if (content && typeof content === 'object') {
			if (content.type === 'text') {
				return content.text || content.content || '';
			}
			return content.text || content.content || '';
		}
		
		return '';
	}

	/**
	 * Processes tool results from message content
	 */
	private _processToolResults(message: OpenCodeMessage, toolContext: ToolContext): void {
		// This would process tool results embedded in the message
		// Implementation depends on how OpenCode structures tool results in messages
	}

	/**
	 * Creates initial chat request from stored request
	 */
	private _createInitialChatRequest(initialRequest: vscode.ChatRequest, internalSessionId: string): vscode.ChatRequest {
		// Store the initial request for the session
		this.sessionStore.setInitialRequest(internalSessionId, initialRequest);
		return initialRequest;
	}

	/**
	 * Logging helper
	 */
	private _log(message: string): void {
		this.logService.debug(`[OpenCodeChatSessionContentProvider] ${message}`);
	}
}