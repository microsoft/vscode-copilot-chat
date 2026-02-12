/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CopilotSession, CustomAgentConfig, MCPServerConfig, PermissionRequest as NewSdkPermissionRequest, PermissionRequestResult, SessionConfig } from '@github/copilot-sdk';
import type { SweCustomAgent } from '@github/copilot/sdk';
import type { CancellationToken, Uri } from 'vscode';
import { INativeEnvService } from '../../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { RelativePattern } from '../../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../../platform/log/common/logService';
import { coalesce } from '../../../../../util/vs/base/common/arrays';
import { disposableTimeout, raceCancellationError } from '../../../../../util/vs/base/common/async';
import { Emitter } from '../../../../../util/vs/base/common/event';
import { Disposable, DisposableMap, IDisposable, IReference, RefCountedDisposable, toDisposable } from '../../../../../util/vs/base/common/lifecycle';
import { joinPath } from '../../../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus } from '../../../../../vscodeTypes';
import { ExternalEditTracker } from '../../../common/externalEditTracker';
import { stripReminders, ToolCall } from '../../common/copilotCLITools';
import { ICopilotCLIAgents } from '../copilotCli';
import { ICopilotCLISessionItem, ICopilotCLISessionService, Mutex } from '../copilotcliSessionService';
import { ICopilotCLIMCPHandler } from '../mcpHandler';
import { CopilotClientManager, ICopilotClientManager } from './copilotClientManager';
import { NewSdkCopilotCLISession, NewSdkCopilotCLISessionOptions, NewSdkUserInputRequest, NewSdkUserInputResponse } from './copilotcliSession';

const SESSION_SHUTDOWN_TIMEOUT_MS = 300 * 1000;

export class NewSdkCopilotCLISessionService extends Disposable implements ICopilotCLISessionService {
	declare _serviceBrand: undefined;

	private _sessionWrappers = new DisposableMap<string, NewSdkRefCountedSession>();

	private readonly _onDidChangeSessions = new Emitter<void>();
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly sessionTerminators = new DisposableMap<string, IDisposable>();
	private sessionMutexForGetSession = new Map<string, Mutex>();

	constructor(
		@ILogService protected readonly logService: ILogService,
		@ICopilotClientManager private readonly copilotClientManager: CopilotClientManager,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@INativeEnvService private readonly nativeEnv: INativeEnvService,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@ICopilotCLIMCPHandler private readonly mcpHandler: ICopilotCLIMCPHandler,
		@ICopilotCLIAgents private readonly agents: ICopilotCLIAgents,
	) {
		super();
		this._monitorSessionFiles();
	}

	private _monitorSessionFiles(): void {
		try {
			const sessionDir = joinPath(this.nativeEnv.userHome, '.copilot', 'session-state');
			const watcher = this._register(this.fileSystem.createFileSystemWatcher(new RelativePattern(sessionDir, '**/*.jsonl')));
			this._register(watcher.onDidCreate(() => this._onDidChangeSessions.fire()));
			this._register(watcher.onDidChange(() => this._onDidChangeSessions.fire()));
			this._register(watcher.onDidDelete(() => this._onDidChangeSessions.fire()));
		} catch (error) {
			this.logService.error(`[NewSdkSessionService] Failed to monitor session files: ${error}`);
		}
	}

	async getSessionWorkingDirectory(_sessionId: string, _token: CancellationToken): Promise<Uri | undefined> {
		// The new SDK's SessionMetadata doesn't include context/cwd info in listSessions().
		// We'd need to resume the session or track working directories ourselves.
		// For now return undefined — the delegating service can fall back to the old SDK path.
		return undefined;
	}

	async getAllSessions(filter: (sessionId: string) => boolean | undefined, token: CancellationToken): Promise<readonly ICopilotCLISessionItem[]> {
		try {
			const client = await raceCancellationError(this.copilotClientManager.getClient(), token);
			const sessionMetadataList = await raceCancellationError(client.listSessions(), token);

			const diskSessions: ICopilotCLISessionItem[] = coalesce(sessionMetadataList.map((metadata): ICopilotCLISessionItem | undefined => {
				const filterResult = filter(metadata.sessionId);
				if (filterResult === false) {
					return undefined;
				}
				const id = metadata.sessionId;
				const startTime = metadata.startTime.getTime();
				const endTime = metadata.modifiedTime.getTime();
				const label = metadata.summary ? labelFromPrompt(metadata.summary) : '';
				if (!label) {
					return undefined;
				}

				return {
					id,
					label,
					timing: { created: startTime, startTime, endTime },
				};
			}));

			const diskSessionIds = new Set(diskSessions.map(s => s.id));
			// Include in-progress sessions not yet persisted to disk
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

			return diskSessions
				.map((session): ICopilotCLISessionItem => ({
					...session,
					status: this._sessionWrappers.get(session.id)?.object?.status
				}))
				.concat(newSessions);
		} catch (error) {
			this.logService.error(`[NewSdkSessionService] Failed to get all sessions: ${error}`);
			return [];
		}
	}

