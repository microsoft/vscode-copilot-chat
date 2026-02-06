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
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { isLocation } from '../../../../util/common/types';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable, DisposableMap } from '../../../../util/vs/base/common/lifecycle';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseThinkingProgressPart } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { buildHooksFromRegistry } from '../common/claudeHookRegistry';
import { IClaudeToolPermissionService } from '../common/claudeToolPermissionService';
import { claudeEditTools, ClaudeToolNames, getAffectedUrisForEditTool } from '../common/claudeTools';
import { createFormattedToolInvocation } from '../common/toolInvocationFormatter';
import { IClaudeCodeSdkService } from './claudeCodeSdkService';
import { ClaudeLanguageModelServer, IClaudeLanguageModelServerConfig } from './claudeLanguageModelServer';
import { ClaudeSettingsChangeTracker } from './claudeSettingsChangeTracker';

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
	) {
		super();
	}

	public async handleRequest(claudeSessionId: string | undefined, request: vscode.ChatRequest, _context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, modelId: string, permissionMode?: PermissionMode): Promise<vscode.ChatResult & { claudeSessionId?: string }> {
		try {
			// Get server config, start server if needed
			const langModelServer = await this.getLangModelServer();
			const serverConfig = langModelServer.getConfig();

			const sessionIdForLog = claudeSessionId ?? 'new';
			this.logService.trace(`[ClaudeAgentManager] Handling request for sessionId=${sessionIdForLog}, modelId=${modelId}, permissionMode=${permissionMode}.`);
			let session: ClaudeCodeSession;
			if (claudeSessionId && this._sessions.has(claudeSessionId)) {
				this.logService.trace(`[ClaudeAgentManager] Reusing Claude session ${claudeSessionId}.`);
				session = this._sessions.get(claudeSessionId)!;
			} else {
				this.logService.trace(`[ClaudeAgentManager] Creating Claude session for sessionId=${sessionIdForLog}.`);
				const newSession = this.instantiationService.createInstance(ClaudeCodeSession, serverConfig, langModelServer, claudeSessionId, modelId, permissionMode);
				if (newSession.sessionId) {
					this._sessions.set(newSession.sessionId, newSession);
				}
				session = newSession;
			}

			await session.invoke(
				this.resolvePrompt(request),
				request.toolInvocationToken,
				stream,
				token,
				modelId,
				permissionMode
			);

			// Store the session if sessionId was assigned during invoke
			if (session.sessionId && !this._sessions.has(session.sessionId)) {
				this.logService.trace(`[ClaudeAgentManager] Tracking Claude session ${claudeSessionId} -> ${session.sessionId}`);
				this._sessions.set(session.sessionId, session);
			}

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

	private resolvePrompt(request: vscode.ChatRequest): Anthropic.TextBlockParam[] {
		if (request.prompt.startsWith('/')) {
			return [{ type: 'text', text: request.prompt }]; // likely a slash command, don't modify
		}

		const contentBlocks: Anthropic.TextBlockParam[] = [];
		const extraRefsTexts: string[] = [];
		let prompt = request.prompt;
		request.references.forEach(ref => {
			const valueText = URI.isUri(ref.value) ?
				ref.value.fsPath :
				isLocation(ref.value) ?
					`${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}` :
					undefined;
			if (valueText) {
				if (ref.range) {
					prompt = prompt.slice(0, ref.range[0]) + valueText + prompt.slice(ref.range[1]);
				} else {
					extraRefsTexts.push(`- ${valueText}`);
				}
			}
		});

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
	readonly prompt: Anthropic.TextBlockParam[];
	readonly stream: vscode.ChatResponseStream;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken;
	readonly token: vscode.CancellationToken;
	readonly deferred: DeferredPromise<void>;
}

/**
 * Represents the currently active request being processed
 */
interface CurrentRequest {
	readonly stream: vscode.ChatResponseStream;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken;
	readonly token: vscode.CancellationToken;
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
		public sessionId: string | undefined,
		initialModelId: string,
		initialPermissionMode: PermissionMode | undefined,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IToolsService private readonly toolsService: IToolsService,
		@IClaudeCodeSdkService private readonly claudeCodeService: IClaudeCodeSdkService,
		@IClaudeToolPermissionService private readonly toolPermissionService: IClaudeToolPermissionService,
	) {
		super();
		this._currentModelId = initialModelId;
		this._currentPermissionMode = initialPermissionMode ?? 'acceptEdits';
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
	 * @param modelId Model ID to use for this request
	 */
	public async invoke(
		prompt: Anthropic.TextBlockParam[],
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		modelId: string,
		permissionMode?: PermissionMode
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

		// Update model and permission mode on active session if they changed
		await this._setModel(modelId);

		if (permissionMode !== undefined) {
			await this._setPermissionMode(permissionMode);
		}

		// Add this request to the queue and wait for completion
		const deferred = new DeferredPromise<void>();
		const request: QueuedRequest = {
			prompt,
			stream,
			toolInvocationToken,
			token,
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
	 * Starts a new Claude Code session with the configured options
	 */
	private async _startSession(token: vscode.CancellationToken): Promise<void> {
		const directories = this.workspaceService.getWorkspaceFolders().map(folder => folder.fsPath);
		let additionalDirectories: string[] | undefined = directories;
		let cwd: string | undefined;
		// For single-root workspaces, set cwd to the root and no additional directories
		// For empty or multi-root workspaces, don't set cwd
		if (directories.length === 1) {
			cwd = directories[0];
			additionalDirectories = [];
		}

		// Build options for the Claude Code SDK
		this.logService.trace(`appRoot: ${this.envService.appRoot}`);
		const pathSep = isWindows ? ';' : ':';
		const options: Options = {
			// cwd being undefined means the SDK will use process.cwd()
			// we do this for multi-root workspaces or no workspace
			// ideally there would be a better value for multi-root workspaces
			// but the SDK currently only supports a single cwd which is used
			// for history files
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
				ANTHROPIC_API_KEY: this.serverConfig.nonce,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				USE_BUILTIN_RIPGREP: '0',
				PATH: `${this.envService.appRoot}/node_modules/@vscode/ripgrep/bin${pathSep}${process.env.PATH}`
			},
			resume: this.sessionId,
			// Pass the model selection to the SDK
			model: this._currentModelId,
			// Pass the permission mode to the SDK
			...(this._currentPermissionMode !== undefined ? { permissionMode: this._currentPermissionMode } : {}),
			hooks: this._buildHooks(token),
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

		// Start the message processing loop
		this._processMessages();
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
				token: request.token
			};

			// Increment user-initiated message count for this model
			// This is used by the language model server to track which requests are user-initiated
			this.langModelServer.incrementUserInitiatedMessageCount(this._currentModelId);

			yield {
				type: 'user',
				message: {
					role: 'user',
					content: request.prompt
				},
				parent_tool_use_id: null,
				session_id: this.sessionId ?? ''
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
			const pushedToolInvocationIds = new Set<string>();
			for await (const message of this._queryGenerator!) {
				// Check if current request was cancelled
				if (this._currentRequest?.token.isCancellationRequested) {
					throw new Error('Request was cancelled');
				}

				this.logService.trace(`claude-agent-sdk Message: ${JSON.stringify(message, null, 2)}`);
				if (message.session_id) {
					this.sessionId = message.session_id;
				}

				if (message.type === 'assistant') {
					this.handleAssistantMessage(message, this._currentRequest!.stream, unprocessedToolCalls, pushedToolInvocationIds);
				} else if (message.type === 'user') {
					this.handleUserMessage(message, this._currentRequest!.stream, unprocessedToolCalls, pushedToolInvocationIds, this._currentRequest!.toolInvocationToken, this._currentRequest!.token);
				} else if (message.type === 'result') {
					this.handleResultMessage(message, this._currentRequest!.stream);
					// Resolve and remove the completed request
					if (this._promptQueue.length > 0) {
						const completedRequest = this._promptQueue.shift()!;
						completedRequest.deferred.complete();
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
		// Reset session state so the next invoke() can start a fresh session
		this._queryGenerator = undefined;
		this._abortController.abort();
		this._abortController = new AbortController();
		this._currentRequest = undefined;
		// Reject all pending requests
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
	 * Restarts the session to pick up settings changes.
	 * Clears the query generator but preserves the session ID for resume.
	 */
	private _restartSession(): void {
		// Clear the generator so _startSession will be called with resume
		this._queryGenerator = undefined;
		this._abortController.abort();
		this._abortController = new AbortController();
		// Note: We don't clear the prompt queue or pending prompts here
		// because we're not erroring out, just restarting for settings reload
	}

	/**
	 * Handles assistant messages containing text content and tool use blocks
	 */
	private handleAssistantMessage(
		message: SDKAssistantMessage,
		stream: vscode.ChatResponseStream,
		unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>,
		pushedToolInvocationIds: Set<string>
	): void {
		for (const item of message.message.content) {
			if (item.type === 'text') {
				stream.markdown(item.text);
			} else if (item.type === 'thinking') {
				stream.push(new ChatResponseThinkingProgressPart(item.thinking));
			} else if (item.type === 'tool_use') {
				unprocessedToolCalls.set(item.id, item);
				// Push tool invocation immediately so it appears in "running" state
				const invocation = createFormattedToolInvocation(item);
				if (invocation) {
					stream.push(invocation);
					pushedToolInvocationIds.add(item.id);
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
		pushedToolInvocationIds: Set<string>,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): void {
		if (Array.isArray(message.message.content)) {
			for (const toolResult of message.message.content) {
				if (toolResult.type === 'tool_result') {
					this.processToolResult(toolResult, stream, unprocessedToolCalls, pushedToolInvocationIds, toolInvocationToken, token);
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
		pushedToolInvocationIds: Set<string>,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): void {
		const toolUse = unprocessedToolCalls.get(toolResult.tool_use_id!);
		if (!toolUse) {
			return;
		}

		unprocessedToolCalls.delete(toolResult.tool_use_id!);
		
		// Only push a new invocation if we haven't already pushed one
		if (!pushedToolInvocationIds.has(toolUse.id)) {
			const invocation = createFormattedToolInvocation(toolUse);
			if (invocation) {
				invocation.isError = toolResult.is_error;
				if (toolResult.content === ClaudeCodeSession.DenyToolMessage) {
					invocation.isConfirmed = false;
				}
				stream.push(invocation);
			}
		} else {
			// Tool invocation was already pushed in handleAssistantMessage.
			// We cannot update the invocation's error or confirmation status after it's been pushed,
			// as the ChatToolInvocationPart is immutable once in the stream.
			// This means denied tools will show as confirmed, but this is preferable to duplicate invocations.
			pushedToolInvocationIds.delete(toolUse.id);
		}

		if (toolUse.name === ClaudeToolNames.TodoWrite) {
			this.processTodoWriteTool(toolUse, toolInvocationToken, token);
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
