/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { internal, LocalSessionMetadata, Session, SessionContext, SessionEvent, SessionOptions, SweCustomAgent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { devNull, EOL } from 'node:os';
import { createInterface } from 'node:readline';
import type { ChatRequest, ChatSessionItem } from 'vscode';
import { IChatDebugFileLoggerService } from '../../../../platform/chat/common/chatDebugFileLoggerService';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { createDirectoryIfNotExists, IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { RelativePattern } from '../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { deriveCopilotCliOTelEnv } from '../../../../platform/otel/common/agentOTelEnv';
import { IOTelService } from '../../../../platform/otel/common/otelService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { disposableTimeout, raceCancellation, raceCancellationError, raceTimeout, SequencerByKey, ThrottledDelayer } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { Disposable, DisposableMap, DisposableStore, IDisposable, IReference, RefCountedDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { basename, dirname, isEqual, joinPath } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn2, ChatResponseTurn2, ChatSessionStatus, Uri } from '../../../../vscodeTypes';
import { IPromptVariablesService } from '../../../prompt/node/promptVariablesService';
import { IAgentSessionsWorkspace } from '../../common/agentSessionsWorkspace';
import { IChatSessionMetadataStore } from '../../common/chatSessionMetadataStore';
import { IChatSessionWorkspaceFolderService } from '../../common/chatSessionWorkspaceFolderService';
import { IChatSessionWorktreeService } from '../../common/chatSessionWorktreeService';
import { isUntitledSessionId } from '../../common/utils';
import { emptyWorkspaceInfo, getWorkingDirectory, IWorkspaceInfo } from '../../common/workspaceInfo';
import { buildChatHistoryFromEvents, stripReminders } from '../common/copilotCLITools';
import { ICustomSessionTitleService } from '../common/customSessionTitleService';
import { IChatDelegationSummaryService } from '../common/delegationSummaryService';
import { getCopilotCLISessionDir, getCopilotCLISessionEventsFile, getCopilotCLIWorkspaceFile } from './cliHelpers';
import { CopilotCLISessionOptions, ICopilotCLIAgents, ICopilotCLISDK } from './copilotCli';
import { CopilotCliBridgeSpanProcessor } from './copilotCliBridgeSpanProcessor';
import { CopilotCLISession, ICopilotCLISession } from './copilotcliSession';
import { ICopilotCLISkills } from './copilotCLISkills';
import { ICopilotCLIMCPHandler, McpServerMappings } from './mcpHandler';

const COPILOT_CLI_WORKSPACE_JSON_FILE_KEY = 'github.copilot.cli.workspaceSessionFile';

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
	onDidDeleteSession: Event<string>;
	onDidChangeSession: Event<ICopilotCLISessionItem>;
	onDidCreateSession: Event<ICopilotCLISessionItem>;

	getSessionWorkingDirectory(sessionId: string): Uri | undefined;

	// Session metadata querying
	getSessionItem(sessionId: string, token: CancellationToken): Promise<ICopilotCLISessionItem | undefined>;
	getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]>;

	// SDK session management
	createNewSessionId(): string;
	isNewSessionId(sessionId: string): boolean;
	deleteSession(sessionId: string): Promise<void>;

	// Session rename
	renameSession(sessionId: string, title: string): Promise<void>;

	// Session wrapper tracking
	getSession(options: { sessionId: string; model?: string; workspaceInfo: IWorkspaceInfo; readonly: boolean; agent?: SweCustomAgent; debugTargetSessionIds?: readonly string[]; mcpServerMappings?: McpServerMappings }, token: CancellationToken): Promise<IReference<ICopilotCLISession> | undefined>;
	createSession(options: { model?: string; workspaceInfo: IWorkspaceInfo; agent?: SweCustomAgent; sessionId?: string; debugTargetSessionIds?: readonly string[]; mcpServerMappings?: McpServerMappings }, token: CancellationToken): Promise<IReference<ICopilotCLISession>>;
	forkSession(sessionId: string, requestId: string | undefined, options: { workspaceInfo: IWorkspaceInfo }, token: CancellationToken): Promise<string>;
	tryGetPartialSesionHistory(sessionId: string): Promise<readonly (ChatRequestTurn2 | ChatResponseTurn2)[] | undefined>;
}

export const ICopilotCLISessionService = createServiceIdentifier<ICopilotCLISessionService>('ICopilotCLISessionService');

const SESSION_SHUTDOWN_TIMEOUT_MS = 300 * 1000;

