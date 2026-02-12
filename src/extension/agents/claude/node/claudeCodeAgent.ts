/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput, Options, PermissionMode, PreToolUseHookInput, Query, SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { TodoWriteInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import Anthropic from '@anthropic-ai/sdk';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { CapturingToken } from '../../../../platform/requestLogger/common/capturingToken';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { isLocation } from '../../../../util/common/types';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable, DisposableMap } from '../../../../util/vs/base/common/lifecycle';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatReferenceBinaryData, ChatResponseThinkingProgressPart } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { buildHooksFromRegistry } from '../common/claudeHookRegistry';
import { buildMcpServersFromRegistry } from '../common/claudeMcpServerRegistry';
import { IClaudeToolPermissionService } from '../common/claudeToolPermissionService';
import { claudeEditTools, ClaudeToolNames, getAffectedUrisForEditTool } from '../common/claudeTools';
import { completeToolInvocation, createFormattedToolInvocation } from '../common/toolInvocationFormatter';
import { IClaudeCodeSdkService } from './claudeCodeSdkService';
import { ClaudeLanguageModelServer, IClaudeLanguageModelServerConfig } from './claudeLanguageModelServer';
import { IClaudeSessionStateService } from './claudeSessionStateService';
import { ClaudeSettingsChangeTracker } from './claudeSettingsChangeTracker';
import { SYNTHETIC_MODEL_ID, toAnthropicImageMediaType } from './sessionParser/claudeSessionSchema';

// Manages Claude Code agent interactions and language model server lifecycle
export class ClaudeAgentManager extends Disposable {
	private _langModelServer: ClaudeLanguageModelServer | undefined;
	private _sessions = this._register(new DisposableMap<string, ClaudeCodeSession>());

	private async getLangModelServer(): Promise<ClaudeLanguageModelServer> {
		if (!this._langModelServer) {
			this._langModelServer = this.instantiationService.createInstance(ClaudeLanguageModelServer);
			await this._langModelServer.start();
		}

		return this._langModelServer;
	}

	constructor(
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService,
	) {
		super();
	}

	public async handleRequest(
		claudeSessionId: string,
		request: vscode.ChatRequest,
		_context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		isNewSession: boolean,
		yieldRequested?: () => boolean,
		forkFromSessionId?: string
	): Promise<vscode.ChatResult & { claudeSessionId?: string }> {
		try {
			// Read UI state from session state service
			const modelId = this.sessionStateService.getModelIdForSession(claudeSessionId);
			const permissionMode = this.sessionStateService.getPermissionModeForSession(claudeSessionId);
			const folderInfo = this.sessionStateService.getFolderInfoForSession(claudeSessionId);

			if (!modelId || !folderInfo) {
				throw new Error(`Session state not found for session ${claudeSessionId}. State must be committed before calling handleRequest.`);
			}

			// Get server config, start server if needed
			const langModelServer = await this.getLangModelServer();
			const serverConfig = langModelServer.getConfig();

			this.logService.trace(`[ClaudeAgentManager] Handling request for sessionId=${claudeSessionId}, modelId=${modelId}, permissionMode=${permissionMode}, forkFrom=${forkFromSessionId}.`);
			let session: ClaudeCodeSession;
			if (this._sessions.has(claudeSessionId)) {
				this.logService.trace(`[ClaudeAgentManager] Reusing Claude session ${claudeSessionId}.`);
				session = this._sessions.get(claudeSessionId)!;
			} else {
				this.logService.trace(`[ClaudeAgentManager] Creating Claude session for sessionId=${claudeSessionId}.`);
				const newSession = this.instantiationService.createInstance(ClaudeCodeSession, serverConfig, langModelServer, claudeSessionId, modelId, permissionMode, isNewSession, forkFromSessionId);
				this._sessions.set(claudeSessionId, newSession);
				session = newSession;
			}

			await session.invoke(
				await this.resolvePrompt(request),
				request.toolInvocationToken,
				stream,
				token,
				yieldRequested
			);

			return {
				claudeSessionId: session.sessionId
			};
		} catch (invokeError) {
			// Check if this is an abort/cancellation error - don't show these as errors to the user
			const isAbortError = invokeError instanceof Error && (
				invokeError.name === 'AbortError' ||
				invokeError.message?.includes('aborted') ||
				invokeError.message?.includes('cancelled') ||
				invokeError.message?.includes('canceled')
			);
			if (isAbortError) {
				this.logService.trace('[ClaudeAgentManager] Request was aborted/cancelled');
				return { claudeSessionId };
			}

			this.logService.error(invokeError as Error);
			const errorMessage = (invokeError instanceof KnownClaudeError) ? invokeError.message : l10n.t('Claude CLI Error: {0}', invokeError.message);
			stream.markdown(l10n.t('Error: {0}', errorMessage));
			return {
				// This currently can't be used by the sessions API https://github.com/microsoft/vscode/issues/263111
				errorDetails: { message: errorMessage },
			};
		}
	}

