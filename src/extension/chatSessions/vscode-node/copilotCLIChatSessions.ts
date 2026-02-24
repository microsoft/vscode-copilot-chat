/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotClient, CopilotSession, CustomAgentConfig, MCPServerConfig, SessionConfig, SessionMetadata } from '@github/copilot-sdk';
import type { SessionEvent as OldSessionEvent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, Uri } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptsService } from '../../../platform/promptFiles/common/promptsService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Disposable, DisposableStore, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceSet } from '../../../util/vs/base/common/map';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { buildChatHistoryFromEvents } from '../../agents/copilotcli/common/copilotCLITools';
import { IChatDelegationSummaryService } from '../../agents/copilotcli/common/delegationSummaryService';
import { ICopilotCLIAgents, ICopilotCLIModels } from '../../agents/copilotcli/node/copilotCli';
import { ICopilotCLIImageSupport } from '../../agents/copilotcli/node/copilotCLIImageSupport';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISessionItem } from '../../agents/copilotcli/node/copilotcliSessionService';
import { ICopilotCLIMCPHandler } from '../../agents/copilotcli/node/mcpHandler';
import { IUserQuestionHandler } from '../../agents/copilotcli/node/userInputHelpers';
import { IToolsService } from '../../tools/common/toolsService';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { IFolderRepositoryManager, IsolationMode } from '../common/folderRepositoryManager';
import {
	AGENTS_OPTION_ID,
	BRANCH_OPTION_ID,
	ChatSessionOptionsManager,
	copilotCLISessionItemToVSCodeChatSessionItem,
	getAgent,
	getModelId,
	ISOLATION_OPTION_ID,
	REPOSITORY_OPTION_ID,
	sendCopilotCLIInvokeTelemetry,
	SessionIdForCLI
} from './copilotCLIChatSessionsContribution';
import { CopilotSDKSession } from './copilotCLISession';
import { CopilotCloudSessionsProvider } from './copilotCloudSessionsProvider';

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

// ── CopilotSDKCLIProvider ───────────────────────────────────────────────

/**
 * Consolidated provider for Copilot CLI sessions using the new `@github/copilot-sdk`.
 *
 * Replaces `CopilotCLIChatSessionItemProvider`, `CopilotCLIChatSessionContentProvider`,
 * and `CopilotCLIChatSessionParticipant` from the old architecture.
 *
 * Manages:
 * - Session listing via controller API (incremental item yielding)
 * - Content provider for session history, options, and option changes
 * - Request routing (delegation, isUntitled, option locking)
 * - Session lifecycle via `getSession()` / `createSession()` for execution
 * - Readonly session history via `_readSessionHistory()` (no CopilotSDKSession)
 */
export class CopilotSDKCLIProvider extends Disposable {

	// ── Controller & Items ─────────────────────────────────────────────

	private readonly _controller: vscode.ChatSessionItemController;

	// ── Session management ─────────────────────────────────────────────

	private readonly _sessions = new Map<string, CopilotSDKSession>();
	private readonly _untitledSessionIds = new Set<string>();

	// ── Client ─────────────────────────────────────────────────────────

	private _clientPromise?: Promise<CopilotClient>;

	constructor(
		copilotcliSessionType = 'copilotcli',
		private readonly cloudSessionProvider: CopilotCloudSessionsProvider | undefined,
		private readonly optionsManager: ChatSessionOptionsManager,
		vscodeChat: typeof vscode.chat,
		private readonly promptResolver: CopilotCLIPromptResolver,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLIMCPHandler private readonly mcpHandler: ICopilotCLIMCPHandler,
		@IChatSessionWorktreeService private readonly worktreeService: IChatSessionWorktreeService,
		@IChatSessionWorkspaceFolderService private readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
		@IFolderRepositoryManager private readonly folderRepositoryManager: IFolderRepositoryManager,
		@IGitService private readonly gitService: IGitService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IToolsService private readonly toolsService: IToolsService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@ICopilotCLIImageSupport private readonly imageSupport: ICopilotCLIImageSupport,
		@IChatDelegationSummaryService private readonly delegationSummaryService: IChatDelegationSummaryService,
		@IUserQuestionHandler private readonly userQuestionHandler: IUserQuestionHandler,
		@IGitService private readonly gitSevice: IGitService,
		@IAuthenticationService private readonly authentService: IAuthenticationService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();
		this._controller = this._register(
			vscodeChat.createChatSessionItemController('copilotcli', () => this._refreshItems())
		);
		const copilotcliParticipant = this._register(vscodeChat.createChatParticipant(copilotcliSessionType, this._handleRequest.bind(this)));
		this._register(vscodeChat.registerChatSessionContentProvider(copilotcliSessionType, this.getContentProvider(), copilotcliParticipant));

		// Implement newChatSessionItemHandler
		this._controller.newChatSessionItemHandler = (_context: vscode.ChatSessionItemControllerNewItemHandlerContext, _token: vscode.CancellationToken) => {
			const sessionId = generateUuid();
			const resource = SessionIdForCLI.getResource(sessionId);
			this._untitledSessionIds.add(sessionId);
			const item = this._controller.createChatSessionItem(resource, '');
			return Promise.resolve(item);
		};
	}

