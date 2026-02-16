/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { internal, Session, SessionEvent, SessionOptions, SweCustomAgent } from '@github/copilot/sdk';
import type { CancellationToken, ChatRequest, ChatSessionItem, Uri } from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { createDirectoryIfNotExists, IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { RelativePattern } from '../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { disposableTimeout, raceCancellation, raceCancellationError } from '../../../../util/vs/base/common/async';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { Disposable, DisposableMap, IDisposable, IReference, RefCountedDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { joinPath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus } from '../../../../vscodeTypes';
import { stripReminders } from '../common/copilotCLITools';
import { CopilotCLISessionOptions, ICopilotCLIAgents, ICopilotCLISDK } from './copilotCli';
import { CopilotCLISession, ICopilotCLISession } from './copilotcliSession';
import { ICopilotCLIMCPHandler } from './mcpHandler';

const COPILOT_CLI_WORKSPACE_JSON_FILE_KEY = 'github.copilot.cli.workspaceSessionFile';
const CUSTOM_SESSION_TITLE_MEMENTO_KEY = 'github.copilot.cli.customSessionTitles';
const SESSION_TITLE_MAX_AGE_DAYS = 7;

export interface ICopilotCLISessionItem {
	readonly id: string;
	readonly label: string;
	readonly timing: ChatSessionItem['timing'];
	readonly status?: ChatSessionStatus;
	readonly workingDirectory?: Uri;
}

export type ExtendedChatRequest = ChatRequest & { prompt: string };

export interface ICopilotCLISessionService {
	readonly _serviceBrand: undefined;

	onDidChangeSessions: Event<void>;

	getSessionWorkingDirectory(sessionId: string): Uri | undefined;

	// Session metadata querying
	getAllSessions(filter: (sessionId: string) => boolean | undefined, token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]>;

	// SDK session management
	deleteSession(sessionId: string): Promise<void>;

	// Session rename
	renameSession(sessionId: string, title: string): Promise<void>;
	getCustomSessionTitle(sessionId: string): string | undefined;

	// Session wrapper tracking
	getSession(sessionId: string, options: { model?: string; workingDirectory?: Uri; isolationEnabled?: boolean; readonly: boolean; agent?: SweCustomAgent }, token: CancellationToken): Promise<IReference<ICopilotCLISession> | undefined>;
	createSession(options: { model?: string; workingDirectory?: Uri; isolationEnabled?: boolean; agent?: SweCustomAgent }, token: CancellationToken): Promise<IReference<ICopilotCLISession>>;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');

const SESSION_SHUTDOWN_TIMEOUT_MS = 300 * 1000;

class NoopTelemetryService {
	constructor(protected authManager?: unknown) { }
	sendTelemetryEvent(eventName: string, properties?: unknown, measurements?: unknown, tags?: unknown) {
		//
	}
	sendHydroEvent(event: unknown) {
		//
	}
	dispose() {
		//
	}
}

type TelemetryService = ConstructorParameters<typeof internal.LocalSessionManager>[0]['telemetryService'];

export class CopilotCLISessionService extends Disposable implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private _sessionManager: Lazy<Promise<internal.LocalSessionManager>>;
	private _sessionWrappers = new DisposableMap<string, RefCountedSession>();


	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly sessionTerminators = new DisposableMap<string, IDisposable>();

	private sessionMutexForGetSession = new Map<string, Mutex>();

	private readonly _sessionTracker: CopilotCLISessionWorkspaceTracker;
	private readonly _sessionWorkingDirectories = new Map<string, Uri | undefined>();
	constructor(
		@ILogService protected readonly logService: ILogService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@INativeEnvService private readonly nativeEnv: INativeEnvService,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@ICopilotCLIMCPHandler private readonly mcpHandler: ICopilotCLIMCPHandler,
		@ICopilotCLIAgents private readonly agents: ICopilotCLIAgents,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
	) {
		super();
		this.monitorSessionFiles();
		this._sessionManager = new Lazy<Promise<internal.LocalSessionManager>>(async () => {
			const { internal } = await this.copilotCLISDK.getPackage();
			const telemetryService = new NoopTelemetryService() as unknown as TelemetryService;
			return new internal.LocalSessionManager({ telemetryService, flushDebounceMs: undefined, settings: undefined, version: undefined });
		});
		this._sessionTracker = this.instantiationService.createInstance(CopilotCLISessionWorkspaceTracker);
	}

	getSessionWorkingDirectory(sessionId: string): Uri | undefined {
		return this._sessionWorkingDirectories.get(sessionId);
	}

	protected monitorSessionFiles() {
		try {
			const sessionDir = joinPath(this.nativeEnv.userHome, '.copilot', 'session-state');
			const watcher = this._register(this.fileSystem.createFileSystemWatcher(new RelativePattern(sessionDir, '**/*.jsonl')));
			this._register(watcher.onDidCreate(() => this._onDidChangeSessions.fire()));
			this._register(watcher.onDidChange(() => this._onDidChangeSessions.fire()));
			this._register(watcher.onDidDelete(() => this._onDidChangeSessions.fire()));
		} catch (error) {
			this.logService.error(`Failed to monitor Copilot CLI session files: ${error}`);
		}
	}
	async getSessionManager() {
		return this._sessionManager.value;
	}

	private _getAllSessionsProgress: Promise<readonly ICopilotCLISessionItem[]> | undefined;
	async getAllSessions(filter: (sessionId: string) => boolean | undefined, token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]> {
		if (!this._getAllSessionsProgress) {
			this._getAllSessionsProgress = this._getAllSessions(filter, token);
		}
		return this._getAllSessionsProgress.finally(() => {
			this._getAllSessionsProgress = undefined;
		});
	}

	private _sessionLabels: Map<string, string> = new Map();

	async _getAllSessions(filter: (sessionId: string) => boolean | undefined, token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]> {
		try {
			const sessionManager = await raceCancellationError(this.getSessionManager(), token);
			const sessionMetadataList = await raceCancellationError(sessionManager.listSessions(), token);

			await this._sessionTracker.initialize();
			// Convert SessionMetadata to ICopilotCLISession
			const diskSessions: ICopilotCLISessionItem[] = coalesce(await Promise.all(
				sessionMetadataList.map(async (metadata): Promise<ICopilotCLISessionItem | undefined> => {
					let showSession: boolean = false;
					const workingDirectory = metadata.context?.cwd ? URI.file(metadata.context.cwd) : undefined;
					this._sessionWorkingDirectories.set(metadata.sessionId, workingDirectory);
					if (this.workspaceService.getWorkspaceFolders().length === 0) {
						// If we're in empty workspace then show all sessions.
						showSession = true;
					} else {
						const sessionFilterResult = filter(metadata.sessionId);
						const sessionTrackerVisibility = this._sessionTracker.shouldShowSession(metadata.sessionId);
						// This session was started from a specified workspace (e.g. multiroot, untitled or other), hence continue showing it.
						if (sessionTrackerVisibility.isWorkspaceSession) {
							showSession = true;
						}
						if (!showSession && sessionFilterResult === true) {
							showSession = true;
						}
						// If this is an old global session, then show it as well.
						if (!showSession && sessionTrackerVisibility.isOldGlobalSession) {
							// But if not required to be displayed, do not show it.
							if (typeof sessionFilterResult === 'undefined') {
								showSession = true;
							}
						}
						// Possible we have the workspace info in cli metadata.
						if (!showSession && metadata.context && (
							(metadata.context.cwd && this.workspaceService.getWorkspaceFolder(URI.file(metadata.context.cwd))) ||
							(metadata.context.gitRoot && this.workspaceService.getWorkspaceFolder(URI.file(metadata.context.gitRoot)))
						)) {
							showSession = true;
						}
					}
					if (!showSession) {
						return;
					}
					const id = metadata.sessionId;
					const startTime = metadata.startTime.getTime();
					const endTime = metadata.modifiedTime.getTime();
					const label = this.getCustomSessionTitle(metadata.sessionId) ?? this._sessionLabels.get(metadata.sessionId) ?? (metadata.summary ? labelFromPrompt(metadata.summary) : undefined);
					// CLI adds `<current_datetime>` tags to user prompt, this needs to be removed.
					// However in summary CLI can end up truncating the prompt and adding `... <current_dateti...` at the end.
					// So if we see a `<` in the label, we need to load the session to get the first user message.
					if (label && !label.includes('<')) {
						return {
							id,
							label,
							timing: { created: startTime, startTime, endTime },
							workingDirectory
						};
					}
					try {
						// Get the full session to access chat messages
						const session = await this.getSession(metadata.sessionId, { readonly: true }, token);
						const firstUserMessage = session?.object ? session.object.sdkSession.getEvents().find((msg: SessionEvent) => msg.type === 'user.message')?.data.content : undefined;
						session?.dispose();

						const label = labelFromPrompt(firstUserMessage ?? '');
						if (!label) {
							return;
						}
						this._sessionLabels.set(metadata.sessionId, label);
						return {
							id,
							label,
							timing: { created: startTime, startTime, endTime },
							workingDirectory
						};
					} catch (error) {
						this.logService.warn(`Failed to load session ${metadata.sessionId}: ${error}`);
					}
				})
			));

			const diskSessionIds = new Set(diskSessions.map(s => s.id));
			// If we have a new session that has started, then return that as well.
			// Possible SDK has not yet persisted it to disk.
			const newSessions = coalesce(Array.from(this._sessionWrappers.values())
				.filter(session => !diskSessionIds.has(session.object.sessionId))
				.filter(session => session.object.status === ChatSessionStatus.InProgress)
				.map((session): ICopilotCLISessionItem | undefined => {
					const label = labelFromPrompt(session.object.pendingPrompt ?? '');
					if (!label) {
						return;
					}

					const createTime = Date.now();
					return {
						id: session.object.sessionId,
						label,
						status: session.object.status,
						timing: { created: createTime, startTime: createTime },
					};
				}));

			// Merge with cached sessions (new sessions not yet persisted by SDK)
			const allSessions = diskSessions
				.map((session): ICopilotCLISessionItem => {
					return {
						...session,
						status: this._sessionWrappers.get(session.id)?.object?.status
					};
				}).concat(newSessions);

			return allSessions;
		} catch (error) {
			this.logService.error(`Failed to get all sessions: ${error}`);
			throw error;
		}
	}

	public async createSession({ model, workingDirectory, isolationEnabled, agent }: { model?: string; workingDirectory?: Uri; isolationEnabled?: boolean; agent?: SweCustomAgent }, token: CancellationToken): Promise<RefCountedSession> {
		const mcpServers = await this.mcpHandler.loadMcpConfig();
		const options = await this.createSessionsOptions({ model, workingDirectory, isolationEnabled, mcpServers, agent });
		const sessionManager = await raceCancellationError(this.getSessionManager(), token);
		const sdkSession = await sessionManager.createSession(options.toSessionOptions());
		this.logService.trace(`[CopilotCLISession] Created new CopilotCLI session ${sdkSession.sessionId}.`);
		void this._sessionTracker.trackSession(sdkSession.sessionId, 'add');

		return this.createCopilotSession(sdkSession, options, sessionManager);
	}

	protected async createSessionsOptions(options: { model?: string; isolationEnabled?: boolean; workingDirectory?: Uri; mcpServers?: SessionOptions['mcpServers']; agent: SweCustomAgent | undefined }): Promise<CopilotCLISessionOptions> {
		const customAgents = await this.agents.getAgents();
		return new CopilotCLISessionOptions({ ...options, customAgents }, this.logService);
	}

	public async getSession(sessionId: string, { model, workingDirectory, isolationEnabled, readonly, agent }: { model?: string; workingDirectory?: Uri; isolationEnabled?: boolean; readonly: boolean; agent?: SweCustomAgent }, token: CancellationToken): Promise<RefCountedSession | undefined> {
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
					this.logService.trace(`[CopilotCLISession] Reusing CopilotCLI session ${sessionId}.`);
					session.acquire();
					if (!readonly) {
						if (agent) {
							await session.object.sdkSession.selectCustomAgent(agent.name);
						} else {
							session.object.sdkSession.clearCustomAgent();
						}
					}
					return session;
				}
			}

			const [sessionManager, mcpServers] = await Promise.all([
				raceCancellationError(this.getSessionManager(), token),
				this.mcpHandler.loadMcpConfig(),
			]);
			const options = await this.createSessionsOptions({ model, workingDirectory, agent, isolationEnabled, mcpServers });

			const sdkSession = await sessionManager.getSession({ ...options.toSessionOptions(), sessionId }, !readonly);
			if (!sdkSession) {
				this.logService.error(`[CopilotCLISession] CopilotCLI failed to get session ${sessionId}.`);
				return undefined;
			}

			return this.createCopilotSession(sdkSession, options, sessionManager);
		} finally {
			lockDisposable.dispose();
		}
	}

	private createCopilotSession(sdkSession: Session, options: CopilotCLISessionOptions, sessionManager: internal.LocalSessionManager): RefCountedSession {
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
		void this._sessionTracker.trackSession(sessionId, 'delete');
		this._sessionLabels.delete(sessionId);
		void this._removeCustomSessionTitle(sessionId);
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
			this._sessionWrappers.deleteAndLeak(sessionId);
			// Possible the session was deleted in another vscode session or the like.
			this._onDidChangeSessions.fire();
		}
	}

	private _getCustomSessionTitles(): { [sessionId: string]: { title: string; updatedAt: number } | undefined } {
		return this.context.globalState.get<{ [sessionId: string]: { title: string; updatedAt: number } | undefined }>(CUSTOM_SESSION_TITLE_MEMENTO_KEY, {});
	}

	private _pruneStaleEntries(entries: { [sessionId: string]: { title: string; updatedAt: number } | undefined }): Record<string, { title: string; updatedAt: number }> {
		const maxAgeMs = SESSION_TITLE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const pruned: Record<string, { title: string; updatedAt: number }> = {};
		for (const [id, entry] of Object.entries(entries)) {
			if (entry && now - entry.updatedAt < maxAgeMs) {
				pruned[id] = entry;
			}
		}
		return pruned;
	}

	public getCustomSessionTitle(sessionId: string): string | undefined {
		const entries = this._getCustomSessionTitles();
		const entry = entries[sessionId];
		if (!entry) {
			return undefined;
		}
		const maxAgeMs = SESSION_TITLE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
		if (Date.now() - entry.updatedAt >= maxAgeMs) {
			return undefined;
		}
		return entry.title;
	}

	public async renameSession(sessionId: string, title: string): Promise<void> {
		const entries = this._pruneStaleEntries(this._getCustomSessionTitles());
		entries[sessionId] = { title, updatedAt: Date.now() };
		await this.context.globalState.update(CUSTOM_SESSION_TITLE_MEMENTO_KEY, entries);
		this._sessionLabels.set(sessionId, title);
		this._onDidChangeSessions.fire();
	}

	private async _removeCustomSessionTitle(sessionId: string): Promise<void> {
		const entries = this._pruneStaleEntries(this._getCustomSessionTitles());
		if (sessionId in entries) {
			delete entries[sessionId];
			await this.context.globalState.update(CUSTOM_SESSION_TITLE_MEMENTO_KEY, entries);
		}
	}
}

