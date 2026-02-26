/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, Session, SessionOptions } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import type { ChatParticipantToolToken } from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { CapturingToken } from '../../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger, LoggedRequestKind } from '../../../../platform/requestLogger/node/requestLogger';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { raceCancellation } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Codicon } from '../../../../util/vs/base/common/codicons';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { DisposableStore, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { extUriBiasedIgnorePathCase } from '../../../../util/vs/base/common/resources';
import { ThemeIcon } from '../../../../util/vs/base/common/themables';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, ChatToolInvocationPart, EventEmitter, Uri } from '../../../../vscodeTypes';
import { IToolsService } from '../../../tools/common/toolsService';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { buildChatHistoryFromEvents, getAffectedUrisForEditTool, isCopilotCliEditToolCall, processToolExecutionComplete, processToolExecutionStart, ToolCall, UnknownToolCall, updateTodoList } from '../common/copilotCLITools';
import { IChatDelegationSummaryService } from '../common/delegationSummaryService';
import { CopilotCLISessionOptions, ICopilotCLISDK } from './copilotCli';
import { ICopilotCLIImageSupport } from './copilotCLIImageSupport';
import { PermissionRequest, requiresFileEditconfirmation } from './permissionHelpers';
import { IUserQuestionHandler, UserInputRequest, UserInputResponse } from './userInputHelpers';

/**
 * Known commands that can be sent to a CopilotCLI session instead of a free-form prompt.
 */
export type CopilotCLICommand = 'compact';

/**
 * The set of all known CopilotCLI commands.  Used by callers that need to
 * distinguish a slash-command from a regular prompt at runtime.
 */
export const copilotCLICommands: readonly CopilotCLICommand[] = ['compact'] as const;

/**
 * Discriminated-union input for {@link ICopilotCLISession.handleRequest}.
 *
 * Either a free-form prompt **or** a known command.
 */
export type CopilotCLISessionInput =
	| { readonly prompt: string; plan?: boolean }
	| { readonly command: CopilotCLICommand };

type PermissionHandler = (
	permissionRequest: PermissionRequest,
	toolCall: ToolCall | undefined,
	token: CancellationToken,
) => Promise<boolean>;

type UserInputHandler = (
	userInputRequest: UserInputRequest,
	toolCall: ToolCall | undefined,
	token: CancellationToken,
) => Promise<UserInputResponse>;

export interface ICopilotCLISession extends IDisposable {
	readonly sessionId: string;
	readonly title?: string;
	readonly onDidChangeTitle: vscode.Event<string>;
	readonly status: vscode.ChatSessionStatus | undefined;
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;
	readonly permissionRequested?: PermissionRequest;
	readonly onPermissionRequested: vscode.Event<PermissionRequest>;
	readonly options: {
		readonly isolationEnabled: boolean;
		readonly workingDirectory?: Uri;
	};
	readonly pendingPrompt: string | undefined;
	attachPermissionHandler(handler: PermissionHandler): IDisposable;
	attachStream(stream: vscode.ChatResponseStream): IDisposable;
	handleRequest(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		modelId: string | undefined,
		authInfo: NonNullable<SessionOptions['authInfo']>,
		token: vscode.CancellationToken
	): Promise<void>;
	addUserMessage(content: string): void;
	addUserAssistantMessage(content: string): void;
	getSelectedModelId(): Promise<string | undefined>;
	getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]>;
}

export class CopilotCLISession extends DisposableStore implements ICopilotCLISession {
	public readonly sessionId: string;
	private _status?: vscode.ChatSessionStatus;
	public get status(): vscode.ChatSessionStatus | undefined {
		return this._status;
	}
	private readonly _statusChange = this.add(new EventEmitter<vscode.ChatSessionStatus | undefined>());

	public readonly onDidChangeStatus = this._statusChange.event;

