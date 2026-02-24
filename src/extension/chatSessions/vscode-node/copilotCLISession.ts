/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionRequest, PermissionRequestResult, CopilotSession as SDKCopilotSession } from '@github/copilot-sdk';
import type { Attachment, SessionEvent as OldSessionEvent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger, LoggedRequestKind } from '../../../platform/requestLogger/node/requestLogger';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { DeferredPromise } from '../../../util/vs/base/common/async';
import { Codicon } from '../../../util/vs/base/common/codicons';
import { Emitter } from '../../../util/vs/base/common/event';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { extUriBiasedIgnorePathCase } from '../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, ChatToolInvocationPart, Uri } from '../../../vscodeTypes';
import { ExternalEditTracker } from '../../agents/common/externalEditTracker';
import {
	buildChatHistoryFromEvents,
	getAffectedUrisForEditTool,
	isCopilotCliEditToolCall,
	processToolExecutionComplete,
	processToolExecutionStart,
	ToolCall,
	UnknownToolCall,
	updateTodoList,
} from '../../agents/copilotcli/common/copilotCLITools';
import { IChatDelegationSummaryService } from '../../agents/copilotcli/common/delegationSummaryService';
import { ICopilotCLIImageSupport } from '../../agents/copilotcli/node/copilotCLIImageSupport';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { requestPermission, requiresFileEditconfirmation } from '../../agents/copilotcli/node/permissionHelpers2';
import { IUserQuestionHandler, UserInputRequest, UserInputResponse } from '../../agents/copilotcli/node/userInputHelpers';
import { IToolsService } from '../../tools/common/toolsService';

/**
 * Known commands that can be sent to a CopilotCLI session instead of a free-form prompt.
 */
type CopilotCLICommand = 'compact';
const copilotCLICommands: readonly CopilotCLICommand[] = ['compact'] as const;

function isCopilotCLIPlanAgent(modeInstructions: { name?: string; content?: string }): boolean {
	return modeInstructions.name === 'plan';
}

/**
 * Converts prompt resolver attachments (typed as `Attachment` from `@github/copilot/sdk`)
 * to the format expected by CopilotSession.send() from `@github/copilot-sdk`.
 */
function toSDKAttachments(attachments: unknown[]): Array<{ type: 'file'; path: string; displayName?: string } | { type: 'directory'; path: string; displayName?: string } | { type: 'selection'; filePath: string; displayName: string; selection?: { start: { line: number; character: number }; end: { line: number; character: number } }; text?: string }> {
	return (attachments as Attachment[]).map(a => {
		if (a.type === 'selection') {
			return { type: 'selection' as const, filePath: a.filePath, displayName: a.displayName, selection: a.selection, text: a.text };
		} else if (a.type === 'directory') {
			return { type: 'directory' as const, path: a.path, displayName: a.displayName };
		}
		return { type: 'file' as const, path: a.path, displayName: a.displayName };
	});
}

/**
 * Wraps a `CopilotSession` from `@github/copilot-sdk` for execution.
 *
 * This class owns:
 * - Prompt resolution (via `CopilotCLIPromptResolver`)
 * - Event subscriptions → stream translation
 * - Permission handling (registered once in ctor, uses mutable per-request context)
 * - User input handling (registered once in ctor)
 * - Edit tracking via `ExternalEditTracker`
 * - Status and title tracking
 *
 * It is long-lived: created once per session ID and reused across multiple
 * `handleRequest()` calls.
 */
export class CopilotSDKSession extends DisposableStore {
	public readonly sessionId: string;

	private _status?: vscode.ChatSessionStatus;
	public get status(): vscode.ChatSessionStatus | undefined {
		return this._status;
	}
	private readonly _statusChange = this.add(new Emitter<vscode.ChatSessionStatus | undefined>());
	public readonly onDidChangeStatus = this._statusChange.event;

	private _title?: string;
	public get title(): string | undefined {
		return this._title;
	}
	private readonly _onDidChangeTitle = this.add(new Emitter<string>());
	public readonly onDidChangeTitle = this._onDidChangeTitle.event;

