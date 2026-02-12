/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CopilotSession, MessageOptions, PermissionRequest as NewSdkPermissionRequest, PermissionRequestResult, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CapturingToken } from '../../../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger, LoggedRequestKind } from '../../../../../platform/requestLogger/node/requestLogger';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { Codicon } from '../../../../../util/vs/base/common/codicons';
import { Emitter, Event } from '../../../../../util/vs/base/common/event';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../../../util/vs/base/common/map';
import { extUriBiasedIgnorePathCase } from '../../../../../util/vs/base/common/resources';
import { ThemeIcon } from '../../../../../util/vs/base/common/themables';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatQuestion, ChatQuestionType, ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, ChatToolInvocationPart, EventEmitter, Uri } from '../../../../../vscodeTypes';
import { ExternalEditTracker } from '../../../common/externalEditTracker';
import { buildChatHistoryFromEvents, getAffectedUrisForEditTool, isCopilotCliEditToolCall, processToolExecutionComplete, processToolExecutionStart, ToolCall, UnknownToolCall } from '../../common/copilotCLITools';
import { IChatDelegationSummaryService } from '../../common/delegationSummaryService';
import { ICopilotCLISDK } from '../copilotCli';
import { ICopilotCLIImageSupport } from '../copilotCLIImageSupport';
import type { ICopilotCLISession } from '../copilotcliSession';
import { requiresFileEditconfirmation, type PermissionRequest } from '../permissionHelpers';
import { convertBackgroundQuestionToolResponseToAnswers } from '../userInputHelpers';

type UserInputRequestHandler = NonNullable<SessionConfig['onUserInputRequest']>;
export type NewSdkUserInputRequest = Parameters<UserInputRequestHandler>[0];
export type NewSdkUserInputResponse = Awaited<ReturnType<UserInputRequestHandler>>;
/**
 * Permission handler that receives permission requests and returns whether they are approved.
 * Used by the session to delegate permission decisions to the chat participant.
 */
type PermissionHandler = (
	permissionRequest: PermissionRequest,
	toolCall: ToolCall | undefined,
	token: CancellationToken,
) => Promise<boolean>;

export interface NewSdkCopilotCLISessionOptions {
	readonly isolationEnabled: boolean;
	readonly workingDirectory?: Uri;
}

/**
 * Wraps a CopilotSession from @github/copilot-sdk to implement the ICopilotCLISession interface.
 * This enables the new SDK to be used transparently alongside the old SDK,
 * as both implement the same ICopilotCLISession contract.
 */
export class NewSdkCopilotCLISession extends DisposableStore implements ICopilotCLISession {
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

	private _stream?: vscode.ChatResponseStream;

	public get options(): { readonly isolationEnabled: boolean; readonly workingDirectory?: Uri } {
		return this._sessionOptions;
	}
	private _modelId: string | undefined;
	private _pendingPrompt: string | undefined;
	public get pendingPrompt(): string | undefined {
		return this._pendingPrompt;
	}
	public get sdkSession(): CopilotSession {
		return this._sdkSession;
	}

	constructor(
		private readonly _sessionOptions: NewSdkCopilotCLISessionOptions,
		private readonly _sdkSession: CopilotSession,
		modelId: string | undefined,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatDelegationSummaryService private readonly _delegationSummaryService: IChatDelegationSummaryService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@ICopilotCLIImageSupport private readonly _imageSupport: ICopilotCLIImageSupport,
	) {
		super();
		this.sessionId = _sdkSession.sessionId;
		this._modelId = modelId;
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

	public async handleRequest(
		requestId: string,
		prompt: string,
		attachments: MessageOptions['attachments'],
		modelId: string | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		const promptLabel = prompt.length > 50 ? prompt.substring(0, 47) + '...' : prompt;
		const capturingToken = new CapturingToken(`Background Agent | ${promptLabel}`, 'worktree', false, true);
		return this._requestLogger.captureInvocation(capturingToken, () => this._handleRequestImpl(requestId, prompt, attachments, modelId, token));
	}

	private async _handleRequestImpl(
		requestId: string,
		prompt: string,
		attachments: MessageOptions['attachments'],
		modelId: string | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Session disposed');
		}
		this._pendingPrompt = prompt;
		this._status = ChatSessionStatus.InProgress;
		this._statusChange.fire(this._status);
		if (modelId) {
			this._modelId = modelId;
		}

		this.logService.info(`[NewSdkCopilotCLISession] Invoking session ${this.sessionId}`);
		const disposables = this.add(new DisposableStore());
		// Abort via session.abort() when cancellation is requested
		disposables.add(token.onCancellationRequested(() => {
			void this._sdkSession.abort();
		}));
		disposables.add(toDisposable(() => {
			void this._sdkSession.abort();
		}));

		const pendingToolInvocations = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall]>();
		const toolNames = new Map<string, string>();
		const editToolIds = new Set<string>();
		const toolCalls = new Map<string, ToolCall>();
		const editTracker = new ExternalEditTracker();
		let sdkRequestId: string | undefined;
		const toolIdEditMap = new Map<string, Promise<string | undefined>>();
		const editFilesAndToolCallIds = new ResourceMap<ToolCall[]>();

