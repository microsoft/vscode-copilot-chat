/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMetadata, Session, internal } from '@github/copilot/sdk';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { CancellationToken, ChatRequest } from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { RelativePattern } from '../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { disposableTimeout, raceCancellationError } from '../../../../util/vs/base/common/async';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus } from '../../../../vscodeTypes';
import { CopilotCLISessionOptions, ICopilotCLISDK, ICopilotCLISessionOptionsService } from './copilotCli';
import { CopilotCLISession, ICopilotCLISession } from './copilotcliSession';
import { stripReminders } from './copilotcliToolInvocationFormatter';
import { getCopilotLogger } from './logger';

export interface ICopilotCLISessionItem {
	readonly id: string;
	readonly label: string;
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
	getSession(sessionId: string, model: string | undefined, workingDirectory: string | undefined, readonly: boolean, token: CancellationToken): Promise<ICopilotCLISession | undefined>;
	createSession(prompt: string, model: string | undefined, workingDirectory: string | undefined, token: CancellationToken): Promise<ICopilotCLISession>;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');

const SESSION_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

export class CopilotCLISessionService extends Disposable implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private _sessionManager: Lazy<Promise<internal.CLISessionManager>>;
	private _sessionWrappers = new DisposableMap<string, CopilotCLISession>();
	private _newActiveSessions = new Map<string, ICopilotCLISessionItem>();