export class CopilotCLISessionWorkspaceTracker {
	private readonly _initializeSessionStorageFiles: Lazy<Promise<{ global: Uri; workspace: Uri }>>;
	private _oldGlobalSessions?: Set<string>;
	private readonly _workspaceSessions = new Set<string>();
	constructor(
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		this._initializeSessionStorageFiles = new Lazy<Promise<{ global: Uri; workspace: Uri }>>(async () => {
			const globalFile = joinPath(this.context.globalStorageUri, 'copilot.cli.oldGlobalSessions.json');
			let workspaceFile = joinPath(this.context.globalStorageUri, 'copilot.cli.workspaceSessions.json');
			// If we have workspace folders, track workspace sessions separately. Otherwise treat them as global sessions.
			if (this.workspaceService.getWorkspaceFolders().length) {
				let workspaceFileName = this.context.workspaceState.get<string | undefined>(COPILOT_CLI_WORKSPACE_JSON_FILE_KEY);
				if (!workspaceFileName) {
					workspaceFileName = `copilot.cli.workspaceSessions.${generateUuid()}.json`;
					await this.context.workspaceState.update(COPILOT_CLI_WORKSPACE_JSON_FILE_KEY, workspaceFileName);
				}
				workspaceFile = joinPath(this.context.globalStorageUri, workspaceFileName);
			}

			await Promise.all([
				createDirectoryIfNotExists(this.fileSystem, this.context.globalStorageUri),
				// Load old sessions
				(async () => {
					const oldSessions = await this.fileSystem.readFile(globalFile).then(c => new TextDecoder().decode(c).split(',')).catch(() => undefined);
					if (oldSessions) {
						this._oldGlobalSessions = new Set<string>(oldSessions);
					}
				})(),
				// Load workspace sessions
				(async () => {
					const workspaceSessions = this.workspaceService.getWorkspaceFolders().length ?
						await this.fileSystem.readFile(workspaceFile).then(c => new TextDecoder().decode(c).split(',')).catch(() => []) : [];
					workspaceSessions.forEach(s => this._workspaceSessions.add(s));
				})(),
			]);

			return { global: globalFile, workspace: workspaceFile };
		});
		void this._initializeSessionStorageFiles.value;
	}

