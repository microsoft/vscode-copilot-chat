/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, Session } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IGitService } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { DisposableStore, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { extUriBiasedIgnorePathCase } from '../../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, EventEmitter, Uri } from '../../../../vscodeTypes';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { buildChatHistoryFromEvents, getAffectedUrisForEditTool, isCopilotCliEditToolCall, processToolExecutionComplete, processToolExecutionStart } from '../common/copilotCLITools';
import { CopilotCLISessionOptions, getAuthInfo } from './copilotCli';
import { PermissionRequest, requiresFileEditconfirmation } from './permissionHelpers';

type PermissionHandler = (
	permissionRequest: PermissionRequest,
	token: CancellationToken,
) => Promise<boolean>;

export interface ICopilotCLISession extends IDisposable {
	readonly sessionId: string;
	readonly status: vscode.ChatSessionStatus | undefined;
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;
	readonly permissionRequested?: PermissionRequest;
	readonly onPermissionRequested: vscode.Event<PermissionRequest>;

	attachPermissionHandler(handler: PermissionHandler): IDisposable;
	attachStream(stream: vscode.ChatResponseStream): IDisposable;
	handleRequest(
		prompt: string,
		attachments: Attachment[],
		modelId: string | undefined,
		token: vscode.CancellationToken
	): Promise<void>;
	addUserMessage(content: string): void;
	addUserAssistantMessage(content: string): void;
	getSelectedModelId(): Promise<string | undefined>;
	getChatHistory(): (ChatRequestTurn2 | ChatResponseTurn2)[];
}

export class CopilotCLISession extends DisposableStore implements ICopilotCLISession {
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();
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
	public get sdkSession() {
		return this._sdkSession;
	}
	private _lastUsedModel: string | undefined;

	constructor(
		private readonly _options: CopilotCLISessionOptions,
		private readonly _sdkSession: Session,
		@IGitService private readonly gitService: IGitService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
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

	public async handleRequest(
		prompt: string,
		attachments: Attachment[],
		modelId: string | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Session disposed');
		}
		this._status = ChatSessionStatus.InProgress;
		this._statusChange.fire(this._status);

		this.logService.trace(`[CopilotCLISession] Invoking session ${this.sessionId}`);
		const disposables = this.add(new DisposableStore());
		const abortController = new AbortController();
		disposables.add(token.onCancellationRequested(() => {
			abortController.abort();
		}));
		disposables.add(toDisposable(() => abortController.abort()));

		const toolNames = new Map<string, string>();
		const editToolIds = new Set<string>();
		const editTracker = new ExternalEditTracker();
		const editFilesAndToolCallIds = new ResourceMap<string[]>();
		disposables.add(this._options.addPermissionHandler(async (permissionRequest) => {
			// Need better API from SDK to correlate file edits in permission requests to tool invocations.
			return await this.requestPermission(permissionRequest, editTracker,
				(file: Uri) => {
					const ids = editFilesAndToolCallIds.get(file);
					return ids?.shift();
				},
				this._options.toSessionOptions().workingDirectory,
				token
			);
		}));

		try {
			// Where possible try to avoid an extra call to getSelectedModel by using cached value.
			const [currentModel, authInfo] = await Promise.all([
				modelId ? (this._lastUsedModel ?? this._sdkSession.getSelectedModel()) : undefined,
				getAuthInfo(this.authenticationService)
			]);
			if (authInfo) {
				this._sdkSession.setAuthInfo(authInfo);
			}
			if (modelId && modelId !== currentModel) {
				this._lastUsedModel = modelId;
				await this._sdkSession.setSelectedModel(modelId);
			}

			disposables.add(toDisposable(this._sdkSession.on('*', (event) => this.logService.trace(`[CopilotCLISession]CopilotCLI Event: ${JSON.stringify(event, null, 2)}`))));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message', (event) => {
				if (typeof event.data.content === 'string' && event.data.content.length) {
					this._stream?.markdown(event.data.content);
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_start', (event) => {
				toolNames.set(event.data.toolCallId, event.data.toolName);
				if (isCopilotCliEditToolCall(event.data)) {
					editToolIds.add(event.data.toolCallId);
					// Track edits for edit tools.
					const editUris = getAffectedUrisForEditTool(event.data);
					if (editUris.length) {
						editUris.forEach(uri => {
							const ids = editFilesAndToolCallIds.get(uri) || [];
							ids.push(event.data.toolCallId);
							editFilesAndToolCallIds.set(uri, ids);
							this.logService.trace(`[CopilotCLISession] Tracking for toolCallId ${event.data.toolCallId} of file ${uri.fsPath}`);
						});
					}
				} else {
					const responsePart = processToolExecutionStart(event, this._pendingToolInvocations);
					if (responsePart instanceof ChatResponseThinkingProgressPart) {
						this._stream?.push(responsePart);
						this._stream?.push(new ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
					}
				}
				this.logService.trace(`[CopilotCLISession] Start Tool ${event.data.toolName || '<unknown>'}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_complete', (event) => {
				// Mark the end of the edit if this was an edit tool.
				editTracker.completeEdit(event.data.toolCallId);
				if (editToolIds.has(event.data.toolCallId)) {
					this.logService.trace(`[CopilotCLISession] Completed edit tracking for toolCallId ${event.data.toolCallId}`);
					return;
				}

				const responsePart = processToolExecutionComplete(event, this._pendingToolInvocations);
				if (responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
					this._stream?.push(responsePart);
				}

				const toolName = toolNames.get(event.data.toolCallId) || '<unknown>';
				const success = `success: ${event.data.success}`;
				const error = event.data.error ? `error: ${event.data.error.code},${event.data.error.message}` : '';
				const result = event.data.result ? `result: ${event.data.result?.content}` : '';
				const parts = [success, error, result].filter(part => part.length > 0).join(', ');
				this.logService.trace(`[CopilotCLISession]Complete Tool ${toolName}, ${parts}`);
			})));
			disposables.add(toDisposable(this._sdkSession.on('session.error', (event) => {
				this.logService.error(`[CopilotCLISession]CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
				this._stream?.markdown(`\n\n❌ Error: (${event.data.errorType}) ${event.data.message}`);
			})));

			await this._sdkSession.send({ prompt, attachments, abortController });
			this.logService.trace(`[CopilotCLISession] Invoking session (completed) ${this.sessionId}`);

			if (this._options.isolationEnabled) {
				// When isolation is enabled and we are using a git workspace, stage
				// all changes in the working directory when the session is completed
				const workingDirectory = this._options.toSessionOptions().workingDirectory;
				if (workingDirectory) {
					await this.gitService.add(Uri.file(workingDirectory), []);
					this.logService.trace(`[CopilotCLISession] Staged all changes in working directory ${workingDirectory}`);
				}
			}

			this._status = ChatSessionStatus.Completed;
			this._statusChange.fire(this._status);
		} catch (error) {
			this._status = ChatSessionStatus.Failed;
			this._statusChange.fire(this._status);
			this.logService.error(`[CopilotCLISession] Invoking session (error) ${this.sessionId}`, error);
			this._stream?.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
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

	public getChatHistory(): (ChatRequestTurn2 | ChatResponseTurn2)[] {
		const events = this._sdkSession.getEvents();
		return buildChatHistoryFromEvents(events);
	}

	private async requestPermission(
		permissionRequest: PermissionRequest,
		editTracker: ExternalEditTracker,
		getEditKeyForFile: (file: Uri) => string | undefined,
		workingDirectory: string | undefined,
		token: vscode.CancellationToken
	): Promise<{ kind: 'approved' } | { kind: 'denied-interactively-by-user' }> {
		if (permissionRequest.kind === 'read') {
			// If user is reading a file in the working directory or workspace, auto-approve
			// read requests. Outside workspace reads (e.g., /etc/passwd) will still require
			// approval.
			const data = Uri.file(permissionRequest.path);

			if (workingDirectory && extUriBiasedIgnorePathCase.isEqualOrParent(data, Uri.file(workingDirectory))) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read file in working directory ${permissionRequest.path}`);
				return { kind: 'approved' };
			}

			if (this.workspaceService.getWorkspaceFolder(data)) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read workspace file ${permissionRequest.path}`);
				return { kind: 'approved' };
			}
		}

		if (workingDirectory && permissionRequest.kind === 'write') {
			// TODO:@rebornix @lszomoru
			// If user is writing a file in the working directory configured for the session, AND the working directory is not a workspace folder,
			// auto-approve the write request. Currently we only set non-workspace working directories when using git worktrees.
			const editFile = Uri.file(permissionRequest.fileName);

			const isWorkspaceFile = this.workspaceService.getWorkspaceFolder(editFile);
			const isWorkingDirectoryFile = !this.workspaceService.getWorkspaceFolder(Uri.file(workingDirectory)) && extUriBiasedIgnorePathCase.isEqualOrParent(editFile, Uri.file(workingDirectory));

			let autoApprove = false;
			// If isolation is enabled, we only auto-approve writes within the working directory.
			if (this._options.isolationEnabled && isWorkingDirectoryFile) {
				autoApprove = true;
			}
			// If its a workspace file, and not editing protected files, we auto-approve.
			if (!autoApprove && isWorkspaceFile && !(await this.instantiationService.invokeFunction(requiresFileEditconfirmation, permissionRequest))) {
				autoApprove = true;
			}

			if (autoApprove) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request ${permissionRequest.fileName}`);
				const editKey = getEditKeyForFile(editFile);

				// If we're editing a file, start tracking the edit & wait for core to acknowledge it.
				if (editKey && this._stream) {
					this.logService.trace(`[CopilotCLISession] Starting to track edit for toolCallId ${editKey} & file ${editFile.fsPath}`);
					await editTracker.trackEdit(editKey, [editFile], this._stream);
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

			if (await permissionHandler(permissionRequest, token)) {
				// If we're editing a file, start tracking the edit & wait for core to acknowledge it.
				const editFile = permissionRequest.kind === 'write' ? Uri.file(permissionRequest.fileName) : undefined;
				const editKey = editFile ? getEditKeyForFile(editFile) : undefined;
				if (editFile && editKey && this._stream) {
					this.logService.trace(`[CopilotCLISession] Starting to track edit for toolCallId ${editKey} & file ${editFile.fsPath}`);
					await editTracker.trackEdit(editKey, [editFile], this._stream);
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
}
