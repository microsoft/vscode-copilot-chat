/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, Session } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { DisposableStore, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { extUriBiasedIgnorePathCase } from '../../../../util/vs/base/common/resources';
import { ChatRequestTurn2, ChatResponseThinkingProgressPart, ChatResponseTurn2, ChatSessionStatus, EventEmitter, Uri } from '../../../../vscodeTypes';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { CopilotCLISessionOptions, ICopilotCLISessionOptionsService } from './copilotCli';
import { buildChatHistoryFromEvents, getAffectedUrisForEditTool, isCopilotCliEditToolCall, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
import { PermissionRequest } from './permissionHelpers';

/**
 * Handler function that processes permission requests from the Copilot CLI session.
 * @param permissionRequest - The permission request to handle
 * @param token - Cancellation token to abort the permission request
 * @returns A promise that resolves to true if permission is granted, false otherwise
 */
type PermissionHandler = (
	permissionRequest: PermissionRequest,
	token: CancellationToken,
) => Promise<boolean>;

/**
 * Interface for managing a Copilot CLI session.
 * Provides methods for handling chat requests, managing permissions, and tracking session status.
 */
export interface ICopilotCLISession extends IDisposable {
	/** Unique identifier for this session */
	readonly sessionId: string;

	/** Current status of the chat session (InProgress, Completed, or Failed) */
	readonly status: vscode.ChatSessionStatus | undefined;

	/** Event fired when the session status changes */
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;

	/** The currently pending permission request, if any */
	readonly permissionRequested?: PermissionRequest;

	/** Event fired when a permission request is made */
	readonly onPermissionRequested: vscode.Event<PermissionRequest>;

	/**
	 * Attaches a handler to process permission requests from the CLI.
	 * @param handler - The permission handler function
	 * @returns A disposable to unregister the handler
	 */
	attachPermissionHandler(handler: PermissionHandler): IDisposable;

	/**
	 * Attaches a response stream to receive session output.
	 * @param stream - The chat response stream
	 * @returns A disposable to detach the stream
	 */
	attachStream(stream: vscode.ChatResponseStream): IDisposable;

	/**
	 * Handles a chat request by sending it to the Copilot CLI session.
	 * @param prompt - The user's prompt text
	 * @param attachments - Any file or context attachments
	 * @param modelId - Optional model ID to use for this request
	 * @param token - Cancellation token
	 */
	handleRequest(
		prompt: string,
		attachments: Attachment[],
		modelId: string | undefined,
		token: vscode.CancellationToken
	): Promise<void>;

	/**
	 * Adds a user message to the session history.
	 * @param content - The message content
	 */
	addUserMessage(content: string): void;

	/**
	 * Adds an assistant message to the session history.
	 * @param content - The message content
	 */
	addUserAssistantMessage(content: string): void;

	/**
	 * Gets the currently selected model ID for this session.
	 * @returns The model ID or undefined if none is selected
	 */
	getSelectedModelId(): Promise<string | undefined>;

	/**
	 * Retrieves the chat history for this session.
	 * @returns An array of chat request and response turns
	 */
	getChatHistory(): (ChatRequestTurn2 | ChatResponseTurn2)[];
}

/**
 * Manages a Copilot CLI session, handling chat interactions, tool invocations,
 * permissions, and file edits. This class bridges between VS Code's chat UI and
 * the underlying Copilot CLI SDK session.
 */
export class CopilotCLISession extends DisposableStore implements ICopilotCLISession {
	/** Map tracking pending tool invocations by their call ID */
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();

	public readonly sessionId: string;

	/** Current session status */
	private _status?: vscode.ChatSessionStatus;
	public get status(): vscode.ChatSessionStatus | undefined {
		return this._status;
	}

	/** Event emitter for status changes */
	private readonly _statusChange = this.add(new EventEmitter<vscode.ChatSessionStatus | undefined>());

	public readonly onDidChangeStatus = this._statusChange.event;

	/** Currently pending permission request awaiting user response */
	private _permissionRequested?: PermissionRequest;
	public get permissionRequested(): PermissionRequest | undefined {
		return this._permissionRequested;
	}

	/** Event emitter for permission requests */
	private readonly _onPermissionRequested = this.add(new EventEmitter<PermissionRequest>());
	public readonly onPermissionRequested = this._onPermissionRequested.event;

	/** Handler function for processing permission requests */
	private _permissionHandler?: PermissionHandler;

	/** Event emitter that fires when a permission handler is set */
	private readonly _permissionHandlerSet = this.add(new Emitter<void>());

	/** The active chat response stream for outputting messages */
	private _stream?: vscode.ChatResponseStream;

	constructor(
		private readonly _options: CopilotCLISessionOptions,
		private readonly _sdkSession: Session,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ICopilotCLISessionOptionsService private readonly cliSessionOptions: ICopilotCLISessionOptionsService,
	) {
		super();
		this.sessionId = _sdkSession.sessionId;
	}

	/**
	 * Attaches a response stream to this session for outputting messages.
	 * @param stream - The chat response stream to attach
	 * @returns A disposable to detach the stream when no longer needed
	 */
	attachStream(stream: vscode.ChatResponseStream): IDisposable {
		this._stream = stream;
		return toDisposable(() => {
			if (this._stream === stream) {
				this._stream = undefined;
			}
		});
	}

	/**
	 * Attaches a permission handler to process permission requests from the CLI.
	 * The handler will be called whenever the CLI needs permission for file operations or commands.
	 * @param handler - The function to handle permission requests
	 * @returns A disposable to unregister the handler
	 */
	attachPermissionHandler(handler: PermissionHandler): IDisposable {
		this._permissionHandler = handler;
		this._permissionHandlerSet.fire();
		return toDisposable(() => {
			if (this._permissionHandler === handler) {
				this._permissionHandler = undefined;
			}
		});
	}

	/**
	 * Handles a chat request by sending it to the Copilot CLI session.
	 * This method:
	 * - Sets up event listeners for tool invocations and messages
	 * - Manages permission requests for file operations
	 * - Tracks edit operations and their lifecycle
	 * - Updates session status throughout the request lifecycle
	 * 
	 * @param prompt - The user's prompt text
	 * @param attachments - Any file or context attachments to include
	 * @param modelId - Optional model ID to use for this request
	 * @param token - Cancellation token to abort the request
	 * @throws Error if the session has been disposed
	 */
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

		// Link cancellation token to abort controller
		disposables.add(token.onCancellationRequested(() => {
			abortController.abort();
		}));
		disposables.add(toDisposable(() => abortController.abort()));

		// Track tool invocations and file edits
		const toolNames = new Map<string, string>();
		const editToolIds = new Set<string>();
		const editTracker = new ExternalEditTracker();
		const editFilesAndToolCallIds = new ResourceMap<string[]>();

		// Register permission handler for this request
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
			// Set up authentication and model selection
			const [currentModel, authInfo] = await Promise.all([
				modelId ? this._sdkSession.getSelectedModel() : undefined,
				this.cliSessionOptions.createOptions({}).then(opts => opts.toSessionOptions().authInfo)
			]);
			if (authInfo) {
				this._sdkSession.setAuthInfo(authInfo);
			}
			if (modelId && modelId !== currentModel) {
				await this._sdkSession.setSelectedModel(modelId);
			}

			// Register event listeners for SDK session events

			// Log all events for debugging
			disposables.add(toDisposable(this._sdkSession.on('*', (event) => this.logService.trace(`[CopilotCLISession]CopilotCLI Event: ${JSON.stringify(event, null, 2)}`))));

			// Handle assistant messages by streaming to the response
			disposables.add(toDisposable(this._sdkSession.on('assistant.message', (event) => {
				if (typeof event.data.content === 'string' && event.data.content.length) {
					this._stream?.markdown(event.data.content);
				}
			})));

			// Handle tool execution start events
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_start', (event) => {
				toolNames.set(event.data.toolCallId, event.data.toolName);
				if (isCopilotCliEditToolCall(event.data.toolName, event.data.arguments)) {
					editToolIds.add(event.data.toolCallId);
					// Track which files will be edited by this tool call for permission correlation
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
					// For non-edit tools, show progress in the UI
					const responsePart = processToolExecutionStart(event, this._pendingToolInvocations);
					if (responsePart instanceof ChatResponseThinkingProgressPart) {
						this._stream?.push(responsePart);
					}
				}
				this.logService.trace(`[CopilotCLISession] Start Tool ${event.data.toolName || '<unknown>'}`);
			})));

			// Handle tool execution completion events
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_complete', (event) => {
				// Mark the end of the edit if this was an edit tool
				editTracker.completeEdit(event.data.toolCallId);
				if (editToolIds.has(event.data.toolCallId)) {
					this.logService.trace(`[CopilotCLISession] Completed edit tracking for toolCallId ${event.data.toolCallId}`);
					return;
				}

				// For non-edit tools, show completion in the UI
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

			// Handle session errors
			disposables.add(toDisposable(this._sdkSession.on('session.error', (event) => {
				this.logService.error(`[CopilotCLISession]CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
				this._stream?.markdown(`\n\n❌ Error: (${event.data.errorType}) ${event.data.message}`);
			})));

			// Send the request to the SDK
			await this._sdkSession.send({ prompt, attachments, abortController });
			this.logService.trace(`[CopilotCLISession] Invoking session (completed) ${this.sessionId}`);

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

	/**
	 * Adds a user message to the session history.
	 * @param content - The message content to add
	 */
	addUserMessage(content: string) {
		this._sdkSession.emit('user.message', { content });
	}

	/**
	 * Adds an assistant message to the session history.
	 * @param content - The message content to add
	 */
	addUserAssistantMessage(content: string) {
		this._sdkSession.emit('assistant.message', {
			messageId: `msg_${Date.now()}`,
			content
		});
	}

	/**
	 * Gets the currently selected model ID for this session.
	 * @returns A promise resolving to the model ID, or undefined if none is selected
	 */
	public getSelectedModelId() {
		return this._sdkSession.getSelectedModel();
	}

	/**
	 * Retrieves the chat history for this session.
	 * Converts SDK session events into VS Code chat history format.
	 * @returns An array of chat request and response turns
	 */
	public getChatHistory(): (ChatRequestTurn2 | ChatResponseTurn2)[] {
		const events = this._sdkSession.getEvents();
		return buildChatHistoryFromEvents(events);
	}

	/**
	 * Handles permission requests from the Copilot CLI.
	 * 
	 * This method implements an auto-approval policy for certain operations:
	 * - Read operations within the workspace or working directory are auto-approved
	 * - Write operations to non-workspace working directories (e.g., git worktrees) are auto-approved
	 * - All other operations require explicit user approval via the permission handler
	 * 
	 * For approved write operations, file edits are tracked to show progress in the UI.
	 * 
	 * @param permissionRequest - The permission request to handle
	 * @param editTracker - Tracker for monitoring file edits
	 * @param getEditKeyForFile - Function to get the tool call ID associated with a file edit
	 * @param workingDirectory - The session's working directory, if any
	 * @param token - Cancellation token
	 * @returns A promise resolving to an approval or denial result
	 */
	private async requestPermission(
		permissionRequest: PermissionRequest,
		editTracker: ExternalEditTracker,
		getEditKeyForFile: (file: Uri) => string | undefined,
		workingDirectory: string | undefined,
		token: vscode.CancellationToken
	): Promise<{ kind: 'approved' } | { kind: 'denied-interactively-by-user' }> {
		// Auto-approve read operations within workspace or working directory
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

		// Auto-approve write operations to non-workspace working directories
		if (workingDirectory && permissionRequest.kind === 'write') {
			// TODO:@rebornix @lszomoru
			// If user is writing a file in the working directory configured for the session, AND the working directory is not a workspace folder,
			// auto-approve the write request. Currently we only set non-workspace working directories when using git worktrees.
			const data = Uri.file(permissionRequest.fileName);

			if (!this.workspaceService.getWorkspaceFolder(Uri.file(workingDirectory)) && extUriBiasedIgnorePathCase.isEqualOrParent(data, Uri.file(workingDirectory))) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to write file in working directory ${permissionRequest.fileName}`);
				return { kind: 'approved' };
			}
		}

		// Request explicit user approval for operations that don't qualify for auto-approval
		try {
			const permissionHandler = await this.waitForPermissionHandler(permissionRequest);
			if (!permissionHandler) {
				this.logService.warn(`[CopilotCLISession] No permission handler registered, denying request for ${permissionRequest.kind} permission.`);
				return { kind: 'denied-interactively-by-user' };
			}

			if (await permissionHandler(permissionRequest, token)) {
				// If we're editing a file, start tracking the edit & wait for core to acknowledge it
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

	/**
	 * Waits for a permission handler to be attached, if one isn't already available.
	 * This method fires the permission requested event and waits for a handler to be attached
	 * before resolving.
	 * 
	 * @param permissionRequest - The permission request that needs handling
	 * @returns A promise resolving to the permission handler, or undefined if none is set
	 */
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