	public async initialize(): Promise<void> {
		await this._initializeSessionStorageFiles.value;
	}

	public async trackSession(sessionId: string, operation: 'add' | 'delete'): Promise<void> {
		// If we're not in a workspace, do not track sessions as these are global sessions.
		if (this.workspaceService.getWorkspaceFolders().length === 0) {
			return;
		}
		if (operation === 'add') {
			this._workspaceSessions.add(sessionId);
		} else {
			this._workspaceSessions.delete(sessionId);
		}

		const sessions = Array.from(this._workspaceSessions).join(',');
		const { workspace } = await this._initializeSessionStorageFiles.value;
		// No need to block caller anymore, we've tracked in memory for now.
		void this.fileSystem.writeFile(workspace, Buffer.from(sessions));
	}

	/**
	 * InitializeOldSessions should have been called before this.
	 */
	public shouldShowSession(sessionId: string): { isOldGlobalSession?: boolean; isWorkspaceSession?: boolean } {
		return {
			isOldGlobalSession: this._oldGlobalSessions?.has(sessionId),
			isWorkspaceSession: this._workspaceSessions.has(sessionId),
		};
	}
}

function labelFromPrompt(prompt: string): string {
	// Strip system reminders from the prompt
	return stripReminders(prompt);
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
			// already unlocked
			return;
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