	private _permissionRequested?: PermissionRequest;
	public get permissionRequested(): PermissionRequest | undefined {
		return this._permissionRequested;
	}
	private readonly _onPermissionRequested = this.add(new EventEmitter<PermissionRequest>());
	public readonly onPermissionRequested = this._onPermissionRequested.event;
	private _permissionHandler?: PermissionHandler;
	private readonly _permissionHandlerSet = this.add(new Emitter<void>());
	private readonly _onUserInputRequested = this.add(new EventEmitter<UserInputRequest>());
	public readonly onUserInputRequested = this._onUserInputRequested.event;
	private _userInputHandler?: UserInputHandler;
	private readonly _userInputHandlerSet = this.add(new Emitter<void>());
	private _userInputRequested?: UserInputRequest;
	public get userInputRequested(): UserInputRequest | undefined {
		return this._userInputRequested;
	}
	private _title?: string;
	public get title(): string | undefined {
		return this._title;
	}
	private _onDidChangeTitle = this.add(new Emitter<string>());
	public onDidChangeTitle = this._onDidChangeTitle.event;
	private _stream?: vscode.ChatResponseStream;
	public get sdkSession() {
		return this._sdkSession;
	}
	public get options() {
		return {
			isolationEnabled: this._options.isolationEnabled,
			workingDirectory: this._options.workingDirectory,
		};
	}
	private _lastUsedModel: string | undefined;
	private _pendingPrompt: string | undefined;
	public get pendingPrompt(): string | undefined {
		return this._pendingPrompt;
	}
	constructor(
		private readonly _options: CopilotCLISessionOptions,
		private readonly _sdkSession: Session,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatDelegationSummaryService private readonly _delegationSummaryService: IChatDelegationSummaryService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@ICopilotCLIImageSupport private readonly _imageSupport: ICopilotCLIImageSupport,
		@IToolsService private readonly _toolsService: IToolsService,
		@IUserQuestionHandler private readonly _userQuestionHandler: IUserQuestionHandler,
	) {
		super();
		this.sessionId = _sdkSession.sessionId;
	}

	attachStream(stream: vscode.ChatResponseStream): IDisposable {
		this._stream = stream;
		return toDisposable(() => {
			if (this._stream === stream) {
				this._stream = undefined;
			}
		});
	}

	attachPermissionHandler(handler: PermissionHandler): IDisposable {
		this._permissionHandler = handler;
		this._permissionHandlerSet.fire();
		return toDisposable(() => {
			if (this._permissionHandler === handler) {
				this._permissionHandler = undefined;
			}
		});
	}

	attachUserInputHandler(handler: UserInputHandler): IDisposable {
		this._userInputHandler = handler;
		this._userInputHandlerSet.fire();
		return toDisposable(() => {
			if (this._userInputHandler === handler) {
				this._userInputHandler = undefined;
			}
		});
	}

	public async handleRequest(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		modelId: string | undefined,
		authInfo: NonNullable<SessionOptions['authInfo']>,
		token: vscode.CancellationToken
	): Promise<void> {
		const label = 'prompt' in input ? input.prompt : `/${input.command}`;
		const promptLabel = label.length > 50 ? label.substring(0, 47) + '...' : label;
		const capturingToken = new CapturingToken(`Background Agent | ${promptLabel}`, 'worktree', false, true);
		return this._requestLogger.captureInvocation(capturingToken, () => this._handleRequestImpl(request, input, attachments, modelId, authInfo, token));
	}

	private async _handleRequestImpl(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		modelId: string | undefined,
		authInfo: NonNullable<SessionOptions['authInfo']>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Session disposed');
		}
		const prompt = 'prompt' in input ? input.prompt : `/${input.command}`;
		this._pendingPrompt = prompt;
		this._status = ChatSessionStatus.InProgress;
		this._statusChange.fire(this._status);

		this.logService.info(`[CopilotCLISession] Invoking session ${this.sessionId}`);
		const disposables = this.add(new DisposableStore());
		const abortController = new AbortController();
		disposables.add(token.onCancellationRequested(() => {
			abortController.abort();
		}));
		disposables.add(toDisposable(() => abortController.abort()));
		const pendingToolInvocations = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();