	public async createSession({ model, workingDirectory, isolationEnabled, agent }: { model?: string; workingDirectory?: Uri; isolationEnabled?: boolean; agent?: SweCustomAgent }, token: CancellationToken): Promise<NewSdkRefCountedSession> {
		const client = await raceCancellationError(this.copilotClientManager.getClient(), token);
		const { config, toolCalls, sessionOptions } = await this._buildSessionConfig({ model, workingDirectory, isolationEnabled, token });

		const sdkSession = await client.createSession(config);
		this.logService.trace(`[NewSdkSessionService] Created new CopilotCLI session ${sdkSession.sessionId}.`);

		return this._wrapSdkSession(sdkSession, sessionOptions, model, toolCalls);
	}

	public async getSession(sessionId: string, { model, workingDirectory, isolationEnabled, readonly: _readonly, agent }: { model?: string; workingDirectory?: Uri; isolationEnabled?: boolean; readonly: boolean; agent?: SweCustomAgent }, token: CancellationToken): Promise<NewSdkRefCountedSession | undefined> {
		const lock = this.sessionMutexForGetSession.get(sessionId) ?? new Mutex();
		this.sessionMutexForGetSession.set(sessionId, lock);
		const lockDisposable = await lock.acquire(token);
		if (!lockDisposable || this._store.isDisposed || token.isCancellationRequested) {
			lockDisposable?.dispose();
			return;
		}

		try {
			const existing = this._sessionWrappers.get(sessionId);
			if (existing) {
				this.logService.trace(`[NewSdkSessionService] Reusing CopilotCLI session ${sessionId}.`);
				existing.acquire();
				return existing;
			}

			const client = await raceCancellationError(this.copilotClientManager.getClient(), token);
			const { config, toolCalls, sessionOptions } = await this._buildSessionConfig({ model, workingDirectory, isolationEnabled, token });

			const sdkSession = await client.resumeSession(sessionId, config);
			return this._wrapSdkSession(sdkSession, sessionOptions, model, toolCalls);
		} finally {
			lockDisposable.dispose();
		}
	}

	public async deleteSession(sessionId: string): Promise<void> {
		try {
			this._sessionWrappers.get(sessionId)?.dispose();
			const client = await this.copilotClientManager.getClient();
			await client.deleteSession(sessionId);
		} catch (error) {
			this.logService.error(`[NewSdkSessionService] Failed to delete session ${sessionId}: ${error}`);
		} finally {
			this._sessionWrappers.deleteAndLeak(sessionId);
			this._onDidChangeSessions.fire();
		}
	}

	private _getActiveSession(sessionId: string): NewSdkCopilotCLISession | undefined {
		// Find the active in-progress session — permission/input requests come through the client,
		// not the session, so we need to locate the session that initiated the request.
		for (const wrapper of this._sessionWrappers.values()) {
			if (wrapper.object.status === ChatSessionStatus.InProgress && wrapper.object.sessionId === sessionId) {
				return wrapper.object;
			}
		}
		return undefined;
	}

