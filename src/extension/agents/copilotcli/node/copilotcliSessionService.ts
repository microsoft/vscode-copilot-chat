/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Session, SessionEvent, internal } from '@github/copilot/sdk';
import type { CancellationToken, ChatRequest } from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { RelativePattern } from '../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { disposableTimeout, raceCancellation, raceCancellationError } from '../../../../util/vs/base/common/async';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { Disposable, DisposableMap, IDisposable, IReference, RefCountedDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus } from '../../../../vscodeTypes';
import { stripReminders } from '../common/copilotCLITools';
import { CopilotCLISessionOptions, ICopilotCLISDK } from './copilotCli';
import { CopilotCLISession, ICopilotCLISession } from './copilotcliSession';
import { getCopilotLogger } from './logger';
import { ICopilotCLIMCPHandler } from './mcpHandler';

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
	getSession(sessionId: string, options: { model?: string; workingDirectory?: string; isolationEnabled?: boolean; readonly: boolean }, token: CancellationToken): Promise<IReference<ICopilotCLISession> | undefined>;
	createSession(prompt: string, options: { model?: string; workingDirectory?: string; isolationEnabled?: boolean }, token: CancellationToken): Promise<IReference<ICopilotCLISession>>;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');

const SESSION_SHUTDOWN_TIMEOUT_MS = 300 * 1000;

