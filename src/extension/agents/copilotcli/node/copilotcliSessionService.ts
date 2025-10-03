/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CopilotCLISessionManager, Session } from '@github/copilot/sdk';
import type { CancellationToken } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { DisposableMap } from '../../../../util/vs/base/common/lifecycle';

export interface ICopilotCLISession {
	readonly id: string;
	readonly sdkSession: Session;
	readonly label: string;
	readonly timestamp: Date;
}

export interface ICopilotCLISessionService {
	readonly _serviceBrand: undefined;

	// Session metadata querying
	getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]>;
	getSession(sessionId: string, token: CancellationToken): Promise<ICopilotCLISession | undefined>;

	// SDK session management
	getSessionManager(): Promise<CopilotCLISessionManager>;
	getOrCreateSDKSession(sessionId: string | undefined): Promise<Session>;

	// Session wrapper tracking
	trackSessionWrapper<T>(sessionId: string, wrapper: T): void;
	findSessionWrapper<T>(sessionId: string): T | undefined;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');

export class CopilotCLISessionService implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private _sessionManager: CopilotCLISessionManager | undefined;
	private _sessionWrappers = new DisposableMap<string, any>();
	private _sessions = new Map<string, ICopilotCLISession>();

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	public async getSessionManager(): Promise<CopilotCLISessionManager> {
		if (!this._sessionManager) {
			try {
				const { CopilotCLISessionManager } = await import('@github/copilot/sdk');
				this._sessionManager = new CopilotCLISessionManager({
					logger: {
						isDebug: () => false,
						debug: (msg: string) => this.logService.debug(msg),
						log: (msg: string) => this.logService.trace(msg),
						info: (msg: string) => this.logService.info(msg),
						notice: (msg: string | Error) => this.logService.info(typeof msg === 'string' ? msg : msg.message),
						warning: (msg: string | Error) => this.logService.warn(typeof msg === 'string' ? msg : msg.message),
						error: (msg: string | Error) => this.logService.error(typeof msg === 'string' ? msg : msg.message),
						startGroup: () => { },
						endGroup: () => { }
					}
				});
			} catch (error) {
				this.logService.error(`Failed to initialize CopilotCLISessionManager: ${error}`);
				throw error;
			}
		}
		return this._sessionManager;
	}

	async getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]> {
		try {
			const sessionManager = await this.getSessionManager();
			const sessionMetadataList = await sessionManager.listSessions();

			// Convert SessionMetadata to ICopilotCLISession
			const diskSessions: ICopilotCLISession[] = await Promise.all(
				sessionMetadataList.map(async (metadata) => {
					try {
						// Get the full session to access chat messages
						const sdkSession = await sessionManager.getSession(metadata.id);
						const label = await this._generateSessionLabel(sdkSession);
						return {
							id: metadata.id,
							sdkSession,
							label,
							timestamp: metadata.startTime
						};
					} catch (error) {
						this.logService.warn(`Failed to load session ${metadata.id}: ${error}`);
						throw error;
					}
				})
			);

			// Merge with cached sessions (new sessions not yet persisted by SDK)
			const diskSessionIds = new Set(diskSessions.map(s => s.id));
			const cachedSessions = Array.from(this._sessions.values()).filter(s => !diskSessionIds.has(s.id));
			const allSessions = [...diskSessions, ...cachedSessions];

			return allSessions;
		} catch (error) {
			this.logService.error(`Failed to get all sessions: ${error}`);
			return Array.from(this._sessions.values());
		}
	}

	async getSession(sessionId: string, token: CancellationToken): Promise<ICopilotCLISession | undefined> {
		const cached = this._sessions.get(sessionId);
		if (cached) {
			return cached;
		}

		// Fall back to querying all sessions
		const all = await this.getAllSessions(token);
		return all.find(session => session.id === sessionId);
	}

	public async getOrCreateSDKSession(sessionId: string | undefined): Promise<Session> {
		const sessionManager = await this.getSessionManager();

		if (sessionId) {
			try {
				const sdkSession = await sessionManager.getSession(sessionId);
				return sdkSession;
			} catch (error) {
				// Fall through to create new session
			}
		}

		const sdkSession = await sessionManager.createSession();

		// Cache the new session immediately
		const label = await this._generateSessionLabel(sdkSession);
		const newSession: ICopilotCLISession = {
			id: sdkSession.id,
			sdkSession,
			label,
			timestamp: new Date()
		};
		this._sessions.set(sdkSession.id, newSession);

		return sdkSession;
	}

	public trackSessionWrapper<T>(sessionId: string, wrapper: T): void {
		this._sessionWrappers.set(sessionId, wrapper);
	}

	public findSessionWrapper<T>(sessionId: string): T | undefined {
		return this._sessionWrappers.get(sessionId) as T | undefined;
	}

	private async _generateSessionLabel(sdkSession: Session): Promise<string> {
		try {
			const chatMessages = await sdkSession.getChatMessages();

			// Find the first user message
			const firstUserMessage = chatMessages.find(msg => msg.role === 'user');
			if (firstUserMessage && firstUserMessage.content) {
				const content = typeof firstUserMessage.content === 'string'
					? firstUserMessage.content
					: Array.isArray(firstUserMessage.content)
						? firstUserMessage.content
							.filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && 'type' in block && block.type === 'text')
							.map(block => block.text)
							.join(' ')
						: '';

				if (content) {
					// Return first line or first 50 characters, whichever is shorter
					const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? '';
					return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
				}
			}
		} catch (error) {
			this.logService.warn(`Failed to generate session label for ${sdkSession.id}: ${error}`);
		}

		// Fallback to session ID
		return `Session ${sdkSession.id.slice(0, 8)}`;
	}
}
