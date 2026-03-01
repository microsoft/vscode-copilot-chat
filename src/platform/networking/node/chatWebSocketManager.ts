/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OpenAI } from 'openai';
import { createServiceIdentifier } from '../../../util/common/services';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ModelSupportedEndpoint } from '../../endpoint/common/endpointProvider';
import { ILogService } from '../../log/common/logService';

export const IChatWebSocketManager = createServiceIdentifier<IChatWebSocketManager>('IChatWebSocketManager');

export interface IChatWebSocketManager {
	readonly _serviceBrand: undefined;

	/**
	 * Gets or creates a WebSocket connection for the given conversation turn.
	 * The connection is scoped to a single turn, reused across tool call rounds
	 * within the same turn, but closed when a new turn starts.
	 */
	getOrCreateConnection(conversationId: string, turnId: string, secretKey: string): Promise<IChatWebSocketConnection>;

	/**
	 * Returns true if there is an open WebSocket connection for the given
	 * conversation and run. Used to decide whether the server already has
	 * context from earlier iterations in this turn.
	 */
	hasActiveConnection(conversationId: string, turnId: string): boolean;

	/**
	 * Closes and removes the connection for a specific conversation.
	 * When turnId is provided, the connection is only closed if it matches
	 * the currently tracked run for that conversation.
	 */
	closeConnection(conversationId: string, turnId?: string): void;

	/**
	 * Closes all active connections.
	 */
	closeAll(): void;
}

/**
 * No-op implementation for contexts where WebSocket is not available (web, tests, chat-lib).
 */
export class NullChatWebSocketManager implements IChatWebSocketManager {
	declare readonly _serviceBrand: undefined;
	async getOrCreateConnection(_conversationId: string, _turnId: string, _secretKey: string): Promise<IChatWebSocketConnection> {
		throw new Error('WebSocket not available');
	}
	hasActiveConnection(_conversationId: string, _turnId: string): boolean { return false; }
	closeConnection(_conversationId: string, _turnId?: string): void { }
	closeAll(): void { }
}

export interface IChatWebSocketConnection extends IDisposable {
	/** Sends a response.create request and returns an async iterable of response events. */
	sendRequest(
		body: Record<string, unknown>,
		token: CancellationToken,
	): IChatWebSocketRequestHandle;

	/** Whether the connection is currently open and usable. */
	readonly isOpen: boolean;
}

export interface IChatWebSocketRequestHandle {
	/** Fires for each JSON event received from the server. */
	readonly onEvent: Event<OpenAI.Responses.ResponseStreamEvent>;
	/** Fires when an error occurs. */
	readonly onError: Event<Error>;
	/** Fires when the request completes (response.completed received). */
	readonly onComplete: Event<void>;
	/** Resolves when the request has finished (completed or errored). */
	readonly done: Promise<void>;
}

export class ChatWebSocketManager extends Disposable implements IChatWebSocketManager {
	declare readonly _serviceBrand: undefined;

	private readonly _connections = new Map<string, { turnId: string; connection: ChatWebSocketConnection }>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
	) {
		super();
	}

	async getOrCreateConnection(conversationId: string, turnId: string, secretKey: string): Promise<IChatWebSocketConnection> {
		const existing = this._connections.get(conversationId);

		// Reuse the connection if it's for the same turn and still open.
		if (existing?.turnId === turnId && existing.connection.isOpen) {
			this._logService.debug(`[ChatWebSocketManager] Reusing connection for conversation ${conversationId} turn ${turnId}`);
			return existing.connection;
		}

		if (existing) {
			this._logService.debug(`[ChatWebSocketManager] Closing previous connection for conversation ${conversationId} (turn changed)`);
			existing.connection.dispose();
			this._connections.delete(conversationId);
		}

		const uri = URI.parse(this._capiClientService.capiPingURL);
		const wsUrl = uri.with({ scheme: uri.scheme === 'https' ? 'wss' : 'ws', path: ModelSupportedEndpoint.Responses }).toString();

		const connection = new ChatWebSocketConnection(wsUrl, secretKey, this._logService, conversationId, turnId);
		this._logService.debug(`[ChatWebSocketManager] Creating new connection for conversation ${conversationId} turn ${turnId}`);
		this._connections.set(conversationId, { turnId, connection });

		// Remove from map when disposed externally
		connection.onDidDispose(() => {
			const entry = this._connections.get(conversationId);
			if (entry?.connection === connection) {
				this._connections.delete(conversationId);
			}
		});

		await connection.connect();
		return connection;
	}

	hasActiveConnection(conversationId: string, turnId: string): boolean {
		const entry = this._connections.get(conversationId);
		return !!entry && entry.turnId === turnId && entry.connection.isOpen;
	}

	closeConnection(conversationId: string, turnId?: string): void {
		const entry = this._connections.get(conversationId);
		if (entry) {
			if (turnId && entry.turnId !== turnId) {
				this._logService.debug(`[ChatWebSocketManager] Not closing connection for conversation ${conversationId}: requested turn ${turnId} does not match active turn ${entry.turnId}`);
				return;
			}
			this._logService.debug(`[ChatWebSocketManager] Closing connection for conversation ${conversationId} turn ${turnId}`);
			entry.connection.dispose();
			this._connections.delete(conversationId);
		}
	}

	closeAll(): void {
		for (const entry of this._connections.values()) {
			entry.connection.dispose();
		}
		this._connections.clear();
	}

	override dispose(): void {
		this.closeAll();
		super.dispose();
	}
}

