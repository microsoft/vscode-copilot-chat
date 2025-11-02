/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelProvider, Session, SessionManager, internal } from '@github/copilot/sdk';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { CancellationToken, ChatRequest } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { raceCancellationError } from '../../../../util/vs/base/common/async';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus } from '../../../../vscodeTypes';
import { ICopilotCLISDK } from './copilotCli';
import { CopilotCLISession, ICopilotCLISession } from './copilotcliSession';
import { stripReminders } from './copilotcliToolInvocationFormatter';
import { getCopilotLogger } from './logger';

export interface ICopilotCLISessionItem {
	readonly id: string;
	readonly label: string;
	readonly isEmpty: boolean;
	readonly timestamp: Date;
	readonly status?: ChatSessionStatus;
}

export type ExtendedChatRequest = ChatRequest & { prompt: string };

export interface ICopilotCLISessionService {
	readonly _serviceBrand: undefined;

	onDidChangeSessions: Event<void>;

	// Session metadata querying
	getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]>;

	// SDK session management
	deleteSession(sessionId: string): Promise<void>;

	// Session wrapper tracking
	getSession(sessionId: string, model: ModelProvider | undefined, readonly: boolean, token: CancellationToken): Promise<ICopilotCLISession | undefined>;
	createSession(prompt: string, model: ModelProvider | undefined, token: CancellationToken): Promise<ICopilotCLISession>;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');


