/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentOptions, Attachment, ModelProvider, PostToolUseHookInput, PreToolUseHookInput, Session, SessionEvent } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, EventEmitter, LanguageModelTextPart, Uri } from '../../../../vscodeTypes';
import { IToolsService } from '../../../tools/common/toolsService';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { getAffectedUrisForEditTool } from '../common/copilotcliTools';
import { ICopilotCLISDK } from './copilotCli';
import { buildChatHistoryFromEvents, isCopilotCliEditToolCall, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
import { getCopilotLogger } from './logger';
import { getConfirmationToolParams, PermissionRequest } from './permissionHelpers';

export interface ICopilotCLISession {
	readonly sessionId: string;
	readonly status: vscode.ChatSessionStatus | undefined;
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;

	handleRequest(
		prompt: string,
		attachments: Attachment[],
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		modelId: ModelProvider | undefined,
		workingDirectory: string | undefined,
		token: vscode.CancellationToken
	): Promise<void>;

	addUserMessage(content: string): void;
	addUserAssistantMessage(content: string): void;
	getSelectedModelId(): Promise<string | undefined>;
	getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]>;
}
export class CopilotCLISession extends DisposableStore implements ICopilotCLISession {
	private _abortController = new AbortController();
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();
	private _editTracker = new ExternalEditTracker();
	public readonly sessionId: string;
	private _status?: vscode.ChatSessionStatus;
	public get status(): vscode.ChatSessionStatus | undefined {
		return this._status;
	}
	private readonly _statusChange = this.add(new EventEmitter<vscode.ChatSessionStatus | undefined>());

	public readonly onDidChangeStatus = this._statusChange.event;

	constructor(
		private readonly _sdkSession: Session,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IToolsService private readonly toolsService: IToolsService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK
	) {
		super();
		this.sessionId = _sdkSession.sessionId;
	}

	public override dispose(): void {
		this._abortController.abort();
		super.dispose();
	}

	async *query(prompt: string, attachments: Attachment[], options: AgentOptions): AsyncGenerator<SessionEvent> {
		// Dynamically import the SDK
		const { Agent } = await this.copilotCLISDK.getPackage();
		const agent = new Agent(options);
		yield* agent.query(prompt, attachments);
	}

	public async handleRequest(
		prompt: string,
		attachments: Attachment[],
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		modelId: ModelProvider | undefined,
		workingDirectory: string | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Session disposed');
		}

		this._status = ChatSessionStatus.InProgress;
		this._statusChange.fire(this._status);

		this.logService.trace(`[CopilotCLISession] Invoking session ${this.sessionId}`);
		const copilotToken = await this._authenticationService.getCopilotToken();
		// TODO@rebornix handle workspace properly
		const effectiveWorkingDirectory = workingDirectory ?? this.workspaceService.getWorkspaceFolders().at(0)?.fsPath;

		const options: AgentOptions = {
			modelProvider: modelId ?? {
				type: 'anthropic',
				model: 'claude-sonnet-4.5',
			},
			abortController: this._abortController,
			workingDirectory: effectiveWorkingDirectory,
			copilotToken: copilotToken.token,
			env: {
				...process.env,
				COPILOTCLI_DISABLE_NONESSENTIAL_TRAFFIC: '1'
			},
			requestPermission: async (permissionRequest) => {
				return await this.requestPermission(permissionRequest, toolInvocationToken);
			},
			logger: getCopilotLogger(this.logService),
			session: this._sdkSession,
			hooks: {
				preToolUse: [
					async (input: PreToolUseHookInput) => {
						const editKey = getEditOperationKey(input.toolName, input.toolArgs);
						await this._onWillEditTool(input, editKey, stream);
					}
				],
				postToolUse: [
					async (input: PostToolUseHookInput) => {
						const editKey = getEditOperationKey(input.toolName, input.toolArgs);
						void this._onDidEditTool(editKey);
					}
				]
			}
		};