const enum ConnectionState {
	Connecting,
	Open,
	Closed,
}

function wsCloseCodeToString(code: number): string {
	switch (code) {
		case 1000: return 'Normal Closure';
		case 1001: return 'Going Away';
		case 1002: return 'Protocol Error';
		case 1003: return 'Unsupported Data';
		case 1005: return 'No Status Received';
		case 1006: return 'Abnormal Closure';
		case 1007: return 'Invalid Payload';
		case 1008: return 'Policy Violation';
		case 1009: return 'Message Too Big';
		case 1010: return 'Missing Extension';
		case 1011: return 'Internal Error';
		case 1012: return 'Service Restart';
		case 1013: return 'Try Again Later';
		case 1014: return 'Bad Gateway';
		case 1015: return 'TLS Handshake Failed';
		default: return 'Unknown';
	}
}

class ChatWebSocketConnection extends Disposable implements IChatWebSocketConnection {
	private _ws: WebSocket | undefined;
	private _state: ConnectionState = ConnectionState.Closed;
	private _activeRequest: ChatWebSocketActiveRequest | undefined;

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	constructor(
		private readonly _url: string,
		private readonly _secretKey: string,
		private readonly _logService: ILogService,
		private readonly _conversationId: string,
		private readonly _turnId: string,
	) {
		super();
	}

	get isOpen(): boolean {
		return this._state === ConnectionState.Open && !!this._ws;
	}