		const toolNames = new Map<string, string>();
		const editToolIds = new Set<string>();
		const toolCalls = new Map<string, ToolCall>();
		const editTracker = new ExternalEditTracker();
		let sdkRequestId: string | undefined;
		const toolIdEditMap = new Map<string, Promise<string | undefined>>();
		const editFilesAndToolCallIds = new ResourceMap<ToolCall[]>();
		disposables.add(this._options.addPermissionHandler(async (permissionRequest) => {
			const response = await this.requestPermission(permissionRequest, editTracker,
				(toolCallId: string) => toolCalls.get(toolCallId),
				this._options.toSessionOptions().workingDirectory,
				token
			);

			this._requestLogger.addEntry({
				type: LoggedRequestKind.MarkdownContentRequest,
				debugName: `Permission Request`,
				startTimeMs: Date.now(),
				icon: Codicon.question,
				markdownContent: this._renderPermissionToMarkdown(permissionRequest, response.kind),
				isConversationRequest: true
			});

			return response;
		}));
		disposables.add(this._options.addUserInputHandler(async (userInputRequest) => {
			if (!this._stream) {
				this.logService.warn('[AskQuestionsTool] No stream available, cannot show question carousel');
				throw new Error('User skipped question');
			}
			const answer = await this._userQuestionHandler.askUserQuestion(userInputRequest, request.toolInvocationToken, token);
			if (!answer) {
				throw new Error('User skipped question');
			}
			return answer;
		}));
		const chunkMessageIds = new Set<string>();
		const assistantMessageChunks: string[] = [];
		const logStartTime = Date.now();
		try {
			// Where possible try to avoid an extra call to getSelectedModel by using cached value.
			const currentModel = await modelId ? (this._lastUsedModel ?? raceCancellation(this._sdkSession.getSelectedModel(), token)) : undefined;
			if (authInfo) {
				this._sdkSession.setAuthInfo(authInfo);
			}
			if (modelId && modelId !== currentModel && !token.isCancellationRequested) {
				this._lastUsedModel = modelId;
				await raceCancellation(this._sdkSession.setSelectedModel(modelId), token);
			}

			disposables.add(toDisposable(this._sdkSession.on('*', (event) => {
				this.logService.trace(`[CopilotCLISession] CopilotCLI Event: ${JSON.stringify(event, null, 2)}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('session.title_changed', (event) => {
				this._title = event.data.title;
				this._onDidChangeTitle.fire(event.data.title);
			})));
			disposables.add(toDisposable(this._sdkSession.on('user.message', (event) => {
				sdkRequestId = event.id;
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.usage', (event) => {
				if (this._stream && typeof event.data.outputTokens === 'number' && typeof event.data.inputTokens === 'number') {
					this._stream.usage({
						completionTokens: event.data.outputTokens,
						promptTokens: event.data.inputTokens,
					});
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message_delta', (event) => {
				// Support for streaming delta messages.
				if (typeof event.data.deltaContent === 'string' && event.data.deltaContent.length) {
					chunkMessageIds.add(event.data.messageId);
					assistantMessageChunks.push(event.data.deltaContent);
					this._stream?.markdown(event.data.deltaContent);
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message', (event) => {
				if (typeof event.data.content === 'string' && event.data.content.length && !chunkMessageIds.has(event.data.messageId)) {
					assistantMessageChunks.push(event.data.content);
					this._stream?.markdown(event.data.content);
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_start', (event) => {
				toolNames.set(event.data.toolCallId, event.data.toolName);
				toolCalls.set(event.data.toolCallId, event.data as unknown as ToolCall);
				if (isCopilotCliEditToolCall(event.data)) {
					editToolIds.add(event.data.toolCallId);
					// Track edits for edit tools.
					const editUris = getAffectedUrisForEditTool(event.data);
					if (editUris.length) {
						editUris.forEach(uri => {
							const ids = editFilesAndToolCallIds.get(uri) || [];
							ids.push(event.data as UnknownToolCall as ToolCall);
							editFilesAndToolCallIds.set(uri, ids);
							this.logService.trace(`[CopilotCLISession] Tracking for toolCallId ${event.data.toolCallId} of file ${uri.fsPath}`);
						});
					}
				} else {
					const responsePart = processToolExecutionStart(event, pendingToolInvocations, this.options.workingDirectory);
					if (responsePart instanceof ChatResponseThinkingProgressPart) {
						this._stream?.push(responsePart);
						this._stream?.push(new ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
					} else if (responsePart instanceof ChatToolInvocationPart) {
						responsePart.enablePartialUpdate = true;
						this._stream?.push(responsePart);


						if ((event.data as ToolCall).toolName === 'update_todo') {
							updateTodoList(event, this._toolsService, request.toolInvocationToken, token).catch(error => {
								this.logService.error(`[CopilotCLISession] Failed to invoke todo tool for toolCallId ${event.data.toolCallId}`, error);
							});
						}
					}
				}
				this.logService.trace(`[CopilotCLISession] Start Tool ${event.data.toolName || '<unknown>'}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_complete', (event) => {
				const toolName = toolNames.get(event.data.toolCallId) || '<unknown>';
				// Log tool call to request logger
				const eventError = event.data.error ? { ...event.data.error, code: event.data.error.code || '' } : undefined;
				const eventData = { ...event.data, error: eventError };
				this._logToolCall(event.data.toolCallId, toolName, toolCalls.get(event.data.toolCallId)?.arguments, eventData);

				// Mark the end of the edit if this was an edit tool.
				toolIdEditMap.set(event.data.toolCallId, editTracker.completeEdit(event.data.toolCallId));
				if (editToolIds.has(event.data.toolCallId)) {
					this.logService.trace(`[CopilotCLISession] Completed edit tracking for toolCallId ${event.data.toolCallId}`);
					return;
				}

				// Just complete the tool invocation - the part was already pushed with partial updates enabled
				const [responsePart,] = processToolExecutionComplete(event, pendingToolInvocations, this.logService, this.options.workingDirectory) ?? [];
				if (responsePart) {
					if (responsePart instanceof ChatToolInvocationPart) {
						responsePart.enablePartialUpdate = true;
					}
					this._stream?.push(responsePart);
				}

				const success = `success: ${event.data.success}`;
				const error = event.data.error ? `error: ${event.data.error.code},${event.data.error.message}` : '';
				const result = event.data.result ? `result: ${event.data.result?.content}` : '';
				const parts = [success, error, result].filter(part => part.length > 0).join(', ');
				this.logService.trace(`[CopilotCLISession]Complete Tool ${toolName}, ${parts}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('session.error', (event) => {
				this.logService.error(`[CopilotCLISession]CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
				this._stream?.markdown(`\n\n❌ Error: (${event.data.errorType}) ${event.data.message}`);
				const errorMarkdown = [`# Error Details`, `Type: ${event.data.errorType}`, `Message: ${event.data.message}`, `## Stack`, event.data.stack || ''].join('\n');
				this._requestLogger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: `Session Error`,
					startTimeMs: Date.now(),
					icon: Codicon.error,
					markdownContent: errorMarkdown,
					isConversationRequest: true
				});
			})));

			this._logRequest(prompt, modelId || '', attachments, logStartTime);
			if (!token.isCancellationRequested) {
				if ('command' in input) {
					switch (input.command) {
						case 'compact': {
							this._stream?.progress(l10n.t('Compacting conversation...'));
							await this._sdkSession.initializeAndValidateTools();
							this._sdkSession.currentMode = 'interactive';
							const result = await this._sdkSession.compactHistory();
							if (result.success) {
								this._stream?.markdown(l10n.t('Compacted conversation.'));
							} else {
								this._stream?.markdown(l10n.t('Unable to compact conversation.'));
							}
							break;
						}
					}
				} else {
					if (input.plan) {
						this._sdkSession.currentMode = 'plan';
					} else {
						this._sdkSession.currentMode = 'interactive';
					}
					await this._sdkSession.send({ prompt: input.prompt, attachments, abortController });
				}
			}
			this.logService.trace(`[CopilotCLISession] Invoking session (completed) ${this.sessionId}`);

			const requestDetails: { requestId: string; toolIdEditMap: Record<string, string> } = { requestId: request.id, toolIdEditMap: {} };
			await Promise.all(Array.from(toolIdEditMap.entries()).map(async ([toolId, editFilePromise]) => {
				const editId = await editFilePromise.catch(() => undefined);
				if (editId) {
					requestDetails.toolIdEditMap[toolId] = editId;
				}
			}));
			if (Object.keys(requestDetails.toolIdEditMap).length > 0 && sdkRequestId) {
				this.copilotCLISDK.setRequestId(sdkRequestId, requestDetails);
			}
			this._status = ChatSessionStatus.Completed;
			this._statusChange.fire(this._status);

			// Log the completed conversation
			this._logConversation(prompt, assistantMessageChunks.join(''), modelId || '', attachments, logStartTime, 'Completed');
		} catch (error) {
			this._status = ChatSessionStatus.Failed;
			this._statusChange.fire(this._status);
			this.logService.error(`[CopilotCLISession] Invoking session (error) ${this.sessionId}`, error);
			this._stream?.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);