	private readonly _onDidChangeSessions = new Emitter<void>();
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly sessionTerminators = new DisposableMap<string, IDisposable>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICopilotCLISessionOptionsService private readonly optionsService: ICopilotCLISessionOptionsService,
		@INativeEnvService private readonly nativeEnv: INativeEnvService,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
	) {
		super();
		this.monitorSessionFiles();
		this._sessionManager = new Lazy<Promise<internal.CLISessionManager>>(async () => {
			const { internal } = await this.copilotCLISDK.getPackage();
			return new internal.CLISessionManager({
				logger: getCopilotLogger(this.logService)
			});
		});
	}

	private monitorSessionFiles() {
		try {
			const sessionDir = joinPath(this.nativeEnv.userHome, '.copilot', 'session-state');
			const watcher = this._register(this.fileSystem.createFileSystemWatcher(new RelativePattern(sessionDir, '*.jsonl')));
			this._register(watcher.onDidCreate(() => this._onDidChangeSessions.fire()));
		} catch (error) {
			this.logService.error(`Failed to monitor Copilot CLI session files: ${error}`);
		}
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
					const timestamp = metadata.startTime;
					const id = metadata.sessionId;
					const label = metadata.summary ? labelFromPrompt(metadata.summary) : undefined;
					if (label) {
						return {
							id,
							label,
							timestamp,
						} satisfies ICopilotCLISessionItem;
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
						const chatMessages = await raceCancellationError(session.getChatContextMessages(), token);
						const noUserMessages = !chatMessages.find(message => message.role === 'user');
						if (noUserMessages) {
							return undefined;
						}
						const label = this._generateSessionLabel(session.sessionId, chatMessages, undefined);
						return {
							id,
							label,
							timestamp,
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
		const sessionManager = await raceCancellationError(this.getSessionManager(), token);
		const session = await sessionManager.getSession({ sessionId }, false);
		if (!session) {
			return undefined;
		}
		return { session, dispose: () => Promise.resolve() };
	}

	public async createSession(prompt: string, model: string | undefined, workingDirectory: string | undefined, token: CancellationToken): Promise<CopilotCLISession> {
		const sessionDisposables = this._register(new DisposableStore());
		try {
			const options = await raceCancellationError(this.optionsService.createOptions({
				model: model as unknown as ModelMetadata['model'],
				workingDirectory
			}), token);
			const sessionManager = await raceCancellationError(this.getSessionManager(), token);
			const sdkSession = await sessionManager.createSession(options.toSessionOptions());
			const chatMessages = await sdkSession.getChatContextMessages();
			const label = this._generateSessionLabel(sdkSession.sessionId, chatMessages, prompt);
			const newSession: ICopilotCLISessionItem = {
				id: sdkSession.sessionId,
				label,
				timestamp: sdkSession.startTime
			};
			this._newActiveSessions.set(sdkSession.sessionId, newSession);
			this.logService.trace(`[CopilotCLIAgentManager] Created new CopilotCLI session ${sdkSession.sessionId}.`);

			sessionDisposables.add(toDisposable(() => this._newActiveSessions.delete(sdkSession.sessionId)));

			const session = await this.createCopilotSession(sdkSession, options, sessionManager, sessionDisposables);

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

	public async getSession(sessionId: string, model: string | undefined, workingDirectory: string | undefined, readonly: boolean, token: CancellationToken): Promise<CopilotCLISession | undefined> {
		const session = this._sessionWrappers.get(sessionId);

		if (session) {
			this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${sessionId}.`);
			return session;
		}

		const sessionDisposables = this._register(new DisposableStore());
		try {
			const sessionManager = await raceCancellationError(this.getSessionManager(), token);
			const options = await raceCancellationError(this.optionsService.createOptions({
				model: model as unknown as ModelMetadata['model'],
				workingDirectory
			}), token);

			const sdkSession = await sessionManager.getSession({ ...options.toSessionOptions(), sessionId }, !readonly);
			if (!sdkSession) {
				this.logService.error(`[CopilotCLIAgentManager] CopilotCLI failed to get session ${sessionId}.`);
				sessionDisposables.dispose();
				return undefined;
			}

			return this.createCopilotSession(sdkSession, options, sessionManager, sessionDisposables);
		} catch (error) {
			sessionDisposables.dispose();
			throw error;
		}
	}

	private async createCopilotSession(sdkSession: Session, options: CopilotCLISessionOptions, sessionManager: internal.CLISessionManager, disposables: IDisposable,): Promise<CopilotCLISession> {
		const sessionDisposables = this._register(new DisposableStore());
		sessionDisposables.add(disposables);
		try {
			sessionDisposables.add(toDisposable(() => {
				this._sessionWrappers.deleteAndLeak(sdkSession.sessionId);
				sdkSession.abort();
				void sessionManager.closeSession(sdkSession.sessionId);
			}));

			const session = this.instantiationService.createInstance(CopilotCLISession, options, sdkSession);
			session.add(sessionDisposables);
			session.add(session.onDidChangeStatus(() => this._onDidChangeSessions.fire()));

			// We have no way of tracking Chat Editor life cycle.
			// Hence when we're done with a request, lets dispose the chat session (say 60s after).
			// If in the mean time we get another request, we'll clear the timeout.
			// When vscode shuts the sessions will be disposed anyway.
			// This code is to avoid leaving these sessions alive forever in memory.
			session.add(session.onDidChangeStatus(e => {
				// If we're waiting for a permission, then do not start the timeout.
				if (session.permissionRequested) {
					this.sessionTerminators.deleteAndDispose(session.sessionId);
				} else if (session.status === undefined || session.status === ChatSessionStatus.Completed || session.status === ChatSessionStatus.Failed) {
					// We're done with this session, start timeout to dispose it
					this.sessionTerminators.set(session.sessionId, disposableTimeout(() => {
						session.dispose();
						this.sessionTerminators.deleteAndDispose(session.sessionId);
					}, SESSION_SHUTDOWN_TIMEOUT_MS));
				} else {
					// Session is busy.
					this.sessionTerminators.deleteAndDispose(session.sessionId);
				}
			}));

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
			await sessionManager.deleteSession(sessionId);

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
					return labelFromPrompt(content);
				}
			} else if (prompt && prompt.trim().length > 0) {
				return labelFromPrompt(prompt);

			}
		} catch (error) {
			this.logService.warn(`Failed to generate session label for ${sessionId}: ${error}`);
		}

		// Fallback to session ID
		return `Session ${sessionId.slice(0, 8)}`;
	}
}

function labelFromPrompt(prompt: string): string {
	// Strip system reminders and return first line or first 50 characters, whichever is shorter
	const cleanContent = stripReminders(prompt);
	const firstLine = cleanContent.split('\n').find((l: string) => l.trim().length > 0) ?? '';
	return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
}