	async connect(): Promise<void> {
		if (this._state === ConnectionState.Open) {
			return;
		}

		this._state = ConnectionState.Connecting;
		this._logService.debug(`[ChatWebSocketManager] Connecting to ${this._url} for conversation ${this._conversationId} turn ${this._turnId}`);

		return new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(this._url, {
				headers: {
					'Authorization': `Bearer ${this._secretKey}`,
					'Copilot-Integration-Id': 'vscode-chat',
				},
			});

			const onOpen = () => {
				cleanup();
				this._state = ConnectionState.Open;
				this._ws = ws;
				this._setupMessageHandlers(ws);
				this._logService.debug(`[ChatWebSocketManager] Connected for conversation ${this._conversationId} turn ${this._turnId}`);
				resolve();
			};

			const onError = (event: globalThis.Event) => {
				cleanup();
				this._state = ConnectionState.Closed;
				const errorMessage = 'message' in event ? String((event as globalThis.Event & { message?: string }).message) : 'WebSocket connection failed';
				this._logService.error(`[ChatWebSocketManager] Connection error for conversation ${this._conversationId} turn ${this._turnId}: ${errorMessage}`);
				reject(new Error(errorMessage));
			};

			const onClose = () => {
				cleanup();
				this._state = ConnectionState.Closed;
				this._logService.debug(`[ChatWebSocketManager] Connection closed during setup for conversation ${this._conversationId} turn ${this._turnId}`);
				reject(new Error('WebSocket closed during connection setup'));
			};

			const cleanup = () => {
				ws.removeEventListener('open', onOpen);
				ws.removeEventListener('error', onError);
				ws.removeEventListener('close', onClose);
			};

			ws.addEventListener('open', onOpen);
			ws.addEventListener('error', onError);
			ws.addEventListener('close', onClose);
		});
	}

	private _setupMessageHandlers(ws: WebSocket): void {
		ws.addEventListener('message', (event) => {
			if (typeof event.data !== 'string') {
				return; // Only process text messages
			}

			let parsed: OpenAI.Responses.ResponseStreamEvent;
			try {
				parsed = JSON.parse(event.data);
			} catch {
				this._logService.error(`[ChatWebSocketManager] Failed to parse message for conversation ${this._conversationId} turn ${this._turnId}`);
				return;
			}

			this._activeRequest?.handleEvent(parsed);
		});

		ws.addEventListener('close', (event) => {
			this._state = ConnectionState.Closed;
			this._logService.debug(`[ChatWebSocketManager] Connection closed for conversation ${this._conversationId} turn ${this._turnId} (code: ${event.code} ${wsCloseCodeToString(event.code)}${event.reason ? `, reason: ${event.reason}` : ''})`);
			this._activeRequest?.handleConnectionClose(event.code, event.reason);
			this._activeRequest = undefined;
		});

		ws.addEventListener('error', (event) => {
			const errorMessage = 'message' in event ? String((event as globalThis.Event & { message?: string }).message) : 'WebSocket error';
			this._logService.error(`[ChatWebSocketManager] Error for conversation ${this._conversationId} turn ${this._turnId}: ${errorMessage}`);
			this._activeRequest?.handleError(new Error(errorMessage));
		});
	}

	sendRequest(body: Record<string, unknown>, token: CancellationToken): IChatWebSocketRequestHandle {
		if (!this._ws || this._state !== ConnectionState.Open) {
			throw new Error('WebSocket is not connected');
		}

		// Cancel any previous in-flight request
		this._activeRequest?.handleError(new Error('Request superseded by new request'));

		const request = new ChatWebSocketActiveRequest();
		this._activeRequest = request;

		// Handle cancellation
		const cancelDisposable = token.onCancellationRequested(() => {
			if (this._activeRequest === request) {
				request.handleError(new CancellationError());
				this._activeRequest = undefined;
			}
		});
		request.done.finally(() => cancelDisposable.dispose());

		const message: Record<string, unknown> = {
			type: 'response.create',
			...body,
		};

		// Remove `stream: true` as WebSocket always streams
		delete message['stream'];

		this._logService.debug(`[ChatWebSocketManager] Sending request for conversation ${this._conversationId} turn ${this._turnId}`);
		this._ws.send(JSON.stringify(message));

		return request;
	}

	override dispose(): void {
		this._activeRequest?.handleError(new Error('Connection disposed'));
		this._activeRequest = undefined;

		if (this._ws) {
			this._ws.close();
			this._ws = undefined;
		}
		this._state = ConnectionState.Closed;
		this._onDidDispose.fire();
		super.dispose();
	}
}

class ChatWebSocketActiveRequest implements IChatWebSocketRequestHandle {
	private readonly _onEvent = new Emitter<OpenAI.Responses.ResponseStreamEvent>();
	readonly onEvent = this._onEvent.event;

	private readonly _onError = new Emitter<Error>();
	readonly onError = this._onError.event;

	private readonly _onComplete = new Emitter<void>();
	readonly onComplete = this._onComplete.event;

	private _resolve!: () => void;
	private _reject!: (err: Error) => void;
	private _settled = false;

	readonly done: Promise<void>;

	constructor() {
		this.done = new Promise<void>((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
	}

	handleEvent(event: OpenAI.Responses.ResponseStreamEvent): void {
		if (this._settled) {
			return;
		}

		if (event.type === 'error') {
			const error = new Error(event.message || 'Server error');
			(error as Error & { code?: string }).code = event.code || undefined;
			this._onError.fire(error);
			this._settled = true;
			this._reject(error);
			this._dispose();
			return;
		}

		this._onEvent.fire(event);

		if (event.type === 'response.completed') {
			this._onComplete.fire();
			this._settled = true;
			this._resolve();
			this._dispose();
		}
	}

	handleConnectionClose(code: number, reason: string): void {
		if (this._settled) {
			return;
		}
		const error = new Error(`WebSocket closed unexpectedly (code: ${code} ${wsCloseCodeToString(code)}${reason ? `, reason: ${reason}` : ''})`);
		this._onError.fire(error);
		this._settled = true;
		this._reject(error);
		this._dispose();
	}

	handleError(error: Error): void {
		if (this._settled) {
			return;
		}
		this._onError.fire(error);
		this._settled = true;
		this._reject(error);
		this._dispose();
	}

	private _dispose(): void {
		this._onEvent.dispose();
		this._onError.dispose();
		this._onComplete.dispose();
	}
}