	private async resolvePrompt(request: vscode.ChatRequest): Promise<Anthropic.ContentBlockParam[]> {
		if (request.prompt.startsWith('/')) {
			return [{ type: 'text', text: request.prompt }]; // likely a slash command, don't modify
		}

		const contentBlocks: Anthropic.ContentBlockParam[] = [];
		const extraRefsTexts: string[] = [];
		const uriToString = (uri: URI) => uri.scheme === 'file' ? uri.fsPath : uri.toString();
		let prompt = request.prompt;
		for (const ref of request.references) {
			let refValue = ref.value;
			if (refValue instanceof ChatReferenceBinaryData) {
				const mediaType = toAnthropicImageMediaType(refValue.mimeType);
				if (mediaType) {
					const data = await refValue.data();
					contentBlocks.push({
						type: 'image',
						source: {
							type: 'base64',
							data: Buffer.from(data).toString('base64'),
							media_type: mediaType
						}
					});
					continue;
				}
				// Unsupported image type — fall through to use reference URI if available
				if (!refValue.reference) {
					continue;
				}
				refValue = refValue.reference;
			}

			const valueText = URI.isUri(refValue) ?
				uriToString(refValue) :
				isLocation(refValue) ?
					`${uriToString(refValue.uri)}:${refValue.range.start.line + 1}` :
					undefined;
			if (valueText) {
				if (ref.range) {
					prompt = prompt.slice(0, ref.range[0]) + valueText + prompt.slice(ref.range[1]);
				} else {
					extraRefsTexts.push(`- ${valueText}`);
				}
			}
		}

		// Add system-reminder as a separate content block so it's not rendered in chat history
		if (extraRefsTexts.length > 0) {
			contentBlocks.push({
				type: 'text',
				text: `<system-reminder>\nThe user provided the following references:\n${extraRefsTexts.join('\n')}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>`
			});
		}

		// Add the actual user prompt as a separate content block
		contentBlocks.push({ type: 'text', text: prompt });

		return contentBlocks;
	}
}

class KnownClaudeError extends Error { }

/**
 * Represents a queued chat request waiting to be processed by the Claude session
 */
interface QueuedRequest {
	readonly prompt: Anthropic.ContentBlockParam[];
	readonly stream: vscode.ChatResponseStream;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken;
	readonly token: vscode.CancellationToken;
	readonly yieldRequested?: () => boolean;
	readonly deferred: DeferredPromise<void>;
}

/**
 * Represents the currently active request being processed
 */
interface CurrentRequest {
	readonly stream: vscode.ChatResponseStream;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken;
	readonly token: vscode.CancellationToken;
	readonly yieldRequested?: () => boolean;
}

export class ClaudeCodeSession extends Disposable {
	private static readonly DenyToolMessage = 'The user declined to run the tool';
	private _queryGenerator: Query | undefined;
	private _promptQueue: QueuedRequest[] = [];
	private _currentRequest: CurrentRequest | undefined;
	private _pendingPrompt: DeferredPromise<QueuedRequest> | undefined;
	private _abortController = new AbortController();
	private _editTracker: ExternalEditTracker;
	private _settingsChangeTracker: ClaudeSettingsChangeTracker;
	private _currentModelId: string;
	private _currentPermissionMode: PermissionMode;
	private _isResumed: boolean;
	private _yieldInProgress = false;
	private _sessionStarting: Promise<void> | undefined;

	/**
	 * Sets the model on the active SDK session.
	 */
	private async _setModel(modelId: string): Promise<void> {
		if (this._queryGenerator && modelId !== this._currentModelId) {
			this.logService.trace(`[ClaudeCodeSession] Setting model to ${modelId} on active session`);
			// TODO: Does this throw? How would we handle errors here?
			await this._queryGenerator.setModel(modelId);
			this._currentModelId = modelId;
		}
	}