			// Log the failed conversation
			this._logConversation(prompt, assistantMessageChunks.join(''), modelId || '', attachments, logStartTime, 'Failed', error instanceof Error ? error.message : String(error));
		} finally {
			this._pendingPrompt = undefined;
			disposables.dispose();
		}
	}

	addUserMessage(content: string) {
		this._sdkSession.emit('user.message', { content });
	}

	addUserAssistantMessage(content: string) {
		this._sdkSession.emit('assistant.message', {
			messageId: `msg_${Date.now()}`,
			content
		});
	}

	public getSelectedModelId() {
		return this._sdkSession.getSelectedModel();
	}

	public async getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]> {
		const events = this._sdkSession.getEvents();
		const getVSCodeRequestId = (sdkRequestId: string) => {
			return this.copilotCLISDK.getRequestId(sdkRequestId);
		};
		const modelId = await this.getSelectedModelId();
		return buildChatHistoryFromEvents(this.sessionId, modelId, events, getVSCodeRequestId, this._delegationSummaryService, this.logService, this.options.workingDirectory);
	}

	private async requestPermission(
		permissionRequest: PermissionRequest,
		editTracker: ExternalEditTracker,
		getToolCall: (toolCallId: string) => ToolCall | undefined,
		workingDirectory: string | undefined,
		token: vscode.CancellationToken
	): Promise<{ kind: 'approved' } | { kind: 'denied-interactively-by-user' }> {
		if (permissionRequest.kind === 'read') {
			// If user is reading a file in the working directory or workspace, auto-approve
			// read requests. Outside workspace reads (e.g., /etc/passwd) will still require
			// approval.
			const data = Uri.file(permissionRequest.path);

			if (this._imageSupport.isTrustedImage(data)) {
				return { kind: 'approved' };
			}

			if (workingDirectory && extUriBiasedIgnorePathCase.isEqualOrParent(data, Uri.file(workingDirectory))) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read file in working directory ${permissionRequest.path}`);
				return { kind: 'approved' };
			}

			if (this.workspaceService.getWorkspaceFolder(data)) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read workspace file ${permissionRequest.path}`);
				return { kind: 'approved' };
			}
		}

		// Get hold of file thats being edited if this is a edit tool call (requiring write permissions).
		const toolCall = permissionRequest.toolCallId ? getToolCall(permissionRequest.toolCallId) : undefined;
		const editFiles = toolCall ? getAffectedUrisForEditTool(toolCall) : undefined;
		// Sometimes we don't get a tool call id for the edit permission request
		const editFile = permissionRequest.kind === 'write' ? (editFiles && editFiles.length ? editFiles[0] : (permissionRequest.fileName ? Uri.file(permissionRequest.fileName) : undefined)) : undefined;
		if (workingDirectory && permissionRequest.kind === 'write' && editFile) {
			const isWorkspaceFile = this.workspaceService.getWorkspaceFolder(editFile);
			const isWorkingDirectoryFile = !this.workspaceService.getWorkspaceFolder(Uri.file(workingDirectory)) && extUriBiasedIgnorePathCase.isEqualOrParent(editFile, Uri.file(workingDirectory));

			let autoApprove = false;
			// If isolation is enabled, we only auto-approve writes within the working directory.
			if (this._options.isolationEnabled && isWorkingDirectoryFile) {
				autoApprove = true;
			}
			// If its a workspace file, and not editing protected files, we auto-approve.
			if (!autoApprove && isWorkspaceFile && !(await requiresFileEditconfirmation(this.instantiationService, permissionRequest, toolCall))) {
				autoApprove = true;
			}
			// If we're working in the working directory (non-isolation), and not editing protected files, we auto-approve.
			if (!autoApprove && isWorkingDirectoryFile && !(await requiresFileEditconfirmation(this.instantiationService, permissionRequest, toolCall, Uri.file(workingDirectory)))) {
				autoApprove = true;
			}

			if (autoApprove) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request ${editFile.fsPath}`);

				// If we're editing a file, start tracking the edit & wait for core to acknowledge it.
				if (toolCall && this._stream) {
					this.logService.trace(`[CopilotCLISession] Starting to track edit for toolCallId ${toolCall.toolCallId} & file ${editFile.fsPath}`);
					await editTracker.trackEdit(toolCall.toolCallId, [editFile], this._stream);
				}

				return { kind: 'approved' };
			}
		}

		try {
			const permissionHandler = await this.waitForPermissionHandler(permissionRequest);
			if (!permissionHandler) {
				this.logService.warn(`[CopilotCLISession] No permission handler registered, denying request for ${permissionRequest.kind} permission.`);
				return { kind: 'denied-interactively-by-user' };
			}

			if (await permissionHandler(permissionRequest, toolCall, token)) {
				// If we're editing a file, start tracking the edit & wait for core to acknowledge it.
				if (editFile && toolCall && this._stream) {
					this.logService.trace(`[CopilotCLISession] Starting to track edit for toolCallId ${toolCall.toolCallId} & file ${editFile.fsPath}`);
					await editTracker.trackEdit(toolCall.toolCallId, [editFile], this._stream);
				}
				return { kind: 'approved' };
			}
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		} finally {
			this._permissionRequested = undefined;
		}

		return { kind: 'denied-interactively-by-user' };
	}

	private async waitForPermissionHandler(permissionRequest: PermissionRequest): Promise<PermissionHandler | undefined> {
		if (!this._permissionHandler) {
			this._permissionRequested = permissionRequest;
			this._onPermissionRequested.fire(permissionRequest);
			const disposables = this.add(new DisposableStore());
			await Event.toPromise(this._permissionHandlerSet.event, disposables);
			disposables.dispose();
			this._permissionRequested = undefined;
		}
		return this._permissionHandler;
	}

	private _logRequest(userPrompt: string, modelId: string, attachments: Attachment[], startTimeMs: number): void {
		const markdownContent = this._renderRequestToMarkdown(userPrompt, modelId, attachments, startTimeMs);
		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Background Agent | ${userPrompt.substring(0, 30)}${userPrompt.length > 30 ? '...' : ''}`,
			startTimeMs,
			icon: ThemeIcon.fromId('worktree'),
			markdownContent,
			isConversationRequest: true
		});
	}

	private _logConversation(userPrompt: string, assistantResponse: string, modelId: string, attachments: Attachment[], startTimeMs: number, status: 'Completed' | 'Failed', errorMessage?: string): void {
		const markdownContent = this._renderConversationToMarkdown(userPrompt, assistantResponse, modelId, attachments, startTimeMs, status, errorMessage);
		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Background Agent | ${userPrompt.substring(0, 30)}${userPrompt.length > 30 ? '...' : ''}`,
			startTimeMs,
			icon: ThemeIcon.fromId('worktree'),
			markdownContent,
			isConversationRequest: true
		});
	}

	private _renderRequestToMarkdown(userPrompt: string, modelId: string, attachments: Attachment[], startTimeMs: number): string {
		const result: string[] = [];
		result.push(`# Background Agent Session`);
		result.push(``);
		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`sessionId    : ${this.sessionId}`);
		result.push(`modelId      : ${modelId}`);
		result.push(`isolation    : ${this.options.isolationEnabled ? 'enabled' : 'disabled'}`);
		result.push(`working dir  : ${this.options.workingDirectory?.fsPath || '<not set>'}`);
		result.push(`startTime    : ${new Date(startTimeMs).toISOString()}`);
		result.push(`~~~`);
		result.push(``);
		result.push(`## User Prompt`);
		result.push(`~~~`);
		result.push(userPrompt);
		result.push(`~~~`);
		result.push(``);
		result.push(`## Attachments`);
		result.push(`~~~`);
		attachments.forEach(attachment => {
			result.push(`- ${attachment.displayName} (${attachment.type}, ${attachment.type === 'selection' ? attachment.filePath : attachment.path})`);
		});
		result.push(`~~~`);
		result.push(``);
		return result.join('\n');
	}

	private _renderPermissionToMarkdown(permissionRequest: PermissionRequest, response: string): string {
		const result: string[] = [];
		result.push(`# Permission Request`);
		result.push(``);
		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`sessionId    : ${this.sessionId}`);
		result.push(`kind         : ${permissionRequest.kind}`);
		result.push(`toolCallId   : ${permissionRequest.toolCallId || ''}`);
		result.push(`~~~`);
		result.push(``);
		switch (permissionRequest.kind) {
			case 'read':
				result.push(`## Read Permission Details`);
				result.push(`~~~`);
				result.push(`path         : ${permissionRequest.path}`);
				result.push(`intention    : ${permissionRequest.intention}`);
				result.push(`~~~`);
				break;
			case 'write':
				result.push(`## Write Permission Details`);
				result.push(`~~~`);
				result.push(`path         : ${permissionRequest.fileName}`);
				result.push(`intention    : ${permissionRequest.intention}`);
				result.push(`diff         : ${permissionRequest.diff}`);
				result.push(`~~~`);
				break;
			case 'mcp':
				result.push(`## MCP Permission Details`);
				result.push(`~~~`);
				result.push(`server       : ${permissionRequest.serverName}`);
				result.push(`tool         : ${permissionRequest.toolName} (${permissionRequest.toolTitle})`);
				result.push(`readOnly     : ${permissionRequest.readOnly}`);
				result.push(`args         : ${permissionRequest.args !== undefined ? (typeof permissionRequest.args === 'string' ? permissionRequest.args : JSON.stringify(permissionRequest.args, undefined, 2)) : ''}`);
				result.push(`~~~`);
				break;
			case 'shell':
				result.push(`## Shell Permission Details`);
				result.push(`~~~`);
				result.push(`command : ${permissionRequest.fullCommandText}`);
				result.push(`intention    : ${permissionRequest.intention}`);
				result.push(`paths        : ${permissionRequest.possiblePaths}`);
				result.push(`urls         : ${permissionRequest.possibleUrls}`);
				result.push(`~~~`);
				break;
			case 'url':
				result.push(`## URL Permission Details`);
				result.push(`~~~`);
				result.push(`url      : ${permissionRequest.url}`);
				result.push(`intention    : ${permissionRequest.intention}`);
				result.push(`~~~`);
				break;
		}
		result.push(``);
		result.push(`## Response`);
		result.push(`~~~`);
		result.push(response);
		result.push(``);
		return result.join('\n');
	}

	private _renderConversationToMarkdown(userPrompt: string, assistantResponse: string, modelId: string, attachments: Attachment[], startTimeMs: number, status: 'Completed' | 'Failed', errorMessage?: string): string {
		const result: string[] = [];
		result.push(`# Background Agent Session`);
		result.push(``);
		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`sessionId    : ${this.sessionId}`);
		result.push(`status       : ${status}`);
		result.push(`modelId      : ${modelId}`);
		result.push(`isolation    : ${this.options.isolationEnabled ? 'enabled' : 'disabled'}`);
		result.push(`working dir  : ${this.options.workingDirectory?.fsPath || '<not set>'}`);
		result.push(`startTime    : ${new Date(startTimeMs).toISOString()}`);
		result.push(`endTime      : ${new Date().toISOString()}`);
		result.push(`duration     : ${Date.now() - startTimeMs}ms`);
		if (errorMessage) {
			result.push(`error        : ${errorMessage}`);
		}
		result.push(`~~~`);
		result.push(``);
		result.push(`## User Prompt`);
		result.push(`~~~`);
		result.push(userPrompt);
		result.push(`~~~`);
		result.push(``);
		result.push(`## Attachments`);
		result.push(`~~~`);
		attachments.forEach(attachment => {
			result.push(`- ${attachment.displayName} (${attachment.type}, ${attachment.type === 'selection' ? attachment.filePath : attachment.path})`);
		});
		result.push(`~~~`);
		result.push(``);
		result.push(`## Assistant Response`);
		result.push(`~~~`);
		result.push(assistantResponse || '(no response)');
		result.push(`~~~`);
		return result.join('\n');
	}

	private _logToolCall(toolCallId: string, toolName: string, args: unknown, eventData: { success: boolean; error?: { code: string; message: string }; result?: { content: string } }): void {
		const argsStr = args !== undefined ? (typeof args === 'string' ? args : JSON.stringify(args, undefined, 2)) : '';
		const resultStr = eventData.result?.content ?? '';
		const errorStr = eventData.error ? `Error: ${eventData.error.code} - ${eventData.error.message}` : '';

		const markdownContent = [
			`# Tool Call: ${toolName}`,
			``,
			`## Metadata`,
			`~~~`,
			`toolCallId   : ${toolCallId}`,
			`toolName     : ${toolName}`,
			`success      : ${eventData.success}`,
			`~~~`,
			``,
			`## Arguments`,
			`~~~`,
			argsStr,
			`~~~`,
			``,
			`## Result`,
			`~~~`,
			eventData.success ? resultStr : errorStr,
			`~~~`,
		].join('\n');

		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Tool: ${toolName}`,
			startTimeMs: Date.now(),
			icon: Codicon.tools,
			markdownContent,
			isConversationRequest: true
		});
	}
}

