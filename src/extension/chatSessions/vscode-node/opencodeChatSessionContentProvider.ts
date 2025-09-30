/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { OpenCodeAgentManager } from '../../agents/opencode/node/opencodeAgentManager';
import { IOpenCodeSession, IOpenCodeSessionService, OpenCodeMessage } from '../../agents/opencode/node/opencodeSessionService';

import { createFormattedToolInvocation } from '../../agents/opencode/common/toolInvocationFormatter';
import { OpenCodeSessionDataStore } from './opencodeChatSessionItemProvider';

/**
 * Tool context for tracking tool invocations and results
 */
interface ToolContext {
	unprocessedToolCalls: Map<string, any>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

/**
 * Content provider for OpenCode chat sessions
 * Converts OpenCode session data to VS Code chat format and handles real-time updates
 */
export class OpenCodeChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly opencodeAgentManager: OpenCodeAgentManager,
		private readonly sessionStore: OpenCodeSessionDataStore,
		@IOpenCodeSessionService private readonly sessionService: IOpenCodeSessionService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	/**
	 * Provides chat session content for VS Code
	 */
	async provideChatSessionContent(internalSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		this._log(`Providing content for session: ${internalSessionId}`);

		const initialRequest = this.sessionStore.getAndConsumeInitialRequest(internalSessionId);
		// Resolve OpenCode session id; on reload, the internal id may already be the OpenCode id
		let opencodeSessionId = this.sessionStore.getSessionId(internalSessionId);
		let existingSession: IOpenCodeSession | undefined;
		if (opencodeSessionId) {
			existingSession = await this.sessionService.getSession(opencodeSessionId, token);
		} else {
			const maybe = await this.sessionService.getSession(internalSessionId, token);
			if (maybe) {
				existingSession = maybe;
				opencodeSessionId = internalSessionId;
				this.sessionStore.setOpenCodeSessionId(internalSessionId, opencodeSessionId);
			}
		}
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
		const responseParts: (vscode.ChatResponsePart | vscode.ChatToolInvocationPart)[] = [];

		// Prefer structured parts when available
		if (Array.isArray((message as any).parts)) {
			// Structured content: detect tool calls/results and text
			for (const part of (message as any).parts) {
				if (!part || typeof part !== 'object') {
					continue;
				}
				// Text block
				if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
					responseParts.push(new vscode.ChatResponseMarkdownPart(part.text));
					continue;
				}
				// Heuristic: treat certain parts as tool invocations
				const toolUse = this._asOpenCodeToolUse(part);
				if (toolUse) {
					const invocation = createFormattedToolInvocation(part);
					if (invocation) {
						toolContext.pendingToolInvocations.set(toolUse.id, invocation);
						responseParts.push(invocation);
					}

					// If OpenCode 'tool' part already includes completion, finalize immediately
					if (part.type === 'tool') {
						const status = String(part.state?.status ?? '');
						const output = part.state?.output ?? part.output ?? part.result ?? part.content;
						if (status === 'completed' || typeof output !== 'undefined') {
							const pending = toolContext.pendingToolInvocations.get(toolUse.id);
							if (pending) {
								createFormattedToolInvocation(part, pending);
								toolContext.pendingToolInvocations.delete(toolUse.id);
							}
						}
					}
				}
			}
		} else if (typeof message.content === 'string') {
			// Fallback: plain string content
			const text = message.content.trim();
			if (text) {
				responseParts.push(new vscode.ChatResponseMarkdownPart(text));
			}
		}

		// Add any pending tool invocations (if not already included)
		for (const inv of toolContext.pendingToolInvocations.values()) {
			if (!responseParts.includes(inv)) {
				responseParts.push(inv);
			}
		}

		if (responseParts.length === 0) {
			return undefined;
		}

