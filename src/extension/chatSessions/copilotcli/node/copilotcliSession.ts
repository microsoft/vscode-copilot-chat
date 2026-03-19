/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, SendOptions, Session, SessionOptions } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import type { ChatParticipantToolToken } from 'vscode';
import { IChatDebugFileLoggerService } from '../../../../platform/chat/common/chatDebugFileLoggerService';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName, IOTelService, ISpanHandle, SpanKind, SpanStatusCode, truncateForOTel } from '../../../../platform/otel/common/index';
import { CapturingToken } from '../../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger, LoggedRequestKind } from '../../../../platform/requestLogger/node/requestLogger';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { raceCancellation } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Codicon } from '../../../../util/vs/base/common/codicons';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';

import { extUriBiasedIgnorePathCase, isEqual } from '../../../../util/vs/base/common/resources';
import { truncate } from '../../../../util/vs/base/common/strings';
import { ThemeIcon } from '../../../../util/vs/base/common/themables';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, ChatToolInvocationPart, EventEmitter, LanguageModelTextPart, Uri } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { IChatSessionMetadataStore, RequestDetails } from '../../common/chatSessionMetadataStore';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { getWorkingDirectory, isIsolationEnabled, IWorkspaceInfo } from '../../common/workspaceInfo';
import { buildChatHistoryFromEvents, getAffectedUrisForEditTool, isCopilotCliEditToolCall, isCopilotCLIToolThatCouldRequirePermissions, processToolExecutionComplete, processToolExecutionStart, ToolCall, updateTodoList } from '../common/copilotCLITools';
import { IChatDelegationSummaryService } from '../common/delegationSummaryService';
import { getCopilotCLISessionStateDir } from './cliHelpers';
import { CopilotCLISessionOptions, ICopilotCLISDK } from './copilotCli';
import { ICopilotCLIImageSupport } from './copilotCLIImageSupport';
import { PermissionRequest, requestPermission, requiresFileEditconfirmation } from './permissionHelpers';
import { IUserQuestionHandler, UserInputRequest } from './userInputHelpers';

/**
 * Known commands that can be sent to a CopilotCLI session instead of a free-form prompt.
 */
export type CopilotCLICommand = 'compact';

/**
 * The set of all known CopilotCLI commands.  Used by callers that need to
 * distinguish a slash-command from a regular prompt at runtime.
 */
export const copilotCLICommands: readonly CopilotCLICommand[] = ['compact'] as const;

export const builtinSlashSCommands = {
	createPr: '/create-pr',
	createDraftPr: '/create-draft-pr'
};

/**
 * Either a free-form prompt **or** a known command.
 */
export type CopilotCLISessionInput =
	| { readonly prompt: string; plan?: boolean }
	| { readonly command: CopilotCLICommand };

function getPromptLabel(input: CopilotCLISessionInput): string {
	return 'prompt' in input ? input.prompt : `/${input.command}`;
}

export interface ICopilotCLISession extends IDisposable {
	readonly sessionId: string;
	readonly title?: string;
	readonly createdPullRequestUrl: string | undefined;
	readonly onDidChangeTitle: vscode.Event<string>;
	readonly status: vscode.ChatSessionStatus | undefined;
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;
	readonly workspace: IWorkspaceInfo;
	readonly pendingPrompt: string | undefined;
	attachStream(stream: vscode.ChatResponseStream): IDisposable;
	setPermissionLevel(level: string | undefined): void;
	handleRequest(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken; sessionResource?: vscode.Uri },
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
	private _createdPullRequestUrl: string | undefined;
	public get createdPullRequestUrl(): string | undefined {
		return this._createdPullRequestUrl;
	}
	private _status?: vscode.ChatSessionStatus;
	public get status(): vscode.ChatSessionStatus | undefined {
		return this._status;
	}
	private set status(value: vscode.ChatSessionStatus | undefined) {
		this._status = value;
		this._statusChange.fire(value);
	}
	private readonly _statusChange = this.add(new EventEmitter<vscode.ChatSessionStatus | undefined>());

	public readonly onDidChangeStatus = this._statusChange.event;

