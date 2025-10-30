/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, ModelProvider, Session, SessionOptions } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { INotebookService } from '../../../../platform/notebook/common/notebookService';
import { ITabsAndEditorsService } from '../../../../platform/tabs/common/tabsAndEditorsService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { raceTimeout } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { DisposableStore, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { isEqual } from '../../../../util/vs/base/common/resources';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, EventEmitter, FileType, LanguageModelTextPart, TextEdit, Uri } from '../../../../vscodeTypes';
import { createEditsFromRealDiff } from '../../../prompt/node/editFromDiffGeneration';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { CopilotCLIPermissionsHandler } from './copilotCli';
import { buildChatHistoryFromEvents, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
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

	constructor(
		private readonly _permissionHandler: CopilotCLIPermissionsHandler,
		private readonly _session: Session,
		@ILogService private readonly _logService: ILogService,
		@IToolsService private readonly toolsService: IToolsService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@INotebookService private readonly _notebookService: INotebookService,
		@ITabsAndEditorsService private readonly _tabsAndEditorsService: ITabsAndEditorsService
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

		disposables.add(token.onCancellationRequested(() => this._session.abort()));
		disposables.add(this._permissionHandler.onDidRequestPermissions(async (permissionRequest) => {
			try {
				return await this.requestPermission(permissionRequest, stream, toolInvocationToken);
			} catch (error) {
				this._logService.error(`[CopilotCLISession] Permission request error: ${error}`);
				return { kind: 'denied-interactively-by-user' };
			}
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

		const editToolCalls = new Map<string, string>();
		disposables.add(toDisposable(this._session.on('tool.execution_start', (event) => {
			const responsePart = processToolExecutionStart(event, toolNames, this._pendingToolInvocations);
			const toolName = toolNames.get(event.data.toolCallId);
			if (responsePart instanceof ChatResponseThinkingProgressPart) {
				stream.push(responsePart);
			}
			if (event.data.toolName === 'str_replace_editor' && (event.data.arguments as any)?.command === 'str_replace') {
				const filePath = (event.data.arguments as any).path;
				editToolCalls.set(event.data.toolCallId, filePath);
			}
			if (event.data.toolName === 'edit') {
				const filePath = (event.data.arguments as any).path;
				editToolCalls.set(event.data.toolCallId, filePath);
			}
			this._logService.trace(`Start Tool ${toolName || '<unknown>'}`);
		})));
		disposables.add(toDisposable(this._session.on('tool.execution_complete', (event) => {
			const responsePart = processToolExecutionComplete(event, this._pendingToolInvocations);
			if (responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
				stream.push(responsePart);
			}

			// Complete edit tool calls
			const filePath = editToolCalls.get(event.data.toolCallId);
			if (filePath) {
				if (event.data.success && !event.data.error) {
					const file = Uri.file(filePath);
					stream.textEdit(file, true);
				} else {
					editToolCalls.delete(event.data.toolCallId);
				}
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
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken
	): Promise<ReturnType<NonNullable<SessionOptions['requestPermission']>>> {
		if (permissionRequest.kind === 'read') {
			// If user is reading a file in the workspace, auto-approve read requests.
			// Outisde workspace reads (e.g., /etc/passwd) will still require approval.
			const file = Uri.file(permissionRequest.path);
			if (this._workspaceService.getWorkspaceFolder(file)) {
				if (await this.getFileSaveConfirmation(file, 'read', toolInvocationToken)) {
					this._logService.trace(`[CopilotCLISession] Auto Approving request to read workspace file ${permissionRequest.path}`);
					return { kind: 'approved' };
				} else {
					return { kind: 'denied-interactively-by-user' };
				}
			}
		}

		const { tool, input } = getConfirmationToolParams(permissionRequest);
		if (!(await this.getConfirmation(tool, input, toolInvocationToken))) {
			return { kind: 'denied-interactively-by-user' };
		}

		switch (permissionRequest.kind) {
			case 'write': {
				const file = Uri.file(permissionRequest.fileName);
				if (!(await this.getFileSaveConfirmation(file, 'edit', toolInvocationToken))) {
					this._logService.trace(`[CopilotCLISession] Aborting editing of file ${file.fsPath} as user denied permission to to save the uncommited changes.`);
					return { kind: 'denied-interactively-by-user' };
				}
				if (await this.applyEdits(file, permissionRequest.diff, stream)) {
					return { kind: 'approved' };
				}
				break;
			}
			case 'read': {
				const file = Uri.file(permissionRequest.path);
				if (await this.getFileSaveConfirmation(file, 'read', toolInvocationToken)) {
					return { kind: 'approved' };
				} else {
					return { kind: 'denied-interactively-by-user' };
				}
			}
			default:
				break;
		}
		return { kind: 'approved' };
	}

	/**
	 * For llm to be able to read the file, we must ensure the file is not dirty.
	 */
	private async getFileSaveConfirmation(path: Uri, reason: 'read' | 'edit', toolInvocationToken: vscode.ChatParticipantToolToken): Promise<boolean> {
		// No changes outside workspace
		if (!this._workspaceService.getWorkspaceFolder(path)) {
			return true;
		}

		const stat = await this._fileSystemService.stat(path);
		if (stat.type !== FileType.File || !(await this.isFileDirty(path))) {
			return true;
		}

		// Prompt user to save the file before reading
		const message = reason === 'read' ?
			l10n.t('You will need to save the {0} before reading its contents.', path.fsPath) :
			l10n.t('You will need to save the {0} before editing its contents.', path.fsPath);
		const input = {
			title: 'Save file(s)',
			message,
			confirmationType: 'basic'
		};

		// For llm to be able to read the file, we must save the file first.
		const saveAndContinue = await this.getConfirmation(ToolName.CoreConfirmationTool, input, toolInvocationToken);
		if (saveAndContinue) {
			await this.saveFile(path);
			return true;
		}
		return false;
	}

	private async getConfirmation(tool: string, input: unknown, toolInvocationToken: vscode.ChatParticipantToolToken): Promise<boolean> {
		try {
			const result = await this.toolsService.invokeTool(tool,
				{ input, toolInvocationToken },
				CancellationToken.None
			);

			const firstResultPart = result.content.at(0);
			if (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes') {
				return true;
			}
		} catch (error) {
			this._logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		}

		return false;
	}

	private async applyEdits(file: Uri, diff: string, stream: vscode.ChatResponseStream): Promise<boolean> {
		// TODO @DonJayamanne: Handle notebook edits
		if (await this._notebookService.hasSupportedNotebooks(file)) {
			return true;
		}

		const document = await this._workspaceService.openTextDocument(file);
		const changed = new Promise<boolean>((resolve) => this.add(this._workspaceService.onDidChangeTextDocument(e => {
			if (e.document === document) {
				resolve(true);
			}
		})));
		const edits = await this.computeEdits(document, diff);
		stream.textEdit(document.uri, []);
		edits.forEach(edit => stream.textEdit(document.uri, edit));
		if (!(await raceTimeout(changed, 5_000))) {
			this._logService.warn(`[CopilotCLISession] Timed out waiting for edits to be applied to ${file.fsPath}`);
		}
		await this.saveFile(file);
		return true;
	}

	private async computeEdits(document: vscode.TextDocument, diff: string): Promise<TextEdit[]> {
		const diffLines = diff.split(/\r?\n/);
		const codeLines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
		return createEditsFromRealDiff(codeLines, diffLines).map(e => e.toTextEdit());
	}

	private async isFileDirty(file: Uri): Promise<boolean> {
		if (await this._notebookService.hasSupportedNotebooks(file)) {
			const notebook = await this._workspaceService.openNotebookDocument(file);
			return notebook.isDirty;
		} else {
			const document = await this._workspaceService.openTextDocument(file);
			return document.isDirty;
		}
	}

	private async saveFile(file: Uri): Promise<void> {
		if (await this._notebookService.hasSupportedNotebooks(file)) {
			// TODO @DonJayamanne: Handle notebook edits
			// const notebook = await this._workspaceService.openNotebookDocument(file);
			// await notebook.save();
		} else {
			if (this._tabsAndEditorsService.visibleTextEditors.some(e => isEqual(e.document.uri, file))) {
				await this._workspaceService.save(file);
			} else {
				const document = this._workspaceService.textDocuments.find(d => isEqual(d.uri, file));
				await document?.save();
			}
		}
	}
}
