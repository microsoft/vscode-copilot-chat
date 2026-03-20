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

		this.logService.trace(`[OpenCodeAgentManager] Handling request for session: ${sessionId}`);

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

			// Wait for response via events
			await this._waitForResponse(sessionId, responseStream, token, controller.signal);

		} catch (error) {
			if (error instanceof Error && error.message === 'Aborted') {
				this.logService.trace(`[OpenCodeAgentManager] Request cancelled for session: ${sessionId}`);
				return;
			}
			this.logService.error(`[OpenCodeAgentManager] Error handling request`, error);
			throw error;
		} finally {
			this._activeRequests.delete(sessionId);
		}
	}

	private async _waitForResponse(
		sessionId: string,
		responseStream: vscode.ChatResponseStream,
		token: CancellationToken,
		signal: AbortSignal
	): Promise<void> {
		return new Promise<void>(async (resolve, reject) => {
			let renderedMessageCount = 0;
			let unsubscribe: (() => void) | undefined;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				unsubscribe?.();
			};

			const onIdle = async () => {
				cleanup();
				// Render any messages we haven't rendered yet
				try {
					this.sessionService.invalidateSession(sessionId);
					const messages = await this.sessionService.getSessionMessages(sessionId);
					for (let i = renderedMessageCount; i < messages.length; i++) {
						const message = messages[i];
						if (message.role === 'assistant') {
							await this._renderMessage(message, responseStream);
						}
					}
				} catch (e) {
					this.logService.error(`[OpenCodeAgentManager] Error rendering final messages`, e);
				}
				resolve();
			};

			// 5-minute timeout
			timeoutHandle = setTimeout(() => {
				cleanup();
				this.logService.warn(`[OpenCodeAgentManager] Response timeout for session: ${sessionId}`);
				resolve();
			}, 300000);

			// Abort/cancel handling
			const abortHandler = () => {
				cleanup();
				reject(new Error('Aborted'));
			};
			signal.addEventListener('abort', abortHandler, { once: true });
			if (token.onCancellationRequested) {
				token.onCancellationRequested(() => {
					cleanup();
					reject(new Error('Aborted'));
				});
			}

			try {
				unsubscribe = await this.sdkService.subscribeToEvents(async (event: unknown) => {
					const e = event as { type?: string; properties?: { sessionID?: string } };
					if (e?.properties?.sessionID !== sessionId) {
						return;
					}

					if (e.type === 'session.idle') {
						await onIdle();
						return;
					}

					if (e.type === 'session.status') {
						const statusEvent = e as { type: string; properties: { sessionID: string; status: { type: string } } };
						if (statusEvent.properties.status.type === 'idle') {
							await onIdle();
						}
						return;
					}

					// On any message update, render new assistant messages
					if (e.type === 'session.updated' || e.type === 'message.updated' || e.type === 'message.part.updated') {
						try {
							this.sessionService.invalidateSession(sessionId);
							const messages = await this.sessionService.getSessionMessages(sessionId);
							for (let i = renderedMessageCount; i < messages.length; i++) {
								const message = messages[i];
								if (message.role === 'assistant') {
									await this._renderMessage(message, responseStream);
									renderedMessageCount = i + 1;
								}
							}
						} catch (err) {
							this.logService.error(`[OpenCodeAgentManager] Error rendering streaming messages`, err);
						}
					}
				});
			} catch (err) {
				cleanup();
				reject(err);
			}
		});
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