	/**
	 * Sets the permission mode on the active SDK session.
	 */
	private async _setPermissionMode(mode: PermissionMode): Promise<void> {
		if (this._queryGenerator && mode !== this._currentPermissionMode) {
			this.logService.trace(`[ClaudeCodeSession] Setting permission mode to ${mode} on active session`);
			// TODO: Does this throw? How would we handle errors here?
			await this._queryGenerator.setPermissionMode(mode);
			this._currentPermissionMode = mode;
		}
	}

	constructor(
		private readonly serverConfig: IClaudeLanguageModelServerConfig,
		private readonly langModelServer: ClaudeLanguageModelServer,
		public readonly sessionId: string,
		initialModelId: string,
		initialPermissionMode: PermissionMode,
		isNewSession: boolean,
		private readonly forkFromSessionId: string | undefined,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IToolsService private readonly toolsService: IToolsService,
		@IClaudeCodeSdkService private readonly claudeCodeService: IClaudeCodeSdkService,
		@IClaudeToolPermissionService private readonly toolPermissionService: IClaudeToolPermissionService,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService,
	) {
		super();
		this._currentModelId = initialModelId;
		this._currentPermissionMode = initialPermissionMode;
		this._isResumed = !isNewSession;
		// Initialize edit tracker with plan directory as ignored
		const planDirUri = URI.joinPath(this.envService.userHome, '.claude', 'plans');
		this._editTracker = new ExternalEditTracker([planDirUri]);
		this._settingsChangeTracker = this._createSettingsChangeTracker();
	}

	/**
	 * Creates and configures the settings change tracker with path resolvers.
	 * Add additional path resolvers here for new file types to track.
	 */
	private _createSettingsChangeTracker(): ClaudeSettingsChangeTracker {
		const tracker = this.instantiationService.createInstance(ClaudeSettingsChangeTracker);

		// Track CLAUDE.md files
		tracker.registerPathResolver(() => {
			const paths: URI[] = [];
			// User-level CLAUDE.md
			paths.push(URI.joinPath(this.envService.userHome, '.claude', 'CLAUDE.md'));
			// Project-level CLAUDE.md files
			for (const folder of this.workspaceService.getWorkspaceFolders()) {
				paths.push(URI.joinPath(folder, '.claude', 'CLAUDE.md'));
				paths.push(URI.joinPath(folder, '.claude', 'CLAUDE.local.md'));
				paths.push(URI.joinPath(folder, 'CLAUDE.md'));
				paths.push(URI.joinPath(folder, 'CLAUDE.local.md'));
			}
			return paths;
		});

		// Track settings/hooks files
		tracker.registerPathResolver(() => {
			const paths: URI[] = [];
			// User-level settings
			paths.push(URI.joinPath(this.envService.userHome, '.claude', 'settings.json'));
			// Project-level settings files
			for (const folder of this.workspaceService.getWorkspaceFolders()) {
				paths.push(URI.joinPath(folder, '.claude', 'settings.json'));
				paths.push(URI.joinPath(folder, '.claude', 'settings.local.json'));
			}
			return paths;
		});

		// Track agent files in agents directories
		tracker.registerDirectoryResolver(() => {
			const dirs: URI[] = [];
			// User-level agents directory
			dirs.push(URI.joinPath(this.envService.userHome, '.claude', 'agents'));
			// Project-level agents directory
			for (const folder of this.workspaceService.getWorkspaceFolders()) {
				dirs.push(URI.joinPath(folder, '.claude', 'agents'));
			}
			return dirs;
		}, '.md');

		return tracker;
	}

	public override dispose(): void {
		this._abortController.abort();
		this._promptQueue.forEach(req => req.deferred.error(new Error('Session disposed')));
		this._promptQueue = [];
		this._pendingPrompt?.error(new Error('Session disposed'));
		this._pendingPrompt = undefined;
		super.dispose();
	}

