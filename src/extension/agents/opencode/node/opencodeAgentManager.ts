/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { isLocation } from '../../../../util/common/types';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatToolInvocationPart, MarkdownString } from '../../../../vscodeTypes';
import { OpenCodeClient } from './opencodeClient';
import { OpenCodeServerManager } from './opencodeServerManager';

/**
 * Manages OpenCode agent interactions and server lifecycle
 */
export class OpenCodeAgentManager extends Disposable {
	constructor(
		private readonly serverManager: OpenCodeServerManager,
		private readonly client: OpenCodeClient,
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

			// Connect event stream and forward relevant events to VS Code stream
			await this.client.connectWebSocket();
			const pendingTools = new Map<string, vscode.ChatToolInvocationPart>();
			const partTextCache = new Map<string, string>();
			const messageRoleById = new Map<string, string>();
			const sub = this.client.onMessageReceived(async (ev) => {
				try {
					if (token.isCancellationRequested) { return; }
					if (!ev || (ev.sessionId && ev.sessionId !== activeSessionId)) { return; }
					// Track message role by id (for filtering parts later)
					try {
						const mid = (ev.data as any)?.id;
						const role = (ev.data as any)?.role;
						if (typeof mid === 'string' && typeof role === 'string') {
							messageRoleById.set(mid, role);
						}
					} catch { /* ignore */ }
					// Avoid duplicating content: parts are streamed incrementally via onPartReceived
					return;
				} catch (e) {
					this.logService.error('[OpenCodeAgentManager] Failed to stream event message', e);
				}
			});

			// Also subscribe to raw part stream
			const subPart = this.client.onPartReceived(async ({ data, sessionId, messageId }: any) => {
				try {
					if (token.isCancellationRequested) { return; }
					if (sessionId && sessionId !== activeSessionId) { return; }
					// Filter out parts from user messages
					const mid = String(data?.messageID ?? messageId ?? '');
					const knownRole = mid ? messageRoleById.get(mid) : undefined;
					if (knownRole === 'user') { return; }
					// Handle text parts with de-duplication and delta streaming
					if (data && typeof data === 'object' && data.type === 'text') {
						const pid = String(data.id ?? data.partID ?? data.partId ?? `oc_${Date.now()}`);
						const currentRaw: string = String(data.text ?? data.content ?? '');
						const current = this.stripSystemReminder(currentRaw);
						const previous = partTextCache.get(pid) ?? '';
						if (current && current !== previous) {
							let delta = current;
							if (previous && current.startsWith(previous)) {
								delta = current.slice(previous.length);
							}
							partTextCache.set(pid, current);
							if (delta.trim()) {
								stream.markdown(delta);
							}
						}
						return;
					}

					// Non-text parts: reuse existing renderer
					await this.streamContentPart(data, stream, token as any, pendingTools);
				} catch (e) {
					this.logService.error('[OpenCodeAgentManager] Failed to stream event part', e);
				}
			});

			// Dispose subscriptions on cancellation
			token.onCancellationRequested(() => {
				try { (sub as any)?.dispose?.(); } catch { /* noop */ }
				try { (subPart as any)?.dispose?.(); } catch { /* noop */ }
			});

			// Kick off the prompt; do not wait for its content to stream here
			await this.client.sendMessage({
				sessionId: activeSessionId,
				content: this.resolvePrompt(request)
			}, token);

			// Small grace period to flush late events before disposing listeners (optional)
			setTimeout(() => {
				try { (sub as any)?.dispose?.(); } catch { /* noop */ }
				try { (subPart as any)?.dispose?.(); } catch { /* noop */ }
			}, 250);

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

		// Add context references if any via a system-reminder block (used only for the live prompt)
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
	 * Streams a content part to VS Code
	 */
	private async streamContentPart(
		part: any,
		stream: vscode.ChatResponseStream,
		token: CancellationToken,
		pendingTools: Map<string, vscode.ChatToolInvocationPart>
	): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}

		if (typeof part === 'string') {
			const text = this.stripSystemReminder(part);
			if (text) { stream.markdown(text); }
		} else if (part && typeof part === 'object') {
			switch (part.type) {
				case 'text':
					{
						const text = this.stripSystemReminder(part.text || part.content || '');
						if (text) { stream.markdown(text); }
					}
					break;

				case 'code':
					if (part.language && part.code) {
						stream.markdown(`\`\`\`${part.language}\n${part.code}\n\`\`\``);
					} else {
						stream.markdown(`\`\`\`\n${part.code || part.content}\n\`\`\``);
					}
					break;
				case 'tool_use': {
					const id = String(part.id ?? `oc_${Date.now()}`);
					const name = String(part.name ?? part.tool ?? 'tool');
					const inv = new ChatToolInvocationPart(name, id, false);
					inv.isConfirmed = true;
					if (part.input) {
						const md = new MarkdownString();
						md.appendCodeblock(JSON.stringify(part.input, null, 2), 'json');
						inv.invocationMessage = md;
					}
					pendingTools.set(id, inv);
					stream.push(inv);
					break;
				}
				case 'tool_result': {
					const toolUseId = String(part.tool_use_id ?? part.id ?? '');
					const inv = pendingTools.get(toolUseId);
					if (inv) {
						inv.isComplete = true;
						inv.isError = !!part.is_error;
						const md = new MarkdownString();
						const result = part.result ?? part.content ?? part.output;
						if (typeof result === 'string') {
							md.appendCodeblock(result);
						} else {
							try {
								md.appendCodeblock(JSON.stringify(result ?? {}, null, 2), 'json');
							} catch {
								md.appendCodeblock(String(result));
							}
						}
						inv.pastTenseMessage = md;
						pendingTools.delete(toolUseId);
					}
					break;
				}
				case 'tool': {
					const id = String(part.callID ?? part.id ?? `oc_${Date.now()}`);
					const name = String(part.tool ?? part.name ?? 'tool');
					let inv = pendingTools.get(id);
					if (!inv) {
						inv = new ChatToolInvocationPart(name, id, false);
						inv.isConfirmed = true;
						const input = part.state?.input ?? part.input;
						if (input) {
							const mdIn = new MarkdownString();
							try { mdIn.appendCodeblock(JSON.stringify(input, null, 2), 'json'); }
							catch { mdIn.appendCodeblock(String(input)); }
							inv.invocationMessage = mdIn;
						}

						pendingTools.set(id, inv);
						stream.push(inv);
					}

					const status = String(part.state?.status ?? '');
					const output = part.state?.output ?? part.output ?? part.result ?? part.content;
					if (status === 'completed' || typeof output !== 'undefined') {
						inv!.isComplete = true;
						inv!.isError = status === 'error' || !!part.error;
						const mdOut = new MarkdownString();
						if (typeof output === 'string') {
							mdOut.appendCodeblock(output);
						} else {
							try { mdOut.appendCodeblock(JSON.stringify(output ?? {}, null, 2), 'json'); }
							catch { mdOut.appendCodeblock(String(output)); }
						}
						inv!.invocationMessage = mdOut;
						inv!.pastTenseMessage = mdOut;
						stream.push(inv);
						pendingTools.delete(id);
					}
					break;
				}

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

	private stripSystemReminder(text: string): string {
		try {
			return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
		} catch {
			return text;
		}
	}

	override dispose(): void {
		// Clean up resources
		super.dispose();
	}
}
