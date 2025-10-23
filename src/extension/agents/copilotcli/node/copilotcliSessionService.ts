/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { CancellationToken, ChatSessionStatus } from 'vscode';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { raceCancellation } from '../../../../util/vs/base/common/async';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Disposable, DisposableMap, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotCLIPermissionsHandler, CopilotCLISessionOptionsService } from './copilotCli';
import { CopilotCLISession } from './copilotcliSession';
import { stripReminders } from './copilotcliToolInvocationFormatter';
import { getCopilotLogger } from './logger';
import { ensureNodePtyShim } from './nodePtyShim';
import type { internal, ModelProvider, Session, SessionEvent, SessionManagerOptions } from '@github/copilot/sdk';

export interface ICopilotCLISession {
	readonly id: string;
	readonly label: string;
	readonly isEmpty: boolean;
	readonly timestamp: Date;
}

export interface ICopilotCLISessionService {
	readonly _serviceBrand: undefined;

	onDidChangeSessions: Event<void>;

	// Session metadata querying
	getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]>;

	// SDK session management
	getSessionManager(options: SessionManagerOptions): Promise<internal.CLISessionManager>;
	// getOrCreateSDKSession(sessionId: string | undefined, prompt: string): Promise<Session>;
	getOrCreateSession(sessionId: string | undefined, prompt: string, modelId: ModelProvider | undefined): Promise<CopilotCLISession>;
	deleteSession(sessionId: string): Promise<boolean>;
	setSessionStatus(sessionId: string, status: ChatSessionStatus): void;
	getSessionStatus(sessionId: string): ChatSessionStatus | undefined;

	// Pending request tracking (for untitled sessions)
	setPendingRequest(sessionId: string): void;
	isPendingRequest(sessionId: string): boolean;
	clearPendingRequest(sessionId: string): void;
	emitUserAndAssistantMessage(sessionId: string, userMessage: string, assistantMessage: string, token: CancellationToken): Promise<void>;
	getEvents(sessionId: string, token: CancellationToken): Promise<SessionEvent[]>;
	// getNewSessionId(prompt: string): Promise<string>;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');

