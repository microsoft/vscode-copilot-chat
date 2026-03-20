/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { ChatToolInvocationPart } from '../../../../vscodeTypes';
import { OpenCodeSessionUri } from '../common/opencodeSessionUri';
import { IOpenCodeSdkService } from './opencodeSdkService';
import { IOpenCodeSessionService, OpenCodeMessage } from './opencodeSessionService';

export interface OpenCodeAgentRequest {
	sessionId: string;
	prompt: string;
	token: CancellationToken;
	responseStream: vscode.ChatResponseStream;
}

export class OpenCodeAgentManager extends Disposable {
	private readonly _activeRequests = new Map<string, AbortController>();

	constructor(
		@IOpenCodeSdkService private readonly sdkService: IOpenCodeSdkService,
		@IOpenCodeSessionService private readonly sessionService: IOpenCodeSessionService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	public async handleRequest(request: OpenCodeAgentRequest): Promise<void> {
		const { sessionId, prompt, token, responseStream } = request;

		this.logService.info(`[OpenCodeAgentManager] Handling request for session: ${sessionId}`);

		// Cancel any existing request for this session
		const existingController = this._activeRequests.get(sessionId);
		if (existingController) {
			existingController.abort();
		}

		const controller = new AbortController();
		this._activeRequests.set(sessionId, controller);

		try {
			// Ensure server is running
			await this.sdkService.ensureServer();

			// Send the message
			const result = await this.sessionService.sendMessage(sessionId, prompt);

			if (result.status !== 200) {
				throw new Error(`Failed to send message: status ${result.status}`);
			}

			// Poll for the response (OpenCode processes asynchronously)
			await this._pollForResponse(sessionId, responseStream, token, controller.signal);

		} catch (error) {
			if (error instanceof Error && error.message === 'Aborted') {
				this.logService.info(`[OpenCodeAgentManager] Request cancelled for session: ${sessionId}`);
				return;
			}
			this.logService.error(`[OpenCodeAgentManager] Error handling request`, error);
			throw error;
		} finally {
			this._activeRequests.delete(sessionId);
		}
	}

	private async _pollForResponse(
		sessionId: string,
		responseStream: vscode.ChatResponseStream,
		token: CancellationToken,
		signal: AbortSignal
	): Promise<void> {
		const maxWaitTime = 300000; // 5 minutes
		const pollInterval = 500; // 500ms
		let elapsed = 0;
		let lastMessageCount = 0;

		// Get initial message count
		const initialMessages = await this.sessionService.getSessionMessages(sessionId);
		lastMessageCount = initialMessages.length;

		while (elapsed < maxWaitTime) {
			if (token.isCancellationRequested || signal.aborted) {
				throw new Error('Aborted');
			}

			await new Promise(resolve => setTimeout(resolve, pollInterval));
			elapsed += pollInterval;

			// Invalidate cache and get fresh messages
			this.sessionService.invalidateSession(sessionId);
			const messages = await this.sessionService.getSessionMessages(sessionId);

			if (messages.length > lastMessageCount) {
				// Process new messages
				for (let i = lastMessageCount; i < messages.length; i++) {
					const message = messages[i];
					if (message.role === 'assistant') {
						await this._renderMessage(message, responseStream);
					}
				}
				lastMessageCount = messages.length;

				// Check if the last assistant message indicates completion
				const lastMessage = messages[messages.length - 1];
				if (lastMessage?.role === 'assistant' && this._isCompletionMessage(lastMessage)) {
					this.logService.trace(`[OpenCodeAgentManager] Response complete for session: ${sessionId}`);
					return;
				}
			}
		}

		this.logService.warn(`[OpenCodeAgentManager] Response timeout for session: ${sessionId}`);
	}

	private _isCompletionMessage(message: OpenCodeMessage): boolean {
		// Check if the message contains only text (no pending tool invocations)
		if (!message.parts || message.parts.length === 0) {
			return true;
		}

		// If there are tool invocations without results, we're not complete
		for (const part of message.parts) {
			if (part.type === 'tool-invocation' && !part.toolResult) {
				return false;
			}
		}

		return true;
	}

	private async _renderMessage(
		message: OpenCodeMessage,
		responseStream: vscode.ChatResponseStream
	): Promise<void> {
		for (const part of message.parts) {
			if (part.type === 'text' && part.text) {
				responseStream.markdown(part.text);
			} else if (part.type === 'tool-invocation' && part.toolInvocation) {
				const toolName = part.toolInvocation.name;
				const toolId = part.toolInvocation.id;
				const invocation = new ChatToolInvocationPart(toolName, toolId);

				// Format tool invocation message based on tool type
				const input = part.toolInvocation.state?.input;
				if (input) {
					if (toolName === 'bash' || toolName === 'shell' || toolName === 'command') {
						invocation.toolSpecificData = {
							commandLine: { original: (input as { command?: string }).command ?? '' },
							language: 'bash'
						};
					} else if (toolName === 'read' || toolName === 'read_file') {
						const filePath = (input as { path?: string; filePath?: string }).path ?? (input as { path?: string; filePath?: string }).filePath ?? '';
						invocation.invocationMessage = `Read ${filePath}`;
					} else if (toolName === 'edit' || toolName === 'edit_file') {
						const filePath = (input as { path?: string; filePath?: string }).path ?? (input as { path?: string; filePath?: string }).filePath ?? '';
						invocation.invocationMessage = `Edited ${filePath}`;
					} else if (toolName === 'write' || toolName === 'write_file') {
						const filePath = (input as { path?: string; filePath?: string }).path ?? (input as { path?: string; filePath?: string }).filePath ?? '';
						invocation.invocationMessage = `Wrote ${filePath}`;
					} else {
						invocation.invocationMessage = `Used tool: ${toolName}`;
					}
				}

				responseStream.push(invocation);
			}
		}
	}

	public async getOrCreateSession(resource: vscode.Uri): Promise<string> {
		const sessionId = OpenCodeSessionUri.getSessionId(resource);

		// Check if session exists
		const existingSession = await this.sessionService.getSession(sessionId);
		if (existingSession) {
			return sessionId;
		}

		// Create new session
		const newSession = await this.sessionService.createSession();
		return newSession.id;
	}

	public cancelRequest(sessionId: string): void {
		const controller = this._activeRequests.get(sessionId);
		if (controller) {
			controller.abort();
			this._activeRequests.delete(sessionId);
		}
	}

	override dispose(): void {
		for (const controller of this._activeRequests.values()) {
			controller.abort();
		}
		this._activeRequests.clear();
		super.dispose();
	}
}
