/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { ChatToolInvocationPart } from '../../../../vscodeTypes';
import { OpenCodeSessionUri } from '../common/opencodeSessionUri';
import { IOpenCodeSdkService } from './opencodeSdkService';
import { IOpenCodeSessionService, OpenCodeMessage, OpenCodeMessagePart } from './opencodeSessionService';

export interface OpenCodeAgentRequest {
	sessionId: string;
	prompt: string;
	token: CancellationToken;
	responseStream: vscode.ChatResponseStream;
}

/** Per-message render state, tracking how much has already been streamed. */
interface MessageRenderState {
	/** Number of text characters already rendered for this message */
	renderedTextLength: number;
	/** Tool invocation parts already emitted, keyed by toolInvocation.id */
	emittedInvocations: Map<string, ChatToolInvocationPart>;
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

	private _waitForResponse(
		sessionId: string,
		responseStream: vscode.ChatResponseStream,
		token: CancellationToken,
		signal: AbortSignal
	): Promise<void> {
		// Per-message render state: tracks how much of each assistant message has been streamed
		const messageRenderState = new Map<string, MessageRenderState>();

		let unsubscribe: (() => void) | undefined;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let cancellationDisposable: { dispose(): void } | undefined;
		let resolve: () => void;
		let reject: (err: Error) => void;
		let cleanedUp = false;

		const cleanup = () => {
			cleanedUp = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
			unsubscribe?.();
			unsubscribe = undefined;
			signal.removeEventListener('abort', abortHandler);
			cancellationDisposable?.dispose();
			cancellationDisposable = undefined;
		};

		const renderMessages = async (messages: OpenCodeMessage[], isFinal: boolean) => {
			for (const message of messages) {
				if (message.role !== 'assistant') {
					continue;
				}
				await this._renderMessageDelta(message, responseStream, messageRenderState, isFinal);
			}
		};

		const onIdle = async () => {
			cleanup();
			try {
				this.sessionService.invalidateSession(sessionId);
				const messages = await this.sessionService.getSessionMessages(sessionId);
				await renderMessages(messages, true);
			} catch (e) {
				this.logService.error(`[OpenCodeAgentManager] Error rendering final messages`, e);
			}
			resolve();
		};

		const abortHandler = () => {
			cleanup();
			reject(new Error('Aborted'));
		};

		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		// 5-minute timeout
		timeoutHandle = setTimeout(() => {
			cleanup();
			this.logService.warn(`[OpenCodeAgentManager] Response timeout for session: ${sessionId}`);
			resolve();
		}, 300000);

		signal.addEventListener('abort', abortHandler);
		if (token.onCancellationRequested) {
			cancellationDisposable = token.onCancellationRequested(() => {
				cleanup();
				reject(new Error('Aborted'));
			});
		}

		this.sdkService.subscribeToEvents(async (event: unknown) => {
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

			if (e.type === 'session.updated' || e.type === 'message.updated' || e.type === 'message.part.updated') {
				try {
					this.sessionService.invalidateSession(sessionId);
					const messages = await this.sessionService.getSessionMessages(sessionId);
					await renderMessages(messages, false);
				} catch (err) {
					this.logService.error(`[OpenCodeAgentManager] Error rendering streaming messages`, err);
				}
			}
		}).then(unsub => {
			if (cleanedUp) {
				// cleanup() ran before subscribeToEvents resolved — dispose immediately
				unsub();
			} else {
				unsubscribe = unsub;
			}
		}).catch(err => {
			cleanup();
			reject(err instanceof Error ? err : new Error(String(err)));
		});

		return promise;
	}

