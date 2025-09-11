/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createOpencodeClient } from '@opencode-ai/sdk';
import type { CancellationToken } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
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
	private _sdkClient: any | undefined;
	private _sdkEventsAbort?: AbortController;

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
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	setConfig(config: IOpenCodeServerConfig): void {
		this._config = config;
		this.logService.trace(`[OpenCodeClient] Config set: ${this._config.url}`);
		// initialize SDK client immediately
		this._sdkClient = createOpencodeClient({ baseUrl: this._config.url, responseStyle: 'data' });
	}

	async getAllSessions(token?: CancellationToken): Promise<readonly OpenCodeSessionData[]> {
		if (!this._sdkClient) { throw new Error('OpenCodeClient not configured. Call setConfig() first.'); }
		try {
			const sessions = await this._sdkClient.session.list();
			const list: any[] = Array.isArray(sessions) ? sessions : [];
			return list.map(s => this.mapSessionSummary(s));
		} catch (error) {
			this.logService.error('[OpenCodeClient] SDK: Failed to get all sessions', error);
			throw error;
		}
	}

	async getSession(sessionId: string, token?: CancellationToken): Promise<OpenCodeSessionData | undefined> {
		if (!this._sdkClient) { throw new Error('OpenCodeClient not configured. Call setConfig() first.'); }
		try {
			const session = await this._sdkClient.session.get({ path: { id: sessionId } });
			return this.mapSessionSummary(session);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes('404')) { return undefined; }
			this.logService.error(`[OpenCodeClient] SDK: Failed to get session ${sessionId}`, error);
			throw error;
		}
	}

	async createSession(options?: CreateSessionOptions, token?: CancellationToken): Promise<OpenCodeSessionData> {
		if (!this._sdkClient) { throw new Error('OpenCodeClient not configured. Call setConfig() first.'); }
		try {
			const session = await this._sdkClient.session.create({ body: { title: options?.label } });
			const mapped = this.mapSessionSummary(session);
			this.logService.info(`[OpenCodeClient] SDK: Created session: ${mapped.id}`);
			return mapped;
		} catch (error) {
			this.logService.error('[OpenCodeClient] SDK: Failed to create session', error);
			throw error;
		}
	}

	async sendMessage(options: SendMessageOptions, token?: CancellationToken): Promise<OpenCodeMessage> {
		if (!this._sdkClient) { throw new Error('OpenCodeClient not configured. Call setConfig() first.'); }
		try {
			const result = await this._sdkClient.session.prompt({ path: { id: options.sessionId }, body: { parts: [{ type: 'text', text: options.content }] } });
			const mapped = this.mapMessage({ id: result?.info?.id, role: result?.info?.role ?? 'assistant', content: undefined, parts: Array.isArray(result?.parts) ? result.parts : [] });
			return mapped;
		} catch (error) {
			this.logService.error(`[OpenCodeClient] SDK: Failed to send message to session ${options.sessionId}`, error);
			throw error;
		}
	}

	async deleteSession(sessionId: string, token?: CancellationToken): Promise<void> {
		if (!this._sdkClient) { throw new Error('OpenCodeClient not configured. Call setConfig() first.'); }
		try {
			await this._sdkClient.session.delete({ path: { id: sessionId } });
			this.logService.info(`[OpenCodeClient] SDK: Deleted session: ${sessionId}`);
		} catch (error) {
			this.logService.error(`[OpenCodeClient] SDK: Failed to delete session ${sessionId}`, error);
			throw error;
		}
	}

	async getSessionMessages(sessionId: string, token?: CancellationToken): Promise<readonly OpenCodeMessage[]> {
		if (!this._sdkClient) { throw new Error('OpenCodeClient not configured. Call setConfig() first.'); }
		try {
			const arr = await this._sdkClient.session.messages({ path: { id: sessionId } });
			const list: any[] = Array.isArray(arr) ? arr : [];
			return list.map((entry: any) => this.mapMessageEntry(entry));
		} catch (error) {
			this.logService.error(`[OpenCodeClient] SDK: Failed to get session messages for ${sessionId}`, error);
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
		if (!this._sdkClient) { throw new Error('OpenCodeClient not configured. Call setConfig() first.'); }

		if (this._isWebSocketConnecting) {
			this.logService.trace('[OpenCodeClient] Events already connecting');
			return;
		}

		this._isWebSocketConnecting = true;

		try {
			this._sdkEventsAbort?.abort();
			this._sdkEventsAbort = new AbortController();
			const subscription = await this._sdkClient.event.subscribe({ signal: this._sdkEventsAbort.signal });
			(async () => {
				try {
					for await (const ev of subscription.stream) {
						try {
							const type = (ev as any).type || (ev as any).event || '';
							const props = (ev as any).properties || (ev as any).data || {};
							switch (type) {
								case 'session_created':
									this._onSessionCreated.fire({ type: 'session_created', data: props, sessionId: props?.id, timestamp: new Date() });
									break;
								case 'session_updated':
									this._onSessionUpdated.fire({ type: 'session_updated', data: props, sessionId: props?.id, timestamp: new Date() });
									break;
								case 'session_deleted':
									this._onSessionDeleted.fire({ type: 'session_deleted', data: { sessionId: String(props?.id ?? props?.sessionId ?? '') }, sessionId: props?.id, timestamp: new Date() });
									break;
								case 'message_received':
								case 'message_created':
									this._onMessageReceived.fire({ type: 'message_received', data: this.mapMessage(props), sessionId: props?.sessionID, timestamp: new Date() });
									break;
								default:
									break;
							}
						} catch (inner) {
							this.logService.error('[OpenCodeClient] Failed to process event', inner);
						}
					}
				} catch (iterErr) {
					this.logService.error('[OpenCodeClient] Event stream ended', iterErr);
				}
			})();
			this.logService.info('[OpenCodeClient] Connected to events stream');
		} finally {
			this._isWebSocketConnecting = false;
		}
	}

	/**
	 * Disconnect from WebSocket
	 */
	async disconnectWebSocket(): Promise<void> {
		try {
			this._sdkEventsAbort?.abort();
		} finally {
			this._sdkEventsAbort = undefined;
		}
	}

	override dispose(): void {
		this.disconnectWebSocket();
		super.dispose();
	}
}
