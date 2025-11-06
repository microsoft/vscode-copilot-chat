/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, Session } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, EventEmitter, LanguageModelTextPart, Uri } from '../../../../vscodeTypes';
import { IToolsService } from '../../../tools/common/toolsService';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { CopilotCLIPermissionsHandler, ICopilotCLISessionOptionsService } from './copilotCli';
import { buildChatHistoryFromEvents, getAffectedUrisForEditTool, isCopilotCliEditToolCall, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
import { getConfirmationToolParams, PermissionRequest } from './permissionHelpers';

export interface ICopilotCLISession extends IDisposable {
	readonly sessionId: string;
	readonly status: vscode.ChatSessionStatus | undefined;
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;

	handleRequest(
		prompt: string,
		attachments: Attachment[],
		modelId: string | undefined,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): Promise<void>;

	addUserMessage(content: string): void;
	addUserAssistantMessage(content: string): void;
	getSelectedModelId(): Promise<string | undefined>;
	getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]>;
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

	constructor(
		private readonly _sdkSession: Session,
		private readonly _permissionHandler: CopilotCLIPermissionsHandler,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IToolsService private readonly toolsService: IToolsService,
		@ICopilotCLISessionOptionsService private readonly cliSessionOptions: ICopilotCLISessionOptionsService,
	) {
		super();
		this.sessionId = _sdkSession.sessionId;
	}

	public async handleRequest(
		prompt: string,
		attachments: Attachment[],
		modelId: string | undefined,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken,
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
		disposables.add(this._permissionHandler.onDidRequestPermissions(async (permissionRequest) => {
			return await this.requestPermission(permissionRequest, stream, editTracker,
				(file: Uri) => {
					const ids = editFilesAndToolCallIds.get(file);
					return ids?.shift();
				},
				toolInvocationToken
			);
		}));

		try {
			const [currentModel,
				sessionOptions
			] = await Promise.all([
				modelId ? this._sdkSession.getSelectedModel() : undefined,
				this.cliSessionOptions.createOptions({}, this._permissionHandler)
			]);
			if (sessionOptions.authInfo) {
				this._sdkSession.setAuthInfo(sessionOptions.authInfo);
			}
			if (modelId && modelId !== currentModel) {
				await this._sdkSession.setSelectedModel(modelId);
			}

			disposables.add(toDisposable(this._sdkSession.on('*', (event) => this.logService.trace(`[CopilotCLISession]CopilotCLI Event: ${JSON.stringify(event, null, 2)}`))));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message', (event) => {
				if (typeof event.data.content === 'string' && event.data.content.length) {
					stream.markdown(event.data.content);
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_start', (event) => {
				toolNames.set(event.data.toolCallId, event.data.toolName);
				if (isCopilotCliEditToolCall(event.data.toolName, event.data.arguments)) {
					editToolIds.add(event.data.toolCallId);
					// Track edits for edit tools.
					const editUris = getAffectedUrisForEditTool(event.data.toolName, event.data.arguments || {});
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
						stream.push(responsePart);
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
					stream.push(responsePart);
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
				stream.markdown(`\n\n❌ Error: (${event.data.errorType}) ${event.data.message}`);
			})));

			await this._sdkSession.send({ prompt, attachments, abortController });
			this.logService.trace(`[CopilotCLISession] Invoking session (completed) ${this.sessionId}`);

			this._status = ChatSessionStatus.Completed;
			this._statusChange.fire(this._status);
		} catch (error) {
			this._status = ChatSessionStatus.Failed;
			this._statusChange.fire(this._status);
			this.logService.error(`[CopilotCLISession] Invoking session (error) ${this.sessionId}`, error);
			stream.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
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

	public async getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]> {
		const events = await this._sdkSession.getEvents();
		return buildChatHistoryFromEvents(events);
	}

	private async requestPermission(
		permissionRequest: PermissionRequest,
		stream: vscode.ChatResponseStream,
		editTracker: ExternalEditTracker,
		getEditKeyForFile: (file: Uri) => string | undefined,
		toolInvocationToken: vscode.ChatParticipantToolToken
	): Promise<{ kind: 'approved' } | { kind: 'denied-interactively-by-user' }> {
		if (permissionRequest.kind === 'read') {
			// If user is reading a file in the workspace, auto-approve read requests.
			// Outisde workspace reads (e.g., /etc/passwd) will still require approval.
			const data = Uri.file(permissionRequest.path);
			if (this.workspaceService.getWorkspaceFolder(data)) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read workspace file ${permissionRequest.path}`);
				return { kind: 'approved' };
			}
		}

		try {
			const { tool, input } = getConfirmationToolParams(permissionRequest);
			const result = await this.toolsService.invokeTool(tool,
				{ input, toolInvocationToken },
				CancellationToken.None);

			const firstResultPart = result.content.at(0);
			if (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes') {
				// If we're editing a file, start tracking the edit & wait for core to acknowledge it.
				const editFile = permissionRequest.kind === 'write' ? Uri.file(permissionRequest.fileName) : undefined;
				const editKey = editFile ? getEditKeyForFile(editFile) : undefined;
				if (editFile && editKey) {
					this.logService.trace(`[CopilotCLISession] Starting to track edit for toolCallId ${editKey} & file ${editFile.fsPath}`);
					await editTracker.trackEdit(editKey, [editFile], stream);
				}
				return { kind: 'approved' };
			}
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		}

		return { kind: 'denied-interactively-by-user' };
	}
}
