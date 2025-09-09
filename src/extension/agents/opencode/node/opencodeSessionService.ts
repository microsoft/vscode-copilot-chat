/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { CreateSessionOptions, IOpenCodeClient, OpenCodeMessage, OpenCodeSessionData } from './opencodeClient';

export interface IOpenCodeSession {
	readonly id: string;
	readonly label: string;
	readonly messages: readonly OpenCodeMessage[];
	readonly timestamp: Date;
	readonly status: 'active' | 'idle' | 'completed' | 'error';
}

export const IOpenCodeSessionService = createServiceIdentifier<IOpenCodeSessionService>('IOpenCodeSessionService');

export interface IOpenCodeSessionService {
	readonly _serviceBrand: undefined;
	getAllSessions(token: CancellationToken): Promise<readonly IOpenCodeSession[]>;
	getSession(sessionId: string, token: CancellationToken): Promise<IOpenCodeSession | undefined>;
	createSession(options?: CreateSessionOptions): Promise<IOpenCodeSession>;
}

export class OpenCodeSessionService extends Disposable implements IOpenCodeSessionService {
	declare _serviceBrand: undefined;

	// Simple in-memory cache with timestamp-based invalidation
	private _sessionCache: Map<string, { session: IOpenCodeSession; timestamp: number }> = new Map();
	private _allSessionsCache: { sessions: readonly IOpenCodeSession[]; timestamp: number } | undefined;
	private readonly _cacheTimeout = 30000; // 30 seconds

	constructor(
		@IOpenCodeClient private readonly client: IOpenCodeClient,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	async getAllSessions(token: CancellationToken): Promise<readonly IOpenCodeSession[]> {
		try {
			// Check cache first
			if (this._allSessionsCache && this.isCacheValid(this._allSessionsCache.timestamp)) {
				this.logService.trace('[OpenCodeSessionService] Returning cached sessions list');
				return this._allSessionsCache.sessions;
			}

			this.logService.trace('[OpenCodeSessionService] Fetching all sessions from client');
			const sessionData = await this.client.getAllSessions(token);
			
			const sessions = sessionData.map(data => this.convertToOpenCodeSession(data));
			
			// Update cache
			this._allSessionsCache = {
				sessions,
				timestamp: Date.now()
			};

			// Also update individual session cache entries
			for (const session of sessions) {
				this._sessionCache.set(session.id, {
					session,
					timestamp: Date.now()
				});
			}

			this.logService.info(`[OpenCodeSessionService] Retrieved ${sessions.length} sessions`);
			return sessions;
		} catch (error) {
			this.logService.error('[OpenCodeSessionService] Failed to get all sessions', error);
			throw error;
		}
	}

	async getSession(sessionId: string, token: CancellationToken): Promise<IOpenCodeSession | undefined> {
		try {
			// Check cache first
			const cached = this._sessionCache.get(sessionId);
			if (cached && this.isCacheValid(cached.timestamp)) {
				this.logService.trace(`[OpenCodeSessionService] Returning cached session: ${sessionId}`);
				return cached.session;
			}

			this.logService.trace(`[OpenCodeSessionService] Fetching session from client: ${sessionId}`);
			const sessionData = await this.client.getSession(sessionId, token);
			
			if (!sessionData) {
				// Remove from cache if it doesn't exist
				this._sessionCache.delete(sessionId);
				return undefined;
			}

			const session = this.convertToOpenCodeSession(sessionData);
			
			// Update cache
			this._sessionCache.set(sessionId, {
				session,
				timestamp: Date.now()
			});

			return session;
		} catch (error) {
			this.logService.error(`[OpenCodeSessionService] Failed to get session ${sessionId}`, error);
			throw error;
		}
	}

	async createSession(options?: CreateSessionOptions): Promise<IOpenCodeSession> {
		try {
			this.logService.info('[OpenCodeSessionService] Creating new session', options);
			const sessionData = await this.client.createSession(options);
			
			const session = this.convertToOpenCodeSession(sessionData);
			
			// Update cache
			this._sessionCache.set(session.id, {
				session,
				timestamp: Date.now()
			});

			// Invalidate the all sessions cache since we added a new session
			this._allSessionsCache = undefined;

			this.logService.info(`[OpenCodeSessionService] Created session: ${session.id}`);
			return session;
		} catch (error) {
			this.logService.error('[OpenCodeSessionService] Failed to create session', error);
			throw error;
		}
	}

	/**
	 * Convert OpenCodeSessionData to IOpenCodeSession
	 * This allows us to potentially add additional processing or transformation logic
	 */
	private convertToOpenCodeSession(data: OpenCodeSessionData): IOpenCodeSession {
		return {
			id: data.id,
			label: data.label || `Session ${data.id}`,
			messages: data.messages,
			timestamp: data.timestamp,
			status: data.status
		};
	}

	/**
	 * Check if a cache entry is still valid based on timestamp
	 */
	private isCacheValid(timestamp: number): boolean {
		return Date.now() - timestamp < this._cacheTimeout;
	}

	/**
	 * Clear all cached data
	 */
	public clearCache(): void {
		this.logService.trace('[OpenCodeSessionService] Clearing cache');
		this._sessionCache.clear();
		this._allSessionsCache = undefined;
	}

	/**
	 * Invalidate cache for a specific session
	 */
	public invalidateSession(sessionId: string): void {
		this.logService.trace(`[OpenCodeSessionService] Invalidating cache for session: ${sessionId}`);
		this._sessionCache.delete(sessionId);
		// Also invalidate all sessions cache since it might be stale
		this._allSessionsCache = undefined;
	}

	override dispose(): void {
		this.clearCache();
		super.dispose();
	}
}