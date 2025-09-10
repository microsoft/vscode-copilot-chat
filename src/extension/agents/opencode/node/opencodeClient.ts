/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import type { CancellationToken } from 'vscode';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IOpenCodeServerConfig } from './opencodeServerManager';

export interface OpenCodeMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'system';
	readonly content: string;
	readonly timestamp: Date;
	readonly sessionId?: string;
	readonly parts?: readonly any[];
}

export interface OpenCodeSessionData {
	readonly id: string;
	readonly label: string;
	readonly messages: readonly OpenCodeMessage[];
	readonly timestamp: Date;
	readonly status: 'active' | 'idle' | 'completed' | 'error';
}

export interface CreateSessionOptions {
	readonly label?: string;
	readonly initialMessage?: string;
}

export interface SendMessageOptions {
	readonly content: string;
	readonly sessionId: string;
}

export interface ApiResponse<T> {
	readonly success: boolean;
	readonly data?: T;
	readonly error?: string;
}

/**
 * WebSocket event types for real-time updates
 */
export interface OpenCodeWebSocketEvent {
	readonly type: string;
	readonly data: any;
	readonly sessionId?: string;
	readonly timestamp: Date;
}

export interface SessionUpdatedEvent extends OpenCodeWebSocketEvent {
	readonly type: 'session_updated';
	readonly data: OpenCodeSessionData;
}

export interface MessageReceivedEvent extends OpenCodeWebSocketEvent {
	readonly type: 'message_received';
	readonly data: OpenCodeMessage;
}

export interface SessionCreatedEvent extends OpenCodeWebSocketEvent {
	readonly type: 'session_created';
	readonly data: OpenCodeSessionData;
}

export interface SessionDeletedEvent extends OpenCodeWebSocketEvent {
	readonly type: 'session_deleted';
	readonly data: { sessionId: string };
}

export const IOpenCodeClient = createServiceIdentifier<IOpenCodeClient>('IOpenCodeClient');

export interface IOpenCodeClient {
	readonly _serviceBrand: undefined;

	// Configuration
	setConfig(config: IOpenCodeServerConfig): void;

	// Session management
	getAllSessions(token?: CancellationToken): Promise<readonly OpenCodeSessionData[]>;
	getSession(sessionId: string, token?: CancellationToken): Promise<OpenCodeSessionData | undefined>;
	createSession(options?: CreateSessionOptions, token?: CancellationToken): Promise<OpenCodeSessionData>;
	sendMessage(options: SendMessageOptions, token?: CancellationToken): Promise<OpenCodeMessage>;
	deleteSession(sessionId: string, token?: CancellationToken): Promise<void>;
	getSessionMessages(sessionId: string, token?: CancellationToken): Promise<readonly OpenCodeMessage[]>;

	// Real-time updates
	connectWebSocket(): Promise<void>;
	disconnectWebSocket(): Promise<void>;
	readonly onSessionUpdated: Event<SessionUpdatedEvent>;
	readonly onMessageReceived: Event<MessageReceivedEvent>;
	readonly onSessionCreated: Event<SessionCreatedEvent>;
	readonly onSessionDeleted: Event<SessionDeletedEvent>;
}

export class OpenCodeClient extends Disposable implements IOpenCodeClient {
	declare _serviceBrand: undefined;

	private _config: IOpenCodeServerConfig | undefined;
	private _isWebSocketConnecting = false;

	// Event emitters for real-time updates
	private readonly _onSessionUpdated = this._register(new Emitter<SessionUpdatedEvent>());
	private readonly _onMessageReceived = this._register(new Emitter<MessageReceivedEvent>());
	private readonly _onSessionCreated = this._register(new Emitter<SessionCreatedEvent>());
	private readonly _onSessionDeleted = this._register(new Emitter<SessionDeletedEvent>());