	/**
	 * Invokes the Claude Code session with a user prompt
	 * @param prompt The user's prompt as an array of content blocks
	 * @param toolInvocationToken Token for invoking tools
	 * @param stream Response stream for sending results back to VS Code
	 * @param token Cancellation token for request cancellation
	 * @param yieldRequested Function to check if the user has requested to interrupt
	 */
	public async invoke(
		prompt: Anthropic.ContentBlockParam[],
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		yieldRequested?: () => boolean
	): Promise<void> {
		if (this._store.isDisposed) {
			throw new Error('Session disposed');
		}

		// Check if settings files have changed since session started
		if (this._queryGenerator && await this._settingsChangeTracker.hasChanges()) {
			this.logService.trace('[ClaudeCodeSession] Settings files changed, restarting session with resume');
			this._restartSession();
		}

		if (!this._queryGenerator) {
			await this._startSession(token);
		}

		// Read current model and permission mode from session state service
		const modelId = this.sessionStateService.getModelIdForSession(this.sessionId);
		const permissionMode = this.sessionStateService.getPermissionModeForSession(this.sessionId);

		// Update model and permission mode on active session if they changed
		if (modelId) {
			await this._setModel(modelId);
		}
		await this._setPermissionMode(permissionMode);

		// Add this request to the queue and wait for completion
		const deferred = new DeferredPromise<void>();
		const request: QueuedRequest = {
			prompt,
			stream,
			toolInvocationToken,
			token,
			yieldRequested,
			deferred
		};

		this._promptQueue.push(request);

		// If there's a pending prompt request, fulfill it immediately
		if (this._pendingPrompt) {
			const pendingPrompt = this._pendingPrompt;
			this._pendingPrompt = undefined;
			pendingPrompt.complete(request);
		}

		return deferred.p;
	}

	/**
	 * Starts a new Claude Code session with the configured options.
	 * Guards against concurrent starts (e.g., from yield restart racing with a new invoke).
	 */
	private async _startSession(token: vscode.CancellationToken): Promise<void> {
		// If a session start is already in progress, wait for it rather than starting a second
		if (this._sessionStarting) {
			await this._sessionStarting;
			return;
		}

		const startPromise = this._doStartSession(token);
		this._sessionStarting = startPromise;
		try {
			await startPromise;
		} finally {
			this._sessionStarting = undefined;
		}
	}

	private async _doStartSession(token: vscode.CancellationToken): Promise<void> {
		const folderInfo = this.sessionStateService.getFolderInfoForSession(this.sessionId);
		if (!folderInfo) {
			throw new Error(`No folder info found for session ${this.sessionId}`);
		}
		const { cwd, additionalDirectories } = folderInfo;

		// Build options for the Claude Code SDK
		this.logService.trace(`appRoot: ${this.envService.appRoot}`);
		const pathSep = isWindows ? ';' : ':';
		const mcpServers = await buildMcpServersFromRegistry(this.instantiationService);
		const options: Options = {
			cwd,
			additionalDirectories,
			// We allow this because we handle the visibility of
			// the permission mode ourselves in the options
			allowDangerouslySkipPermissions: true,
			abortController: this._abortController,
			executable: process.execPath as 'node', // get it to fork the EH node process
			// TODO: CAPI does not yet support the WebSearch tool
			// Once it does, we can re-enable it.
			disallowedTools: ['WebSearch'],
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: `http://localhost:${this.serverConfig.port}`,
				ANTHROPIC_API_KEY: `${this.serverConfig.nonce}.${this.sessionId}`,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				USE_BUILTIN_RIPGREP: '0',
				PATH: `${this.envService.appRoot}/node_modules/@vscode/ripgrep/bin${pathSep}${process.env.PATH}`
			},
			// Handle forking: if forkFromSessionId is set, use resume + forkSession
			// Otherwise, use sessionId for new sessions or resume for existing ones
			...(this.forkFromSessionId
				? { resume: this.forkFromSessionId, forkSession: true, sessionId: this.sessionId }
				: this._isResumed
					? { resume: this.sessionId }
					: { sessionId: this.sessionId }),
			// Pass the model selection to the SDK
			model: this._currentModelId,
			// Pass the permission mode to the SDK
			permissionMode: this._currentPermissionMode,
			hooks: this._buildHooks(token),
			mcpServers,
			canUseTool: async (name, input) => {
				if (!this._currentRequest) {
					return { behavior: 'deny', message: 'No active request' };
				}
				this.logService.trace(`[ClaudeCodeSession]: canUseTool: ${name}(${JSON.stringify(input)})`);
				return this.toolPermissionService.canUseTool(name, input, {
					toolInvocationToken: this._currentRequest.toolInvocationToken,
					permissionMode: this._currentPermissionMode,
					stream: this._currentRequest.stream
				});
			},
			systemPrompt: {
				type: 'preset',
				preset: 'claude_code'
			},
			settingSources: ['user', 'project', 'local'],
			stderr: data => this.logService.error(`claude-agent-sdk stderr: ${data}`)
		};