	// Mutable per-request context. Set at the start of _handleRequestImpl, cleared in finally.
	// The permission/user-input handlers (registered once in ctor) access these via `this`.
	private _currentStream?: vscode.ChatResponseStream;
	private _currentRequest?: vscode.ChatRequest;
	private _currentToken?: vscode.CancellationToken;
	// Edit tracker and tool calls are also per-request, used by permission handler for edit tracking.
	private _currentEditTracker?: ExternalEditTracker;
	private _currentToolCalls?: Map<string, ToolCall>;

	public get isolationEnabled(): boolean {
		return this._isolationEnabled;
	}

	public get workingDirectory(): Uri | undefined {
		return this._workingDirectory;
	}

	constructor(
		private readonly _sdkSession: SDKCopilotSession,
		private readonly _isolationEnabled: boolean,
		private readonly _workingDirectory: Uri | undefined,
		private readonly _promptResolver: CopilotCLIPromptResolver,
		private readonly _logService: ILogService,
		private readonly _workspaceService: IWorkspaceService,
		private readonly _delegationSummaryService: IChatDelegationSummaryService,
		private readonly _requestLogger: IRequestLogger,
		private readonly _imageSupport: ICopilotCLIImageSupport,
		private readonly _toolsService: IToolsService,
		private readonly _instantiationService: IInstantiationService,
		private readonly _userQuestionHandler: IUserQuestionHandler,
	) {
		super();
		this.sessionId = _sdkSession.sessionId;

		// Register permission handler once — persists for the lifetime of the session.
		_sdkSession.registerPermissionHandler(async (req) => {
			return this._handlePermission(req as PermissionRequest);
		});

		// Register user input handler once — persists for the lifetime of the session.
		_sdkSession.registerUserInputHandler(async (req) => {
			return this._handleUserInput(req as UserInputRequest);
		});
	}

	/**
	 * Switch the model used by this session. Called by the provider before handleRequest
	 * when the user changes the model between requests.
	 */
	public async setModelId(modelId: string): Promise<void> {
		const current = await this._sdkSession.rpc.model.getCurrent();
		if (current.modelId !== modelId) {
			await this._sdkSession.rpc.model.switchTo({ modelId });
		}
	}

	/**
	 * Get the currently selected model ID.
	 */
	public async getSelectedModelId(): Promise<string | undefined> {
		const result = await this._sdkSession.rpc.model.getCurrent();
		return result.modelId;
	}

