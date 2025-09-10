/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { isLocation } from '../../../../util/common/types';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';

import { IOpenCodeClient } from './opencodeClient';
import { IOpenCodeServerManager } from './opencodeServerManager';

export const IOpenCodeAgentManager = createServiceIdentifier<IOpenCodeAgentManager>('IOpenCodeAgentManager');

export interface IOpenCodeAgentManager {
	readonly _serviceBrand: undefined;
	handleRequest(
		sessionId: string | undefined,
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult & { sessionId?: string }>;
}

/**
 * Manages OpenCode agent interactions and server lifecycle
 */
export class OpenCodeAgentManager extends Disposable implements IOpenCodeAgentManager {
	declare _serviceBrand: undefined;

	constructor(
		@IOpenCodeServerManager private readonly serverManager: IOpenCodeServerManager,
		@IOpenCodeClient private readonly client: IOpenCodeClient,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	async handleRequest(
		sessionId: string | undefined,
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult & { sessionId?: string }> {
		try {
			this.logService.info(`[OpenCodeAgentManager] Handling request for session: ${sessionId || 'new'}`);

			// Ensure server is running and client is configured
			await this.ensureServerReady(token);

			// Create session if needed
			let activeSessionId = sessionId;
			if (!activeSessionId) {
				this.logService.info('[OpenCodeAgentManager] Creating new session');
				const newSession = await this.client.createSession({
					label: this.generateSessionLabel(request.prompt)
				}, token);
				activeSessionId = newSession.id;
				this.logService.info(`[OpenCodeAgentManager] Created session: ${activeSessionId}`);
			}

			// Send message and handle response
			const message = await this.client.sendMessage({
				sessionId: activeSessionId,
				content: this.resolvePrompt(request)
			}, token);

			// Stream the response
			await this.streamResponse(message, stream, token);

			return {
				sessionId: activeSessionId
			};

		} catch (error) {
			this.logService.error('[OpenCodeAgentManager] Request handling failed', error);
			const errorMessage = error instanceof Error ? error.message : String(error);
			stream.markdown(`❌ Error: ${errorMessage}`);
			return {
				errorDetails: { message: errorMessage }
			};
		}
	}

	/**
	 * Ensures the OpenCode server is running and client is configured
	 */
	private async ensureServerReady(token?: CancellationToken): Promise<void> {
		if (!this.serverManager.isRunning()) {
			this.logService.info('[OpenCodeAgentManager] Starting OpenCode server');
			const config = await this.serverManager.start(token);
			this.client.setConfig(config);
		} else {
			const config = this.serverManager.getConfig();
			if (config) {
				this.client.setConfig(config);
			}
		}
	}

	/**
	 * Resolves chat request prompt including references
	 */
	private resolvePrompt(request: vscode.ChatRequest): string {
		const extraRefsTexts: string[] = [];
		let prompt = request.prompt;

		// Process references similar to Claude implementation
		request.references.forEach(ref => {
			const valueText = URI.isUri(ref.value) ?
				ref.value.fsPath :
				isLocation(ref.value) ?
					`${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}` :
					undefined;

			if (valueText) {
				if (ref.range) {
					// Replace inline reference
					prompt = prompt.slice(0, ref.range[0]) + valueText + prompt.slice(ref.range[1]);
				} else {
					// Add as context
					extraRefsTexts.push(`- ${valueText}`);
				}
			}
		});

		// Add context references if any
		if (extraRefsTexts.length > 0) {
			prompt = `<system-reminder>\nThe user provided the following references:\n${extraRefsTexts.join('\n')}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n` + prompt;
		}

		return prompt;
	}

	/**
	 * Generates a session label from the user prompt
	 */
	private generateSessionLabel(prompt: string): string {
		// Take first meaningful part of prompt, max 50 chars
		const cleaned = prompt.trim().replace(/\s+/g, ' ');
		if (cleaned.length <= 50) {
			return cleaned;
		}

		// Try to break at word boundary
		const truncated = cleaned.substring(0, 47);
		const lastSpace = truncated.lastIndexOf(' ');

		if (lastSpace > 20) {
			return truncated.substring(0, lastSpace) + '...';
		}

		return truncated + '...';
	}

	/**
	 * Streams the response message to VS Code
	 */
	private async streamResponse(
		message: any,
		stream: vscode.ChatResponseStream,
		token: CancellationToken
	): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}

		// Handle different message types
		if (typeof message.content === 'string') {
			// Simple text message
			stream.markdown(message.content);
		} else if (message.content && Array.isArray(message.content)) {
			// Structured content
			for (const part of message.content) {
				if (token.isCancellationRequested) {
					break;
				}

				await this.streamContentPart(part, stream, token);
			}
		} else if (message.content) {
			// Object content
			await this.streamContentPart(message.content, stream, token);
		}
	}

	/**
	 * Streams a content part to VS Code
	 */
	private async streamContentPart(
		part: any,
		stream: vscode.ChatResponseStream,
		token: CancellationToken
	): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}

		if (typeof part === 'string') {
			stream.markdown(part);
		} else if (part && typeof part === 'object') {
			switch (part.type) {
				case 'text':
					stream.markdown(part.text || part.content || '');
					break;

				case 'code':
					if (part.language && part.code) {
						stream.markdown(`\`\`\`${part.language}\n${part.code}\n\`\`\``);
					} else {
						stream.markdown(`\`\`\`\n${part.code || part.content}\n\`\`\``);
					}
					break;

				case 'tool_use':
					// Defer tool handling until OpenCode server exposes tool_use semantics
					stream.progress(`\n\n🛠️ Tool requested: ${part?.name ?? 'unknown'} (not executed)`);
					break;

				default:
					// Generic content
					if (part.text) {
						stream.markdown(part.text);
					} else if (part.content) {
						stream.markdown(part.content);
					}
					break;
			}
		}
	}



	override dispose(): void {
		// Clean up resources
		super.dispose();
	}
}
