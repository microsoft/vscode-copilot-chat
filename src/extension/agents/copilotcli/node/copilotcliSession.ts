/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, ModelProvider, Session, SessionOptions } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { DisposableStore, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, EventEmitter, LanguageModelTextPart, Uri } from '../../../../vscodeTypes';
import { IToolsService } from '../../../tools/common/toolsService';
import { CopilotCLIPermissionsHandler } from './copilotCli';
import { buildChatHistoryFromEvents, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
import { getConfirmationToolParams, PermissionRequest } from './permissionHelpers';

export interface ICopilotCLISession {
	readonly sessionId: string;
	readonly status: vscode.ChatSessionStatus | undefined;
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;
	readonly aborted: boolean;
	readonly onDidAbort: vscode.Event<void>;

	handleRequest(
		prompt: string,
		attachments: Attachment[],
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		modelId: ModelProvider | undefined,
		token: vscode.CancellationToken
	): Promise<void>;

	addUserMessage(content: string): void;
	addUserAssistantMessage(content: string): void;
	getSelectedModelId(): Promise<string | undefined>;
	getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]>;
}

export class CopilotCLISession extends DisposableStore implements ICopilotCLISession {
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();
	public get sessionId(): string {
		return this._session.sessionId;
	}

	private _status?: vscode.ChatSessionStatus;
	public get status(): vscode.ChatSessionStatus | undefined {
		return this._status;
	}
	private readonly _statusChange = this.add(new EventEmitter<vscode.ChatSessionStatus | undefined>());

	public readonly onDidChangeStatus = this._statusChange.event;

	private _aborted?: boolean;
	public get aborted(): boolean {
		return this._aborted ?? false;
	}
	private readonly _onDidAbort = this.add(new EventEmitter<void>());

	public readonly onDidAbort = this._onDidAbort.event;

	constructor(
		private readonly _permissionHandler: CopilotCLIPermissionsHandler,
		private readonly _session: Session,
		@ILogService private readonly _logService: ILogService,
		@IToolsService private readonly toolsService: IToolsService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService
	) {
		super();
	}

	public async handleRequest(
		prompt: string,
		attachments: Attachment[],
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		modelId: ModelProvider | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		const disposables = this.add(new DisposableStore());

		if (modelId) {
			console.log(this._session.messageCount);
			const currentModel = await this._session.getSelectedModel();
			if (currentModel !== modelId.model) {
				await this._session.setSelectedModel(modelId.model);
			}
		}

		disposables.add(token.onCancellationRequested(() => {
			this._session.abort();
			this._aborted = true;
			this._onDidAbort.fire();
		}));
		disposables.add(this._permissionHandler.onDidRequestPermissions(async (permissionRequest) => {
			return await this.requestPermission(permissionRequest, toolInvocationToken);
		}));

		const toolNames = new Map<string, string>();

		disposables.add(toDisposable(this._session.on('*', (event) => this._logService.trace(`CopilotCLI Event: ${JSON.stringify(event, null, 2)}`))));
		disposables.add(toDisposable(this._session.on('assistant.turn_start', () => toolNames.clear())));
		disposables.add(toDisposable(this._session.on('assistant.turn_end', () => toolNames.clear())));
		disposables.add(toDisposable(this._session.on('assistant.message', (event) => {
			if (typeof event.data.content === 'string' && event.data.content.length) {
				stream.markdown(event.data.content);
			}
		})));
		disposables.add(toDisposable(this._session.on('tool.execution_start', (event) => {
			const responsePart = processToolExecutionStart(event, toolNames, this._pendingToolInvocations);
			const toolName = toolNames.get(event.data.toolCallId);
			if (responsePart instanceof ChatResponseThinkingProgressPart) {
				stream.push(responsePart);
			}
			this._logService.trace(`Start Tool ${toolName || '<unknown>'}`);
		})));
		disposables.add(toDisposable(this._session.on('tool.execution_complete', (event) => {
			const responsePart = processToolExecutionComplete(event, this._pendingToolInvocations);
			if (responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
				stream.push(responsePart);
			}

			const toolName = toolNames.get(event.data.toolCallId) || '<unknown>';
			const success = `success: ${event.data.success}`;
			const error = event.data.error ? `error: ${event.data.error.code},${event.data.error.message}` : '';
			const result = event.data.result ? `result: ${event.data.result?.content}` : '';
			const parts = [success, error, result].filter(part => part.length > 0).join(', ');
			this._logService.trace(`Complete Tool ${toolName}, ${parts}`);
		})));
		disposables.add(toDisposable(this._session.on('session.error', (event) => {
			this._logService.error(`CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
			stream.markdown(`\n\n❌ Error: (${event.data.errorType}) ${event.data.message}`);
		})));

		try {
			this._logService.trace(`[CopilotCLISession] Invoking session ${this._session.sessionId}`);
			this._status = ChatSessionStatus.InProgress;
			this._statusChange.fire(this._status);

			await this._session.send({ prompt, attachments });

			this._status = ChatSessionStatus.Completed;
		} catch (error) {
			this._status = ChatSessionStatus.Failed;
			throw error;
		} finally {
			this._statusChange.fire(this._status);
			disposables.dispose();
		}
	}

	addUserMessage(content: string) {
		this._session.emit('user.message', { content });
	}

	addUserAssistantMessage(content: string) {
		this._session.emit('assistant.message', {
			messageId: `msg_${Date.now()}`,
			content
		});
	}

	public getSelectedModelId() {
		return this._session.getSelectedModel();
	}

	public async getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]> {
		const events = await this._session.getEvents();
		return buildChatHistoryFromEvents(events);
	}

	private async requestPermission(
		permissionRequest: PermissionRequest,
		toolInvocationToken: vscode.ChatParticipantToolToken
	): Promise<ReturnType<NonNullable<SessionOptions['requestPermission']>>> {
		if (permissionRequest.kind === 'read') {
			// If user is reading a file in the workspace, auto-approve read requests.
			// Outisde workspace reads (e.g., /etc/passwd) will still require approval.
			const data = Uri.file(permissionRequest.path);
			if (this._workspaceService.getWorkspaceFolder(data)) {
				this._logService.trace(`[CopilotCLISession] Auto Approving request to read workspace file ${permissionRequest.path}`);
				return { kind: 'approved' };
			}
		}

		try {
			const { tool, input } = getConfirmationToolParams(permissionRequest);
			const result = await this.toolsService.invokeTool(tool,
				{ input, toolInvocationToken },
				CancellationToken.None
			);

			const firstResultPart = result.content.at(0);
			if (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes') {
				return { kind: 'approved' };
			}
		} catch (error) {
			this._logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		}

		return { kind: 'denied-interactively-by-user' };
	}
}