	/**
	 * Get the chat history for this session, converted to VS Code turn format.
	 */
	public async getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]> {
		const events = await this._sdkSession.getMessages();
		const modelId = await this.getSelectedModelId();
		return buildChatHistoryFromEvents(
			this.sessionId,
			modelId,
			events as unknown as OldSessionEvent[],
			() => undefined,
			this._delegationSummaryService,
			this._logService,
			this._workingDirectory
		);
	}

	public addUserMessage(content: string): void {
		this._logService.trace(`[CopilotSDKSession] addUserMessage called for session ${this.sessionId}`);
	}

	public addUserAssistantMessage(content: string): void {
		this._logService.trace(`[CopilotSDKSession] addUserAssistantMessage called for session ${this.sessionId}`);
	}

	/**
	 * The single entry point for request execution.
	 *
	 * Determines whether the request is a command or a prompt, resolves the prompt
	 * via CopilotCLIPromptResolver if needed, subscribes to SDK events, sends the
	 * message, and waits for idle.
	 */
	public handleRequest(
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		const promptText = request.command ? `/${request.command}` : request.prompt;
		const label = promptText.length > 50 ? promptText.substring(0, 47) + '...' : promptText;
		const capturingToken = new CapturingToken(`Background Agent | ${label}`, 'worktree', false, true);
		return this._requestLogger.captureInvocation(capturingToken, () =>
			this._handleRequestImpl(request, stream, token)
		);
	}

	// ── Core request implementation ──────────────────────────────────────

	private async _handleRequestImpl(
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Session disposed');
		}

		this._status = ChatSessionStatus.InProgress;
		this._statusChange.fire(this._status);
		this._logService.info(`[CopilotSDKSession] Invoking session ${this.sessionId}`);

		// Set per-request context for the registered handlers to use.
		this._currentStream = stream;
		this._currentRequest = request;
		this._currentToken = token;

		const disposables = this.add(new DisposableStore());

		// Per-request tracking state
		const chunkMessageIds = new Set<string>();
		const pendingToolInvocations = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, ToolCall]>();
		const toolNames = new Map<string, string>();
		const toolCalls = new Map<string, ToolCall>();
		const editToolIds = new Set<string>();
		const editTracker = new ExternalEditTracker();
		const editFilesAndToolCallIds = new ResourceMap<ToolCall[]>();
		const toolIdEditMap = new Map<string, Promise<string | undefined>>();

		// Expose to permission handler
		this._currentEditTracker = editTracker;
		this._currentToolCalls = toolCalls;

		// Idle promise: we wait for the SDK to signal session.idle
		const idlePromise = new DeferredPromise<void>();
		const unsubscribeFns: (() => void)[] = [];

		try {
			// ── Subscribe to SDK session events ─────────────────────────────

			unsubscribeFns.push(this._sdkSession.on('session.idle', () => {
				idlePromise.complete(undefined);
			}));

			unsubscribeFns.push(this._sdkSession.on('session.title_changed', (event) => {
				this._title = event.data.title;
				this._onDidChangeTitle.fire(event.data.title);
			}));

			unsubscribeFns.push(this._sdkSession.on('assistant.usage', (event) => {
				if (typeof event.data.outputTokens === 'number' && typeof event.data.inputTokens === 'number') {
					stream.usage({ completionTokens: event.data.outputTokens, promptTokens: event.data.inputTokens });
				}
			}));

			unsubscribeFns.push(this._sdkSession.on('assistant.message_delta', (event) => {
				if (typeof event.data.deltaContent === 'string' && event.data.deltaContent.length) {
					chunkMessageIds.add(event.data.messageId);
					stream.markdown(event.data.deltaContent);
				}
			}));

			unsubscribeFns.push(this._sdkSession.on('assistant.message', (event) => {
				if (typeof event.data.content === 'string' && event.data.content.length && !chunkMessageIds.has(event.data.messageId)) {
					stream.markdown(event.data.content);
				}
			}));

			unsubscribeFns.push(this._sdkSession.on('tool.execution_start', (event) => {
				toolNames.set(event.data.toolCallId, event.data.toolName);
				toolCalls.set(event.data.toolCallId, event.data as unknown as ToolCall);
				if (isCopilotCliEditToolCall(event.data)) {
					editToolIds.add(event.data.toolCallId);
					const editUris = getAffectedUrisForEditTool(event.data);
					if (editUris.length) {
						for (const uri of editUris) {
							const ids = editFilesAndToolCallIds.get(uri) || [];
							ids.push(event.data as UnknownToolCall as ToolCall);
							editFilesAndToolCallIds.set(uri, ids);
						}
					}
				} else {
					const responsePart = processToolExecutionStart(
						event as unknown as Parameters<typeof processToolExecutionStart>[0],
						pendingToolInvocations,
						this._workingDirectory
					);
					if (responsePart instanceof ChatResponseThinkingProgressPart) {
						stream.push(responsePart);
						stream.push(new ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
					} else if (responsePart instanceof ChatToolInvocationPart) {
						responsePart.enablePartialUpdate = true;
						stream.push(responsePart);

						if ((event.data as unknown as ToolCall).toolName === 'update_todo') {
							updateTodoList(
								event as unknown as Parameters<typeof updateTodoList>[0],
								this._toolsService,
								request.toolInvocationToken,
								token
							).catch(error => {
								this._logService.error(`[CopilotSDKSession] Failed to invoke todo tool for toolCallId ${event.data.toolCallId}`, error);
							});
						}
					}
				}
			}));

			unsubscribeFns.push(this._sdkSession.on('tool.execution_complete', (event) => {
				const toolName = toolNames.get(event.data.toolCallId) || '<unknown>';
				const eventError = event.data.error ? { ...event.data.error, code: (event.data.error as { code?: string }).code || '' } : undefined;
				const eventData = { ...event.data, error: eventError };

				this._requestLogger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: `Tool: ${toolName}`,
					startTimeMs: Date.now(),
					icon: Codicon.tools,
					markdownContent: `Tool: ${toolName}\nResult: ${JSON.stringify(eventData).substring(0, 500)}`,
					isConversationRequest: true,
				});

				toolIdEditMap.set(event.data.toolCallId, editTracker.completeEdit(event.data.toolCallId));
				if (editToolIds.has(event.data.toolCallId)) {
					return;
				}

				const [responsePart] = processToolExecutionComplete(
					event as unknown as Parameters<typeof processToolExecutionComplete>[0],
					pendingToolInvocations,
					this._logService,
					this._workingDirectory
				) ?? [];
				if (responsePart) {
					if (responsePart instanceof ChatToolInvocationPart) {
						responsePart.enablePartialUpdate = true;
					}
					stream.push(responsePart);
				}
			}));

			unsubscribeFns.push(this._sdkSession.on('session.error', (event) => {
				this._logService.error(`[CopilotSDKSession] CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
				stream.markdown(`\n\n❌ Error: (${event.data.errorType}) ${event.data.message}`);
				this._requestLogger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'Session Error',
					startTimeMs: Date.now(),
					icon: Codicon.error,
					markdownContent: [`# Error Details`, `Type: ${event.data.errorType}`, `Message: ${event.data.message}`, `## Stack`, event.data.stack || ''].join('\n'),
					isConversationRequest: true,
				});
			}));

			// ── Register cancellation ───────────────────────────────────────

			disposables.add(token.onCancellationRequested(() => {
				this._sdkSession.abort().catch(err => {
					this._logService.error('[CopilotSDKSession] Error aborting session', err);
				});
			}));

			// ── Determine what to send ──────────────────────────────────────

			if (!token.isCancellationRequested) {
				if (request.command && (copilotCLICommands as readonly string[]).includes(request.command)) {
					stream.progress(l10n.t('Compacting conversation...'));
					await this._sdkSession.send({ prompt: `/${request.command}` });
				} else if (request.command) {
					await this._sdkSession.send({ prompt: `/${request.command}` });
				} else {
					const plan = request.modeInstructions2 ? isCopilotCLIPlanAgent(request.modeInstructions2) : false;
					await this._setMode(plan);

					const { prompt, attachments } = await this._promptResolver.resolvePrompt(
						request, undefined, [], this._isolationEnabled, this._workingDirectory, token
					);

					await this._sdkSession.send({ prompt, attachments: toSDKAttachments(attachments) });
				}
			}

			// Wait for the SDK to signal idle
			if (!token.isCancellationRequested) {
				await idlePromise.p;
			}

			this._logService.trace(`[CopilotSDKSession] Invoking session (completed) ${this.sessionId}`);
			this._status = ChatSessionStatus.Completed;
			this._statusChange.fire(this._status);
		} catch (error) {
			this._status = ChatSessionStatus.Failed;
			this._statusChange.fire(this._status);
			this._logService.error(`[CopilotSDKSession] Invoking session (error) ${this.sessionId}`, error);
			stream.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			// Clear per-request context
			this._currentStream = undefined;
			this._currentRequest = undefined;
			this._currentToken = undefined;
			this._currentEditTracker = undefined;
			this._currentToolCalls = undefined;

			for (const unsub of unsubscribeFns) {
				unsub();
			}
			disposables.dispose();
		}
	}

	// ── Permission handling ─────────────────────────────────────────────

	/**
	 * Handles permission requests from the SDK. Registered once in the
	 * constructor; uses mutable per-request context fields.
	 */
	private async _handlePermission(
		permissionRequest: PermissionRequest,
	): Promise<PermissionRequestResult> {
		const stream = this._currentStream;
		const token = this._currentToken;
		const editTracker = this._currentEditTracker;
		const toolCalls = this._currentToolCalls;

		// Between requests, deny everything (safe default)
		if (!stream || !token) {
			return { kind: 'denied-interactively-by-user' };
		}

		const workingDirectory = this._workingDirectory?.fsPath;

		// Auto-approve reads inside workspace or working directory
		if (permissionRequest.kind === 'read' && typeof permissionRequest.path === 'string') {
			const data = Uri.file(permissionRequest.path);
			if (this._imageSupport.isTrustedImage(data)) {
				return { kind: 'approved' };
			}
			if (workingDirectory && extUriBiasedIgnorePathCase.isEqualOrParent(data, Uri.file(workingDirectory))) {
				return { kind: 'approved' };
			}
			if (this._workspaceService.getWorkspaceFolder(data)) {
				return { kind: 'approved' };
			}
		}

		// Auto-approve writes in isolated working directory or workspace (unless protected files)
		const toolCall = permissionRequest.toolCallId && toolCalls ? toolCalls.get(permissionRequest.toolCallId) : undefined;
		const editFiles = toolCall ? getAffectedUrisForEditTool(toolCall) : undefined;
		const editFile = permissionRequest.kind === 'write'
			? (editFiles && editFiles.length ? editFiles[0] : (typeof permissionRequest.fileName === 'string' ? Uri.file(permissionRequest.fileName) : undefined))
			: undefined;

		if (workingDirectory && permissionRequest.kind === 'write' && editFile) {
			const isWorkspaceFile = this._workspaceService.getWorkspaceFolder(editFile);
			const isWorkingDirectoryFile = !this._workspaceService.getWorkspaceFolder(Uri.file(workingDirectory))
				&& extUriBiasedIgnorePathCase.isEqualOrParent(editFile, Uri.file(workingDirectory));

			let autoApprove = false;
			if (this._isolationEnabled && isWorkingDirectoryFile) {
				autoApprove = true;
			}
			if (!autoApprove && isWorkspaceFile && !(await requiresFileEditconfirmation(this._instantiationService, permissionRequest, toolCall))) {
				autoApprove = true;
			}

			if (autoApprove) {
				// Track the edit & wait for VS Code to acknowledge it
				if (toolCall && editTracker) {
					await editTracker.trackEdit(toolCall.toolCallId, [editFile], stream);
				}
				return { kind: 'approved' };
			}
		}

		// Interactive approval via permission confirmation tools
		if (this._currentRequest) {
			try {
				const approved = await requestPermission(
					this._instantiationService,
					permissionRequest,
					toolCall,
					this._toolsService,
					this._currentRequest.toolInvocationToken,
					token
				);
				if (approved) {
					if (editFile && toolCall && editTracker) {
						await editTracker.trackEdit(toolCall.toolCallId, [editFile], stream);
					}
					return { kind: 'approved' };
				}
			} catch (error) {
				this._logService.error(`[CopilotSDKSession] Permission request error: ${error}`);
			}
		}

		return { kind: 'denied-interactively-by-user' };
	}

	// ── User input handling ─────────────────────────────────────────────

	/**
	 * Handles user input requests from the SDK (ask_user tool).
	 * Registered once in the constructor; uses mutable per-request context.
	 */
	private async _handleUserInput(
		userInputRequest: UserInputRequest,
	): UserInputResponse {
		const stream = this._currentStream;
		const token = this._currentToken;

		if (!stream || !this._currentRequest || !token) {
			throw new Error('User skipped question');
		}

		const answer = await this._userQuestionHandler.askUserQuestion(
			userInputRequest,
			stream,
			this._currentRequest.toolInvocationToken,
			token
		);
		if (!answer) {
			throw new Error('User skipped question');
		}
		return answer;
	}

	// ── Mode setting ────────────────────────────────────────────────────

	private async _setMode(plan: boolean): Promise<void> {
		const mode = plan ? 'plan' : 'interactive';
		try {
			await this._sdkSession.rpc.mode.set({ mode });
		} catch {
			// Mode setting may not be supported; continue
		}
	}
}