	/**
	 * Emits only the delta (new parts / new text characters) of an assistant message.
	 * Tracks per-message render state so re-calls don't duplicate content.
	 */
	private async _renderMessageDelta(
		message: OpenCodeMessage,
		responseStream: vscode.ChatResponseStream,
		renderState: Map<string, MessageRenderState>,
		isFinal: boolean
	): Promise<void> {
		let state = renderState.get(message.id);
		if (!state) {
			state = { renderedTextLength: 0, emittedInvocations: new Map() };
			renderState.set(message.id, state);
		}

		let accumulatedText = '';
		for (const part of message.parts) {
			if (part.type === 'text' && part.text) {
				accumulatedText += part.text;
			}
		}

		// Emit only the new text delta
		if (accumulatedText.length > state.renderedTextLength) {
			const delta = accumulatedText.slice(state.renderedTextLength);
			responseStream.markdown(delta);
			state.renderedTextLength = accumulatedText.length;
		}

		// Process tool invocations and their results
		for (const part of message.parts) {
			if (part.type === 'tool-invocation' && part.toolInvocation) {
				await this._renderToolInvocationDelta(part, responseStream, state, isFinal);
			} else if (part.type === 'tool-result' && part.toolResult) {
				this._renderToolResultDelta(part, responseStream, state);
			}
		}
	}

	private async _renderToolInvocationDelta(
		part: OpenCodeMessagePart,
		responseStream: vscode.ChatResponseStream,
		state: MessageRenderState,
		isFinal: boolean
	): Promise<void> {
		const inv = part.toolInvocation!;
		const existing = state.emittedInvocations.get(inv.id);

		if (!existing) {
			// First time seeing this invocation — emit it
			const invocationPart = new ChatToolInvocationPart(inv.name, inv.id);
			invocationPart.enablePartialUpdate = true;

			const input = inv.state?.input;
			if (input) {
				const toolName = inv.name;
				if (toolName === 'bash' || toolName === 'shell' || toolName === 'command') {
					invocationPart.toolSpecificData = {
						commandLine: { original: (input as { command?: string }).command ?? '' },
						language: 'bash'
					};
				} else if (toolName === 'read' || toolName === 'read_file') {
					const filePath = (input as { path?: string; filePath?: string }).path ?? (input as { path?: string; filePath?: string }).filePath ?? '';
					invocationPart.invocationMessage = l10n.t('Read {0}', filePath);
				} else if (toolName === 'edit' || toolName === 'edit_file') {
					const filePath = (input as { path?: string; filePath?: string }).path ?? (input as { path?: string; filePath?: string }).filePath ?? '';
					invocationPart.invocationMessage = l10n.t('Edited {0}', filePath);
				} else if (toolName === 'write' || toolName === 'write_file') {
					const filePath = (input as { path?: string; filePath?: string }).path ?? (input as { path?: string; filePath?: string }).filePath ?? '';
					invocationPart.invocationMessage = l10n.t('Wrote {0}', filePath);
				} else {
					invocationPart.invocationMessage = l10n.t('Used tool: {0}', inv.name);
				}
			}

			responseStream.push(invocationPart);
			state.emittedInvocations.set(inv.id, invocationPart);
		} else if (isFinal && !existing.isComplete) {
			// Final pass: mark as complete if not already done
			existing.isComplete = true;
			existing.isConfirmed = true;
			existing.enablePartialUpdate = true;
			responseStream.push(existing);
		}
	}

	private _renderToolResultDelta(
		part: OpenCodeMessagePart,
		responseStream: vscode.ChatResponseStream,
		state: MessageRenderState
	): void {
		const result = part.toolResult!;
		const invocationPart = state.emittedInvocations.get(result.id);

		if (invocationPart && !invocationPart.isComplete) {
			// Complete the corresponding tool invocation
			invocationPart.isComplete = true;
			invocationPart.isConfirmed = !result.is_error;
			invocationPart.isError = result.is_error ?? false;
			invocationPart.enablePartialUpdate = true;

			if (result.is_error) {
				const errorText = typeof result.result === 'string'
					? result.result
					: JSON.stringify(result.result);
				invocationPart.pastTenseMessage = new vscode.MarkdownString(errorText);
			}

			responseStream.push(invocationPart);
		}
	}

	public async getOrCreateSession(resource: vscode.Uri): Promise<string> {
		const sessionId = OpenCodeSessionUri.getSessionId(resource);

		const existingSession = await this.sessionService.getSession(sessionId);
		if (existingSession) {
			return sessionId;
		}

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
