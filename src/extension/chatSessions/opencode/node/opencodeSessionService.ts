/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IOpenCodeSdkService, OpenCodeMessage, OpenCodeSession } from './opencodeSdkService';

export { OpenCodeMessage, OpenCodeSession };

export interface IOpenCodeSessionService {
	readonly _serviceBrand: undefined;

	/**
	 * Lists all available OpenCode sessions
	 */
	listSessions(): Promise<OpenCodeSession[]>;

	/**
	 * Gets a specific session by ID
	 */
	getSession(sessionId: string): Promise<OpenCodeSession | undefined>;

	/**
	 * Creates a new session
	 */
	createSession(title?: string): Promise<OpenCodeSession>;

	/**
	 * Gets messages for a session
	 */
	getSessionMessages(sessionId: string): Promise<OpenCodeMessage[]>;

	/**
	 * Sends a message to a session
	 */
	sendMessage(sessionId: string, text: string): Promise<{ status: number }>;

	/**
	 * Deletes a session
	 */
	deleteSession(sessionId: string): Promise<void>;

	/**
	 * Invalidates cache for a session
	 */
	invalidateSession(sessionId: string): void;

	/**
	 * Clears all cached data
	 */
	clearCache(): void;
}

export const IOpenCodeSessionService = createServiceIdentifier<IOpenCodeSessionService>('IOpenCodeSessionService');

interface SessionCacheEntry {
	session: OpenCodeSession;
	timestamp: number;
}

interface MessagesCacheEntry {
	messages: OpenCodeMessage[];
	timestamp: number;
}

export class OpenCodeSessionService extends Disposable implements IOpenCodeSessionService {
	readonly _serviceBrand: undefined;

	private readonly _sessionCache = new Map<string, SessionCacheEntry>();
	private readonly _messagesCache = new Map<string, MessagesCacheEntry>();
	private _allSessionsCache: { sessions: OpenCodeSession[]; timestamp: number } | undefined;
	private readonly _cacheTimeout = 30000; // 30 seconds

	constructor(
		@IOpenCodeSdkService private readonly sdkService: IOpenCodeSdkService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	private isCacheValid(timestamp: number): boolean {
		return Date.now() - timestamp < this._cacheTimeout;
	}

	public async listSessions(): Promise<OpenCodeSession[]> {
		if (this._allSessionsCache && this.isCacheValid(this._allSessionsCache.timestamp)) {
			this.logService.trace('[OpenCodeSessionService] Returning cached sessions');
			return this._allSessionsCache.sessions;
		}

		this.logService.trace('[OpenCodeSessionService] Fetching sessions from server');
		try {
			const sessions = await this.sdkService.listSessions();
			this._allSessionsCache = { sessions, timestamp: Date.now() };

			// Update individual session cache
			for (const session of sessions) {
				this._sessionCache.set(session.id, { session, timestamp: Date.now() });
			}

			return sessions;
		} catch (error) {
			this.logService.error('[OpenCodeSessionService] Failed to list sessions', error);
			throw error;
		}
	}

	public async getSession(sessionId: string): Promise<OpenCodeSession | undefined> {
		const cached = this._sessionCache.get(sessionId);
		if (cached && this.isCacheValid(cached.timestamp)) {
			this.logService.trace(`[OpenCodeSessionService] Returning cached session: ${sessionId}`);
			return cached.session;
		}

		this.logService.trace(`[OpenCodeSessionService] Fetching session from server: ${sessionId}`);
		try {
			const session = await this.sdkService.getSession(sessionId);
			if (session) {
				this._sessionCache.set(sessionId, { session, timestamp: Date.now() });
			}
			return session;
		} catch (error) {
			this.logService.error(`[OpenCodeSessionService] Failed to get session: ${sessionId}`, error);
			throw error;
		}
	}

	public async createSession(title?: string): Promise<OpenCodeSession> {
		this.logService.trace('[OpenCodeSessionService] Creating new session');
		try {
			const session = await this.sdkService.createSession(title);
			this._sessionCache.set(session.id, { session, timestamp: Date.now() });
			this._allSessionsCache = undefined; // Invalidate list cache
			return session;
		} catch (error) {
			this.logService.error('[OpenCodeSessionService] Failed to create session', error);
			throw error;
		}
	}

	public async getSessionMessages(sessionId: string): Promise<OpenCodeMessage[]> {
		const cached = this._messagesCache.get(sessionId);
		if (cached && this.isCacheValid(cached.timestamp)) {
			this.logService.trace(`[OpenCodeSessionService] Returning cached messages: ${sessionId}`);
			return cached.messages;
		}

		this.logService.trace(`[OpenCodeSessionService] Fetching messages from server: ${sessionId}`);
		try {
			const messages = await this.sdkService.getSessionMessages(sessionId);
			this._messagesCache.set(sessionId, { messages, timestamp: Date.now() });
			return messages;
		} catch (error) {
			this.logService.error(`[OpenCodeSessionService] Failed to get messages: ${sessionId}`, error);
			throw error;
		}
	}

	public async sendMessage(sessionId: string, text: string): Promise<{ status: number }> {
		this.logService.trace(`[OpenCodeSessionService] Sending message to session: ${sessionId}`);
		try {
			const result = await this.sdkService.sendMessage(sessionId, text);
			// Invalidate messages cache after sending
			this._messagesCache.delete(sessionId);
			return result;
		} catch (error) {
			this.logService.error(`[OpenCodeSessionService] Failed to send message: ${sessionId}`, error);
			throw error;
		}
	}

	public async deleteSession(sessionId: string): Promise<void> {
		this.logService.trace(`[OpenCodeSessionService] Deleting session: ${sessionId}`);
		try {
			await this.sdkService.deleteSession(sessionId);
			this._sessionCache.delete(sessionId);
			this._messagesCache.delete(sessionId);
			this._allSessionsCache = undefined;
		} catch (error) {
			this.logService.error(`[OpenCodeSessionService] Failed to delete session: ${sessionId}`, error);
			throw error;
		}
	}

	public invalidateSession(sessionId: string): void {
		this.logService.trace(`[OpenCodeSessionService] Invalidating cache for session: ${sessionId}`);
		this._sessionCache.delete(sessionId);
		this._messagesCache.delete(sessionId);
		this._allSessionsCache = undefined;
	}

	public clearCache(): void {
		this.logService.trace('[OpenCodeSessionService] Clearing all caches');
		this._sessionCache.clear();
		this._messagesCache.clear();
		this._allSessionsCache = undefined;
	}

	override dispose(): void {
		this.clearCache();
		super.dispose();
	}
}