		try {
			for await (const event of this.query(prompt, attachments, options)) {
				if (token.isCancellationRequested) {
					break;
				}

				this._processEvent(event, stream, toolInvocationToken);
			}
			this._status = ChatSessionStatus.Completed;
			this._statusChange.fire(this._status);
		} catch (error) {
			this._status = ChatSessionStatus.Failed;
			this._statusChange.fire(this._status);
			this.logService.error(`CopilotCLI session error: ${error}`);
			stream.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	addUserMessage(content: string) {
		this._sdkSession.addEvent({ type: 'user.message', data: { content } });
	}

	addUserAssistantMessage(content: string) {
		this._sdkSession.addEvent({
			type: 'assistant.message', data: {
				messageId: `msg_${Date.now()}`,
				content
			}
		});
	}

	public getSelectedModelId() {
		return this._sdkSession.getSelectedModel();
	}

	public async getChatHistory(): Promise<(ChatRequestTurn2 | ChatResponseTurn2)[]> {
		const events = await this._sdkSession.getEvents();
		return buildChatHistoryFromEvents(events);
	}

	private _toolNames = new Map<string, string>();
	private _processEvent(
		event: SessionEvent,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken
	): void {
		this.logService.trace(`CopilotCLI Event: ${JSON.stringify(event, null, 2)}`);

		switch (event.type) {
			case 'assistant.turn_start':
			case 'assistant.turn_end': {
				this._toolNames.clear();
				break;
			}

			case 'assistant.message': {
				if (event.data.content.length) {
					stream.markdown(event.data.content);
				}
				break;
			}

			case 'tool.execution_start': {
				this._toolNames.set(event.data.toolCallId, event.data.toolName);
				const responsePart = processToolExecutionStart(event, this._pendingToolInvocations);
				if (isCopilotCliEditToolCall(event.data.toolName, event.data.arguments)) {
					this._pendingToolInvocations.delete(event.data.toolCallId);
				}
				if (responsePart instanceof ChatResponseThinkingProgressPart) {
					stream.push(responsePart);
					stream.push(new ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
				}
				this.logService.trace(`Start Tool ${event.data.toolName || '<unknown>'}`);
				break;
			}

			case 'tool.execution_complete': {
				const responsePart = processToolExecutionComplete(event, this._pendingToolInvocations);
				if (responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
					stream.push(responsePart);
				}

				const toolName = this._toolNames.get(event.data.toolCallId) || '<unknown>';
				const success = `success: ${event.data.success}`;
				const error = event.data.error ? `error: ${event.data.error.code},${event.data.error.message}` : '';
				const result = event.data.result ? `result: ${event.data.result?.content}` : '';
				const parts = [success, error, result].filter(part => part.length > 0).join(', ');
				this.logService.trace(`Complete Tool ${toolName}, ${parts}`);
				break;
			}

			case 'session.error': {
				this.logService.error(`CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
				stream.markdown(`\n\n❌ Error: ${event.data.message}`);
				break;
			}
		}
	}

	private async requestPermission(
		permissionRequest: PermissionRequest,
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
				return { kind: 'approved' };
			}
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		}

		return { kind: 'denied-interactively-by-user' };
	}

	private async _onWillEditTool(input: PreToolUseHookInput, editKey: string, stream: vscode.ChatResponseStream): Promise<void> {
		const uris = getAffectedUrisForEditTool(input.toolName, input.toolArgs);
		return this._editTracker.trackEdit(editKey, uris, stream);
	}

	private async _onDidEditTool(editKey: string): Promise<void> {
		return this._editTracker.completeEdit(editKey);
	}
}


function getEditOperationKey(toolName: string, toolArgs: unknown): string {
	// todo@connor4312: get copilot CLI to surface the tool call ID instead?
	return `${toolName}:${JSON.stringify(toolArgs)}`;
}
