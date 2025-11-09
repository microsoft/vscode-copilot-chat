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
 * Handler function type for processing permission requests from the Copilot CLI session.
 * Called when the CLI needs permission to perform operations like reading or writing files.
 */
type PermissionHandler = (
	permissionRequest: PermissionRequest,
	token: CancellationToken,
) => Promise<boolean>;

/**
 * Interface for managing a Copilot CLI session.
 * Provides methods for handling chat requests, managing permissions, and tracking session state.
 */
export interface ICopilotCLISession extends IDisposable {
	/** Unique identifier for this CLI session */
	readonly sessionId: string;
	/** Current status of the session (InProgress, Completed, Failed, or undefined) */
	readonly status: vscode.ChatSessionStatus | undefined;
	/** Event fired when the session status changes */
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;
	/** The currently pending permission request, if any */
	readonly permissionRequested?: PermissionRequest;
	/** Event fired when a permission request is made */
	readonly onPermissionRequested: vscode.Event<PermissionRequest>;

	/**
	 * Attaches a handler to process permission requests during the session.
	 * @param handler Function to handle permission requests
	 * @returns Disposable to remove the handler
	 */
	attachPermissionHandler(handler: PermissionHandler): IDisposable;
	/**
	 * Attaches a response stream to receive output from the CLI session.
	 * @param stream The chat response stream to attach
	 * @returns Disposable to detach the stream
	 */
	attachStream(stream: vscode.ChatResponseStream): IDisposable;
	/**
	 * Handles a chat request in the CLI session.
	 * @param prompt The user's prompt text
	 * @param attachments File attachments included with the request
	 * @param modelId Optional model ID to use for this request
	 * @param token Cancellation token
	 */
	handleRequest(
		prompt: string,
		attachments: Attachment[],
		modelId: string | undefined,
		token: vscode.CancellationToken
	): Promise<void>;
	/**
	 * Adds a user message to the session history.
	 * @param content The message content
	 */
	addUserMessage(content: string): void;
	/**
	 * Adds an assistant message to the session history.
	 * @param content The message content
	 */
	addUserAssistantMessage(content: string): void;
	/**
	 * Gets the currently selected model ID for the session.
	 * @returns The model ID or undefined
	 */
	getSelectedModelId(): Promise<string | undefined>;
	/**
	 * Gets the complete chat history as an array of request and response turns.
	 * @returns Array of chat turns
	 */
	getChatHistory(): (ChatRequestTurn2 | ChatResponseTurn2)[];
}

/**
 * Implementation of a Copilot CLI session that manages interactions with the Copilot CLI SDK.
 * Handles chat requests, tool invocations, permission requests, and file editing operations.
 * 
 * This class coordinates between the VS Code chat UI, the Copilot CLI SDK, and various
 * services for workspace management, logging, and authentication.
 */
export class CopilotCLISession extends DisposableStore implements ICopilotCLISession {
	/** Tracks tool invocations that are currently pending completion */
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();
	public readonly sessionId: string;
	/** Current status of the session (InProgress, Completed, Failed, or undefined) */
	private _status?: vscode.ChatSessionStatus;
	public get status(): vscode.ChatSessionStatus | undefined {
		return this._status;
	}
	/** Event emitter for status changes */
	private readonly _statusChange = this.add(new EventEmitter<vscode.ChatSessionStatus | undefined>());

	public readonly onDidChangeStatus = this._statusChange.event;

	/** The currently pending permission request, if any */
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
	/** The currently attached response stream, if any */
	private _stream?: vscode.ChatResponseStream;
	/**
	 * Creates a new CopilotCLISession instance.
	 * @param _options Configuration options for the CLI session
	 * @param _sdkSession The underlying SDK session instance
	 * @param logService Service for logging messages
	 * @param workspaceService Service for workspace operations
	 * @param cliSessionOptions Service for creating CLI session options
	 */
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
	 * Attaches a response stream to receive output from the CLI session.
	 * The stream will receive markdown content, tool invocations, and error messages.
	 * @param stream The chat response stream to attach
	 * @returns Disposable to detach the stream
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
	 * Attaches a handler to process permission requests during the session.
	 * When a permission is requested, the handler will be called to determine whether to approve or deny it.
	 * @param handler Function to handle permission requests
	 * @returns Disposable to remove the handler
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
	 * Handles a chat request in the CLI session.
	 * Processes the request through the Copilot CLI SDK, managing tool invocations,
	 * permission requests, and file edits. Updates the session status and streams
	 * responses back through the attached stream.
	 * 
	 * @param prompt The user's prompt text
	 * @param attachments File attachments included with the request
	 * @param modelId Optional model ID to use for this request
	 * @param token Cancellation token to abort the request
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
		// Set up abort controller to handle cancellation requests
		const abortController = new AbortController();
		disposables.add(token.onCancellationRequested(() => {
			abortController.abort();
		}));
		disposables.add(toDisposable(() => abortController.abort()));