export class CopilotCLISessionService extends Disposable implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private _sessionManager: Lazy<Promise<internal.CLISessionManager>>;
	private _sessionWrappers = new DisposableMap<string, RefCountedSession>();
	private _newActiveSessions = new Map<string, ICopilotCLISessionItem>();


	private readonly _onDidChangeSessions = new Emitter<void>();
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly sessionTerminators = new DisposableMap<string, IDisposable>();

	private sessionMutexForGetSession = new Map<string, Mutex>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INativeEnvService private readonly nativeEnv: INativeEnvService,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@ICopilotCLIMCPHandler private readonly mcpHandler: ICopilotCLIMCPHandler,
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

	protected monitorSessionFiles() {
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
					const id = metadata.sessionId;
					const timestamp = metadata.modifiedTime;
					const label = metadata.summary ? labelFromPrompt(metadata.summary) : undefined;
					// CLI adds `<current_datetime>` tags to user prompt, this needs to be removed.
					// However in summary CLI can end up truncating the prompt and adding `... <current_dateti...` at the end.
					// So if we see a `<` in the label, we need to load the session to get the first user message.
					if (label && !label.includes('<')) {
						return {
							id,
							label,
							timestamp,
						} satisfies ICopilotCLISessionItem;
					}
					try {
						// Get the full session to access chat messages
						const session = await this.getSession(metadata.sessionId, { readonly: true }, token);
						const firstUserMessage = session?.object ? session.object.sdkSession.getEvents().find((msg: SessionEvent) => msg.type === 'user.message')?.data.content : undefined;
						session?.dispose();

						const label = labelFromPrompt(firstUserMessage ?? '');
						if (!label) {
							this.logService.warn(`Copilot CLI session ${metadata.sessionId} has no user messages.`);
							return;
						}
						return {
							id,
							label,
							timestamp,
						} satisfies ICopilotCLISessionItem;
					} catch (error) {
						this.logService.warn(`Failed to load session ${metadata.sessionId}: ${error}`);
					}
				})
			));

			// Merge with cached sessions (new sessions not yet persisted by SDK)
			const allSessions = diskSessions
				.map(session => {
					return {
						...session,
						status: this._sessionWrappers.get(session.id)?.object?.status
					} satisfies ICopilotCLISessionItem;
				});

			return allSessions;
		} catch (error) {
			this.logService.error(`Failed to get all sessions: ${error}`);
			return Array.from(this._newActiveSessions.values());
		}
	}

	public async createSession(prompt: string, { model, workingDirectory, isolationEnabled }: { model?: string; workingDirectory?: string; isolationEnabled?: boolean }, token: CancellationToken): Promise<RefCountedSession> {
		const mcpServers = await this.mcpHandler.loadMcpConfig(workingDirectory);
		const options = new CopilotCLISessionOptions({ model, workingDirectory, isolationEnabled, mcpServers }, this.logService);
		const sessionManager = await raceCancellationError(this.getSessionManager(), token);
		const sdkSession = await sessionManager.createSession(options.toSessionOptions());
		const label = labelFromPrompt(prompt);
		const newSession: ICopilotCLISessionItem = {
			id: sdkSession.sessionId,
			label,
			timestamp: sdkSession.startTime
		};
		this._newActiveSessions.set(sdkSession.sessionId, newSession);
		this.logService.trace(`[CopilotCLIAgentManager] Created new CopilotCLI session ${sdkSession.sessionId}.`);


		const session = this.createCopilotSession(sdkSession, options, sessionManager);

		session.object.add(toDisposable(() => this._newActiveSessions.delete(sdkSession.sessionId)));
		session.object.add(session.object.onDidChangeStatus(() => {
			// This will get swapped out as soon as the session has completed.
			if (session.object.status === ChatSessionStatus.Completed || session.object.status === ChatSessionStatus.Failed) {
				this._newActiveSessions.delete(sdkSession.sessionId);
			}
		}));
		return session;
	}

	public async getSession(sessionId: string, { model, workingDirectory, isolationEnabled, readonly }: { model?: string; workingDirectory?: string; isolationEnabled?: boolean; readonly: boolean }, token: CancellationToken): Promise<RefCountedSession | undefined> {
		// https://github.com/microsoft/vscode/issues/276573
		const lock = this.sessionMutexForGetSession.get(sessionId) ?? new Mutex();
		this.sessionMutexForGetSession.set(sessionId, lock);
		const lockDisposable = await lock.acquire(token);
		if (!lockDisposable || this._store.isDisposed || token.isCancellationRequested) {
			lockDisposable?.dispose();
			return;
		}

		try {
			{
				const session = this._sessionWrappers.get(sessionId);
				if (session) {
					this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${sessionId}.`);
					session.acquire();
					return session;
				}
			}

			const [sessionManager, mcpServers] = await Promise.all([
				raceCancellationError(this.getSessionManager(), token),
				this.mcpHandler.loadMcpConfig(workingDirectory)
			]);
			const options = new CopilotCLISessionOptions({ model, workingDirectory, isolationEnabled, mcpServers }, this.logService);

			const sdkSession = await sessionManager.getSession({ ...options.toSessionOptions(), sessionId }, !readonly);
			if (!sdkSession) {
				this.logService.error(`[CopilotCLIAgentManager] CopilotCLI failed to get session ${sessionId}.`);
				return undefined;
			}

			return this.createCopilotSession(sdkSession, options, sessionManager);
		} finally {
			lockDisposable.dispose();
		}
	}

	private createCopilotSession(sdkSession: Session, options: CopilotCLISessionOptions, sessionManager: internal.CLISessionManager): RefCountedSession {
		const session = this.instantiationService.createInstance(CopilotCLISession, options, sdkSession);
		session.add(session.onDidChangeStatus(() => this._onDidChangeSessions.fire()));
		session.add(toDisposable(() => {
			this._sessionWrappers.deleteAndLeak(sdkSession.sessionId);
			this.sessionMutexForGetSession.delete(sdkSession.sessionId);
			sdkSession.abort();
			void sessionManager.closeSession(sdkSession.sessionId);
		}));

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

		const refCountedSession = new RefCountedSession(session);
		this._sessionWrappers.set(sdkSession.sessionId, refCountedSession);
		return refCountedSession;
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
}

function labelFromPrompt(prompt: string): string {
	// Strip system reminders and return first line or first 50 characters, whichever is shorter
	const cleanContent = stripReminders(prompt);
	const firstLine = cleanContent.split('\n').find((l: string) => l.trim().length > 0) ?? '';
	return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
}

export class Mutex {
	private _locked = false;
	private readonly _acquireQueue: (() => void)[] = [];

	isLocked(): boolean {
		return this._locked;
	}

	// Acquire the lock; resolves with a release function you MUST call.
	acquire(token: CancellationToken): Promise<IDisposable | undefined> {
		return raceCancellation(new Promise<IDisposable | undefined>(resolve => {
			const tryAcquire = () => {
				if (token.isCancellationRequested) {
					resolve(undefined);
					return;
				}
				if (!this._locked) {
					this._locked = true;
					resolve(toDisposable(() => this._release()));
				} else {
					this._acquireQueue.push(tryAcquire);
				}
			};
			tryAcquire();
		}), token);
	}

	private _release(): void {
		if (!this._locked) {
			throw new Error('Mutex: release called while not locked');
		}
		this._locked = false;
		const next = this._acquireQueue.shift();
		if (next) {
			next();
		}
	}
}

export class RefCountedSession extends RefCountedDisposable implements IReference<CopilotCLISession> {
	constructor(public readonly object: CopilotCLISession) {
		super(object);
	}
	dispose(): void {
		this.release();
	}
}