	// ── Public API ──────────────────────────────────────────────────────

	/**
	 * Creates the request handler to register with VS Code.
	 */
	public createRequestHandler(): ChatExtendedRequestHandler {
		return (request, context, stream, token) => this._handleRequest(request, context, stream, token);
	}

	/**
	 * Returns the content provider interface for `registerChatSessionContentProvider`.
	 */
	private getContentProvider(): vscode.ChatSessionContentProvider {
		return {
			onDidChangeChatSessionOptions: this.optionsManager.onDidChangeSessionOptions,
			onDidChangeChatSessionProviderOptions: this.optionsManager.onDidChangeProviderOptions,
			provideChatSessionContent: (resource, token) => this._provideChatSessionContent(resource, token),
			provideChatSessionProviderOptions: () => this.optionsManager.provideChatSessionProviderOptions(),
			provideHandleOptionsChange: (resource, updates, token) => this.optionsManager.handleOptionsChange(resource, updates, token),
		};
	}

	/**
	 * Notify that the session list has changed (e.g., after session creation/completion).
	 */
	public notifySessionsChange(): void {
		void this._refreshItems();
	}

	/**
	 * Swap a session item in the controller (untitled → real after first request).
	 */
	public swap(modified: { resource: vscode.Uri; label: string }): void {
		const newItem = this._controller.createChatSessionItem(modified.resource, modified.label);
		this._controller.items.add(newItem);
	}