		return new vscode.ChatResponseTurn2(responseParts, {}, '');
	}





	/**
	 * Extracts text content from message
	 */
	private _extractTextContent(content: any): string {
		if (typeof content === 'string') {
			return this._stripSystemReminder(content);
		}

		if (Array.isArray(content)) {
			const text = content
				.filter(part => typeof part === 'string' || (part && part.type === 'text'))
				.map(part => typeof part === 'string' ? part : part.text || part.content || '')
				.join('');
			return this._stripSystemReminder(text);
		}

		if (content && typeof content === 'object') {
			if (content.type === 'text') {
				return this._stripSystemReminder(content.text || content.content || '');
			}
			return this._stripSystemReminder(content.text || content.content || '');
		}

		return '';
	}

	/**
	 * Remove any <system-reminder>...</system-reminder> blocks from text.
	 */
	private _stripSystemReminder(text: string): string {
		try {
			return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
		} catch {
			return text;
		}
	}

	/**
	 * Processes tool results from message content
	 */
	private _processToolResults(message: OpenCodeMessage, toolContext: ToolContext): void {
		// Try to match tool result parts back to pending invocations and complete them
		const content: any = (message as any).content;
		const parts: any[] = Array.isArray(content) ? content : (content && typeof content === 'object' ? [content] : []);
		for (const part of parts) {
			if (!part || typeof part !== 'object') { continue; }
			const toolResult = this._asOpenCodeToolResult(part);
			if (!toolResult) { continue; }
			const pending = toolContext.pendingToolInvocations.get(toolResult.tool_use_id || toolResult.id);
			if (!pending) { continue; }

			// Use the tool invocation formatter to process the result
			createFormattedToolInvocation(part, pending);

			// Remove from pending once completed
			toolContext.pendingToolInvocations.delete(toolResult.tool_use_id || toolResult.id);
		}
	}

	private _asOpenCodeToolUse(part: any): { id: string; name: string; input?: any } | undefined {
		// Heuristics: known shapes could be { type: 'tool_use', name, id, input }
		if (part?.type === 'tool_use' && typeof part?.name === 'string') {
			return { id: String(part.id ?? this._genId()), name: part.name, input: part.input };
		}
		// OpenCode: { type: 'tool', tool, callID, state: { input, output, status } }
		if (part?.type === 'tool' && (part.tool || part.name)) {
			return {
				id: String(part.callID ?? part.id ?? this._genId()),
				name: String(part.tool ?? part.name),
				input: part.state?.input ?? part.input
			};
		}
		// Treat certain types as tool invocations
		const toolLike = new Set(['shell', 'command', 'git', 'http', 'search']);
		if (typeof part?.type === 'string' && toolLike.has(part.type)) {
			return { id: String(part.id ?? this._genId()), name: part.type, input: part };
		}
		return undefined;
	}

	private _asOpenCodeToolResult(part: any): { id: string; tool_use_id?: string; is_error?: boolean; result?: any } | undefined {
		// Known shape: { type: 'tool_result', tool_use_id, is_error, content/result }
		if (part?.type === 'tool_result') {
			return {
				id: String(part.id ?? this._genId()),
				tool_use_id: typeof part.tool_use_id === 'string' ? part.tool_use_id : undefined,
				is_error: !!part.is_error,
				result: part.result ?? part.content ?? part.output ?? part
			};
		}
		// OpenCode 'tool' may also include the result
		if (part?.type === 'tool') {
			const status = String(part.state?.status ?? '');
			const output = part.state?.output ?? part.output ?? part.result ?? part.content;
			if (status === 'completed' || typeof output !== 'undefined') {
				return {
					id: String(part.callID ?? part.id ?? this._genId()),
					tool_use_id: String(part.callID ?? part.id ?? ''),
					is_error: status === 'error' || !!part.error,
					result: output
				};
			}
		}
		// Fallback: recognize generic result blocks
		if (typeof part?.result !== 'undefined' || typeof part?.output !== 'undefined') {
			return {
				id: String(part.id ?? this._genId()),
				is_error: !!part.error,
				result: part.result ?? part.output
			};
		}
		return undefined;
	}

	private _genId(): string {
		return 'oc_tool_' + Math.random().toString(36).slice(2, 10);
	}

	/**
	 * Creates initial chat request from stored request
	 */
	private _createInitialChatRequest(initialRequest: vscode.ChatRequest, internalSessionId: string): vscode.ChatRequest {
		// Mirror Claude: pass through the initial request and attach a toolInvocationToken
		return {
			...initialRequest,
			toolInvocationToken: { sessionId: internalSessionId } as vscode.ChatParticipantToolToken
		};
	}



	/**
	 * Logging helper
	 */
	private _log(message: string): void {
		this.logService.debug(`[OpenCodeChatSessionContentProvider] ${message}`);
	}
}