export class CopilotCLISessionService extends Disposable implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	_sessionManager: internal.CLISessionManager | undefined;
	private _sessionWrappers = new DisposableMap<string, CopilotCLISession>();
	private _sessions = new Map<string, ICopilotCLISession>();
	private _pendingRequests = new Set<string>();


	private readonly _onDidChangeSessions = new Emitter<void>();
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;
	private readonly _sessionStatuses = new Map<string, ChatSessionStatus>();
	private readonly _optionsService: CopilotCLISessionOptionsService;
	constructor(
		@ILogService private readonly logService: ILogService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IEnvService private readonly envService: IEnvService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._optionsService = instantiationService.createInstance(CopilotCLISessionOptionsService);
	}

	public async getSessionManager(options: SessionManagerOptions = {}): Promise<internal.CLISessionManager> {
		try {
			// Ensure node-pty shim exists before importing SDK
			await ensureNodePtyShim(this.extensionContext.extensionPath, this.envService.appRoot, this.logService);

			const { internal } = await import('@github/copilot/sdk');
			return new internal.CLISessionManager({
				...options,
				logger: getCopilotLogger(this.logService)
			});
		} catch (error) {
			this.logService.error(`Failed to initialize SessionManager: ${error}`);
			throw error;
		}
	}

	async emitUserAndAssistantMessage(sessionId: string, userMessage: string, assistantMessage: string, token: CancellationToken) {
		const session = this._sessionWrappers.get(sessionId)?.session ?? await this.getSession(sessionId, true, token);
		if (session) {
			session.emit('user.message', { content: userMessage });
			session.emit('assistant.message', {
				messageId: `msg_${Date.now()}`,
				content: assistantMessage
			});
		}
	}
	async getEvents(sessionId: string, token: CancellationToken): Promise<SessionEvent[]> {
		const session = this._sessionWrappers.get(sessionId)?.session ?? await this.getSession(sessionId, false, token);
		if (session) {
			// TODO @DonJayamanne We need a way to verify the types here.
			return session.getEvents() as SessionEvent[];
		} else {
			return [];
		}
	}

	private _getAllSessionsProgress: Promise<readonly ICopilotCLISession[]> | undefined;
	async getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]> {
		if (!this._getAllSessionsProgress) {
			this._getAllSessionsProgress = this._getAllSessions(token);
		}
		return this._getAllSessionsProgress.finally(() => {
			this._getAllSessionsProgress = undefined;
		});
	}
	async _getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISession[]> {
		try {
			const sessionManager = await raceCancellation(this.getSessionManager(), token);
			const sessionMetadataList = sessionManager ? await raceCancellation(sessionManager.listSessions(), token) : undefined;
			if (!sessionMetadataList || !sessionManager || token.isCancellationRequested) {
				return [];
			}

			// Convert SessionMetadata to ICopilotCLISession
			const diskSessions: ICopilotCLISession[] = coalesce(await Promise.all(
				sessionMetadataList.map(async (metadata) => {
					try {
						// Get the full session to access chat messages
						const session = await sessionManager.getSession(metadata.sessionId, false);
						if (!session) {
							this.logService.warn(`Copilot CLI session not found, ${metadata.sessionId}`);
							return;
						}
						const chatMessages = await session.getChatMessages();
						const noUserMessages = !chatMessages.find(message => message.role === 'user');
						const label = await this._generateSessionLabel(session.sessionId, chatMessages as any, undefined);

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

						const info = {
							id: metadata.sessionId,
							label,
							timestamp,
							isEmpty: noUserMessages
						};
						return info;
					} catch (error) {
						this.logService.warn(`Failed to load session ${metadata.sessionId}: ${error}`);
					}
				})
			));

			// Merge with cached sessions (new sessions not yet persisted by SDK)
			const diskSessionIds = new Set(diskSessions.map(s => s.id));
			const cachedSessions = coalesce(Array.from(this._sessions.values()).filter(s => s && !diskSessionIds.has(s.id)));
			const allSessions = diskSessions.concat(cachedSessions);

			return allSessions;
		} catch (error) {
			this.logService.error(`Failed to get all sessions: ${error}`);
			return coalesce(Array.from(this._sessions.values()));
		}
	}

	async getSession(sessionId: string, resume: boolean, token: CancellationToken): Promise<Session | undefined> {
		const sessionManager = await raceCancellation(this.getSessionManager(), token);
		const sdkSession = await sessionManager?.getSession(sessionId, resume);
		return sdkSession;
	}

	public async getOrCreateSession(sessionId: string | undefined, prompt: string, model?: ModelProvider): Promise<CopilotCLISession> {
		if (sessionId) {
			const session = this._sessionWrappers.get(sessionId);
			if (session) {
				this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${sessionId}.`);
				return session;
			}
		}

		const modelProvider = model ?? {
			type: 'anthropic',
			model: 'claude-sonnet-4.5',
		};
		const permissionHandler = this._register(new CopilotCLIPermissionsHandler());
		const options = await this._optionsService.createOptions({ modelProvider: modelProvider }, permissionHandler);

		const sessionManager = await this.getSessionManager(options);
		let sdkSession: Session | undefined;
		if (sessionId) {
			try {
				sdkSession = await sessionManager.getSession(sessionId, true);
			} catch (error) {
				// Fall through to create new session
				this.logService.error(`[CopilotCLIAgentManager] CopilotCLI failed to get session ${sessionId}.`);
			}
		}

		if (sdkSession) {
			this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${sessionId}.`);
		} else {
			sdkSession = await sessionManager.createSession(model ? { selectedModel: model.model } : undefined);
			// Cache the new session immediately
			const chatMessages = await sdkSession.getChatMessages();
			const noUserMessages = !chatMessages.find(message => message.role === 'user');
			const label = await this._generateSessionLabel(sdkSession.sessionId, chatMessages as any, prompt);
			const newSession: ICopilotCLISession = {
				id: sdkSession.sessionId,
				label,
				timestamp: sdkSession.startTime,
				isEmpty: noUserMessages
			};
			this._sessions.set(sdkSession.sessionId, newSession);
		}
		const disposable = toDisposable(() => {
			// TODO @DonJayamanne Should we be aborting the ongoing requests here?
			// If user closes the chat session I think we should
			// TODO @DonJayamanne We need to dispose this object when the corresponding chat session is closed
			options.abortController?.abort();
			permissionHandler.dispose();
		});

		const session = this.instantiationService.createInstance(CopilotCLISession, permissionHandler, sdkSession);
		session.add(disposable);

		this._sessionWrappers.set(sdkSession.sessionId, session);

		return session;
	}


	public setSessionStatus(sessionId: string, status: ChatSessionStatus): void {
		this._sessionStatuses.set(sessionId, status);
		this._onDidChangeSessions.fire();
	}

	public getSessionStatus(sessionId: string): ChatSessionStatus | undefined {
		return this._sessionStatuses.get(sessionId);
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
			this._onDidChangeSessions.fire();

			return true;
		} catch (error) {
			this.logService.error(`Failed to delete session ${sessionId}: ${error}`);
			return false;
		}
	}

	private async _generateSessionLabel(sessionId: string, chatMessages: readonly ChatCompletionMessageParam[], prompt: string | undefined): Promise<string> {
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

	public setPendingRequest(sessionId: string): void {
		this._pendingRequests.add(sessionId);
	}

	public isPendingRequest(sessionId: string): boolean {
		return this._pendingRequests.has(sessionId);
	}

	public clearPendingRequest(sessionId: string): void {
		this._pendingRequests.delete(sessionId);
	}
}