	/**
	 * Delete a session, including worktree and workspace folder cleanup.
	 */
	public async deleteSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.dispose();
			this._sessions.delete(sessionId);
		}
		try {
			const client = await this._getOrCreateClient();
			await client.deleteSession(sessionId);
		} catch (error) {
			this.logService.error(`[CopilotSDKCLIProvider] Failed to delete session ${sessionId}`, error);
		}

		// Clean up tracked workspace folder
		await this.workspaceFolderService.deleteTrackedWorkspaceFolder(sessionId);

		// Clean up worktree if one exists
		const worktreeProperties = this.worktreeService.getWorktreeProperties(sessionId);
		const worktreePath = this.worktreeService.getWorktreePath(sessionId);
		if (worktreePath) {
			try {
				const repository = worktreeProperties ? await this.gitService.getRepository(URI.file(worktreeProperties.repositoryPath), true) : undefined;
				if (!repository) {
					throw new Error(l10n.t('No active repository found to delete worktree.'));
				}
				await this.gitService.deleteWorktree(repository.rootUri, worktreePath.fsPath);
			} catch (error) {
				this.logService.error(`[CopilotSDKCLIProvider] Failed to delete worktree for session ${sessionId}`, error);
			}
		}

		this._controller.items.delete(SessionIdForCLI.getResource(sessionId));
		this.notifySessionsChange();
	}

	/**
	 * Rename a session.
	 */
	public async renameSession(sessionId: string, title: string): Promise<void> {
		const resource = SessionIdForCLI.getResource(sessionId);
		const existing = this._controller.items.get(resource);
		if (existing) {
			this._controller.items.delete(resource);
			const newItem = this._controller.createChatSessionItem(resource, title);
			this._controller.items.add(newItem);
		}
	}

	// ── isUntitled logic ────────────────────────────────────────────────

	private _isUntitled(sessionId: string): boolean {
		return this._untitledSessionIds.has(sessionId);
	}

	// ── Client lifecycle ────────────────────────────────────────────────

	private _getOrCreateClient(): Promise<CopilotClient> {
		if (!this._clientPromise) {
			this._clientPromise = this._createClient();
		}
		return this._clientPromise;
	}

	private async _createClient(): Promise<CopilotClient> {
		const token = await this.authentService.getGitHubSession('any', { silent: true });
		const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
		delete env['NODE_OPTIONS'];
		delete env['VSCODE_INSPECTOR_OPTIONS']; // debug inspector options from parent
		delete env['VSCODE_ESM_ENTRYPOINT'];    // VS Code's internal ESM loader entrypoint
		delete env['VSCODE_HANDLES_UNCAUGHT_ERRORS'];
		// Strip VSCODE_ and ELECTRON_ vars (except ELECTRON_RUN_AS_NODE)
		for (const key of Object.keys(env)) {
			if (key === 'ELECTRON_RUN_AS_NODE') {
				continue;
			}
			if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
				delete env[key];
			}
		}
		const client = new CopilotClient({
			useStdio: true,
			autoStart: true,
			githubToken: token?.accessToken ?? undefined,
			env,
			cliPath: '/Users/donjayamanne/development/vsc/copilot-agent-runtime/dist-cli/index.js',
			// cliPath: URI.joinPath(this.extensionContext.extensionUri, 'node_modules', '@github', 'copilot', 'index.js').fsPath,
		});
		await client.start();
		// Subscribe to lifecycle events for real-time controller updates
		client.on('session.created', (e) => {
			// we have taken care of this.
			// TODO @DonJayamanne Add tests & tests this
		});
		client.on('session.deleted', (e) => {
			this._sessions.delete(e.sessionId);
			this._controller.items.delete(SessionIdForCLI.getResource(e.sessionId));
		});
		client.on('session.updated', async (e) => {
			if (this._sessions.has(e.sessionId)) {
				// we have taken care of this.
				// TODO @DonJayamanne Add tests & tests this
				// I don't think this is correct, what if the stats are not the same...
				// I think we need to update the session item in controller with the latest details
				// TODO @DonJayamanne Figure this out.
				return;
			}
			if (e.metadata?.summary) {
				const cliSessionItem = this._sessionMetadataToCLISessionItem({
					sessionId: e.sessionId,
					summary: e.metadata.summary,
					startTime: new Date(Date.parse(e.metadata.startTime)),
					modifiedTime: new Date(Date.parse(e.metadata.modifiedTime)),
					isRemote: false,
				});
				const item = await copilotCLISessionItemToVSCodeChatSessionItem(cliSessionItem, this.shouldShowBadge(), this.worktreeService, this.workspaceFolderService, vscode.workspace, this._controller);
				this._controller.items.add(item);
				return;
			} else {
				// TODO @DonJayamanne
				// Try to open the session and get the summary.
				// Or wait for the next update which should have the summary.
			}
		});

		this._register(toDisposable(() => {
			client.stop().catch(err => this.logService.error('[CopilotSDKCLIProvider] Error stopping client', err));
		}));

		return client;
	}

	private async _validateAuth(): Promise<void> {
		const client = await this._getOrCreateClient();
		const authStatus = await client.getAuthStatus();
		if (!authStatus.isAuthenticated) {
			throw new Error(l10n.t('Authorization failed. Please sign into GitHub and try again.'));
		}
	}

	// ── Session get/create (execution only) ─────────────────────────────

	public async resumeSession(sessionId: string): Promise<CopilotSDKSession> {
		const existing = this._sessions.get(sessionId);
		if (existing) {
			return existing;
		}
		const client = await this._getOrCreateClient();
		// const modelId = await this.copilotCLIModels.getDefaultModel();
		const sdkSession = await client.resumeSession(sessionId, {
			// model: modelId,
			streaming: true,
		});
		return this._wrapAndCacheSession(sdkSession, sessionId, false, undefined);
	}

	public async createSession(
		sessionId: string,
		options: {
			model?: string;
			isolationEnabled: boolean;
			workingDirectory?: Uri;
			agent?: CustomAgentConfig;
		}
	): Promise<CopilotSDKSession> {
		const client = await this._getOrCreateClient();
		const mcpServers = await this.mcpHandler.loadMcpConfig() as Record<string, MCPServerConfig>;
		const customAgents = await this.copilotCLIAgents.getAgents() as CustomAgentConfig[];

		const sessionConfig: SessionConfig = {
			sessionId,
			model: options.model,
			workingDirectory: options.workingDirectory?.fsPath,
			streaming: true,
			mcpServers,
			customAgents
		};

		const sdkSession = await client.createSession(sessionConfig);
		return this._wrapAndCacheSession(sdkSession, sessionId, options.isolationEnabled, options.workingDirectory);
	}

	private _wrapAndCacheSession(
		sdkSession: CopilotSession,
		sessionId: string,
		isolationEnabled: boolean,
		workingDirectory: Uri | undefined,
	): CopilotSDKSession {
		const session = new CopilotSDKSession(
			sdkSession,
			isolationEnabled,
			workingDirectory,
			this.promptResolver,
			this.logService,
			this.workspaceService,
			this.delegationSummaryService,
			this.requestLogger,
			this.imageSupport,
			this.toolsService,
			this.instantiationService,
			this.userQuestionHandler,
		);
		const disposable = toDisposable(() => {
			if (this._sessions.get(sessionId) === session) {
				this._sessions.delete(sessionId);
			}
		});
		session.add(disposable);
		session.onDidChangeStatus(() => this.notifySessionsChange());
		session.onDidChangeTitle(() => this.notifySessionsChange());

		this._sessions.set(sessionId, session);
		this._register(disposable);

		return session;
	}

	// ── Controller & Session Items ──────────────────────────────────────
	private shouldShowBadge(): boolean {
		const repositories = this.gitSevice.repositories
			.filter(repository => repository.kind !== 'worktree');

		return vscode.workspace.workspaceFolders === undefined || // empty window
			vscode.workspace.isAgentSessionsWorkspace ||          // agent sessions workspace
			repositories.length > 1;                              // multiple repositories
	}

	private async _refreshItems(): Promise<void> {
		try {
			const client = await this._getOrCreateClient();
			const sessions = await client.listSessions();
			const knownResources = new ResourceSet();
			this._controller.items.forEach(item => knownResources.add(item.resource));
			const shouldShowBadge = this.shouldShowBadge();
			sessions.forEach(session => {
				const workingDirectory = session.context?.cwd ? URI.file(session.context.cwd) : undefined;
				if (workingDirectory && this.folderRepositoryManager.setFallbackSessionWorkingDirectory) {
					this.folderRepositoryManager.setFallbackSessionWorkingDirectory(session.sessionId, workingDirectory);
				}
			});
			await Promise.all(sessions.map(async (session) => {
				if (this._shouldShowSession(session.sessionId)) {
					const cliSessionItem = this._sessionMetadataToCLISessionItem(session);
					const item = await copilotCLISessionItemToVSCodeChatSessionItem(cliSessionItem, shouldShowBadge, this.worktreeService, this.workspaceFolderService, vscode.workspace, this._controller);
					knownResources.delete(item.resource);
					this._controller.items.add(item);
				}
			}));

			knownResources.forEach(resource => this._controller.items.delete(resource));
		} catch (error) {
			this.logService.error('[CopilotSDKCLIProvider] Failed to refresh session items', error);
		}
	}

	private _sessionMetadataToCLISessionItem(session: SessionMetadata): ICopilotCLISessionItem {
		const workingDirectory = session.context?.cwd ? URI.file(session.context.cwd) : undefined;
		const cliSessionItem: ICopilotCLISessionItem = {
			id: session.sessionId,
			label: session.summary || '',
			timing: { created: session.startTime.getTime(), startTime: session.startTime.getTime(), lastRequestEnded: session.modifiedTime.getTime() },
			status: this._sessions.get(session.sessionId)?.status,
			workingDirectory,
		};
		return cliSessionItem;
	}

	private _shouldShowSession(sessionId: string): boolean | undefined {
		if (this._untitledSessionIds.has(sessionId) || this._sessions.has(sessionId)) {
			return true;
		}
		// Check workspace folder association
		const workspaceFolder = this.workspaceFolderService.getSessionWorkspaceFolder(sessionId);
		if (workspaceFolder && this.workspaceService.getWorkspaceFolder(workspaceFolder)) {
			return true;
		}
		// Check worktree association
		const worktreePath = this.worktreeService.getWorktreePath(sessionId);
		if (worktreePath) {
			return true;
		}
		return undefined;
	}

	// ── Content Provider ────────────────────────────────────────────────

	private async _provideChatSessionContent(resource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const sessionId = SessionIdForCLI.parse(resource);
		const isUntitled = this._isUntitled(sessionId);

		// Resolve agent
		const [sessionAgent, defaultAgent] = await Promise.all([
			this.copilotCLIAgents.getSessionAgent(sessionId),
			this.copilotCLIAgents.getDefaultAgent(),
		]);
		const agentId = sessionAgent ?? defaultAgent;

		const { options, providerOptionsChanged } = await this.optionsManager.buildSessionContentOptions(
			sessionId,
			isUntitled,
			agentId,
			token,
		);

		if (providerOptionsChanged) {
			this.optionsManager.notifyProviderOptionsChange();
		}

		// Load chat history
		const history = isUntitled ? [] : await this._readSessionHistory(sessionId);

		return { history, activeResponseCallback: undefined, requestHandler: undefined, options };
	}

	private async _readSessionHistory(sessionId: string): Promise<(vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[]> {
		// Piggyback on active session if available
		const activeSession = this._sessions.get(sessionId);
		if (activeSession) {
			return activeSession.getChatHistory();
		}

		// Lightweight readonly: open a temporary CopilotSession, read, destroy
		try {
			const client = await this._getOrCreateClient();
			const tempSession = await client.resumeSession(sessionId, { disableResume: true });
			const events = await tempSession.getMessages();
			const history = buildChatHistoryFromEvents(
				sessionId,
				undefined,
				events as unknown as OldSessionEvent[],
				() => undefined,
				this.delegationSummaryService,
				this.logService,
				undefined,
			);
			await tempSession.destroy();
			return history;
		} catch (error) {
			this.logService.error(`[CopilotSDKCLIProvider] Failed to read session history for ${sessionId}`, error);
			return [];
		}
	}



	// ── Request Handler ─────────────────────────────────────────────────

	private async _handleRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult | void> {
		const { chatSessionContext } = context;
		const disposables = new DisposableStore();

		try {
			// Handle delegation from another chat
			if (!chatSessionContext) {
				sendCopilotCLIInvokeTelemetry(request.id, false, undefined, false, this.telemetryService);

				await this._validateAuth();
				return await this._handleDelegationFromAnotherChat(request, context, stream, token);
			}

			const { resource } = chatSessionContext.chatSessionItem;
			const id = SessionIdForCLI.parse(resource);
			const isUntitled = this._isUntitled(id);

			sendCopilotCLIInvokeTelemetry(request.id, true, isUntitled, request.command === 'delegate', this.telemetryService);

			// Process initial session options
			const initialOptions = chatSessionContext?.initialSessionOptions;
			if (initialOptions && initialOptions.length > 0 && chatSessionContext) {
				const sessionResource = chatSessionContext.chatSessionItem.resource;
				const sessionId = SessionIdForCLI.parse(sessionResource);
				for (const opt of initialOptions) {
					const value = typeof opt.value === 'string' ? opt.value : opt.value.id;
					if (opt.optionId === AGENTS_OPTION_ID) {
						void this.copilotCLIAgents.setDefaultAgent(value);
						void this.copilotCLIAgents.trackSessionAgent(sessionId, value);
					} else if (opt.optionId === REPOSITORY_OPTION_ID && value && this._isUntitled(sessionId)) {
						this.folderRepositoryManager.setUntitledSessionFolder(sessionId, URI.file(value));
					} else if (opt.optionId === BRANCH_OPTION_ID && value) {
						this.optionsManager.setSessionBranch(sessionId, value);
					} else if (opt.optionId === ISOLATION_OPTION_ID && value) {
						this.optionsManager.setSessionIsolation(sessionId, value);
					}
				}
			}

			// Auth validation + lock repo in parallel
			await Promise.all([
				this._validateAuth(),
				this._lockRepoOptionForSession(context, token),
			]);

			// Resolve model and agent in parallel
			const [modelId, agent] = await Promise.all([
				this._getModelId(request, token),
				this._getAgent(id, request, token),
			]);

			if (isUntitled && agent) {
				const changes = [{ optionId: AGENTS_OPTION_ID, value: agent.name ?? '' }];
				this.optionsManager.notifySessionOptionsChange(resource, changes);
			}

			// Get or create session
			const { session, trusted } = await this._getOrCreateSessionForRequest(request, chatSessionContext, id, isUntitled, modelId, agent, stream, disposables, token);
			if (!session || token.isCancellationRequested) {
				if (!trusted) {
					await this._unlockRepoOptionForSession(context, token);
				}
				return {};
			}

			void this.copilotCLIAgents.trackSessionAgent(session.sessionId, agent?.name);

			// Re-lock with more accurate information after session creation
			if (isUntitled) {
				void this._lockRepoOptionForSession(context, token);
			}

			// Handle /delegate to cloud
			if (request.command === 'delegate') {
				await this._handleDelegationToCloud(session, request, context, stream, token);
			} else {
				// Set model if different from creation
				if (modelId) {
					await session.setModelId(modelId);
				}
				// Delegate to session — it resolves prompt, sends, streams
				await session.handleRequest(request, stream, token);
				await this._commitWorktreeChangesIfNeeded(session, token);
			}

			// Post-request cleanup for untitled sessions
			if (isUntitled && !token.isCancellationRequested) {
				this.optionsManager.deleteSessionBranch(id);
				this.optionsManager.deleteSessionIsolation(id);
				this.folderRepositoryManager.deleteUntitledSessionFolder(id);
				// THIS Doesn't feel right...
				this.swap(
					{ resource: SessionIdForCLI.getResource(session.sessionId), label: request.prompt },
				);
			}
			return {};
		} catch (ex) {
			if (isCancellationError(ex)) {
				return {};
			}
			throw ex;
		} finally {
			this.notifySessionsChange();
			disposables.dispose();
		}
	}

	// ── Session creation/resumption for requests ────────────────────────

	private async _getOrCreateSessionForRequest(
		request: vscode.ChatRequest,
		chatSessionContext: vscode.ChatSessionContext,
		sessionId: string,
		isNewSession: boolean,
		modelId: string | undefined,
		agent: CustomAgentConfig | undefined,
		stream: vscode.ChatResponseStream,
		disposables: DisposableStore,
		token: vscode.CancellationToken,
	): Promise<{ session: CopilotSDKSession | undefined; trusted: boolean }> {

		const { isolationEnabled, workingDirectory, worktreeProperties, cancelled, trusted } = await this._getOrInitializeWorkingDirectory(chatSessionContext, stream, request.toolInvocationToken, token);
		if (cancelled || token.isCancellationRequested) {
			return { session: undefined, trusted };
		}

		let session: CopilotSDKSession;
		if (isNewSession) {
			if (worktreeProperties) {
				void this.worktreeService.setWorktreeProperties(sessionId, worktreeProperties);
			}
			if (workingDirectory && !isolationEnabled) {
				void this.workspaceFolderService.trackSessionWorkspaceFolder(sessionId, workingDirectory.fsPath);
			}
			session = await this.createSession(sessionId, {
				model: modelId,
				isolationEnabled,
				workingDirectory,
				agent,
			});
			this._untitledSessionIds.delete(sessionId); // We have created the worktrees now. Changes have been made
		} else {
			session = await this.resumeSession(sessionId);
		}

		// TODO: This is the wrong point to trigger an udpate, it should happen when we have a title for the users requets
		// I.e. we need something in history to display.
		this.notifySessionsChange();
		this.logService.info(`[CopilotSDKCLIProvider] Using session: ${sessionId} (isNew: ${isNewSession}, isolationEnabled: ${isolationEnabled})`);

		if (workingDirectory && !isolationEnabled) {
			void this.workspaceFolderService.trackSessionWorkspaceFolder(sessionId, workingDirectory.fsPath);
		}

		return { session, trusted };
	}

	// ── Working directory initialization ────────────────────────────────

	private async _getOrInitializeWorkingDirectory(
		chatSessionContext: vscode.ChatSessionContext | undefined,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken,
	): Promise<{
		isolationEnabled: boolean;
		workingDirectory: Uri | undefined;
		worktreeProperties: ChatSessionWorktreeProperties | undefined;
		cancelled: boolean;
		trusted: boolean;
	}> {
		if (chatSessionContext) {
			const existingSessionId = SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource);
			const id = existingSessionId ?? SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource);
			const isNew = this._isUntitled(id);

			if (isNew) {
				const branch = this.optionsManager.getSessionBranch(id);
				const isolation = (this.optionsManager.getSessionIsolation(id) as IsolationMode | undefined) ?? undefined;
				const folderInfo = await this.folderRepositoryManager.initializeFolderRepository(id, { stream, toolInvocationToken, branch: branch ?? undefined, isolation }, token);
				if (folderInfo.trusted === false || folderInfo.cancelled) {
					return { isolationEnabled: false, workingDirectory: undefined, worktreeProperties: undefined, cancelled: true, trusted: folderInfo.trusted !== false };
				}
				return { isolationEnabled: !!folderInfo.worktreeProperties, workingDirectory: folderInfo.worktree ?? folderInfo.folder, worktreeProperties: folderInfo.worktreeProperties, cancelled: false, trusted: true };
			} else {
				const folderInfo = await this.folderRepositoryManager.getFolderRepository(id, { promptForTrust: true, stream }, token);
				if (folderInfo.trusted === false) {
					return { isolationEnabled: false, workingDirectory: undefined, worktreeProperties: undefined, cancelled: true, trusted: false };
				}
				const worktreeProperties = folderInfo.worktree ? this.worktreeService.getWorktreeProperties(id) : undefined;
				return { isolationEnabled: !!worktreeProperties, workingDirectory: folderInfo.worktree ?? folderInfo.folder, worktreeProperties, cancelled: false, trusted: true };
			}
		} else {
			const folderInfo = await this.folderRepositoryManager.initializeFolderRepository(undefined, { stream, toolInvocationToken, isolation: undefined }, token);
			if (folderInfo.trusted === false || folderInfo.cancelled) {
				return { isolationEnabled: false, workingDirectory: undefined, worktreeProperties: undefined, cancelled: true, trusted: folderInfo.trusted !== false };
			}
			return { isolationEnabled: !!folderInfo.worktreeProperties, workingDirectory: folderInfo.worktree ?? folderInfo.folder, worktreeProperties: folderInfo.worktreeProperties, cancelled: false, trusted: true };
		}
	}

	// ── Option locking ──────────────────────────────────────────────────

	private async _lockRepoOptionForSession(context: vscode.ChatContext, token: vscode.CancellationToken): Promise<void> {
		const chatSessionContext = context.chatSessionContext;
		if (!chatSessionContext || !this._isUntitled(SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource))) {
			return;
		}
		const { resource } = chatSessionContext.chatSessionItem;
		const id = SessionIdForCLI.parse(resource);
		const folderInfo = await this.folderRepositoryManager.getFolderRepository(id, undefined, token);
		const changes = this.optionsManager.buildLockSessionOptionChanges(id, folderInfo);
		if (changes) {
			this.optionsManager.notifySessionOptionsChange(resource, changes);
		}
	}

	private async _unlockRepoOptionForSession(context: vscode.ChatContext, token: vscode.CancellationToken): Promise<void> {
		const chatSessionContext = context.chatSessionContext;
		if (!chatSessionContext) {
			return;
		}
		const { resource } = chatSessionContext.chatSessionItem;
		const id = SessionIdForCLI.parse(resource);
		const folderInfo = await this.folderRepositoryManager.getFolderRepository(id, undefined, token);
		const changes = this.optionsManager.buildUnlockSessionOptionChanges(id, folderInfo);
		if (changes) {
			this.optionsManager.notifySessionOptionsChange(resource, changes);
		}
	}

	// ── Delegation ──────────────────────────────────────────────────────

	private async _handleDelegationFromAnotherChat(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> {
		const sessionId = generateUuid();
		const [{ isolationEnabled, workingDirectory, worktreeProperties, cancelled }, modelId, additionalReferences] = await Promise.all([
			this._getOrInitializeWorkingDirectory(undefined, stream, request.toolInvocationToken, token),
			this._getModelId(request, token),
			this.getAdditionalReferences(request, context, sessionId, stream, token)
		]);

		if (cancelled || token.isCancellationRequested) {
			stream.markdown(l10n.t('Background Agent delegation cancelled.'));
			return {};
		}

		const session = await this.createSession(sessionId, {
			model: modelId,
			isolationEnabled,
			workingDirectory,
		});

		if (worktreeProperties) {
			void this.worktreeService.setWorktreeProperties(session.sessionId, worktreeProperties);
		}
		if (workingDirectory && !isolationEnabled) {
			void this.workspaceFolderService.trackSessionWorkspaceFolder(session.sessionId, workingDirectory.fsPath);
		}

		// Fire session changed so it appears in the UI
		this.notifySessionsChange();

		// Send request to the session (session resolves prompt internally)
		const references: vscode.ChatPromptReference[] = ([] as vscode.ChatPromptReference[]).concat(request.references).concat(additionalReferences);
		session.handleRequest({ ...request, references }, stream, token)
			.then(() => this._commitWorktreeChangesIfNeeded(session, token))
			.catch(error => {
				this.logService.error(`[CopilotSDKCLIProvider] Failed to handle delegated request: ${error}`);
			});

		stream.markdown(l10n.t('A background agent has begun working on your request. Follow its progress in the sessions list.'));
		return {};
	}

	private async getAdditionalReferences(request: vscode.ChatRequest, context: vscode.ChatContext, sessionId: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatPromptReference[]> {
		if (!this._hasHistoryToSummarize(context.history)) {
			return [];
		}
		stream.progress(l10n.t('Analyzing chat history'));
		let summary = await this.delegationSummaryService.summarize(context, token);
		if (!summary) {
			return [];
		}
		summary = `${request.prompt}\n**Summary**\n${summary}`;
		const summaryRef = await this.delegationSummaryService.trackSummaryUsage(sessionId, summary);
		if (summaryRef) {
			return [summaryRef];
		}

		return [];
	}

	private _hasHistoryToSummarize(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): boolean {
		if (!history || history.length === 0) {
			return false;
		}
		const allResponsesEmpty = history.every(turn => {
			if (turn instanceof vscode.ChatResponseTurn) {
				return turn.response.length === 0;
			}
			return true;
		});
		return !allResponsesEmpty;
	}

	private async _handleDelegationToCloud(
		session: CopilotSDKSession,
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (!this.cloudSessionProvider) {
			stream.warning(l10n.t('No cloud agent available'));
			return;
		}

		const worktreeProperties = this.worktreeService.getWorktreeProperties(session.sessionId);
		const repositoryPath = worktreeProperties?.repositoryPath ? URI.file(worktreeProperties.repositoryPath) : undefined;
		const repository = repositoryPath ? await this.gitService.getRepository(repositoryPath) : undefined;
		const hasChanges = repository?.changes?.indexChanges && repository.changes.indexChanges.length > 0;

		if (hasChanges) {
			stream.warning(l10n.t('You have uncommitted changes in your workspace. The cloud agent will start from the last committed state. Consider committing your changes first if you want to include them.'));
		}

		const prInfo = await this.cloudSessionProvider.delegate(request, stream, context, token, { prompt: request.prompt, chatContext: context });
		session.addUserMessage(`/delegate ${request.prompt}`);
		const assistantMessage = `A cloud agent has begun working on your request. Follow its progress in the associated chat and pull request.\n<pr_metadata uri="${prInfo.uri?.toString()}" title="${escapeXml(prInfo.title)}" description="${escapeXml(prInfo.description)}" author="${escapeXml(prInfo.author)}" linkTag="${escapeXml(prInfo.linkTag)}"/>`;
		session.addUserAssistantMessage(assistantMessage);
	}

	// ── Worktree handling ───────────────────────────────────────────────

	private async _commitWorktreeChangesIfNeeded(session: CopilotSDKSession, token: vscode.CancellationToken): Promise<void> {
		if (token.isCancellationRequested || session.status !== vscode.ChatSessionStatus.Completed) {
			return;
		}
		if (session.isolationEnabled) {
			// When isolation is enabled, commit all changes in the worktree directory
			await this.worktreeService.handleRequestCompleted(session.sessionId);
		} else if (session.workingDirectory) {
			// When isolation is not enabled, stage changes in the workspace directory
			await this.workspaceFolderService.handleRequestCompleted(session.workingDirectory);
		}
	}

	// ── Model & Agent resolution ────────────────────────────────────────

	private async _getModelId(request: vscode.ChatRequest | undefined, token: vscode.CancellationToken): Promise<string | undefined> {
		return getModelId(request, this.copilotCLIModels, this.promptsService, this.logService, token);
	}

	private async _getAgent(sessionId: string | undefined, request: vscode.ChatRequest | undefined, token: vscode.CancellationToken): Promise<CustomAgentConfig | undefined> {
		return getAgent(sessionId, request, this.copilotCLIAgents, token) as unknown as CustomAgentConfig | undefined;
	}
}