export class CopilotCLISessionService extends Disposable implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private _sessionManager: Lazy<Promise<internal.CLISessionManager>>;
	private _sessionWrappers = new DisposableMap<string, CopilotCLISession>();
	private _newActiveSessions = new Map<string, ICopilotCLISessionItem>();


	private readonly _onDidChangeSessions = new Emitter<void>();
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();

		this._sessionManager = new Lazy<Promise<internal.CLISessionManager>>(async () => {
			const { internal } = await this.copilotCLISDK.getPackage();
			return new internal.CLISessionManager({
				logger: getCopilotLogger(this.logService)
			});
		});
	}

	async getSessionManager() {
		return this._sessionManager.value;
	}

	private _getAllSessionsProgress: Promise<readonly ICopilotCLISessionItem[]> | undefined;
	async getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]> {
		if (!this._getAllSessionsProgress) {
			this._getAllSessionsProgress = this._getAllSessions(token);
		}
		return this._getAllSessionsProgress.finally(() => {
			this._getAllSessionsProgress = undefined;
		});
	}

	async _getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]> {
		try {
			const sessionManager = await raceCancellationError(this.getSessionManager(), token);
			const sessionMetadataList = await raceCancellationError(sessionManager.listSessions(), token);

			// Convert SessionMetadata to ICopilotCLISession
			const diskSessions: ICopilotCLISessionItem[] = coalesce(await Promise.all(
				sessionMetadataList.map(async (metadata) => {
					if (this._newActiveSessions.has(metadata.sessionId)) {
						// This is a new session not yet persisted to disk by SDK
						return undefined;
					}
					let dispose: (() => Promise<void>) | undefined = undefined;
					let session: Session | undefined = undefined;
					try {
						// Get the full session to access chat messages
						({ session, dispose } = (await this.getReadonlySdkSession(metadata.sessionId, token)) || {});
						if (!session) {
							this.logService.warn(`Copilot CLI session not found, ${metadata.sessionId}`);
							return;
						}
						const chatMessages = await raceCancellationError(session.getChatMessages(), token);
						const noUserMessages = !chatMessages.find(message => message.role === 'user');
						const label = await this._generateSessionLabel(session.sessionId, chatMessages, undefined);

						// Get timestamp from last SDK event, or fallback to metadata.startTime
						const sdkEvents = session.getEvents();
						const lastEventWithTimestamp = [...sdkEvents].reverse().find(event =>
							event.type !== 'session.import_legacy'
							&& event.type !== 'session.start'
							&& 'timestamp' in event
						);
						const timestamp = lastEventWithTimestamp && 'timestamp' in lastEventWithTimestamp
							? new Date(lastEventWithTimestamp.timestamp)
							: metadata.startTime;

						return {
							id: metadata.sessionId,
							label,
							timestamp,
							isEmpty: noUserMessages
						} satisfies ICopilotCLISessionItem;
					} catch (error) {
						this.logService.warn(`Failed to load session ${metadata.sessionId}: ${error}`);
					} finally {
						await dispose?.();
					}
				})
			));

			// Merge with cached sessions (new sessions not yet persisted by SDK)
			const allSessions = diskSessions
				.filter(session => !this._newActiveSessions.has(session.id))
				.filter(session => !session.isEmpty)
				.map(session => {
					return {
						...session,
						status: this._sessionWrappers.get(session.id)?.status
					} satisfies ICopilotCLISessionItem;
				});

			return allSessions;
		} catch (error) {
			this.logService.error(`Failed to get all sessions: ${error}`);
			return Array.from(this._newActiveSessions.values());
		}
	}

	private async getReadonlySdkSession(sessionId: string, token: CancellationToken): Promise<{ session: Session; dispose: () => Promise<void> } | undefined> {
		// let session = this._sessionWrappers.get(sessionId)?.session;
		const sessionManager = await raceCancellationError(this.getSessionManager(), token);
		const session = await sessionManager.getSession(sessionId);
		if (!session) {
			return undefined;
		}
		return { session, dispose: () => Promise.resolve() };
	}

	public async createSession(prompt: string, model: ModelProvider | undefined, token: CancellationToken): Promise<CopilotCLISession> {
		const sessionDisposables = this._register(new DisposableStore());
		try {
			const sessionManager = await raceCancellationError(this.getSessionManager(), token);

			const sdkSession = await sessionManager.createSession();
			const chatMessages = await sdkSession.getChatMessages();
			const noUserMessages = !chatMessages.find(message => message.role === 'user');
			const label = this._generateSessionLabel(sdkSession.sessionId, chatMessages as any, prompt);
			const newSession: ICopilotCLISessionItem = {
				id: sdkSession.sessionId,
				label,
				timestamp: sdkSession.startTime,
				isEmpty: noUserMessages
			};
			this._newActiveSessions.set(sdkSession.sessionId, newSession);
			this.logService.trace(`[CopilotCLIAgentManager] Created new CopilotCLI session ${sdkSession.sessionId}.`);

			sessionDisposables.add(toDisposable(() => this._newActiveSessions.delete(sdkSession.sessionId)));

			const session = await this.createCopilotSession(sdkSession, sessionManager, sessionDisposables);

			sessionDisposables.add(session.onDidChangeStatus(() => {
				// This will get swapped out as soon as the session has completed.
				if (session.status === ChatSessionStatus.Completed || session.status === ChatSessionStatus.Failed) {
					this._newActiveSessions.delete(sdkSession.sessionId);
				}
			}));
			return session;
		} catch (error) {
			sessionDisposables.dispose();
			throw error;
		}
	}

	public async getSession(sessionId: string, model: ModelProvider | undefined, readonly: boolean, token: CancellationToken): Promise<CopilotCLISession | undefined> {
		const session = this._sessionWrappers.get(sessionId);

		if (session) {
			this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${sessionId}.`);
			return session;
		}

		const sessionDisposables = this._register(new DisposableStore());
		try {
			const sessionManager = await raceCancellationError(this.getSessionManager(), token);

			const sdkSession = await sessionManager.getSession(sessionId);
			if (!sdkSession) {
				this.logService.error(`[CopilotCLIAgentManager] CopilotCLI failed to get session ${sessionId}.`);
				sessionDisposables.dispose();
				return undefined;
			}

			return this.createCopilotSession(sdkSession, sessionManager, sessionDisposables);
		} catch (error) {
			sessionDisposables.dispose();
			throw error;
		}
	}

	private async createCopilotSession(sdkSession: Session, sessionManager: SessionManager, disposables: IDisposable,): Promise<CopilotCLISession> {
		const sessionDisposables = this._register(new DisposableStore());
		sessionDisposables.add(disposables);
		try {
			sessionDisposables.add(toDisposable(() => {
				this._sessionWrappers.deleteAndLeak(sdkSession.sessionId);
				// sdkSession.abort();
				// sessionManager.closeSession(sdkSession);
			}));

			const session = this.instantiationService.createInstance(CopilotCLISession, sdkSession);
			session.add(sessionDisposables);
			session.add(session.onDidChangeStatus(() => this._onDidChangeSessions.fire()));

			this._sessionWrappers.set(sdkSession.sessionId, session);
			return session;
		} catch (error) {
			sessionDisposables.dispose();
			throw error;
		}
	}

	public async deleteSession(sessionId: string): Promise<void> {
		try {
			{
				const session = this._sessionWrappers.get(sessionId);
				if (session) {
					session.dispose();
					this.logService.warn(`Delete an active session ${sessionId}.`);
				}
			}

			// Delete from session manager first
			const sessionManager = await this.getSessionManager();
			const sdkSession = await sessionManager.getSession(sessionId);
			if (sdkSession) {
				await sessionManager.deleteSession(sdkSession);
			}

		} catch (error) {
			this.logService.error(`Failed to delete session ${sessionId}: ${error}`);
		} finally {
			this._newActiveSessions.delete(sessionId);
			this._sessionWrappers.deleteAndLeak(sessionId);
			// Possible the session was deleted in another vscode session or the like.
			this._onDidChangeSessions.fire();
		}
	}

	private _generateSessionLabel(sessionId: string, chatMessages: readonly ChatCompletionMessageParam[], prompt: string | undefined): string {
		try {
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
					const cleanContent = stripReminders(content);
					const firstLine = cleanContent.split('\n').find((l: string) => l.trim().length > 0) ?? '';
					return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
				}
			} else if (prompt && prompt.trim().length > 0) {
				return prompt.trim().length > 50 ? prompt.trim().substring(0, 47) + '...' : prompt.trim();
			}
		} catch (error) {
			this.logService.warn(`Failed to generate session label for ${sessionId}: ${error}`);
		}

		// Fallback to session ID
		return `Session ${sessionId.slice(0, 8)}`;
	}
}