	private _permissionRequested?: PermissionRequest;
	public get permissionRequested(): PermissionRequest | undefined {
		return this._permissionRequested;
	}
	private _title?: string;
	public get title(): string | undefined {
		return this._title;
	}
	private _onDidChangeTitle = this.add(new Emitter<string>());
	public onDidChangeTitle = this._onDidChangeTitle.event;
	private _stream?: vscode.ChatResponseStream;
	private _toolInvocationToken?: ChatParticipantToolToken;
	public get sdkSession() {
		return this._sdkSession;
	}
	public get workspace() {
		return this._options.workspaceInfo;
	}
	private _lastUsedModel: string | undefined;
	private _permissionLevel: string | undefined;
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
		@IChatSessionMetadataStore private readonly _chatSessionMetadataStore: IChatSessionMetadataStore,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatDelegationSummaryService private readonly _delegationSummaryService: IChatDelegationSummaryService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@ICopilotCLIImageSupport private readonly _imageSupport: ICopilotCLIImageSupport,
		@IToolsService private readonly _toolsService: IToolsService,
		@IUserQuestionHandler private readonly _userQuestionHandler: IUserQuestionHandler,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IOTelService private readonly _otelService: IOTelService,
		@IChatDebugFileLoggerService private readonly _debugFileLogger: IChatDebugFileLoggerService,
	) {
		super();
		this.sessionId = _sdkSession.sessionId;
		this._debugFileLogger.startSession(this.sessionId).catch(err => {
			this.logService.error('[CopilotCLISession] Failed to start debug log session', err);
		});
		this.add(toDisposable(() => {
			this._debugFileLogger.endSession(this.sessionId).catch(err => {
				this.logService.error('[CopilotCLISession] Failed to end debug log session', err);
			});
		}));
	}

	attachStream(stream: vscode.ChatResponseStream): IDisposable {
		this._stream = stream;
		return toDisposable(() => {
			if (this._stream === stream) {
				this._stream = undefined;
			}
		});
	}

	public setPermissionLevel(level: string | undefined): void {
		this._permissionLevel = level;
	}

	// TODO: This should be pre-populated when we restore a session based on its original context.
	// E.g. if we're resuming a session, and it tries to read a file, we shouldn't prompt for permissions again.
	/**
	 * Accumulated attachments across all requests in this session.
	 * Used for permission auto-approval: if a file was attached by the user in any
	 * request, read access is auto-approved for that file in subsequent turns.
	 */
	private readonly attachments: Attachment[] = [];
	/**
	 * Promise chain that serialises request completion tracking.
	 * When a steering request arrives while a previous request is still running,
	 * the steering handler awaits both `previousRequest` and its own SDK send so
	 * that the steering message does not resolve until the original request finishes.
	 */
	private previousRequest: Promise<unknown> = Promise.resolve();

	/**
	 * Entry point for every chat request against this session.
	 *
	 * **Steering behaviour**: if the session is already busy (`InProgress` or
	 * `NeedsInput`), the incoming message is treated as a *steering* request.
	 * Steering sends the new prompt to the SDK with `mode: 'immediate'` so it is
	 * injected into the running conversation as additional context. The steering
	 * request only resolves once *both* the steering send and the original
	 * in-flight request have completed, keeping the session's promise chain
	 * consistent.
	 *
	 * When the session is idle, a normal full request is started instead.
	 */
	public async handleRequest(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken; sessionResource?: vscode.Uri },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		modelId: string | undefined,
		authInfo: NonNullable<SessionOptions['authInfo']>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Session disposed');
		}
		this._createdPullRequestUrl = undefined;
		const label = getPromptLabel(input);
		const promptLabel = truncate(label, 50);
		const capturingToken = new CapturingToken(`Copilot CLI | ${promptLabel}`, 'worktree', false, true);
		const isAlreadyBusyWithAnotherRequest = !!this._status && (this._status === ChatSessionStatus.InProgress || this._status === ChatSessionStatus.NeedsInput);
		this._toolInvocationToken = request.toolInvocationToken;

		const previousRequestSnapshot = this.previousRequest;

		const handled = this._requestLogger.captureInvocation(capturingToken, async () => {
			await this.updateModel(modelId, authInfo, token);

			if (isAlreadyBusyWithAnotherRequest) {
				return this._handleRequestSteering(input, attachments, modelId, previousRequestSnapshot, token);
			} else {
				return this._handleRequestImpl(request, input, attachments, modelId, token);
			}
		});

		this.previousRequest = this.previousRequest.then(() => handled);
		return handled;
	}

	/**
	 * Handles a steering request – a message sent while the session is already
	 * busy with a previous request.
	 *
	 * The steering prompt is sent to the SDK with `mode: 'immediate'` (via
	 * {@link sendRequestInternal}) so the SDK injects it into the running
	 * conversation as additional user context. The SDK send itself typically
	 * completes quickly (it only enqueues the message), but we also await
	 * `previousRequestPromise` so that this method does not resolve until the
	 * original in-flight request is fully done. This ensures callers see the
	 * correct session state when the returned promise settles.
	 *
	 * @param previousRequestPromise A snapshot of `this.previousRequest` captured
	 *   *before* the promise chain was extended with the current call. Using the
	 *   snapshot avoids a circular await that would deadlock.
	 */
	private async _handleRequestSteering(
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		modelId: string | undefined,
		previousRequestPromise: Promise<unknown>,
		token: vscode.CancellationToken,
	): Promise<void> {
		this.attachments.push(...attachments);
		const prompt = getPromptLabel(input);
		this._pendingPrompt = prompt;
		this.logService.info(`[CopilotCLISession] Steering session ${this.sessionId}`);
		const disposables = new DisposableStore();
		const logStartTime = Date.now();
		const abortController = new AbortController();
		disposables.add(token.onCancellationRequested(() => {
			abortController.abort();
		}));
		disposables.add(toDisposable(() => abortController.abort()));

		try {
			// Send the steering prompt (completes quickly) and also wait for the
			// previous request to finish, so this promise settles only once all
			// in-flight work is done.
			await Promise.all([previousRequestPromise, this.sendRequestInternal(input, attachments, true, logStartTime, abortController)]);
			this._logConversation(prompt, '', modelId || '', attachments, logStartTime, 'Completed');
		} catch (error) {
			this._logConversation(prompt, '', modelId || '', attachments, logStartTime, 'Failed', error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			disposables.dispose();
		}
	}

	private async _handleRequestImpl(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		modelId: string | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		this.attachments.push(...attachments);
		const prompt = getPromptLabel(input);
		this._pendingPrompt = prompt;
		this.logService.info(`[CopilotCLISession] Invoking session ${this.sessionId}`);
		const disposables = new DisposableStore();
		const logStartTime = Date.now();
		const abortController = new AbortController();
		disposables.add(token.onCancellationRequested(() => {
			abortController.abort();
		}));
		disposables.add(toDisposable(() => abortController.abort()));

		this.status = ChatSessionStatus.InProgress;


		const pendingToolInvocations = new Map<string, [ChatToolInvocationPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();

		const editToolIds = new Set<string>();
		const toolCalls = new Map<string, ToolCall>();
		const editTracker = new ExternalEditTracker();
		let sdkRequestId: string | undefined;
		const toolIdEditMap = new Map<string, Promise<string | undefined>>();
		/**
		 * The sequence of events from the SDK is as follows:
		 * tool.start 			-> About to run a terminal command
		 * permission request 	-> Asks user for permission to run the command
		 * tool.complete 		-> Command has completed running, contains the output or error
		 *
		 * There's a problem with this flow, we end up displaying the UI about execution in progress, even before we asked for permissions.
		 * This looks weird because we display two UI elements in sequence, one for "Running command..." and then immediately after "Permission requested: Allow running this command?".
		 * To fix this, we delay showing the "Running command..." UI until after the permission request is resolved. If the permission request is approved, we then show the "Running command..." UI. If the permission request is denied, we show a message indicating that the command was not run due to lack of permissions.
		 * & if we don't get a permission request, but get some other event, then we show the "Running command..." UI immediately as before.
		 */
		const toolCallWaitingForPermissions: [ChatToolInvocationPart, ToolCall][] = [];
		const flushPendingInvocationMessages = () => {
			for (const [invocationMessage,] of toolCallWaitingForPermissions) {
				this._stream?.push(invocationMessage);
			}
			toolCallWaitingForPermissions.length = 0;
		};

		const chunkMessageIds = new Set<string>();
		const assistantMessageChunks: string[] = [];
		const otelToolSpans = new Map<string, ISpanHandle>();
		let otelLlmSpan: ISpanHandle | undefined;
		try {
			const shouldHandleExitPlanModeRequests = this.configurationService.getConfig(ConfigKey.Advanced.CLIPlanExitModeEnabled);
			disposables.add(toDisposable(this._sdkSession.on('*', (event) => {
				this.logService.trace(`[CopilotCLISession] CopilotCLI Event: ${JSON.stringify(event, null, 2)}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('permission.requested', async (event) => {
				const permissionRequest = event.data.permissionRequest;
				const requestId = event.data.requestId;
				this.status = ChatSessionStatus.NeedsInput;
				try {
					const response = await this.requestPermission(permissionRequest, editTracker,
						(toolCallId: string) => {
							const toolData = toolCalls.get(toolCallId);
							if (!toolData) {
								return undefined;
							}
							const data = pendingToolInvocations.get(toolCallId);
							if (data) {
								return [toolData, data[2]] as const;
							}
							return [toolData, undefined] as const;
						},
						token
					);
					flushPendingInvocationMessages();

					this._requestLogger.addEntry({
						type: LoggedRequestKind.MarkdownContentRequest,
						debugName: `Permission Request`,
						startTimeMs: Date.now(),
						icon: Codicon.question,
						markdownContent: this._renderPermissionToMarkdown(permissionRequest, response.kind),
						isConversationRequest: true
					});

					this._sdkSession.respondToPermission(requestId, response);
				} finally {
					this.status = ChatSessionStatus.InProgress;
				}
			})));
			if (shouldHandleExitPlanModeRequests) {
				disposables.add(toDisposable(this._sdkSession.on('exit_plan_mode.requested', async (event) => {
					if (this._permissionLevel === 'autopilot') {
						this.logService.trace('[CopilotCLISession] Auto-approving exit plan mode in autopilot');
						type ActionType = Parameters<NonNullable<SessionOptions['onExitPlanMode']>>[0]['actions'][number];
						const choices: ActionType[] = (event.data.actions as ActionType[]) ?? [];
						if (choices.includes('autopilot')) {
							this._sdkSession.respondToExitPlanMode(event.data.requestId, { approved: true, selectedAction: 'autopilot', autoApproveEdits: true });
							return;
						}
						if (choices.includes('interactive')) {
							this._sdkSession.respondToExitPlanMode(event.data.requestId, { approved: true, selectedAction: 'interactive' });
							return;
						}
						if (choices.includes('exit_only')) {
							this._sdkSession.respondToExitPlanMode(event.data.requestId, { approved: true, selectedAction: 'exit_only' });
							return;
						}
						this._sdkSession.respondToExitPlanMode(event.data.requestId, { approved: true, autoApproveEdits: true });
						return;
					}
					if (!(this._toolInvocationToken as unknown)) {
						this.logService.warn('[ConfirmationTool] No toolInvocationToken available, cannot request exit plan mode approval');
						this._sdkSession.respondToExitPlanMode(event.data.requestId, { approved: false });
						return;
					}
					const params = {
						title: l10n.t('Approve this plan?'),
						message: event.data.summary,
						confirmationType: 'basic' as const,
					};

					this.status = ChatSessionStatus.NeedsInput;
					let approved = true;
					try {
						const result = await this._toolsService.invokeTool(ToolName.CoreConfirmationTool, {
							input: params,
							toolInvocationToken: this._toolInvocationToken,
						}, CancellationToken.None);

						const firstResultPart = result.content.at(0);
						approved = firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes';
						const autoApproveEdits = approved && this._permissionLevel === 'autoApprove' ? true : undefined;
						if (approved) {
							this._sdkSession.respondToExitPlanMode(event.data.requestId, { approved, selectedAction: 'exit_only', autoApproveEdits });
							return;
						}
					} catch (error) {
						this.logService.error(error, '[ConfirmationTool] Error showing confirmation tool for exit plan mode');
					} finally {
						this.status = ChatSessionStatus.InProgress;
					}
					this._sdkSession.respondToExitPlanMode(event.data.requestId, { approved: false });

				})));
			}
			disposables.add(toDisposable(this._sdkSession.on('user_input.requested', async (event) => {
				// auto approve user input
				if (this._permissionLevel === 'autopilot') {
					this.logService.trace('[CopilotCLISession] Auto-responding to user input in autopilot');
					this._sdkSession.respondToUserInput(event.data.requestId, { answer: 'The user is not available to respond and will review your work later. Work autonomously and make good decisions.', wasFreeform: true });
					return;
				}
				if (!(this._toolInvocationToken as unknown)) {
					this.logService.warn('[AskQuestionsTool] No stream available, cannot show question carousel');
					this._sdkSession.respondToUserInput(event.data.requestId, { answer: '', wasFreeform: false });
					return;
				}
				const userInputRequest: UserInputRequest = {
					question: event.data.question,
					choices: event.data.choices,
					allowFreeform: event.data.allowFreeform,
				};
				this.status = ChatSessionStatus.NeedsInput;
				try {
					const answer = await this._userQuestionHandler.askUserQuestion(userInputRequest, this._toolInvocationToken as unknown as never, token);
					flushPendingInvocationMessages();
					if (!answer) {
						this._sdkSession.respondToUserInput(event.data.requestId, { answer: '', wasFreeform: false });
						return;
					}
					this._sdkSession.respondToUserInput(event.data.requestId, answer);
				} finally {
					this.status = ChatSessionStatus.InProgress;
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('session.title_changed', (event) => {
				this._title = event.data.title;
				this._onDidChangeTitle.fire(event.data.title);
			})));
			disposables.add(toDisposable(this._sdkSession.on('user.message', (event) => {
				sdkRequestId = event.id;
				// Emit a user_message span event for the debug panel
				otelLlmSpan = this._otelService.startSpan(`chat copilot-cli`, {
					kind: SpanKind.CLIENT,
					attributes: {
						[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
						[GenAiAttr.PROVIDER_NAME]: 'copilot-cli',
						[GenAiAttr.REQUEST_MODEL]: modelId || '',
						[CopilotChatAttr.CHAT_SESSION_ID]: this.sessionId,
					},
				});
				const userContent = truncateForOTel(typeof event.data?.content === 'string' ? event.data.content : prompt);
				// Set on span attributes for the detail pane resolver
				otelLlmSpan.setAttribute(CopilotChatAttr.USER_REQUEST, userContent);
				// Set input messages so the model turn detail pane shows the user prompt
				try {
					otelLlmSpan.setAttribute(GenAiAttr.INPUT_MESSAGES, truncateForOTel(JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: userContent }] }])));
				} catch { /* swallow */ }
				// Set on span event for the list view
				otelLlmSpan.addEvent('user_message', { content: userContent });
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.usage', (event) => {
				if (this._stream && typeof event.data.outputTokens === 'number' && typeof event.data.inputTokens === 'number') {
					this._stream.usage({
						completionTokens: event.data.outputTokens,
						promptTokens: event.data.inputTokens,
					});
				}
				// Update the LLM span with token usage
				if (otelLlmSpan) {
					if (typeof event.data.inputTokens === 'number') {
						otelLlmSpan.setAttribute(GenAiAttr.USAGE_INPUT_TOKENS, event.data.inputTokens);
					}
					if (typeof event.data.outputTokens === 'number') {
						otelLlmSpan.setAttribute(GenAiAttr.USAGE_OUTPUT_TOKENS, event.data.outputTokens);
					}
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message_delta', (event) => {
				// Support for streaming delta messages.
				if (typeof event.data.deltaContent === 'string' && event.data.deltaContent.length) {
					chunkMessageIds.add(event.data.messageId);
					assistantMessageChunks.push(event.data.deltaContent);
					flushPendingInvocationMessages();
					this._stream?.markdown(event.data.deltaContent);
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message', (event) => {
				if (typeof event.data.content === 'string' && event.data.content.length && !chunkMessageIds.has(event.data.messageId)) {
					assistantMessageChunks.push(event.data.content);
					flushPendingInvocationMessages();
					this._stream?.markdown(event.data.content);
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_start', (event) => {
				toolCalls.set(event.data.toolCallId, event.data as unknown as ToolCall);

				// End the current LLM span since the model produced a tool call
				if (otelLlmSpan) {
					otelLlmSpan.setAttribute(GenAiAttr.OUTPUT_TYPE, 'tool_call');
					otelLlmSpan.setStatus(SpanStatusCode.OK);
					otelLlmSpan.end();
					otelLlmSpan = undefined;
				}

				// Create an OTel span for this tool execution
				const toolSpan = this._otelService.startSpan(`execute_tool ${event.data.toolName}`, {
					kind: SpanKind.INTERNAL,
					attributes: {
						[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
						[GenAiAttr.TOOL_NAME]: event.data.toolName,
						[GenAiAttr.TOOL_CALL_ID]: event.data.toolCallId,
						[CopilotChatAttr.CHAT_SESSION_ID]: this.sessionId,
					},
				});
				const toolArgs = (event.data as ToolCall).arguments;
				if (toolArgs !== undefined) {
					try {
						toolSpan.setAttribute(GenAiAttr.TOOL_CALL_ARGUMENTS, truncateForOTel(
							typeof toolArgs === 'string' ? toolArgs : JSON.stringify(toolArgs)
						));
					} catch { /* swallow serialization errors */ }
				}
				otelToolSpans.set(event.data.toolCallId, toolSpan);
				if (isCopilotCliEditToolCall(event.data)) {
					flushPendingInvocationMessages();
					editToolIds.add(event.data.toolCallId);
				} else {
					const responsePart = processToolExecutionStart(event, pendingToolInvocations, getWorkingDirectory(this.workspace));
					if (responsePart instanceof ChatResponseThinkingProgressPart) {
						flushPendingInvocationMessages();
						this._stream?.push(responsePart);
						this._stream?.push(new ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
					} else if (responsePart instanceof ChatToolInvocationPart) {
						responsePart.enablePartialUpdate = true;

						if (isCopilotCLIToolThatCouldRequirePermissions(event)) {
							toolCallWaitingForPermissions.push([responsePart, event.data as ToolCall]);
						} else {
							flushPendingInvocationMessages();
							this._stream?.push(responsePart);
						}

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
				const toolName = toolCalls.get(event.data.toolCallId)?.toolName || '<unknown>';
				if (toolName.endsWith('create_pull_request') && event.data.success) {
					const pullRequestUrl = extractPullRequestUrlFromToolResult(event.data.result);
					if (pullRequestUrl) {
						this._createdPullRequestUrl = pullRequestUrl;
						this.logService.trace(`[CopilotCLISession] Captured pull request URL: ${pullRequestUrl}`);
					}
				}
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
				const [responsePart,] = processToolExecutionComplete(event, pendingToolInvocations, this.logService, getWorkingDirectory(this.workspace)) ?? [];
				if (responsePart) {
					flushPendingInvocationMessages();
					if (responsePart instanceof ChatToolInvocationPart) {
						responsePart.enablePartialUpdate = true;
					}
					this._stream?.push(responsePart);
				}

				const success = `success: ${event.data.success}`;
				const error = event.data.error ? `error: ${event.data.error.code},${event.data.error.message}` : '';
				const result = event.data.result ? `result: ${event.data.result?.content}` : '';
				const parts = [success, error, result].filter(part => part.length > 0).join(', ');

				// End the OTel span for this tool execution
				const toolSpan = otelToolSpans.get(event.data.toolCallId);
				if (toolSpan) {
					if (event.data.success) {
						toolSpan.setStatus(SpanStatusCode.OK);
						if (event.data.result?.content) {
							try {
								toolSpan.setAttribute(GenAiAttr.TOOL_CALL_RESULT, truncateForOTel(event.data.result.content));
							} catch { /* swallow */ }
						}
					} else {
						const errMsg = event.data.error ? `${event.data.error.code}: ${event.data.error.message}` : 'unknown error';
						toolSpan.setStatus(SpanStatusCode.ERROR, errMsg);
						toolSpan.setAttribute(GenAiAttr.TOOL_CALL_RESULT, truncateForOTel(`ERROR: ${errMsg}`));
					}
					toolSpan.end();
					otelToolSpans.delete(event.data.toolCallId);
				}
				this.logService.trace(`[CopilotCLISession]Complete Tool ${toolName}, ${parts}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('session.error', (event) => {
				flushPendingInvocationMessages();
				this.logService.error(`[CopilotCLISession]CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
				this._stream?.markdown(`\n\n❌ Error: (${event.data.errorType}) ${event.data.message}`);

				// Emit an OTel span for the error so it appears in the debug panel
				const errorSpan = this._otelService.startSpan(`session_error ${event.data.errorType}`, {
					kind: SpanKind.INTERNAL,
					attributes: {
						[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CONTENT_EVENT,
						[CopilotChatAttr.DEBUG_NAME]: `Session Error: ${event.data.errorType}`,
						[CopilotChatAttr.CHAT_SESSION_ID]: this.sessionId,
						[CopilotChatAttr.MARKDOWN_CONTENT]: truncateForOTel(`Error (${event.data.errorType}): ${event.data.message}`),
					},
				});
				errorSpan.setStatus(SpanStatusCode.ERROR, event.data.message);
				errorSpan.end();

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

			if (!token.isCancellationRequested) {
				await this.sendRequestInternal(input, attachments, false, logStartTime, abortController);
			}
			this.logService.trace(`[CopilotCLISession] Invoking session (completed) ${this.sessionId}`);

			const resolvedToolIdEditMap: Record<string, string> = {};
			await Promise.all(Array.from(toolIdEditMap.entries()).map(async ([toolId, editFilePromise]) => {
				const editId = await editFilePromise.catch(() => undefined);
				if (editId) {
					resolvedToolIdEditMap[toolId] = editId;
				}
			}));
			if (sdkRequestId) {
				await this._chatSessionMetadataStore.updateRequestDetails(this.sessionId, [{
					vscodeRequestId: request.id,
					copilotRequestId: sdkRequestId,
					toolIdEditMap: resolvedToolIdEditMap,
					agentId: this._options.agentName,
				}]).catch(error => {
					this.logService.error(`[CopilotCLISession] Failed to update chat session metadata store for request ${request.id}`, error);
				});
			}
			this.status = ChatSessionStatus.Completed;

			// Log the completed conversation
			this._logConversation(prompt, assistantMessageChunks.join(''), modelId || '', attachments, logStartTime, 'Completed');
		} catch (error) {
			this.status = ChatSessionStatus.Failed;
			this.logService.error(`[CopilotCLISession] Invoking session (error) ${this.sessionId}`, error);
			this._stream?.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);

			// Log the failed conversation
			this._logConversation(prompt, assistantMessageChunks.join(''), modelId || '', attachments, logStartTime, 'Failed', error instanceof Error ? error.message : String(error));
		} finally {
			// Clean up any remaining OTel spans
			if (otelLlmSpan) {
				// Attach the assistant's response text so the debug panel can show agent_response events
				const responseText = assistantMessageChunks.join('');
				if (responseText) {
					try {
						otelLlmSpan.setAttribute(GenAiAttr.OUTPUT_MESSAGES, truncateForOTel(JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: responseText }] }])));
					} catch { /* swallow */ }
				}
				otelLlmSpan.setStatus(SpanStatusCode.OK);
				otelLlmSpan.end();
				otelLlmSpan = undefined;
			} else {
				// LLM span was ended by a tool call, but the model may have sent
				// a final text response after tool execution. Create a short span
				// to carry the agent_response so it appears in the debug panel.
				const responseText = assistantMessageChunks.join('');
				if (responseText) {
					const responseSpan = this._otelService.startSpan('chat copilot-cli', {
						kind: SpanKind.CLIENT,
						attributes: {
							[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
							[GenAiAttr.PROVIDER_NAME]: 'copilot-cli',
							[GenAiAttr.REQUEST_MODEL]: modelId || '',
							[CopilotChatAttr.CHAT_SESSION_ID]: this.sessionId,
						},
					});
					try {
						responseSpan.setAttribute(GenAiAttr.OUTPUT_MESSAGES, truncateForOTel(JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: responseText }] }])));
					} catch { /* swallow */ }
					responseSpan.setStatus(SpanStatusCode.OK);
					responseSpan.end();
				}
			}
			for (const [, span] of otelToolSpans) {
				span.setStatus(SpanStatusCode.ERROR, 'session ended before tool completed');
				span.end();
			}
			otelToolSpans.clear();

			this._pendingPrompt = undefined;
			disposables.dispose();
		}
	}

	private async updateModel(modelId: string | undefined, authInfo: NonNullable<SessionOptions['authInfo']>, token: CancellationToken): Promise<void> {
		// Where possible try to avoid an extra call to getSelectedModel by using cached value.
		let currentModel: string | undefined = undefined;
		if (modelId) {
			if (this._lastUsedModel) {
				currentModel = this._lastUsedModel;
			} else {
				currentModel = await raceCancellation(this._sdkSession.getSelectedModel(), token);
			}
		}
		if (token.isCancellationRequested) {
			return;
		}
		if (authInfo) {
			this._sdkSession.setAuthInfo(authInfo);
		}
		if (modelId && modelId !== currentModel) {
			this._lastUsedModel = modelId;
			await raceCancellation(this._sdkSession.setSelectedModel(modelId), token);
		}
	}

	/**
	 * Sends a request to the underlying SDK session.
	 *
	 * @param steering When `true`, the SDK send uses `mode: 'immediate'` so the
	 *   prompt is injected into the already-running conversation rather than
	 *   starting a new turn. This is the mechanism behind session steering.
	 */
	private async sendRequestInternal(input: CopilotCLISessionInput, attachments: Attachment[], steering = false, logStartTime: number, abortController: AbortController): Promise<void> {
		const prompt = getPromptLabel(input);
		this._logRequest(prompt, this._lastUsedModel || '', attachments, logStartTime);

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
			} else if (this._permissionLevel === 'autopilot') {
				this._sdkSession.currentMode = 'autopilot';
			} else {
				this._sdkSession.currentMode = 'interactive';
			}
			const sendOptions: SendOptions = { prompt: input.prompt, attachments, abortController, agentMode: this._sdkSession.currentMode };
			if (steering) {
				sendOptions.mode = 'immediate';
			}
			await this._sdkSession.send(sendOptions);
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
		const storedDetails = await this._chatSessionMetadataStore.getRequestDetails(this.sessionId);
		// Build lookup from copilotRequestId → RequestDetails for the callback
		const detailsByCopilotId = new Map<string, { requestId: string; toolIdEditMap: Record<string, string> }>();
		for (const d of storedDetails) {
			if (d.copilotRequestId) {
				detailsByCopilotId.set(d.copilotRequestId, { requestId: d.vscodeRequestId, toolIdEditMap: d.toolIdEditMap });
			}
		}
		const legacyMappings: RequestDetails[] = [];
		const getVSCodeRequestId = (sdkRequestId: string) => {
			const stored = detailsByCopilotId.get(sdkRequestId);
			if (stored) {
				return stored;
			}
			const mapping = this.copilotCLISDK.getRequestId(sdkRequestId);
			if (mapping) {
				detailsByCopilotId.set(sdkRequestId, mapping);
				legacyMappings.push({
					copilotRequestId: sdkRequestId,
					vscodeRequestId: mapping.requestId,
					toolIdEditMap: mapping.toolIdEditMap,
				});
			}
			return mapping;
		};
		const modelId = await this.getSelectedModelId();
		const chatHistory = buildChatHistoryFromEvents(this.sessionId, modelId, events, getVSCodeRequestId, this._delegationSummaryService, this.logService, getWorkingDirectory(this.workspace));

		if (legacyMappings.length > 0) {
			await this._chatSessionMetadataStore.updateRequestDetails(this.sessionId, legacyMappings).catch(error => {
				this.logService.error(`[CopilotCLISession] Failed to update chat session metadata store with legacy mappings for session ${this.sessionId}`, error);
			});
		}

		return chatHistory;
	}

	private isFileFromSessionWorkspace(file: Uri): boolean {
		const workingDirectory = getWorkingDirectory(this.workspace);
		if (workingDirectory && extUriBiasedIgnorePathCase.isEqualOrParent(file, workingDirectory)) {
			return true;
		}
		if (this.workspace.folder && extUriBiasedIgnorePathCase.isEqualOrParent(file, this.workspace.folder)) {
			return true;
		}
		// Only if we have a worktree should we check the repository.
		// As this means the user created a worktree and we have a repository.
		// & if the worktree is automatically trusted, then so is the repository as we created the worktree from that.
		if (this.workspace.worktree && this.workspace.repository && extUriBiasedIgnorePathCase.isEqualOrParent(file, this.workspace.repository)) {
			return true;
		}

		return false;
	}
	private async requestPermission(
		permissionRequest: PermissionRequest,
		editTracker: ExternalEditTracker,
		getToolCall: (toolCallId: string) => undefined | [ToolCall, parentToolCallId: string | undefined],
		token: vscode.CancellationToken
	): Promise<{ kind: 'approved' } | { kind: 'denied-interactively-by-user' }> {
		if (this._permissionLevel === 'autoApprove' || this._permissionLevel === 'autopilot') {
			this.logService.trace(`[CopilotCLISession] Auto Approving ${permissionRequest.kind} request (permission level: ${this._permissionLevel})`);
			return { kind: 'approved' };
		}

		const workingDirectory = getWorkingDirectory(this.workspace);

		if (permissionRequest.kind === 'read') {
			// If user is reading a file in the working directory or workspace, auto-approve
			// read requests. Outside workspace reads (e.g., /etc/passwd) will still require
			// approval.
			const data = Uri.file(permissionRequest.path);

			if (this._imageSupport.isTrustedImage(data)) {
				return { kind: 'approved' };
			}

			if (this.isFileFromSessionWorkspace(data)) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read file in session workspace ${permissionRequest.path}`);
				return { kind: 'approved' };
			}

			if (this.workspaceService.getWorkspaceFolder(data)) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read workspace file ${permissionRequest.path}`);
				return { kind: 'approved' };
			}

			// If reading a file from session directory, e.g. plan.md, then auto approve it, this is internal file to Cli.
			const sessionDir = Uri.joinPath(Uri.file(getCopilotCLISessionStateDir()), this.sessionId);
			if (extUriBiasedIgnorePathCase.isEqualOrParent(data, sessionDir)) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read Copilot CLI session resource ${permissionRequest.path}`);
				return { kind: 'approved' };
			}

			// If model is trying to read the contents of a file thats attached, then auto-approve it, as this is an explicit action by the user to share the file with the model.
			if (this.attachments.some(attachment => attachment.type === 'file' && isEqual(Uri.file(attachment.path), data))) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read attached file ${permissionRequest.path}`);
				return { kind: 'approved' };
			}
		}

		// Get hold of file thats being edited if this is a edit tool call (requiring write permissions).
		const toolData = permissionRequest.toolCallId ? getToolCall(permissionRequest.toolCallId) : undefined;
		const toolCall = toolData ? toolData[0] : undefined;
		const toolParentCallId = toolData ? toolData[1] : undefined;
		const editFiles = toolCall ? getAffectedUrisForEditTool(toolCall) : undefined;
		// Sometimes we don't get a tool call id for the edit permission request
		const editFile = permissionRequest.kind === 'write' ? (editFiles && editFiles.length ? editFiles[0] : (permissionRequest.fileName ? Uri.file(permissionRequest.fileName) : undefined)) : undefined;
		if (workingDirectory && permissionRequest.kind === 'write' && editFile) {
			const isWorkspaceFile = this.workspaceService.getWorkspaceFolder(editFile);
			const isWorkingDirectoryFile = !this.workspaceService.getWorkspaceFolder(workingDirectory) && extUriBiasedIgnorePathCase.isEqualOrParent(editFile, workingDirectory);

			let autoApprove = false;
			// If isolation is enabled, we only auto-approve writes within the working directory.
			if (isIsolationEnabled(this.workspace) && isWorkingDirectoryFile) {
				autoApprove = true;
			}
			// If its a workspace file, and not editing protected files, we auto-approve.
			if (!autoApprove && isWorkspaceFile && !(await requiresFileEditconfirmation(this.instantiationService, permissionRequest, toolCall))) {
				autoApprove = true;
			}
			// If we're working in the working directory (non-isolation), and not editing protected files, we auto-approve.
			if (!autoApprove && isWorkingDirectoryFile && !(await requiresFileEditconfirmation(this.instantiationService, permissionRequest, toolCall, workingDirectory))) {
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
		// If reading a file from session directory, e.g. plan.md, then auto approve it, this is internal file to Cli.
		const sessionDir = Uri.joinPath(Uri.file(getCopilotCLISessionStateDir()), this.sessionId);
		if (permissionRequest.kind === 'write' && editFile && extUriBiasedIgnorePathCase.isEqualOrParent(editFile, sessionDir)) {
			this.logService.trace(`[CopilotCLISession] Auto Approving request to write to Copilot CLI session resource ${editFile.fsPath}`);
			return { kind: 'approved' };
		}

		try {
			if (await requestPermission(this.instantiationService, permissionRequest, toolCall, getWorkingDirectory(this.workspace), this._toolsService, this._toolInvocationToken as unknown as never, toolParentCallId, token)) {
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

	private _logRequest(userPrompt: string, modelId: string, attachments: Attachment[], startTimeMs: number): void {
		const markdownContent = this._renderRequestToMarkdown(userPrompt, modelId, attachments, startTimeMs);
		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Copilot CLI | ${truncate(userPrompt, 30)}`,
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
			debugName: `Copilot CLI | ${truncate(userPrompt, 30)}`,
			startTimeMs,
			icon: ThemeIcon.fromId('worktree'),
			markdownContent,
			isConversationRequest: true
		});
	}

	private _renderAttachments(attachments: Attachment[]): string[] {
		const lines: string[] = [];
		for (const attachment of attachments) {
			if (attachment.type === 'github_reference') {
				lines.push(`- ${attachment.title}: (${attachment.number}, ${attachment.type}, ${attachment.referenceType})`);
			} else if (attachment.type === 'blob') {
				lines.push(`- ${attachment.displayName ?? 'blob'} (${attachment.type}, ${attachment.mimeType})`);
			} else {
				lines.push(`- ${attachment.displayName} (${attachment.type}, ${attachment.type === 'selection' ? attachment.filePath : attachment.path})`);
			}
		}
		return lines;
	}

	private _renderRequestToMarkdown(userPrompt: string, modelId: string, attachments: Attachment[], startTimeMs: number): string {
		const result: string[] = [];
		result.push(`# Copilot CLI Session`);
		result.push(``);
		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`sessionId    : ${this.sessionId}`);
		result.push(`modelId      : ${modelId}`);
		result.push(`isolation    : ${isIsolationEnabled(this.workspace) ? 'enabled' : 'disabled'}`);
		result.push(`working dir  : ${getWorkingDirectory(this.workspace)?.fsPath || '<not set>'}`);
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
		result.push(...this._renderAttachments(attachments));
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
		result.push(`# Copilot CLI Session`);
		result.push(``);
		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`sessionId    : ${this.sessionId}`);
		result.push(`status       : ${status}`);
		result.push(`modelId      : ${modelId}`);
		result.push(`isolation    : ${isIsolationEnabled(this.workspace) ? 'enabled' : 'disabled'}`);
		result.push(`working dir  : ${getWorkingDirectory(this.workspace)?.fsPath || '<not set>'}`);
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
		result.push(...this._renderAttachments(attachments));
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

function extractPullRequestUrlFromToolResult(result: unknown): string | undefined {
	if (!result || typeof result !== 'object') {
		return undefined;
	}

	const { content } = result as { content?: unknown };
	const text = typeof content === 'string' ? content : JSON.stringify(content);

	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && 'url' in parsed) {
			const url = (parsed as { url: unknown }).url;
			if (typeof url === 'string' && isHttpUrl(url)) {
				return url;
			}
		}
	} catch {
		// not JSON
	}

	const urlMatch = text.match(/https?:\/\/[^\s"'`,;)\]}>]+/);
	if (urlMatch) {
		const cleaned = urlMatch[0].replace(/[.)\]}>]+$/, '');
		if (isHttpUrl(cleaned)) {
			return cleaned;
		}
	}

	return undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:';
	} catch {
		return false;
	}
}