export class CopilotCLISessionService extends Disposable implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private _sessionManager: Lazy<Promise<internal.LocalSessionManager>>;
	private _sessionWrappers = new DisposableMap<string, RefCountedSession>();
	private readonly _partialSessionHistories = new Map<string, readonly (ChatRequestTurn2 | ChatResponseTurn2)[]>();


	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _onDidDeleteSession = this._register(new Emitter<string>());
	public readonly onDidDeleteSession = this._onDidDeleteSession.event;

	private readonly _onDidChangeSession = this._register(new Emitter<ICopilotCLISessionItem>());
	public readonly onDidChangeSession = this._onDidChangeSession.event;
	private readonly _onDidCreateSession = this._register(new Emitter<ICopilotCLISessionItem>());
	public readonly onDidCreateSession = this._onDidCreateSession.event;

	private readonly _onDidCloseSession = this._register(new Emitter<string>());
	private readonly sessionTerminators = new DisposableMap<string, IDisposable>();

	private sessionMutexForGetSession = new Map<string, Mutex>();

	private readonly _sessionTracker: CopilotCLISessionWorkspaceTracker;
	private readonly _sessionWorkingDirectories = new Map<string, Uri | undefined>();
	private readonly _onDidChangeSessionsThrottler = this._register(new ThrottledDelayer<void>(500));
	private readonly _cachedSessionItems = new Map<string, ICopilotCLISessionItem>();
	private readonly _sessionsBeingCreatedViaFork = new Set<string>();
	private readonly _newSessionIds = new Set<string>();
	/** Bridge processor that forwards SDK native OTel spans to the debug panel. */
	private _bridgeProcessor: CopilotCliBridgeSpanProcessor | undefined;
	/** Whether we've attempted to install the bridge (only try once). */
	private _bridgeInstalled = false;
	constructor(
		@ILogService protected readonly logService: ILogService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@INativeEnvService private readonly nativeEnv: INativeEnvService,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@ICopilotCLIMCPHandler private readonly mcpHandler: ICopilotCLIMCPHandler,
		@ICopilotCLIAgents private readonly agents: ICopilotCLIAgents,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ICustomSessionTitleService private readonly customSessionTitleService: ICustomSessionTitleService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICopilotCLISkills private readonly copilotCLISkills: ICopilotCLISkills,
		@IChatDelegationSummaryService private readonly _delegationSummaryService: IChatDelegationSummaryService,
		@IChatSessionMetadataStore private readonly _chatSessionMetadataStore: IChatSessionMetadataStore,
		@IAgentSessionsWorkspace private readonly _agentSessionsWorkspace: IAgentSessionsWorkspace,
		@IChatSessionWorkspaceFolderService private readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
		@IChatSessionWorktreeService private readonly worktreeManager: IChatSessionWorktreeService,
		@IOTelService private readonly _otelService: IOTelService,
		@IPromptVariablesService private readonly _promptVariablesService: IPromptVariablesService,
		@IChatDebugFileLoggerService private readonly _debugFileLogger: IChatDebugFileLoggerService,
	) {
		super();
		this.monitorSessionFiles();
		this._sessionManager = new Lazy<Promise<internal.LocalSessionManager>>(async () => {
			try {
				const { internal } = await this.getSDKPackage();
				// Always enable SDK OTel so the debug panel receives native spans via the bridge.
				// When user OTel is disabled, we force file exporter to /dev/null so the SDK
				// creates OtelSessionTracker (for debug panel) but doesn't export to any collector.
				if (!process.env['COPILOT_OTEL_ENABLED']) {
					process.env['COPILOT_OTEL_ENABLED'] = 'true';
				}
				// Default content capture to 'true' for the debug panel. When user OTel
				// is enabled, their captureContent setting overrides this default below.
				// When user OTel is disabled, the default gives debug panel content.
				// If the user explicitly set the env var, respect their choice.
				if (!process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']) {
					process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = 'true';
				}
				if (this._otelService.config.enabled) {
					const otelEnv = deriveCopilotCliOTelEnv(this._otelService.config);
					for (const [key, value] of Object.entries(otelEnv)) {
						process.env[key] = value;
					}
					// When user OTel is enabled, their captureContent config takes
					// precedence over the debug-panel default set above.
					process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = String(this._otelService.config.captureContent);
				} else {
					// User OTel disabled: ensure SDK doesn't export to any external collector.
					// Use file exporter to /dev/null so the SDK creates OtelSessionTracker
					// (for debug panel) but writes spans nowhere.
					process.env['COPILOT_OTEL_EXPORTER_TYPE'] = 'file';
					process.env['COPILOT_OTEL_FILE_EXPORTER_PATH'] = devNull;
				}
				return new internal.LocalSessionManager({ telemetryService: new internal.NoopTelemetryService(), flushDebounceMs: undefined, settings: undefined, version: undefined });
			}
			catch (error) {
				this.logService.error(`Failed to initialize Copilot CLI Session Manager: ${error}`);
				throw error;
			}
		});
		this._sessionTracker = this.instantiationService.createInstance(CopilotCLISessionWorkspaceTracker);
	}

	private async getSDKPackage() {
		const { internal, LocalSession } = await this.copilotCLISDK.getPackage();
		return { internal, LocalSession };
	}

	getSessionWorkingDirectory(sessionId: string): Uri | undefined {
		return this._sessionWorkingDirectories.get(sessionId);
	}

	private triggerSessionsChangeEvent() {
		// If we're busy fetching sessions, then do not trigger change event as we'll trigger one after we're done fetching sessions.
		if (this._isGettingSessions > 0) {
			return;
		}

		this._onDidChangeSessionsThrottler.trigger(() => Promise.resolve(this._onDidChangeSessions.fire()));
	}

	public createNewSessionId(): string {
		const sessionId = generateUuid();
		this._newSessionIds.add(sessionId);
		return sessionId;
	}

	public isNewSessionId(sessionId: string): boolean {
		return this._newSessionIds.has(sessionId);
	}

	protected monitorSessionFiles() {
		try {
			const sessionDir = joinPath(this.nativeEnv.userHome, '.copilot', 'session-state');
			const watcher = this._register(this.fileSystem.createFileSystemWatcher(new RelativePattern(sessionDir, '**/*.jsonl')));
			this._register(watcher.onDidCreate(async (e) => {
				const sessionId = extractSessionIdFromEventPath(sessionDir, e);
				if (sessionId && this._sessionsBeingCreatedViaFork.has(sessionId)) {
					return;
				}
				this.triggerSessionsChangeEvent();
				const sessionItem = sessionId ? await this.getSessionItemImpl(sessionId, 'disk', CancellationToken.None) : undefined;
				if (sessionItem) {
					this._onDidChangeSession.fire(sessionItem);
				}
			}));
			this._register(watcher.onDidDelete(e => {
				const sessionId = extractSessionIdFromEventPath(sessionDir, e);
				if (sessionId) {
					this._cachedSessionItems.delete(sessionId);
					this._onDidDeleteSession.fire(sessionId);
				}
				this.triggerSessionsChangeEvent();
			}));
			this._register(watcher.onDidChange((e) => {
				// If we're busy fetching sessions, then do not trigger change event as we'll trigger one after we're done fetching sessions.
				if (this._isGettingSessions > 0) {
					return;
				}

				const sessionId = extractSessionIdFromEventPath(sessionDir, e);
				if (sessionId && this._sessionsBeingCreatedViaFork.has(sessionId)) {
					return;
				}

				// If we're already working on a session that we're aware of then no need to trigger a refresh.
				if (Array.from(this._sessionWrappers.keys()).some(sessionId => e.path.includes(sessionId))) {
					return;
				}
				if (sessionId) {
					this.triggerOnDidChangeSessionItem(sessionId, 'fileSystemChange');
				}
				this.triggerSessionsChangeEvent();
			}));
		} catch (error) {
			this.logService.error(`Failed to monitor Copilot CLI session files: ${error}`);
		}
	}
	async getSessionManager() {
		return this._sessionManager.value;
	}

	private _sessionChangeNotifierByKey = new SequencerByKey<string>();
	private triggerOnDidChangeSessionItem(sessionId: string, reason: 'fileSystemChange' | 'statusChange') {
		this._sessionChangeNotifierByKey.queue(sessionId, async () => {
			// lets wait for 500ms, as we could get a lot of change events in a short period of time.
			// E.g. if you have a session running in integrated terminal, then its possible we will see a lot of updates.
			// In such cases its best to just delay (throttle) by 500ms (we get that via the sequncer and this delay)
			if (reason === 'fileSystemChange') {
				await new Promise<void>(resolve => disposableTimeout(resolve, 500, this._store));
				// If already getting all sessions, no point in triggering individual change event.
				if (this._isGettingSessions > 0) {
					return;
				}
			}

			const sessionItem = await this.getSessionItemImpl(sessionId, reason === 'statusChange' ? 'inMemorySession' : 'disk', CancellationToken.None);
			if (sessionItem) {
				this._onDidChangeSession.fire(sessionItem);
			}
		}).catch(error => {
			this.logService.error(`Failed to trigger session change event for session ${sessionId}: ${error}`);
		});
	}

	/**
	 * This can be very expensive, as this involves loading all of the sessions.
	 * TODO @DonJayamanne We need to try to use SDK to open a session and get the details.
	 */
	public async getSessionItem(sessionId: string, token: CancellationToken): Promise<ICopilotCLISessionItem | undefined> {
		return this.getSessionItemImpl(sessionId, 'inMemorySession', token);
	}

	public async getSessionItemImpl(sessionId: string, source: 'inMemorySession' | 'disk', token: CancellationToken): Promise<ICopilotCLISessionItem | undefined> {
		const wrappedSession = this._sessionWrappers.get(sessionId);
		// Give preference to the session we have in memory, as this contains the latest information.
		if (wrappedSession && (source === 'inMemorySession' || wrappedSession.object.status === ChatSessionStatus.InProgress)) {
			const item = await this.constructSessionItemFromWrappedSession(wrappedSession, token);
			if (item) {
				return item;
			}
		}

		// // We can get the item from cache, as the ICopilotCLISessionItem doesn't store anything that changes.
		// // Except the title
		// let item = this._cachedSessionItems.get(sessionId);
		// if (item) {
		// 	// Since this was a change event for an existing session, we must get the latest title.
		// 	const label = await this.getSessionTitle(sessionId, CancellationToken.None);
		// 	const sessionItem = Object.assign({}, item, { label });
		// 	return sessionItem;
		// }

		const sessionManager = await raceCancellationError(this.getSessionManager(), token);
		const sessionMetadataList = await raceCancellationError(sessionManager.listSessions(), token);
		await this._sessionTracker.initialize();
		const metadata = sessionMetadataList.find(s => s.sessionId === sessionId);
		if (!metadata) {
			return;
		}
		return await this.constructSessionItem(metadata, token);
	}

	public async getSessionTitle(sessionId: string, token: CancellationToken): Promise<string> {
		return this.getSessionTitleImpl(sessionId, undefined, token);
	}

	/**
	 * Gets the session title.
	 * Always give preference to label defined by user, then title from CLI session object.
	 * If we have the metadata then use that over extracting label ourselves or using any cache.
	 */
	private async getSessionTitleImpl(sessionId: string, metadata: LocalSessionMetadata | undefined, token: CancellationToken): Promise<string> {
		// Always give preference to label defined by user, then title from CLI and finally label from prompt summary. This is to ensure that if user has renamed the session, we do not override that with title from CLI or label from prompt.
		const accurateTitle = await this.customSessionTitleService.getCustomSessionTitle(sessionId) ??
			labelFromPrompt(this._sessionWrappers.get(sessionId)?.object.pendingPrompt ?? '') ??
			this._sessionWrappers.get(sessionId)?.object.title;

		if (accurateTitle) {
			return accurateTitle;
		}

		const summarizedTitle = labelFromPrompt(metadata?.summary ?? '');
		if (summarizedTitle) {
			if (summarizedTitle.endsWith('...')) {
				// If the SDK is going to just give us a truncated version of the first user message as the summary, then we might as well extract the label ourselves from the first user message instead of using the truncated summary.
			} else {
				return summarizedTitle;
			}
		}

		const firstUserMessage = await this.getFirstUserMessageFromSession(sessionId, token);
		return labelFromPrompt(firstUserMessage ?? '');
	}


	private _getAllSessionsProgress: Promise<readonly ICopilotCLISessionItem[]> | undefined;
	private _isGettingSessions: number = 0;
	async getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]> {
		if (!this._getAllSessionsProgress) {
			this._getAllSessionsProgress = this._getAllSessions(token);
		}
		return this._getAllSessionsProgress.finally(() => {
			this._getAllSessionsProgress = undefined;
		});
	}

	private _sessionLabels: Map<string, string> = new Map();

	async _getAllSessions(token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]> {
		this._isGettingSessions++;
		try {
			const sessionManager = await raceCancellationError(this.getSessionManager(), token);
			const sessionMetadataList = await raceCancellationError(sessionManager.listSessions(), token);

			await this._sessionTracker.initialize();

			// Convert SessionMetadata to ICopilotCLISession
			const diskSessions: ICopilotCLISessionItem[] = coalesce(await Promise.all(
				sessionMetadataList.map(async (metadata): Promise<ICopilotCLISessionItem | undefined> => {
					const workingDirectory = metadata.context?.cwd ? URI.file(metadata.context.cwd) : undefined;
					this._sessionWorkingDirectories.set(metadata.sessionId, workingDirectory);
					if (!await this.shouldShowSession(metadata.sessionId, metadata.context)) {
						return;
					}
					const id = metadata.sessionId;
					const startTime = metadata.startTime.getTime();
					const endTime = metadata.modifiedTime.getTime();
					const label = await this.customSessionTitleService.getCustomSessionTitle(metadata.sessionId) ?? this._sessionWrappers.get(metadata.sessionId)?.object.title ?? this._sessionLabels.get(metadata.sessionId) ?? (metadata.summary ? labelFromPrompt(metadata.summary) : undefined);
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
						const firstUserMessage = await this.getFirstUserMessageFromSession(metadata.sessionId, token);
						const label = labelFromPrompt(firstUserMessage ?? metadata.summary ?? '');
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
			const newSessions = coalesce(await Promise.all(Array.from(this._sessionWrappers.values())
				.filter(session => !diskSessionIds.has(session.object.sessionId))
				.filter(session => session.object.status === ChatSessionStatus.InProgress)
				.map(async (session): Promise<ICopilotCLISessionItem | undefined> => {
					const label = await this.customSessionTitleService.getCustomSessionTitle(session.object.sessionId) ?? labelFromPrompt(session.object.pendingPrompt ?? '');
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
				})));

			// Merge with cached sessions (new sessions not yet persisted by SDK)
			const allSessions = diskSessions
				.map((session): ICopilotCLISessionItem => {
					return {
						...session,
						status: this._sessionWrappers.get(session.id)?.object?.status
					};
				}).concat(newSessions);

			allSessions.forEach(session => this._cachedSessionItems.set(session.id, session));
			return allSessions;
		} catch (error) {
			this.logService.error(`Failed to get all sessions: ${error}`);
			throw error;
		} finally {
			this._isGettingSessions--;
		}
	}

	private async constructSessionItem(metadata: LocalSessionMetadata, token: CancellationToken): Promise<ICopilotCLISessionItem | undefined> {
		const sessionItem = await this.constructSessionItemImpl(metadata, token);
		if (sessionItem) {
			this._cachedSessionItems.set(metadata.sessionId, sessionItem);
		}
		return sessionItem;
	}

	private async constructSessionItemFromWrappedSession(session: RefCountedSession, token: CancellationToken): Promise<ICopilotCLISessionItem | undefined> {
		const label = (await this.getSessionTitle(session.object.sessionId, token)) || this._cachedSessionItems.get(session.object.sessionId)?.label || labelFromPrompt(session.object.pendingPrompt ?? '');
		const createTime = Date.now();
		return {
			id: session.object.sessionId,
			label,
			status: session.object.status,
			timing: this._cachedSessionItems.get(session.object.sessionId)?.timing ?? { created: createTime, startTime: createTime },
		};
	}

	private async constructSessionItemImpl(metadata: LocalSessionMetadata, token: CancellationToken): Promise<ICopilotCLISessionItem | undefined> {
		const workingDirectory = metadata.context?.cwd ? URI.file(metadata.context.cwd) : undefined;
		this._sessionWorkingDirectories.set(metadata.sessionId, workingDirectory);
		const shouldShowSession = await this.shouldShowSession(metadata.sessionId, metadata.context);
		if (!shouldShowSession) {
			return undefined;
		}

		const id = metadata.sessionId;
		const startTime = metadata.startTime.getTime();
		const endTime = metadata.modifiedTime.getTime();
		const label = await this.getSessionTitleImpl(metadata.sessionId, metadata, token) ?? labelFromPrompt(metadata.summary ?? '');

		if (label) {
			return {
				id,
				label,
				timing: { created: startTime, startTime, endTime },
				workingDirectory,
				status: this._sessionWrappers.get(id)?.object?.status
			};
		}
	}

	public async createSession({ model, workspaceInfo, agent, sessionId, debugTargetSessionIds, mcpServerMappings }: { model?: string; workspaceInfo: IWorkspaceInfo; agent?: SweCustomAgent; sessionId?: string; debugTargetSessionIds?: readonly string[]; mcpServerMappings?: McpServerMappings }, token: CancellationToken): Promise<RefCountedSession> {
		const { mcpConfig: mcpServers, disposable: mcpGateway } = await this.mcpHandler.loadMcpConfig();
		try {
			const copilotUrl = this.configurationService.getConfig(ConfigKey.Shared.DebugOverrideProxyUrl) || undefined;
			const options = await this.createSessionsOptions({ model, workspaceInfo, mcpServers, agent, copilotUrl, sessionId, debugTargetSessionIds });
			const sessionManager = await raceCancellationError(this.getSessionManager(), token);
			const sdkSession = await sessionManager.createSession({ ...options.toSessionOptions(mcpServerMappings), sessionId });
			this._newSessionIds.delete(sdkSession.sessionId);
			// After the first session creation, the SDK's OTel TracerProvider is
			// initialized. Install the bridge processor so SDK-native spans flow
			// to the debug panel.
			this._installBridgeIfNeeded();

			if (copilotUrl) {
				sdkSession.setAuthInfo({
					type: 'hmac',
					hmac: 'empty',
					host: 'https://github.com',
					copilotUser: {
						endpoints: {
							api: copilotUrl
						}
					}
				});
			}
			this.logService.trace(`[CopilotCLISession] Created new CopilotCLI session ${sdkSession.sessionId}.`);
			void this._sessionTracker.trackSession(sdkSession.sessionId, 'add');

			const session = await this.createCopilotSession(sdkSession, options, sessionManager);
			session.object.add(mcpGateway);
			return session;
		}
		catch (error) {
			mcpGateway.dispose();
			throw error;
		}
	}

	/** Get the bridge processor for registering traceId → sessionId mappings. */
	get bridgeProcessor(): CopilotCliBridgeSpanProcessor | undefined {
		return this._bridgeProcessor;
	}

	/**
	 * Install the bridge SpanProcessor on the SDK's global TracerProvider.
	 * Called once after the first session creation (when the SDK provider is ready).
	 */
	private _installBridgeIfNeeded(): void {
		if (this._bridgeInstalled) {
			return;
		}
		this._bridgeInstalled = true;

		try {
			// The SDK registered its BasicTracerProvider as the global provider.
			// In OTel SDK v2, addSpanProcessor() was removed from BasicTracerProvider.
			// We access the internal MultiSpanProcessor._spanProcessors array to inject
			// our bridge. This is the same pattern the SDK itself uses in forceFlush().
			const api = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
			const globalProvider = api.trace.getTracerProvider();

			// Navigate: ProxyTracerProvider._delegate → BasicTracerProvider._activeSpanProcessor → MultiSpanProcessor._spanProcessors
			const delegate = (globalProvider as unknown as Record<string, unknown>)._delegate ?? globalProvider;
			const activeProcessor = (delegate as unknown as Record<string, unknown>)._activeSpanProcessor as Record<string, unknown> | undefined;
			const processorArray = activeProcessor?._spanProcessors;

			if (Array.isArray(processorArray)) {
				this._bridgeProcessor = new CopilotCliBridgeSpanProcessor(this._otelService);
				processorArray.push(this._bridgeProcessor);
				this.logService.info('[CopilotCLISession] Bridge SpanProcessor installed on SDK TracerProvider');
			} else {
				this.logService.warn('[CopilotCLISession] Could not access SDK TracerProvider internals — debug panel will not show SDK spans');
			}
		} catch (err) {
			this.logService.warn(`[CopilotCLISession] Failed to install bridge SpanProcessor: ${err}`);
		}
	}

	private async shouldShowSession(sessionId: string, context?: SessionContext): Promise<boolean> {
		if (isUntitledSessionId(sessionId)) {
			return true;
		}
		// If we're in an empty workspace then show all sessions.
		if (this.workspaceService.getWorkspaceFolders().length === 0) {
			return true;
		}
		if (this._agentSessionsWorkspace.isAgentSessionsWorkspace) {
			return true;
		}
		// This session was started from a specified workspace (e.g. multiroot, untitled or other), hence continue showing it.
		const sessionTrackerVisibility = this._sessionTracker.shouldShowSession(sessionId);
		if (sessionTrackerVisibility.isWorkspaceSession) {
			return true;
		}
		// Possible we have the workspace info in cli metadata.
		if (context && (
			(context.cwd && this.workspaceService.getWorkspaceFolder(URI.file(context.cwd))) ||
			(context.gitRoot && this.workspaceService.getWorkspaceFolder(URI.file(context.gitRoot)))
		)) {
			return true;
		}
		// If we have a workspace folder for this and the workspace folder belongs to one of the open workspace folders, show it.
		const workspaceFolder = await this.workspaceFolderService.getSessionWorkspaceFolder(sessionId);
		if (workspaceFolder && this.workspaceService.getWorkspaceFolder(workspaceFolder)) {
			return true;
		}
		// If we have a git worktree and the worktree's repo belongs to one of the workspace folders, show it.
		const worktree = await this.worktreeManager.getWorktreeProperties(sessionId);
		if (worktree && this.workspaceService.getWorkspaceFolder(URI.file(worktree.repositoryPath))) {
			return true;
		}
		// If this is an old global session, show it if we don't have specific data to exclude it.
		if (sessionTrackerVisibility.isOldGlobalSession && !workspaceFolder && !worktree && (this.workspaceService.getWorkspaceFolders().length === 0 || this._agentSessionsWorkspace.isAgentSessionsWorkspace)) {
			return true;
		}
		return false;
	}

	protected async createSessionsOptions(options: { model?: string; workspaceInfo: IWorkspaceInfo; mcpServers?: SessionOptions['mcpServers']; agent: SweCustomAgent | undefined; copilotUrl?: string; sessionId?: string; debugTargetSessionIds?: readonly string[] }, readonly?: boolean): Promise<CopilotCLISessionOptions> {
		const [customAgents, skillLocations] = await Promise.all([
			this.agents.getAgents(),
			readonly ? Promise.resolve([]) : this.copilotCLISkills.getSkillsLocations(),
		]);
		const variablesContext = this._promptVariablesService.buildTemplateVariablesContext(options.sessionId, options.debugTargetSessionIds);
		const systemMessage = variablesContext ? { mode: 'append' as const, content: variablesContext } : undefined;
		return new CopilotCLISessionOptions({ ...options, customAgents, skillLocations, systemMessage }, this.logService);
	}

	public async getSession({ sessionId, model, workspaceInfo, readonly, agent, debugTargetSessionIds, mcpServerMappings }: { sessionId: string; model?: string; workspaceInfo: IWorkspaceInfo; readonly: boolean; agent?: SweCustomAgent; debugTargetSessionIds?: readonly string[]; mcpServerMappings?: McpServerMappings }, token: CancellationToken): Promise<RefCountedSession | undefined> {
		// https://github.com/microsoft/vscode/issues/276573
		const lock = this.sessionMutexForGetSession.get(sessionId) ?? new Mutex();
		this.sessionMutexForGetSession.set(sessionId, lock);
		const lockDisposable = await lock.acquire(token);
		try {
			{
				const session = this._sessionWrappers.get(sessionId);
				if (session) {
					this.logService.trace(`[CopilotCLISession] Reusing CopilotCLI session ${sessionId}.`);
					this._partialSessionHistories.delete(sessionId);
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

			const [sessionManager, { mcpConfig: mcpServers, disposable: mcpGateway }] = await Promise.all([
				raceCancellationError(this.getSessionManager(), token),
				this.mcpHandler.loadMcpConfig(),
			]);
			try {
				const copilotUrl = this.configurationService.getConfig(ConfigKey.Shared.DebugOverrideProxyUrl) || undefined;
				const options = await this.createSessionsOptions({ model, agent, workspaceInfo, mcpServers, copilotUrl, sessionId, debugTargetSessionIds }, readonly);

				const sdkSession = await sessionManager.getSession({ ...options.toSessionOptions(mcpServerMappings), sessionId }, !readonly);
				if (!sdkSession) {
					this.logService.error(`[CopilotCLISession] CopilotCLI failed to get session ${sessionId}.`);
					return undefined;
				}

				const session = await this.createCopilotSession(sdkSession, options, sessionManager, readonly);
				session.object.add(mcpGateway);
				return session;
			}
			catch (error) {
				mcpGateway.dispose();
				throw error;
			}
		} finally {
			lockDisposable?.dispose();
		}
	}

	/**
	 * Fork an existing session by creating a new session id and copying the underlying
	 * Copilot CLI session workspace and metadata.
	 *
	 * High-level algorithm:
	 * 1. Copy the existing session folder (and related files) into a new folder for the new session id.
	 * 2. Update any session metadata so it references the new session id instead of the original.
	 * 3. Open the new session and truncate it to the last event id to ensure the event log is consistent.
	 * 4. Close and reopen the new session (via `getSession`) so in-memory state reflects the updated data.
	 *
	 * Returns the id of the forked session.
	 */
	public async forkSession(sessionId: string, requestId: string | undefined, { workspaceInfo }: { workspaceInfo: IWorkspaceInfo }, token: CancellationToken): Promise<string> {
		const newSessionId = generateUuid();
		this._sessionsBeingCreatedViaFork.add(newSessionId);
		const disposables = new DisposableStore();
		try {
			const [sessionManager, title,] = await Promise.all([
				raceCancellationError(this.getSessionManager(), token),
				this.getSessionTitle(sessionId, token),
				copySessionFilesForForking(sessionId, newSessionId, workspaceInfo, this._chatSessionMetadataStore, token),
			]);

			const copilotUrl = this.configurationService.getConfig(ConfigKey.Shared.DebugOverrideProxyUrl) || undefined;
			const options = await this.createSessionsOptions({ workspaceInfo, mcpServers: undefined, copilotUrl, agent: undefined, sessionId: newSessionId }, false);

			const sdkSession = await sessionManager.getSession({ ...options.toSessionOptions(), sessionId: newSessionId }, false);
			if (!sdkSession) {
				this.logService.error(`[CopilotCLISession] CopilotCLI failed to open forked session ${newSessionId}.`);
				throw new Error(`Failed to fork session ${sessionId}`);
			}

			const forkedTitlePrefix = l10n.t("Forked: ");
			const customTitle = title.startsWith(forkedTitlePrefix) ? title : l10n.t("Forked: {0}", title);
			const customTitlePromise = this.customSessionTitleService.setCustomSessionTitle(newSessionId, customTitle);
			let events: ReturnType<typeof sdkSession.getEvents> = [];
			// Only if we have a request to truncate should we open and trucate.
			if (requestId) {
				const session = this.createCopilotSession(sdkSession, options, sessionManager, false, true);
				disposables.add(session);
				const history = await session.object.getChatHistory();
				const requestToTruncateTo = history.find(event => event instanceof ChatRequestTurn2 && event.id === requestId);
				if (requestToTruncateTo) {
					const requestId = requestToTruncateTo.id;
					const storedDetails = await this._chatSessionMetadataStore.getRequestDetails(newSessionId);
					const translatedSDKEvent = storedDetails.find(d => d.vscodeRequestId === requestId || d.copilotRequestId === requestId)?.copilotRequestId;
					const sdkEvent = session.object.sdkSession.getEvents().find(e => e.type === 'user.message' && e.id === requestId)?.id;
					const eventToTruncateTo = translatedSDKEvent ?? sdkEvent;
					if (eventToTruncateTo) {
						await sdkSession.truncateToEvent(eventToTruncateTo);
						events = sdkSession.getEvents();
					} else {
						this.logService.warn(`[CopilotCLISession] Cannot find event id to truncate to for request id ${requestId} in session ${newSessionId}`);
					}

				} else {
					this.logService.warn(`[CopilotCLISession] Failed to find event id ${requestId} in session ${newSessionId} while forking. Will not truncate the session.`);
				}

				// Wait for the session to get closed.
				// This means its been saved properly by the SDK.
				const sessionDisposed = new Promise<void>(resolve => {
					const disposable = this._register(this._onDidCloseSession.event(e => {
						if (e === newSessionId) {
							disposable.dispose();
							resolve();
						}
					}));
				});

				session.dispose();
				await raceTimeout(sessionDisposed, 1_000);
				if (events.length) {
					const eventsFile = Uri.file(getCopilotCLISessionEventsFile(newSessionId));
					// File must end with EOL
					const contents = Buffer.from(events.map(e => JSON.stringify(e)).join(EOL) + EOL);
					await this.fileSystem.writeFile(eventsFile, contents);
				}
			} else {
				await sessionManager.closeSession(newSessionId);
			}

			await customTitlePromise;

			this._onDidChangeSessions.fire();
			this._onDidCreateSession.fire({
				id: newSessionId,
				label: customTitle,
				timing: { created: Date.now(), startTime: Date.now() },
				workingDirectory: getWorkingDirectory(workspaceInfo)
			});
			return newSessionId;
		}
		finally {
			disposables.dispose();
			this._sessionsBeingCreatedViaFork.delete(newSessionId);
		}
	}

	public async tryGetPartialSesionHistory(sessionId: string): Promise<readonly (ChatRequestTurn2 | ChatResponseTurn2)[] | undefined> {
		const cached = this._partialSessionHistories.get(sessionId);
		if (cached) {
			return cached;
		}

		try {
			const events = await readSessionEventsFile(sessionId);

			const sessionStartEvent = events.find((event): event is Extract<SessionEvent, { type: 'session.start' }> => event.type === 'session.start');
			const workingDirectory = sessionStartEvent?.data.context?.cwd;
			if (workingDirectory) {
				this._sessionWorkingDirectories.set(sessionId, URI.file(workingDirectory));
			}

			const history = buildChatHistoryFromEvents(sessionId, undefined, events, () => undefined, this._delegationSummaryService, this.logService, workingDirectory ? URI.file(workingDirectory) : undefined);
			this._partialSessionHistories.set(sessionId, history);
			return history;
		} catch (error) {
			this.logService.warn(`[CopilotCLISession] Failed to reconstruct partial session ${sessionId}: ${error}`);
			return undefined;
		}
	}

	private async getFirstUserMessageFromSession(sessionId: string, token: CancellationToken): Promise<string | undefined> {
		const cached = await this._chatSessionMetadataStore.getSessionFirstUserMessage(sessionId);
		if (typeof cached === 'string') {
			return cached;
		}

		let firstUserMessage: string | undefined;
		try {
			const events = await raceCancellation(readSessionEventsFile(sessionId, 'user.message'), token);
			if (events?.length) {
				// Find the first user message and use that as the title.
				firstUserMessage = events.find((msg: SessionEvent) => msg.type === 'user.message')?.data.content;
			}
		} catch (error) {
			this.logService.warn(`[CopilotCLISession] Failed to get session title for session ${sessionId}: ${error}`);
		}

		if (!firstUserMessage) {
			try {
				const session = await this.getSession({ sessionId, readonly: true, workspaceInfo: emptyWorkspaceInfo() }, token);
				firstUserMessage = session?.object ? session.object.sdkSession.getEvents().find((msg: SessionEvent) => msg.type === 'user.message')?.data.content : undefined;
				session?.dispose();
			} catch (error) {
				this.logService.warn(`[CopilotCLISession] Failed to load session for first user message ${sessionId}: ${error}`);
			}
		}

		this._chatSessionMetadataStore.setSessionFirstUserMessage(sessionId, firstUserMessage ?? '').catch(err => {
			this.logService.warn(`[CopilotCLISession] Failed to store first user message for session ${sessionId}: ${err}`);
		});

		return firstUserMessage;
	}

	private createCopilotSession(sdkSession: Session, options: CopilotCLISessionOptions, sessionManager: internal.LocalSessionManager, readonly = false, nowait = false): RefCountedSession {
		const session = this.instantiationService.createInstance(CopilotCLISession, options, sdkSession);
		this._debugFileLogger.startSession(session.sessionId).catch(err => {
			this.logService.error('[CopilotCLISession] Failed to start debug log session', err);
		});
		session.add(toDisposable(() => {
			this._debugFileLogger.endSession(session.sessionId).catch(err => {
				this.logService.error('[CopilotCLISession] Failed to end debug log session', err);
			});
		}));
		// Wire the bridge processor so the session can register traceId → sessionId mappings
		session.setBridgeProcessor(this._bridgeProcessor);
		// Wire SDK trace context updater so the session can propagate traceparent to SDK spans
		const otelLifecycle = sessionManager.otel;
		if (otelLifecycle) {
			session.setSdkTraceContextUpdater((traceparent, tracestate) =>
				otelLifecycle.updateParentTraceContext(sdkSession.sessionId, traceparent, tracestate));
		}
		session.add(session.onDidChangeStatus(() => {
			this.triggerOnDidChangeSessionItem(sdkSession.sessionId, 'statusChange');
			this._onDidChangeSessions.fire();
		}));
		session.add(toDisposable(() => {
			this._sessionWrappers.deleteAndLeak(sdkSession.sessionId);
			this.sessionMutexForGetSession.delete(sdkSession.sessionId);
			(async () => {
				// If this session was created as readonly, then no need to abort,
				// As we wouldn't have made any changes.
				if (!readonly && sdkSession.isAbortable()) {
					await sdkSession.abort().catch(error => {
						this.logService.error(`Failed to abort session ${sdkSession.sessionId}: ${error}`);
					});
				}
				await sessionManager.closeSession(sdkSession.sessionId).catch(error => {
					this.logService.error(`Failed to close session ${sdkSession.sessionId}: ${error}`);
				});
				this._onDidCloseSession.fire(sdkSession.sessionId);
			})();
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
		this._partialSessionHistories.delete(sessionId);
		this._sessionWorkingDirectories.delete(sessionId);
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

	public async renameSession(sessionId: string, title: string): Promise<void> {
		await this.customSessionTitleService.setCustomSessionTitle(sessionId, title);
		this._sessionLabels.set(sessionId, title);
		this._onDidChangeSessions.fire();
	}
}

async function readSessionEventsFile(sessionId: string, findFirstEventType?: string): Promise<SessionEvent[]> {
	const sessionDirPath = getCopilotCLISessionDir(sessionId);
	const sessionDir = URI.file(sessionDirPath);
	const eventsFile = joinPath(sessionDir, 'events.jsonl');

	const events: SessionEvent[] = [];
	const stream = createReadStream(eventsFile.fsPath, { encoding: 'utf8' });
	const reader = createInterface({
		input: stream,
		crlfDelay: Infinity,
	});
	try {
		for await (const line of reader) {
			if (line.trim().length === 0) {
				continue;
			}
			const sessionEvent = JSON.parse(line) as SessionEvent;
			events.push(sessionEvent);
			if (findFirstEventType && sessionEvent.type === findFirstEventType) {
				break;
			}
		}
	} finally {
		reader.close();
		stream.close();
	}

	return events;
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

/**
 * Extracts the session ID from a deleted events.jsonl file path.
 * Expected path format: <sessionDir>/<sessionId>/events.jsonl
 */
function extractSessionIdFromEventPath(sessionDir: URI, deletedFileUri: URI): string | undefined {
	if (basename(deletedFileUri) !== 'events.jsonl') {
		return undefined;
	}
	const parentDir = dirname(deletedFileUri);
	const parentOfParent = dirname(parentDir);
	if (parentOfParent.path !== sessionDir.path) {
		return undefined;
	}
	return basename(parentDir);
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

async function copySessionFilesForForking(sessionId: string, targetSessionId: string, workspaceInfo: IWorkspaceInfo, _chatSessionMetadataStore: IChatSessionMetadataStore, token: CancellationToken): Promise<void> {
	const sourceDir = getCopilotCLISessionDir(sessionId);
	const targetDir = getCopilotCLISessionDir(targetSessionId);
	const filesNotToCopy = [URI.file(getCopilotCLISessionEventsFile(sessionId)), URI.file(getCopilotCLIWorkspaceFile(sessionId)), _chatSessionMetadataStore.getMetadataFileUri(sessionId)];
	try {
		await fs.mkdir(targetDir, { recursive: true });
		await raceCancellationError(Promise.all([
			copySessionEventFileForForking(sessionId, targetSessionId),
			copySessionWorkspaceYmlFileForForking(sessionId, targetSessionId),
			fs.cp(sourceDir, targetDir, {
				recursive: true,
				dereference: false,
				force: true,
				preserveTimestamps: false,
				filter(source, destination) {
					if (filesNotToCopy.some(file => file.fsPath === source)) {
						return false;
					}
					// Lock files created by CLI, since this is a whole new session, nothing is locked.
					if (source.toLowerCase().endsWith('.lock')) {
						return false;
					}
					const sourceUri = URI.file(source);
					if (filesNotToCopy.some(file => isEqual(file, sourceUri))) {
						return false;
					}
					return true;
				},
			}),
			(async () => {
				if (workspaceInfo.worktreeProperties) {
					await _chatSessionMetadataStore.storeWorktreeInfo(targetSessionId, workspaceInfo.worktreeProperties);
				} else if (workspaceInfo.folder) {
					await _chatSessionMetadataStore.storeWorkspaceFolderInfo(targetSessionId, { folderPath: workspaceInfo.folder.fsPath, timestamp: Date.now() });
				}
			})(),
		]), token);

		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
	} catch (error) {
		// If anything goes wrong during the copy, we should clean up the target directory to avoid leaving corrupted sessions around.
		await fs.rm(targetDir, { recursive: true, force: true }).catch(() => { /* swallow errors */ });
		throw error;
	}

}

async function copySessionEventFileForForking(sessionId: string, targetSessionId: string) {
	const sourceSessionEventFile = getCopilotCLISessionEventsFile(sessionId);
	const targetSessionEventFile = getCopilotCLISessionEventsFile(targetSessionId);

	await fs.rm(targetSessionEventFile, { force: true });
	const contents = await fs.readFile(sourceSessionEventFile, { encoding: 'utf8' });
	const modifiedContents = contents.replaceAll(sessionId, targetSessionId);
	await fs.writeFile(targetSessionEventFile, modifiedContents);
}

async function copySessionWorkspaceYmlFileForForking(sessionId: string, targetSessionId: string) {
	const sourceWorkspaceFile = getCopilotCLIWorkspaceFile(sessionId);
	const targetWorkspaceFile = getCopilotCLIWorkspaceFile(targetSessionId);
	const sourceWorkspaceContents = await fs.readFile(sourceWorkspaceFile, { encoding: 'utf8' });
	await fs.writeFile(targetWorkspaceFile, sourceWorkspaceContents.replaceAll(sessionId, targetSessionId));
}