		this.logService.trace(`claude-agent-sdk: Starting query`);
		this._queryGenerator = await this.claudeCodeService.query({
			prompt: this._createPromptIterable(),
			options
		});

		// Take a snapshot of settings files so we can detect changes
		await this._settingsChangeTracker.takeSnapshot();

		// Start the message processing loop (fire-and-forget, but _processMessages
		// handles all errors internally via try/catch → _cleanup)
		void this._processMessages().catch(err => {
			this.logService.error('[ClaudeCodeSession] Unhandled error in message processing loop', err);
		});
	}

	/**
	 * Builds the hooks configuration by combining registry-based hooks with edit tool hooks.
	 */
	private _buildHooks(token: CancellationToken): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
		const hooks = buildHooksFromRegistry(this.instantiationService);

		// Add edit tool hooks to PreToolUse and PostToolUse
		if (!hooks.PreToolUse) {
			hooks.PreToolUse = [];
		}
		hooks.PreToolUse.push({
			matcher: claudeEditTools.join('|'),
			hooks: [(input, toolID) => this._onWillEditTool(input, toolID, token)]
		});

		if (!hooks.PostToolUse) {
			hooks.PostToolUse = [];
		}
		hooks.PostToolUse.push({
			matcher: claudeEditTools.join('|'),
			hooks: [(input, toolID) => this._onDidEditTool(input, toolID)]
		});

		return hooks;
	}

	private async _onWillEditTool(input: HookInput, toolUseID: string | undefined, token: CancellationToken): Promise<HookJSONOutput> {
		let uris: URI[] = [];
		try {
			uris = getAffectedUrisForEditTool(input as PreToolUseHookInput);
		} catch (error) {
			this.logService.error('Error getting affected URIs for edit tool', error);
		}
		if (!this._currentRequest) {
			return {};
		}

		await this._editTracker.trackEdit(
			toolUseID ?? '',
			uris,
			this._currentRequest.stream,
			token
		);
		return {};
	}

	private async _onDidEditTool(_input: HookInput, toolUseID: string | undefined) {
		await this._editTracker.completeEdit(toolUseID ?? '');
		return {};
	}

	private async *_createPromptIterable(): AsyncIterable<SDKUserMessage> {
		while (true) {
			// Wait for a request to be available
			const request = await this._getNextRequest();

			this._currentRequest = {
				stream: request.stream,
				toolInvocationToken: request.toolInvocationToken,
				token: request.token,
				yieldRequested: request.yieldRequested
			};

			// Increment user-initiated message count for this model
			// This is used by the language model server to track which requests are user-initiated
			this.langModelServer.incrementUserInitiatedMessageCount(this._currentModelId);

			// Create a capturing token for this request to group tool calls under the request
			// we use the last text block in the prompt as the label for the token, since that is most representative of the user's intent
			const promptLabel = request.prompt.filter(p => p.type === 'text').at(-1)?.text ?? 'Claude Session Prompt';
			this.sessionStateService.setCapturingTokenForSession(
				this.sessionId,
				new CapturingToken(promptLabel, 'claude', false)
			);

			yield {
				type: 'user',
				message: {
					role: 'user',
					content: request.prompt
				},
				parent_tool_use_id: null,
				session_id: this.sessionId
			};

			// Wait for this request to complete before yielding the next one
			await request.deferred.p;
		}
	}

	/**
	 * Gets the next request from the queue or waits for one to be available
	 * @returns Promise that resolves with the next queued request
	 */
	private async _getNextRequest(): Promise<QueuedRequest> {
		if (this._promptQueue.length > 0) {
			return this._promptQueue[0]; // Don't shift yet, keep for resolution
		}

		// Wait for a request to be queued
		this._pendingPrompt = new DeferredPromise<QueuedRequest>();
		return this._pendingPrompt.p;
	}

	/**
	 * Processes messages from the Claude Code query generator
	 * Routes messages to appropriate handlers and manages request completion
	 */
	private async _processMessages(): Promise<void> {
		try {
			const unprocessedToolCalls = new Map<string, Anthropic.ToolUseBlock>();
			for await (const message of this._queryGenerator!) {
				// Check if current request was cancelled
				if (this._currentRequest?.token.isCancellationRequested) {
					throw new Error('Request was cancelled');
				}

				// Mark session as resumed after first SDK message confirms session exists on disk.
				// This ensures future restarts (yield, settings change) use `resume` instead of `sessionId`.
				if (message.session_id && !this._isResumed) {
					this._isResumed = true;
				}

				// Check yield before processing to avoid streaming partial responses
				if (await this._checkYieldRequested()) {
					continue;
				}

				// Skip if no current request (e.g., after yield cleared it)
				if (!this._currentRequest) {
					this.logService.trace('[ClaudeCodeSession] Skipping message - no current request');
					continue;
				}

				this.logService.trace(`claude-agent-sdk Message: ${JSON.stringify(message, null, 2)}`);

				if (message.type === 'assistant') {
					// Skip synthetic messages (e.g., "No response requested." from abort)
					if (message.message.model === SYNTHETIC_MODEL_ID) {
						this.logService.trace('[ClaudeCodeSession] Skipping synthetic message');
						continue;
					}
					this.handleAssistantMessage(message, this._currentRequest.stream, unprocessedToolCalls);
				} else if (message.type === 'user') {
					this.handleUserMessage(message, this._currentRequest.stream, unprocessedToolCalls, this._currentRequest.toolInvocationToken, this._currentRequest.token);
				} else if (message.type === 'result') {
					this.handleResultMessage(message, this._currentRequest.stream);
					// Clear the capturing token so subsequent requests get their own
					this.sessionStateService.setCapturingTokenForSession(this.sessionId, undefined);
					// Resolve and remove the completed request
					if (this._promptQueue.length > 0) {
						const completedRequest = this._promptQueue.shift()!;
						await completedRequest.deferred.complete();
					}
					this._currentRequest = undefined;
				}
			}
			// Generator ended normally - clean up so next invoke starts fresh
			this._cleanup(new Error('Session ended unexpectedly'));
		} catch (error) {
			this._cleanup(error as Error);
		}
	}

	private _cleanup(error: Error): void {
		// Clear the capturing token so it doesn't leak across sessions or error boundaries
		this.sessionStateService.setCapturingTokenForSession(this.sessionId, undefined);
		this._resetSessionState();

		const wasYielding = this._yieldInProgress;
		this._yieldInProgress = false;

		if (wasYielding) {
			this._restartAfterYield();
		} else {
			this._rejectPendingRequests(error);
		}
	}

	/**
	 * Resets session state so the next session start can begin fresh.
	 * Preserves the sessionId for SDK resume.
	 */
	private _resetSessionState(): void {
		this._queryGenerator = undefined;
		this._abortController = new AbortController();
		this._currentRequest = undefined;
	}

	/**
	 * After a yield, preserves the queue and restarts the session to process
	 * any pending requests (e.g., the steering message).
	 */
	private _restartAfterYield(): void {
		this.logService.trace(`[ClaudeCodeSession] Yield cleanup, sessionId=${this.sessionId}, pending requests=${this._promptQueue.length}`);

		if (this._promptQueue.length > 0) {
			const nextRequest = this._promptQueue[0];
			void this._startSession(nextRequest.token).catch(err => {
				this.logService.error('[ClaudeCodeSession] Failed to restart session after yield', err);
				this._rejectPendingRequests(err);
			});
		}
	}

	/**
	 * Rejects all pending requests and clears the queue.
	 */
	private _rejectPendingRequests(error: Error): void {
		this._promptQueue.forEach(req => {
			if (!req.deferred.isSettled) {
				req.deferred.error(error);
			}
		});
		this._promptQueue = [];
		if (this._pendingPrompt && !this._pendingPrompt.isSettled) {
			this._pendingPrompt.error(error);
		}
		this._pendingPrompt = undefined;
	}

	/**
	 * Checks if the user has requested to interrupt the current request.
	 * If so, completes the current request gracefully and aborts the SDK to allow the next message.
	 * @returns true if a yield was detected and handled, false otherwise
	 */
	private async _checkYieldRequested(): Promise<boolean> {
		if (!this._currentRequest?.yieldRequested?.()) {
			return false;
		}

		this.logService.trace('[ClaudeCodeSession] Yield requested - interrupting session to allow user interruption');
		this._yieldInProgress = true;

		// Complete the current request gracefully
		if (this._promptQueue.length > 0) {
			const completedRequest = this._promptQueue.shift()!;
			await completedRequest.deferred.complete();
		}
		this._currentRequest = undefined;

		// Signal the SDK to stop generating
		this._abortController.abort();

		return true;
	}

	/**
	 * Restarts the session to pick up settings changes.
	 * Clears the query generator but preserves the session ID for resume.
	 */
	private _restartSession(): void {
		// Clear the generator so _startSession will be called with resume
		this._queryGenerator = undefined;
		this._abortController.abort();
		this._abortController = new AbortController();
		this._isResumed = true;
		// Note: We don't clear the prompt queue or pending prompts here
		// because we're not erroring out, just restarting for settings reload
	}

	/**
	 * Handles assistant messages containing text content and tool use blocks
	 */
	private handleAssistantMessage(
		message: SDKAssistantMessage,
		stream: vscode.ChatResponseStream,
		unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>
	): void {
		for (const item of message.message.content) {
			if (item.type === 'text') {
				stream.markdown(item.text);
			} else if (item.type === 'thinking') {
				stream.push(new ChatResponseThinkingProgressPart(item.thinking));
			} else if (item.type === 'tool_use') {
				unprocessedToolCalls.set(item.id, item);
				const invocation = createFormattedToolInvocation(item, false);
				if (invocation) {
					if (message.parent_tool_use_id) {
						invocation.subAgentInvocationId = message.parent_tool_use_id;
					}
					invocation.enablePartialUpdate = true;
					stream.push(invocation);
				}
			}
		}
	}

	/**
	 * Handles user messages containing tool results
	 */
	private handleUserMessage(
		message: SDKUserMessage,
		stream: vscode.ChatResponseStream,
		unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): void {
		if (Array.isArray(message.message.content)) {
			for (const toolResult of message.message.content) {
				if (toolResult.type === 'tool_result') {
					this.processToolResult(toolResult, stream, unprocessedToolCalls, toolInvocationToken, token);
				}
			}
		}
	}

	/**
	 * Processes individual tool results and handles special tool types
	 */
	private processToolResult(
		toolResult: Anthropic.Messages.ToolResultBlockParam,
		stream: vscode.ChatResponseStream,
		unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): void {
		const toolUse = unprocessedToolCalls.get(toolResult.tool_use_id!);
		if (!toolUse) {
			return;
		}

		unprocessedToolCalls.delete(toolResult.tool_use_id!);
		const invocation = createFormattedToolInvocation(toolUse, true);
		if (invocation) {
			invocation.enablePartialUpdate = true;
			invocation.isComplete = true;
			invocation.isError = toolResult.is_error;
			if (toolResult.content === ClaudeCodeSession.DenyToolMessage) {
				invocation.isConfirmed = false;
			}
			// Populate tool output for display in chat UI
			completeToolInvocation(toolUse, toolResult, invocation);
		}

		if (toolUse.name === ClaudeToolNames.TodoWrite) {
			this.processTodoWriteTool(toolUse, toolInvocationToken, token);
		}

		if (invocation) {
			stream.push(invocation);
		}
	}

	/**
	 * Handles the TodoWrite tool by converting Claude's todo format to the core todo list format
	 */
	private processTodoWriteTool(
		toolUse: Anthropic.ToolUseBlock,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): void {
		const input = toolUse.input as TodoWriteInput;
		this.toolsService.invokeTool(ToolName.CoreManageTodoList, {
			input: {
				operation: 'write',
				todoList: input.todos.map((todo, i) => ({
					id: i,
					title: todo.content,
					description: '',
					status: todo.status === 'pending' ?
						'not-started' :
						(todo.status === 'in_progress' ?
							'in-progress' :
							'completed')
				} satisfies IManageTodoListToolInputParams['todoList'][number])),
			} satisfies IManageTodoListToolInputParams,
			toolInvocationToken,
		}, token);
	}

	/**
	 * Handles result messages that indicate completion or errors
	 */
	private handleResultMessage(
		message: SDKResultMessage,
		stream: vscode.ChatResponseStream
	): void {
		if (message.subtype === 'error_max_turns') {
			stream.progress(l10n.t('Maximum turns reached ({0})', message.num_turns));
		} else if (message.subtype === 'error_during_execution') {
			throw new KnownClaudeError(l10n.t('Error during execution'));
		}
	}

}

interface IManageTodoListToolInputParams {
	readonly operation?: 'write' | 'read'; // Optional in write-only mode
	readonly todoList: readonly {
		readonly id: number;
		readonly title: string;
		readonly description: string;
		readonly status: 'not-started' | 'in-progress' | 'completed';
	}[];
}