		// Track tool names and edit operations for correlation with permission requests
		const toolNames = new Map<string, string>();
		const editToolIds = new Set<string>();
		const editTracker = new ExternalEditTracker();
		const editFilesAndToolCallIds = new ResourceMap<string[]>();
		disposables.add(this._options.addPermissionHandler(async (permissionRequest) => {
			// Need better API from SDK to correlate file edits in permission requests to tool invocations.
			// When a file is being edited, we need to match it to the tool call that initiated the edit
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
			// Get current model and auth info in parallel for efficiency
			const [currentModel, authInfo] = await Promise.all([
				modelId ? this._sdkSession.getSelectedModel() : undefined,
				this.cliSessionOptions.createOptions({}).then(opts => opts.toSessionOptions().authInfo)
			]);
			// Update auth info if available
			if (authInfo) {
				this._sdkSession.setAuthInfo(authInfo);
			}
			// Switch to requested model if it's different from current
			if (modelId && modelId !== currentModel) {
				await this._sdkSession.setSelectedModel(modelId);
			}

			// Register event handlers for various SDK events
			// Log all events for debugging purposes
			disposables.add(toDisposable(this._sdkSession.on('*', (event) => this.logService.trace(`[CopilotCLISession]CopilotCLI Event: ${JSON.stringify(event, null, 2)}`))));
			// Handle assistant messages by streaming them to the UI
			disposables.add(toDisposable(this._sdkSession.on('assistant.message', (event) => {
				if (typeof event.data.content === 'string' && event.data.content.length) {
					this._stream?.markdown(event.data.content);
				}
			})));
			// Handle tool execution start events
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_start', (event) => {
				toolNames.set(event.data.toolCallId, event.data.toolName);
				// Check if this is an edit tool (str_replace_editor, edit, or create)
				if (isCopilotCliEditToolCall(event.data.toolName, event.data.arguments)) {
					editToolIds.add(event.data.toolCallId);
					// Track edits for edit tools to correlate with permission requests later
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
					// For non-edit tools, show thinking progress in the UI
					const responsePart = processToolExecutionStart(event, this._pendingToolInvocations);
					if (responsePart instanceof ChatResponseThinkingProgressPart) {
						this._stream?.push(responsePart);
					}
				}
				this.logService.trace(`[CopilotCLISession] Start Tool ${event.data.toolName || '<unknown>'}`);
			})));
			// Handle tool execution complete events
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_complete', (event) => {
				// Mark the end of the edit if this was an edit tool.
				editTracker.completeEdit(event.data.toolCallId);
				// Don't show edit tool results in the UI, as they're handled by the edit tracker
				if (editToolIds.has(event.data.toolCallId)) {
					this.logService.trace(`[CopilotCLISession] Completed edit tracking for toolCallId ${event.data.toolCallId}`);
					return;
				}

				// For non-edit tools, show the result in the UI
				const responsePart = processToolExecutionComplete(event, this._pendingToolInvocations);
				if (responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
					this._stream?.push(responsePart);
				}

				// Log tool completion details for debugging
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

			// Send the prompt and attachments to the SDK
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
	 * This allows programmatically adding messages to the session's event log.
	 * @param content The message content
	 */
	addUserMessage(content: string) {
		this._sdkSession.emit('user.message', { content });
	}

	/**
	 * Adds an assistant message to the session history.
	 * This allows programmatically adding assistant responses to the session's event log.
	 * @param content The message content
	 */
	addUserAssistantMessage(content: string) {
		this._sdkSession.emit('assistant.message', {
			messageId: `msg_${Date.now()}`,
			content
		});
	}

	/**
	 * Gets the currently selected model ID for the session.
	 * @returns The model ID or undefined if no model is selected
	 */
	public getSelectedModelId() {
		return this._sdkSession.getSelectedModel();
	}

	/**
	 * Gets the complete chat history as an array of request and response turns.
	 * Converts SDK events into a format compatible with VS Code's chat API.
	 * @returns Array of chat turns (requests and responses)
	 */
	public getChatHistory(): (ChatRequestTurn2 | ChatResponseTurn2)[] {
		const events = this._sdkSession.getEvents();
		return buildChatHistoryFromEvents(events);
	}

	/**
	 * Handles a permission request from the CLI session.
	 * Implements auto-approval logic for workspace/working directory files,
	 * and delegates other requests to the registered permission handler.
	 * 
	 * @param permissionRequest The permission request to handle
	 * @param editTracker Tracker for managing edit operations
	 * @param getEditKeyForFile Function to get the edit key for a file
	 * @param workingDirectory The working directory for the session
	 * @param token Cancellation token
	 * @returns Object indicating whether the permission was approved or denied
	 */
	private async requestPermission(
		permissionRequest: PermissionRequest,
		editTracker: ExternalEditTracker,
		getEditKeyForFile: (file: Uri) => string | undefined,
		workingDirectory: string | undefined,
		token: vscode.CancellationToken
	): Promise<{ kind: 'approved' } | { kind: 'denied-interactively-by-user' }> {
		// Auto-approve read requests for files in workspace or working directory
		if (permissionRequest.kind === 'read') {
			// If user is reading a file in the working directory or workspace, auto-approve
			// read requests. Outside workspace reads (e.g., /etc/passwd) will still require
			// approval.
			const data = Uri.file(permissionRequest.path);

			// Check if file is in the working directory
			if (workingDirectory && extUriBiasedIgnorePathCase.isEqualOrParent(data, Uri.file(workingDirectory))) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read file in working directory ${permissionRequest.path}`);
				return { kind: 'approved' };
			}

			// Check if file is in a workspace folder
			if (this.workspaceService.getWorkspaceFolder(data)) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to read workspace file ${permissionRequest.path}`);
				return { kind: 'approved' };
			}
		}

		// Auto-approve write requests for non-workspace working directories (e.g., git worktrees)
		if (workingDirectory && permissionRequest.kind === 'write') {
			// TODO:@rebornix @lszomoru
			// If user is writing a file in the working directory configured for the session, AND the working directory is not a workspace folder,
			// auto-approve the write request. Currently we only set non-workspace working directories when using git worktrees.
			const data = Uri.file(permissionRequest.fileName);

			// Only auto-approve if working directory is not a workspace folder
			if (!this.workspaceService.getWorkspaceFolder(Uri.file(workingDirectory)) && extUriBiasedIgnorePathCase.isEqualOrParent(data, Uri.file(workingDirectory))) {
				this.logService.trace(`[CopilotCLISession] Auto Approving request to write file in working directory ${permissionRequest.fileName}`);
				return { kind: 'approved' };
			}
		}

		try {
			// Wait for a permission handler to be registered and invoke it
			const permissionHandler = await this.waitForPermissionHandler(permissionRequest);
			if (!permissionHandler) {
				this.logService.warn(`[CopilotCLISession] No permission handler registered, denying request for ${permissionRequest.kind} permission.`);
				return { kind: 'denied-interactively-by-user' };
			}

			if (await permissionHandler(permissionRequest, token)) {
				// If we're editing a file, start tracking the edit & wait for core to acknowledge it.
				const editFile = permissionRequest.kind === 'write' ? Uri.file(permissionRequest.fileName) : undefined;
				const editKey = editFile ? getEditKeyForFile(editFile) : undefined;
				// Track the edit if applicable
				if (editFile && editKey && this._stream) {
					this.logService.trace(`[CopilotCLISession] Starting to track edit for toolCallId ${editKey} & file ${editFile.fsPath}`);
					await editTracker.trackEdit(editKey, [editFile], this._stream);
				}
				return { kind: 'approved' };
			}
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		} finally {
			// Clear the pending permission request
			this._permissionRequested = undefined;
		}

		return { kind: 'denied-interactively-by-user' };
	}

	/**
	 * Waits for a permission handler to be registered if one is not already available.
	 * If no handler is registered, fires an event to request one and waits for it to be attached.
	 * 
	 * @param permissionRequest The permission request to handle
	 * @returns The registered permission handler, or undefined if none is available
	 */
	private async waitForPermissionHandler(permissionRequest: PermissionRequest): Promise<PermissionHandler | undefined> {
		if (!this._permissionHandler) {
			// No handler registered yet, request one and wait for it to be attached
			this._permissionRequested = permissionRequest;
			this._onPermissionRequested.fire(permissionRequest);
			const disposables = this.add(new DisposableStore());
			// Wait for the permission handler to be set
			await Event.toPromise(this._permissionHandlerSet.event, disposables);
			disposables.dispose();
			this._permissionRequested = undefined;
		}
		return this._permissionHandler;
	}
}
