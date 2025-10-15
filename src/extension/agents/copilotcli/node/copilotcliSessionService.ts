/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Session, SessionManager } from '@github/copilot/sdk';
import type { CancellationToken, ChatContext, ChatRequest, ChatSessionStatus } from 'vscode';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { DisposableMap, IDisposable } from '../../../../util/vs/base/common/lifecycle';
import { stripSystemReminders } from './copilotcliToolInvocationFormatter';
import { ensureNodePtyShim } from './nodePtyShim';

export interface ICopilotCLISession {
	readonly id: string;
	readonly sdkSession: Session;
	readonly label: string;
	readonly timestamp: Date;
}

export type ExtendedChatRequest = ChatRequest & { prompt: string };

export interface ICopilotCLISessionService {
	readonly _serviceBrand: undefined;

	onDidChangeSessions: Event<void>;

	// Session metadata querying
	getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]>;
	getSession(sessionId: string, token: CancellationToken): Promise<ICopilotCLISession | undefined>;

	// SDK session management
	getSessionManager(): Promise<SessionManager>;
	getOrCreateSDKSession(sessionId: string | undefined, prompt: string): Promise<Session>;
	deleteSession(sessionId: string): Promise<boolean>;
	setSessionStatus(sessionId: string, status: ChatSessionStatus): void;
	getSessionStatus(sessionId: string): ChatSessionStatus | undefined;

	// Session wrapper tracking
	trackSessionWrapper<T extends IDisposable>(sessionId: string, wrapper: T): void;
	findSessionWrapper<T extends IDisposable>(sessionId: string): T | undefined;

	// Pending request tracking (for untitled sessions)
	setPendingRequest(sessionId: string, request: ExtendedChatRequest, context: ChatContext): void;
	getPendingRequest(sessionId: string): { request: ExtendedChatRequest; context: ChatContext } | undefined;
	clearPendingRequest(sessionId: string): void;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');

export class CopilotCLISessionService implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private _sessionManager: SessionManager | undefined;
	private _sessionWrappers = new DisposableMap<string, IDisposable>();
	private _sessions = new Map<string, ICopilotCLISession>();
	private _pendingRequests = new Map<string, { request: any; context: any }>();

	private readonly _onDidChangeSessions = new Emitter<void>();
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;
	private readonly _sessionStatuses = new Map<string, ChatSessionStatus>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IEnvService private readonly envService: IEnvService,
	) { }

	public async getSessionManager(): Promise<SessionManager> {
		if (!this._sessionManager) {
			try {
				// Ensure node-pty shim exists before importing SDK
				// @github/copilot has hardcoded: import{spawn}from"node-pty"
				await ensureNodePtyShim(this.extensionContext.extensionPath, this.envService.appRoot);

				const { SessionManager } = await import('@github/copilot/sdk');
				this._sessionManager = new SessionManager({
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
				this.logService.error(`Failed to initialize SessionManager: ${error}`);
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
						const sdkSession = await sessionManager.getSession(metadata.sessionId);
						if (!sdkSession) {
							throw new Error(`Session ${metadata.sessionId} not found`);
						}

						const label = await this._generateSessionLabel(sdkSession, undefined);
						return {
							id: metadata.sessionId,
							sdkSession,
							label,
							timestamp: metadata.startTime
						};
					} catch (error) {
						this.logService.warn(`Failed to load session ${metadata.sessionId}: ${error}`);
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

	public async getOrCreateSDKSession(sessionId: string | undefined, prompt: string): Promise<Session> {
		const sessionManager = await this.getSessionManager();

		if (sessionId) {
			try {
				const sdkSession = await sessionManager.getSession(sessionId);

				if (sdkSession) {
					return sdkSession;
				}
			} catch (error) {
				// Fall through to create new session
			}
		}

		const sdkSession = await sessionManager.createSession();

		// Cache the new session immediately
		const label = await this._generateSessionLabel(sdkSession, prompt);
		const newSession: ICopilotCLISession = {
			id: sdkSession.sessionId,
			sdkSession,
			label,
			timestamp: new Date()
		};
		this._sessions.set(sdkSession.sessionId, newSession);

		return sdkSession;
	}

	public setSessionStatus(sessionId: string, status: ChatSessionStatus): void {
		this._sessionStatuses.set(sessionId, status);
		this._onDidChangeSessions.fire();
	}

	public getSessionStatus(sessionId: string): ChatSessionStatus | undefined {
		return this._sessionStatuses.get(sessionId);
	}

	public trackSessionWrapper<T extends IDisposable>(sessionId: string, wrapper: T): void {
		this._sessionWrappers.set(sessionId, wrapper);
	}

	public findSessionWrapper<T extends IDisposable>(sessionId: string): T | undefined {
		return this._sessionWrappers.get(sessionId) as T | undefined;
	}

	public async deleteSession(sessionId: string): Promise<boolean> {
		try {
			// Delete from session manager first
			const sessionManager = await this.getSessionManager();
			const sdkSession = await sessionManager.getSession(sessionId);
			if (sdkSession) {
				await sessionManager.deleteSession(sdkSession);
			}

			// Clean up local caches
			this._sessions.delete(sessionId);
			this._sessionWrappers.deleteAndDispose(sessionId);

			return true;
		} catch (error) {
			this.logService.error(`Failed to delete session ${sessionId}: ${error}`);
			return false;
		}
	}

	private async _generateSessionLabel(sdkSession: Session, prompt: string | undefined): Promise<string> {
		try {
			const chatMessages = sdkSession.chatMessages;

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
					// Strip system reminders and return first line or first 50 characters, whichever is shorter
					const cleanContent = stripSystemReminders(content);
					const firstLine = cleanContent.split('\n').find((l: string) => l.trim().length > 0) ?? '';
					return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
				}
			} else if (prompt && prompt.trim().length > 0) {
				return prompt.trim().length > 50 ? prompt.trim().substring(0, 47) + '...' : prompt.trim();
			}
		} catch (error) {
			this.logService.warn(`Failed to generate session label for ${sdkSession.sessionId}: ${error}`);
		}

		// Fallback to session ID
		return `Session ${sdkSession.sessionId.slice(0, 8)}`;
	}

	public setPendingRequest(sessionId: string, request: ExtendedChatRequest, context: ChatContext): void {
		this._pendingRequests.set(sessionId, { request, context });
	}

	public getPendingRequest(sessionId: string): { request: ExtendedChatRequest; context: ChatContext } | undefined {
		return this._pendingRequests.get(sessionId);
	}

	public clearPendingRequest(sessionId: string): void {
		this._pendingRequests.delete(sessionId);
	}
}