	readonly onSessionUpdated = this._onSessionUpdated.event;
	readonly onMessageReceived = this._onMessageReceived.event;
	readonly onSessionCreated = this._onSessionCreated.event;
	readonly onSessionDeleted = this._onSessionDeleted.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
	}

	setConfig(config: IOpenCodeServerConfig): void {
		this._config = config;
		this.logService.trace(`[OpenCodeClient] Config set: ${config.url}`);
	}

	private ensureConfig(): IOpenCodeServerConfig {
		if (!this._config) {
			throw new Error('OpenCodeClient not configured. Call setConfig() first.');
		}
		return this._config;
	}

	async getAllSessions(token?: CancellationToken): Promise<readonly OpenCodeSessionData[]> {
		try {
			const response = await this.tryPaths<any>(['/session'], {
				method: 'GET',
				token
			});

			const list = Array.isArray(response.data) ? response.data : [];
			return list.map(s => this.mapSessionSummary(s));
		} catch (error) {
			this.logService.error('[OpenCodeClient] Failed to get all sessions', error);
			throw error;
		}
	}

	async getSession(sessionId: string, token?: CancellationToken): Promise<OpenCodeSessionData | undefined> {
		try {
			const response = await this.tryPaths<any>([
				`/session/${encodeURIComponent(sessionId)}`
			], {
				method: 'GET',
				token
			});

			if (!response.data) {
				return undefined;
			}
			return this.mapSessionSummary(response.data);
		} catch (error) {
			this.logService.error(`[OpenCodeClient] Failed to get session ${sessionId}`, error);
			// Return undefined for 404 errors (session not found)
			if (error instanceof Error && error.message.includes('404')) {
				return undefined;
			}
			throw error;
		}
	}

	async createSession(options?: CreateSessionOptions, token?: CancellationToken): Promise<OpenCodeSessionData> {
		try {
			const body = JSON.stringify({
				title: options?.label,
				parentID: undefined
			});

			const response = await this.tryPaths<any>(['/session'], {
				method: 'POST',
				body,
				token,
				headers: {
					'Content-Type': 'application/json'
				}
			});

			if (!response.data) {
				throw new Error('Failed to create session: no data returned');
			}

			const session = this.mapSessionSummary(response.data);
			this.logService.info(`[OpenCodeClient] Created session: ${session.id}`);
			return session;
		} catch (error) {
			this.logService.error('[OpenCodeClient] Failed to create session', error);
			throw error;
		}
	}

	async sendMessage(options: SendMessageOptions, token?: CancellationToken): Promise<OpenCodeMessage> {
		try {
			// The server expects ChatInput with a required `parts` array
			const body = JSON.stringify({
				parts: [
					{ type: 'text', text: options.content }
				]
			});

			const response = await this.tryPaths<any>([
				`/session/${encodeURIComponent(options.sessionId)}/message`
			], {
				method: 'POST',
				body,
				token,
				headers: {
					'Content-Type': 'application/json'
				}
			});

			if (!response.data) {
				throw new Error('Failed to send message: no data returned');
			}

			// Map minimal message shape
			return this.mapMessage(response.data);
		} catch (error) {
			this.logService.error(`[OpenCodeClient] Failed to send message to session ${options.sessionId}`, error);
			throw error;
		}
	}

	async deleteSession(sessionId: string, token?: CancellationToken): Promise<void> {
		try {
			await this.tryPaths<void>([
				`/session/${encodeURIComponent(sessionId)}`
			], {
				method: 'DELETE',
				token
			});

			this.logService.info(`[OpenCodeClient] Deleted session: ${sessionId}`);
		} catch (error) {
			this.logService.error(`[OpenCodeClient] Failed to delete session ${sessionId}`, error);
			throw error;
		}
	}

	async getSessionMessages(sessionId: string, token?: CancellationToken): Promise<readonly OpenCodeMessage[]> {
		try {
			const response = await this.tryPaths<any>([
				`/session/${encodeURIComponent(sessionId)}/message`
			], {
				method: 'GET',
				token
			});

			const arr: any[] = Array.isArray(response.data) ? response.data : [];
			return arr.map(entry => this.mapMessageEntry(entry));
		} catch (error) {
			this.logService.error(`[OpenCodeClient] Failed to get session messages for ${sessionId}`, error);
			throw error;
		}
	}

	private mapSessionSummary(data: any): OpenCodeSessionData {
		const id = String(data?.id ?? data?.sessionID ?? '');
		const label = String(data?.title ?? id);
		return {
			id,
			label,
			messages: [],
			timestamp: new Date(),
			status: 'active'
		} satisfies OpenCodeSessionData;
	}

	private mapMessage(data: any): OpenCodeMessage {
		const role = (data?.role === 'assistant' || data?.role === 'user') ? data.role : 'assistant';
		// Prefer explicit string content
		let content: string | undefined = typeof data?.content === 'string' ? data.content : undefined;
		// If parts are present, extract text parts
		if (!content && Array.isArray(data?.parts)) {
			const texts = data.parts
				.filter((p: any) => p && (p.type === 'text') && typeof p.text === 'string')
				.map((p: any) => p.text);
			if (texts.length > 0) {
				content = texts.join('\n');
			}
		}
		// Fallback to a text field if present
		if (!content && typeof data?.text === 'string') {
			content = data.text;
		}
		// Last resort: stringify the payload
		if (!content) {
			try { content = JSON.stringify(data); } catch { content = String(data); }
		}

		const msg: any = {
			id: String(data?.id ?? `msg_${Date.now()}`),
			role,
			content,
			timestamp: new Date(),
			sessionId: String(data?.sessionID ?? '')
		} satisfies OpenCodeMessage;
		if (Array.isArray(data?.parts)) {
			msg.parts = data.parts; // preserve structured parts for rendering
		}
		return msg as OpenCodeMessage;
	}

	private mapMessageEntry(entry: any): OpenCodeMessage {
		const info = entry?.info ?? {};
		const parts = Array.isArray(entry?.parts) ? entry.parts : [];
		const texts: string[] = [];
		for (const p of parts) {
			if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
				texts.push(p.text);
			}
		}
		const content = texts.join('\n');
		const msg: OpenCodeMessage = {
			id: String(info.id ?? `msg_${Date.now()}`),
			role: (info.role === 'assistant' || info.role === 'user') ? info.role : 'assistant',
			content,
			timestamp: new Date(),
			sessionId: String(info.sessionID ?? ''),
			parts: parts
		};
		return msg;
	}

	/**
	 * Connect to WebSocket for real-time updates
	 * Note: This is a placeholder implementation. In a real implementation,
	 * this would establish a WebSocket connection to the OpenCode server.
	 */
	async connectWebSocket(): Promise<void> {
		const config = this.ensureConfig();

		if (this._isWebSocketConnecting) {
			this.logService.trace('[OpenCodeClient] WebSocket already connecting');
			return;
		}

		this._isWebSocketConnecting = true;

		try {
			// Convert HTTP URL to WebSocket URL
			const wsUrl = config.url.replace(/^http/, 'ws') + '/ws';
			this.logService.info(`[OpenCodeClient] Would connect to WebSocket: ${wsUrl}`);

			// In a real implementation, this would:
			// 1. Create a WebSocket connection using Node.js built-in or a compatible library
			// 2. Set up event handlers for open, close, error, and message events
			// 3. Handle reconnection logic
			// 4. Parse incoming messages and emit appropriate events

			// For now, we'll simulate successful connection
			this._isWebSocketConnecting = false;
			this.logService.info('[OpenCodeClient] WebSocket connection simulated');
		} catch (error) {
			this._isWebSocketConnecting = false;
			this.logService.error('[OpenCodeClient] Failed to connect WebSocket', error);
			throw error;
		}
	}

	/**
	 * Disconnect from WebSocket
	 */
	async disconnectWebSocket(): Promise<void> {
		if (this._isWebSocketConnecting) {
			this.logService.info('[OpenCodeClient] Disconnecting WebSocket');
			this._isWebSocketConnecting = false;
		}
	}



	override dispose(): void {
		this.disconnectWebSocket();
		super.dispose();
	}

	private async makeRequest<T>(options: {
		method: string;
		path: string;
		config: IOpenCodeServerConfig;
		body?: string;
		headers?: Record<string, string>;
		token?: CancellationToken;
	}): Promise<ApiResponse<T>> {
		const { method, path, config, body, headers = {}, token } = options;

		if (token?.isCancellationRequested) {
			throw new CancellationError();
		}

		const url = new URL(path, config.url);
		const isHttps = url.protocol === 'https:';
		const httpModule = isHttps ? https : http;

		this.logService.trace(`[OpenCodeClient] ${method} ${url.href}`);

		return new Promise((resolve, reject) => {
			const requestOptions: http.RequestOptions = {
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname + url.search,
				method,
				headers: {
					'User-Agent': 'VSCode-OpenCode-Client',
					...headers
				}
			};

			if (body) {
				const headers = requestOptions.headers as Record<string, string>;
				headers['Content-Length'] = Buffer.byteLength(body).toString();
			}

			const req = httpModule.request(requestOptions, (res) => {
				let responseBody = '';

				res.on('data', (chunk) => {
					responseBody += chunk.toString();
				});

				res.on('end', () => {
					try {
						this.logService.trace(`[OpenCodeClient] Response ${res.statusCode}: ${responseBody}`);

						if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
							// Success response
							let data: T | undefined;
							if (responseBody.trim()) {
								try {
									data = JSON.parse(responseBody);
								} catch (parseError) {
									this.logService.warn(`[OpenCodeClient] Failed to parse response JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
								}
							}
							resolve({ success: true, data });
						} else {
							// Error response
							let errorMessage = `HTTP ${res.statusCode}`;
							try {
								const errorData = responseBody ? JSON.parse(responseBody) : undefined;
								const pickString = (val: unknown): string | undefined => {
									if (!val) { return undefined; }
									if (typeof val === 'string') { return val; }
									if (typeof val === 'object') {
										// common shapes: { message: '...' } or nested error
										const msg = (val as any).message;
										if (typeof msg === 'string') { return msg; }
										try { return JSON.stringify(val); } catch { return String(val); }
									}
									return String(val);
								};
								const msg1 = errorData ? pickString((errorData as any).error) : undefined;
								const msg2 = errorData ? pickString((errorData as any).message) : undefined;
								errorMessage = msg1 || msg2 || errorMessage;
							} catch {
								errorMessage = responseBody || errorMessage;
							}
							// Include method and path for easier debugging
							reject(new Error(`${requestOptions.method} ${url.pathname}: ${errorMessage} (${res.statusCode})`));
						}
					} catch (error) {
						reject(error);
					}
				});
			});

			req.on('error', (error) => {
				this.logService.error(`[OpenCodeClient] Request error: ${error instanceof Error ? error.message : String(error)}`);
				reject(error);
			});

			// Handle cancellation
			if (token) {
				token.onCancellationRequested(() => {
					req.destroy();
					reject(new CancellationError());
				});
			}

			// Send request body if present
			if (body) {
				req.write(body);
			}

			req.end();
		});
	}

	/**
	 * Attempt the same request across multiple candidate paths, falling back on 404s.
	 */
	private async tryPaths<T>(paths: string[], options: {
		method: string;
		body?: string;
		headers?: Record<string, string>;
		token?: CancellationToken;
	}): Promise<ApiResponse<T>> {
		const config = this.ensureConfig();
		const candidates = this.addConfiguredBasePath(paths);
		let lastError: unknown;
		for (let i = 0; i < candidates.length; i++) {
			const path = candidates[i];
			try {
				this.logService.trace(`[OpenCodeClient] Trying path: ${path}`);
				return await this.makeRequest<T>({
					method: options.method,
					path,
					config,
					body: options.body,
					headers: options.headers,
					token: options.token
				});
			} catch (error) {
				lastError = error;
				const msg = error instanceof Error ? error.message : String(error);
				// Only fall back on 404; propagate other errors
				if (!msg.includes('(404)') || i === candidates.length - 1) {
					throw error;
				}
				this.logService.trace(`[OpenCodeClient] Path ${path} returned 404, trying next candidate`);
			}
		}
		// Shouldn't reach here because last path throws
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private addConfiguredBasePath(paths: string[]): string[] {
		const cfg = this.configurationService.getNonExtensionConfig<any>('opencode');
		let base: string = cfg?.server?.apiBasePath ?? '';
		base = typeof base === 'string' ? base.trim() : '';
		if (base === '') {
			return paths;
		}
		if (!base.startsWith('/')) {
			base = '/' + base;
		}
		if (base.endsWith('/')) {
			base = base.slice(0, -1);
		}
		const withBase = paths.map(p => {
			const rel = p.startsWith('/') ? p : '/' + p;
			return base + rel;
		});
		// De-duplicate while preserving order: [withBase..., original...]
		const seen = new Set<string>();
		const merged = [...withBase, ...paths].filter(p => (seen.has(p) ? false : (seen.add(p), true)));
		return merged;
	}
}