	private async _buildSessionConfig({ model, workingDirectory, isolationEnabled, token }: {
		model?: string;
		workingDirectory?: Uri;
		isolationEnabled?: boolean;
		token: CancellationToken;
	}): Promise<{ config: SessionConfig; toolCalls: Map<string, ToolCall>; sessionOptions: NewSdkCopilotCLISessionOptions }> {
		const [mcpServers, customAgents] = await Promise.all([
			this.mcpHandler.loadMcpConfig(),
			this.agents.getAgents(),
		]);

		const sessionOptions: NewSdkCopilotCLISessionOptions = {
			isolationEnabled: !!isolationEnabled,
			workingDirectory,
		};

		const editTracker = new ExternalEditTracker();
		const toolCalls = new Map<string, ToolCall>();

		const config: SessionConfig = {
			model,
			streaming: true,
			workingDirectory: workingDirectory?.fsPath,
			mcpServers: mcpServers ? this._convertMcpServers(mcpServers) : undefined,
			customAgents: customAgents.length ? await this._convertCustomAgents(customAgents) : undefined,
			onPermissionRequest: (request: NewSdkPermissionRequest, invocation: { sessionId: string }): Promise<PermissionRequestResult> => {
				const session = this._getActiveSession(invocation.sessionId);
				if (session) {
					return session.handlePermissionRequest(request, editTracker, (id) => toolCalls.get(id), workingDirectory?.fsPath, token);
				}
				return Promise.resolve({ kind: 'denied-interactively-by-user' });
			},
			onUserInputRequest: (request: NewSdkUserInputRequest, invocation: { sessionId: string }): Promise<NewSdkUserInputResponse> => {
				const session = this._getActiveSession(invocation.sessionId);
				if (session) {
					return session.handleUserInputRequest(request);
				}
				return Promise.resolve({ answer: '', wasFreeform: false });
			},
		};

		return { config, toolCalls, sessionOptions };
	}

	private _wrapSdkSession(
		sdkSession: CopilotSession,
		options: NewSdkCopilotCLISessionOptions,
		model: string | undefined,
		toolCalls: Map<string, ToolCall>,
	): NewSdkRefCountedSession {
		const unsubscribeToolStart = sdkSession.on('tool.execution_start', (event) => {
			toolCalls.set(event.id, event.data as unknown as ToolCall);
		});
		const wrappedSession = this._createSessionWrapper(sdkSession, options, model);
		wrappedSession.object.add(toDisposable(() => unsubscribeToolStart()));
		return wrappedSession;
	}

	private _createSessionWrapper(
		sdkSession: CopilotSession,
		options: NewSdkCopilotCLISessionOptions,
		model: string | undefined,
	): NewSdkRefCountedSession {
		const session = this.instantiationService.createInstance(NewSdkCopilotCLISession, options, sdkSession, model);
		session.add(session.onDidChangeStatus(() => this._onDidChangeSessions.fire()));
		session.add(toDisposable(() => {
			this._sessionWrappers.deleteAndLeak(sdkSession.sessionId);
			this.sessionMutexForGetSession.delete(sdkSession.sessionId);
			void sdkSession.abort();
			void sdkSession.destroy();
		}));

		session.add(session.onDidChangeStatus(() => {
			if (session.permissionRequested) {
				this.sessionTerminators.deleteAndDispose(session.sessionId);
			} else if (session.status === undefined || session.status === ChatSessionStatus.Completed || session.status === ChatSessionStatus.Failed) {
				this.sessionTerminators.set(session.sessionId, disposableTimeout(() => {
					session.dispose();
					this.sessionTerminators.deleteAndDispose(session.sessionId);
				}, SESSION_SHUTDOWN_TIMEOUT_MS));
			} else {
				this.sessionTerminators.deleteAndDispose(session.sessionId);
			}
		}));

		const refCountedSession = new NewSdkRefCountedSession(session);
		this._sessionWrappers.set(sdkSession.sessionId, refCountedSession);
		return refCountedSession;
	}

	/**
	 * Convert MCP server configs from the old SDK shape to the new SDK shape.
	 * The shapes are nearly identical — both use Record<string, MCPServerConfig>.
	 */
	private _convertMcpServers(mcpServers: Record<string, unknown>): Record<string, MCPServerConfig> {
		return mcpServers as Record<string, MCPServerConfig>;
	}

	/**
	 * Convert custom agents from the old SDK's SweCustomAgent[] to the new SDK's CustomAgentConfig[].
	 */
	private async _convertCustomAgents(agents: readonly SweCustomAgent[]): Promise<CustomAgentConfig[]> {
		return Promise.all(agents.map(async agent => ({
			name: agent.name,
			description: agent.description,
			tools: agent.tools ? [...agent.tools] : undefined,
			prompt: await agent.prompt(),
		})));
	}
}

function labelFromPrompt(prompt: string): string {
	return stripReminders(prompt);
}

export class NewSdkRefCountedSession extends RefCountedDisposable implements IReference<NewSdkCopilotCLISession> {
	constructor(public readonly object: NewSdkCopilotCLISession) {
		super(object);
	}
	dispose(): void {
		this.release();
	}
}