		const chunkMessageIds = new Set<string>();
		const assistantMessageChunks: string[] = [];
		const logStartTime = Date.now();
		try {
			// Register event listeners
			disposables.add(toDisposable(this._sdkSession.on((event: SessionEvent) => {
				this.logService.trace(`[NewSdkCopilotCLISession] Event: ${JSON.stringify(event, null, 2)}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('user.message', (event) => {
				sdkRequestId = event.id;
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message_delta', (event) => {
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
					const editUris = getAffectedUrisForEditTool(event.data);
					if (editUris.length) {
						editUris.forEach(uri => {
							const ids = editFilesAndToolCallIds.get(uri) || [];
							ids.push(event.data as UnknownToolCall as ToolCall);
							editFilesAndToolCallIds.set(uri, ids);
							this.logService.trace(`[NewSdkCopilotCLISession] Tracking for toolCallId ${event.data.toolCallId} of file ${uri.fsPath}`);
						});
					}
				} else {
					// Cast to match the old SDK event shape expected by processToolExecutionStart
					const responsePart = processToolExecutionStart(event as never, pendingToolInvocations);
					if (responsePart instanceof ChatResponseThinkingProgressPart) {
						this._stream?.push(responsePart);
						this._stream?.push(new ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
					}
				}
				this.logService.trace(`[NewSdkCopilotCLISession] Start Tool ${event.data.toolName || '<unknown>'}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_complete', (event) => {
				const toolName = toolNames.get(event.data.toolCallId) || '<unknown>';
				const eventError = event.data.error ? { ...event.data.error, code: event.data.error.code || '' } : undefined;
				const eventData = { ...event.data, error: eventError };
				this._logToolCall(event.data.toolCallId, toolName, toolCalls.get(event.data.toolCallId)?.arguments, eventData);

				toolIdEditMap.set(event.data.toolCallId, editTracker.completeEdit(event.data.toolCallId));
				if (editToolIds.has(event.data.toolCallId)) {
					this.logService.trace(`[NewSdkCopilotCLISession] Completed edit tracking for toolCallId ${event.data.toolCallId}`);
					return;
				}

				// Cast to match the old SDK event shape expected by processToolExecutionComplete
				const [responsePart,] = processToolExecutionComplete(event as never, pendingToolInvocations, this.logService, this.options.workingDirectory) ?? [];
				if (responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
					this._stream?.push(responsePart);
				}

				const success = `success: ${event.data.success}`;
				const error = event.data.error ? `error: ${event.data.error.code},${event.data.error.message}` : '';
				const result = event.data.result ? `result: ${event.data.result?.content}` : '';
				const parts = [success, error, result].filter(part => part.length > 0).join(', ');
				this.logService.trace(`[NewSdkCopilotCLISession] Complete Tool ${toolName}, ${parts}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('session.error', (event) => {
				this.logService.error(`[NewSdkCopilotCLISession] CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
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
				const messageOptions: MessageOptions = { prompt, attachments };
				await this._sdkSession.sendAndWait(messageOptions, 24 * 60 * 60 * 1000);
			}
			this.logService.trace(`[NewSdkCopilotCLISession] Invoking session (completed) ${this.sessionId}`);

			const requestDetails: { requestId: string; toolIdEditMap: Record<string, string> } = { requestId, toolIdEditMap: {} };
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

			this._logConversation(prompt, assistantMessageChunks.join(''), modelId || '', attachments, logStartTime, 'Completed');
		} catch (error) {
			this._status = ChatSessionStatus.Failed;
			this._statusChange.fire(this._status);
			this.logService.error(`[NewSdkCopilotCLISession] Invoking session (error) ${this.sessionId}`, error);
			this._stream?.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);

			this._logConversation(prompt, assistantMessageChunks.join(''), modelId || '', attachments, logStartTime, 'Failed', error instanceof Error ? error.message : String(error));
		} finally {
			this._pendingPrompt = undefined;
			disposables.dispose();
		}
	}

	/**
	 * Handle a permission request from the new SDK.
	 * The new SDK's PermissionRequest shape is compatible with the old SDK's shape
	 * (both have `kind`, `toolCallId`, and extensible key-value pairs).
	 */
	async handlePermissionRequest(
		permissionRequest: NewSdkPermissionRequest,
		editTracker: ExternalEditTracker,
		getToolCall: (toolCallId: string) => ToolCall | undefined,
		workingDirectory: string | undefined,
		token: vscode.CancellationToken
	): Promise<PermissionRequestResult> {
		// Cast is safe: new SDK PermissionRequest has the same shape as old SDK PermissionRequest
		const permReq = permissionRequest as PermissionRequest;
		if (permReq.kind === 'read') {
			const data = Uri.file(permReq.path as string);

			if (this._imageSupport.isTrustedImage(data)) {
				return { kind: 'approved' };
			}

			if (workingDirectory && extUriBiasedIgnorePathCase.isEqualOrParent(data, Uri.file(workingDirectory))) {
				this.logService.trace(`[NewSdkCopilotCLISession] Auto Approving request to read file in working directory ${permReq.path}`);
				return { kind: 'approved' };
			}

			if (this.workspaceService.getWorkspaceFolder(data)) {
				this.logService.trace(`[NewSdkCopilotCLISession] Auto Approving request to read workspace file ${permReq.path}`);
				return { kind: 'approved' };
			}
		}

		const toolCall = permReq.toolCallId ? getToolCall(permReq.toolCallId) : undefined;
		const editFiles = toolCall ? getAffectedUrisForEditTool(toolCall) : undefined;
		const editFile = permReq.kind === 'write' ? (editFiles && editFiles.length ? editFiles[0] : (permReq.fileName ? Uri.file(permReq.fileName as string) : undefined)) : undefined;
		if (workingDirectory && permReq.kind === 'write' && editFile) {
			const isWorkspaceFile = this.workspaceService.getWorkspaceFolder(editFile);
			const isWorkingDirectoryFile = !this.workspaceService.getWorkspaceFolder(Uri.file(workingDirectory)) && extUriBiasedIgnorePathCase.isEqualOrParent(editFile, Uri.file(workingDirectory));

			let autoApprove = false;
			if (this._sessionOptions.isolationEnabled && isWorkingDirectoryFile) {
				autoApprove = true;
			}
			if (!autoApprove && isWorkspaceFile && !(await requiresFileEditconfirmation(this.instantiationService, permReq, toolCall))) {
				autoApprove = true;
			}

			if (autoApprove) {
				this.logService.trace(`[NewSdkCopilotCLISession] Auto Approving request ${editFile.fsPath}`);
				if (toolCall && this._stream) {
					this.logService.trace(`[NewSdkCopilotCLISession] Starting to track edit for toolCallId ${toolCall.toolCallId} & file ${editFile.fsPath}`);
					await editTracker.trackEdit(toolCall.toolCallId, [editFile], this._stream);
				}
				return { kind: 'approved' };
			}
		}

		try {
			const permissionHandler = await this._waitForPermissionHandler(permReq);
			if (!permissionHandler) {
				this.logService.warn(`[NewSdkCopilotCLISession] No permission handler registered, denying request for ${permReq.kind} permission.`);
				return { kind: 'denied-interactively-by-user' };
			}

			if (await permissionHandler(permReq, toolCall, token)) {
				if (editFile && toolCall && this._stream) {
					this.logService.trace(`[NewSdkCopilotCLISession] Starting to track edit for toolCallId ${toolCall.toolCallId} & file ${editFile.fsPath}`);
					await editTracker.trackEdit(toolCall.toolCallId, [editFile], this._stream);
				}
				return { kind: 'approved' };
			}
		} catch (error) {
			this.logService.error(`[NewSdkCopilotCLISession] Permission request error: ${error}`);
		} finally {
			this._permissionRequested = undefined;
		}

		return { kind: 'denied-interactively-by-user' };
	}

	/**
	 * Handle a user input request from the new SDK.
	 */
	async handleUserInputRequest(userInputRequest: NewSdkUserInputRequest): Promise<NewSdkUserInputResponse> {
		if (!this._stream) {
			this.logService.warn('[NewSdkCopilotCLISession] No stream available, cannot show question carousel');
			return { answer: '', wasFreeform: false };
		}

		const chatQuestion = new ChatQuestion(userInputRequest.question,
			userInputRequest.choices && userInputRequest.choices.length > 0 ? ChatQuestionType.MultiSelect : ChatQuestionType.Text,
			userInputRequest.question,
			{
				message: userInputRequest.question,
				options: userInputRequest.choices?.map((choice: string) => ({ label: choice, id: choice, value: choice })),
				allowFreeformInput: userInputRequest.allowFreeform
			}
		);
		const carouselAnswers = await this._stream.questionCarousel([chatQuestion], false);
		const answers = convertBackgroundQuestionToolResponseToAnswers([chatQuestion], carouselAnswers, this.logService);
		const answer = chatQuestion.title in answers.answers ? answers.answers[chatQuestion.title] : undefined;
		if (answer) {
			return {
				answer: answer.freeText ? answer.freeText : (answer.selected.length ? answer.selected.join(', ') : ''),
				wasFreeform: !!answer.freeText
			};
		}
		return { answer: '', wasFreeform: false };
	}

	/**
	 * Note: The new SDK does not support emitting synthetic events on the session.
	 * This is a no-op. If delegation context is needed, use SessionConfig.systemMessage instead.
	 */
	addUserMessage(_content: string): void {
		this.logService.trace('[NewSdkCopilotCLISession] addUserMessage is not supported by the new SDK — using no-op');
	}

	/**
	 * Note: The new SDK does not support emitting synthetic events on the session.
	 * This is a no-op. If delegation context is needed, use SessionConfig.systemMessage instead.
	 */
	addUserAssistantMessage(_content: string): void {
		this.logService.trace('[NewSdkCopilotCLISession] addUserAssistantMessage is not supported by the new SDK — using no-op');
	}

	public async getSelectedModelId(): Promise<string | undefined> {
		return this._modelId;
	}

	public async getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]> {
		const events = await this._sdkSession.getMessages();
		const getVSCodeRequestId = (sdkRequestId: string) => {
			return this.copilotCLISDK.getRequestId(sdkRequestId);
		};
		// The new SDK's SessionEvent type is compatible with the old SDK's SessionEvent type
		// (same field names: id, type, data, timestamp, parentId, ephemeral)
		return buildChatHistoryFromEvents(this.sessionId, events as never, getVSCodeRequestId, this._delegationSummaryService, this.logService, this.options.workingDirectory);
	}

	private async _waitForPermissionHandler(permissionRequest: PermissionRequest): Promise<PermissionHandler | undefined> {
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

	private _logRequest(userPrompt: string, modelId: string, attachments: MessageOptions['attachments'], startTimeMs: number): void {
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

	private _logConversation(userPrompt: string, assistantResponse: string, modelId: string, attachments: MessageOptions['attachments'], startTimeMs: number, status: 'Completed' | 'Failed', errorMessage?: string): void {
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

	private _renderRequestToMarkdown(userPrompt: string, modelId: string, attachments: MessageOptions['attachments'], startTimeMs: number): string {
		const result: string[] = [];
		result.push(`# Background Agent Session (New SDK)`);
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
		attachments?.forEach(attachment => {
			result.push(`- ${attachment.displayName ?? ''} (${attachment.type}, ${'filePath' in attachment ? attachment.filePath : attachment.path})`);
		});
		result.push(`~~~`);
		result.push(``);
		return result.join('\n');
	}

	private _renderConversationToMarkdown(userPrompt: string, assistantResponse: string, modelId: string, attachments: MessageOptions['attachments'], startTimeMs: number, status: 'Completed' | 'Failed', errorMessage?: string): string {
		const result: string[] = [];
		result.push(`# Background Agent Session (New SDK)`);
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
		attachments?.forEach(attachment => {
			result.push(`- ${attachment.displayName ?? ''} (${attachment.type}, ${'filePath' in attachment ? attachment.filePath : attachment.path})`);
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
