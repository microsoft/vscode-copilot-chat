/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OpenAI } from 'openai';
import { CloseEvent, ErrorEvent } from 'undici';
import { createServiceIdentifier } from '../../../util/common/services';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { QuotaSnapshots } from '../../chat/common/chatQuotaService';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService, collectSingleLineErrorMessage } from '../../log/common/logService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { HeadersImpl, IHeaders, WebSocketConnection } from '../common/fetcherService';
import { IEndpointBody } from '../common/networking';
import { ChatWebSocketRequestOutcome, ChatWebSocketTelemetrySender } from './chatWebSocketTelemetry';

export const IChatWebSocketManager = createServiceIdentifier<IChatWebSocketManager>('IChatWebSocketManager');

export interface IChatWebSocketManager {
	readonly _serviceBrand: undefined;

	/**
	 * Gets or creates a WebSocket connection for the given conversation turn.
	 * The connection is scoped to a single turn, reused across tool call rounds
	 * within the same turn, but closed when a new turn starts.
	 */
	getOrCreateConnection(conversationId: string, turnId: string, headers: Record<string, string>): IChatWebSocketConnection;

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
	getOrCreateConnection(_conversationId: string, _turnId: string, _headers?: Record<string, string>): IChatWebSocketConnection {
		throw new Error('WebSocket not available');
	}
	hasActiveConnection(_conversationId: string, _turnId: string): boolean { return false; }
	closeConnection(_conversationId: string, _turnId?: string): void { }
	closeAll(): void { }
}

export interface IChatWebSocketRequestOptions {
	userInitiated: boolean;
}

export interface IChatWebSocketConnection extends IDisposable {
	/** Opens the WebSocket connection. Must be called before sendRequest. */
	connect(): Promise<void>;

	/** Sends a response.create request and returns an async iterable of response events. */
	sendRequest(
		body: IEndpointBody,
		options: IChatWebSocketRequestOptions,
		token: CancellationToken,
	): IChatWebSocketRequestHandle;

	/** Whether the connection is currently open and usable. */
	readonly isOpen: boolean;

	/** Response headers from the WebSocket connection handshake. */
	readonly responseHeaders: IHeaders;

	/** Response status code from the WebSocket connection handshake. */
	readonly responseStatusCode: number | undefined;

	/** Response status text from the WebSocket connection handshake. */
	readonly responseStatusText: string | undefined;

	/** The request ID from response headers or the outgoing X-Request-Id header. */
	readonly requestId: string;

	/** The GitHub request ID from response headers. */
	readonly gitHubRequestId: string;

	/**
	 * The response.id from the last completed response on this connection.
	 * Used as `previous_response_id` on subsequent requests to avoid
	 * re-sending the full message history.
	 */
	readonly statefulMarker: string | undefined;
}

export interface IChatWebSocketRequestHandle {
	/** Fires for each OpenAI stream event received from the server. */
	readonly onEvent: Event<OpenAI.Responses.ResponseStreamEvent>;
	/** Fires when a CAPI WebSocket error is received (nested error shape). */
	readonly onCAPIError: Event<CAPIWebSocketErrorEvent>;
	/** Fires when a transport-level error occurs (connection lost, etc.). */
	readonly onError: Event<Error>;
	/**
	 * Resolves with the first event received from the server, or rejects
	 * if the connection errors/closes before any event arrives.
	 * Consumers can inspect the event type to decide the response kind
	 * (success stream vs. CAPI error) before processing remaining events.
	 */
	readonly firstEvent: Promise<OpenAI.Responses.ResponseStreamEvent | CAPIWebSocketErrorEvent>;
	/** Resolves when the request has finished (completed or errored). */
	readonly done: Promise<void>;
}

/**
 * CAPI WebSocket error shape. Unlike the OpenAI SDK's flat `ResponseErrorEvent`
 * (`{ type: "error", code, message }`), CAPI wraps the error details in a
 * nested `error` object: `{ type: "error", error: { code, message } }`.
 *
 * Non-recoverable errors (rate limits, quota, upstream failures) also include
 * `copilot_quota_snapshots` with per-model quota state.
 */
export interface CAPIWebSocketErrorEvent {
	readonly type: 'error';
	readonly error: {
		readonly code: string;
		readonly message: string;
	};
	readonly copilot_quota_snapshots?: QuotaSnapshots;
}

export function isCAPIWebSocketError(event: OpenAI.Responses.ResponseStreamEvent | CAPIWebSocketErrorEvent): event is CAPIWebSocketErrorEvent {
	return event.type === 'error' && 'error' in event && typeof (event as CAPIWebSocketErrorEvent).error?.code === 'string';
}

const streamTerminatingOutcomes: Readonly<Record<string, ChatWebSocketRequestOutcome>> = {
	'response.completed': 'completed',
	'response.failed': 'response_failed',
	'response.incomplete': 'response_incomplete',
	'response.cancelled': 'response_cancelled',
	'error': 'upstream_error',
};

export function getStreamTerminatingOutcome(event: OpenAI.Responses.ResponseStreamEvent | CAPIWebSocketErrorEvent): ChatWebSocketRequestOutcome | undefined {
	return streamTerminatingOutcomes[event.type];
}

export class ChatWebSocketManager extends Disposable implements IChatWebSocketManager {
	declare readonly _serviceBrand: undefined;

	private readonly _connections = new Map<string, { turnId: string; connection: ChatWebSocketConnection }>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	getOrCreateConnection(conversationId: string, turnId: string, headers: Record<string, string>): IChatWebSocketConnection {
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

		const connection = new ChatWebSocketConnection(this._capiClientService, this._logService, this._telemetryService, this._configurationService, conversationId, turnId, headers);
		this._logService.debug(`[ChatWebSocketManager] Creating new connection for conversation ${conversationId} turn ${turnId}`);
		this._connections.set(conversationId, { turnId, connection });

		// Remove from map when disposed externally
		connection.onDidDispose(() => {
			const entry = this._connections.get(conversationId);
			if (entry?.connection === connection) {
				this._connections.delete(conversationId);
			}
		});

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
	private _statefulMarker: string | undefined;

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	private _connectStartTime: number | undefined;
	private _connectedTime: number | undefined;
	private _pendingErrorMessage: string | undefined;
	private _totalSentMessageCount = 0;
	private _totalReceivedMessageCount = 0;
	private _totalSentCharacters = 0;
	private _totalReceivedCharacters = 0;
	private _responseHeaders: IHeaders = new HeadersImpl({});
	private _responseStatusCode: number | undefined;
	private _responseStatusText: string | undefined;

	constructor(
		private readonly _capiClientService: ICAPIClientService,
		private readonly _logService: ILogService,
		private readonly _telemetryService: ITelemetryService,
		private readonly _configurationService: IConfigurationService,
		private readonly _conversationId: string,
		private readonly _turnId: string,
		private readonly _headers: Record<string, string>,
	) {
		super();
	}

	get isOpen(): boolean {
		return this._state === ConnectionState.Open && !!this._ws;
	}

	get statefulMarker(): string | undefined {
		return this._statefulMarker;
	}

	get responseHeaders(): IHeaders {
		return this._responseHeaders;
	}

	get responseStatusCode(): number | undefined {
		return this._responseStatusCode;
	}

	get responseStatusText(): string | undefined {
		return this._responseStatusText;
	}

	get requestId(): string {
		return this._responseHeaders.get('x-request-id') || Object.entries(this._headers).find(([k]) => k.toLowerCase() === 'x-request-id')?.[1] || '';
	}

	get gitHubRequestId(): string {
		return this._responseHeaders.get('x-github-request-id') || '';
	}

	async connect(): Promise<void> {
		if (this._state === ConnectionState.Open) {
			return;
		}

		this._state = ConnectionState.Connecting;
		this._connectStartTime = Date.now();
		this._logService.debug(`[ChatWebSocketManager] Connecting WebSocket for conversation ${this._conversationId} turn ${this._turnId}`);

		const connection: WebSocketConnection = await this._capiClientService.createResponsesWebSocket({
			headers: this._headers,
		});

		return new Promise<void>((resolve, reject) => {
			const ws = connection.webSocket;

			const onOpen = () => {
				cleanup();
				this._state = ConnectionState.Open;
				this._connectedTime = Date.now();
				this._ws = ws;
				this._responseHeaders = connection.responseHeaders;
				this._responseStatusCode = connection.responseStatusCode;
				this._responseStatusText = connection.responseStatusText;
				this._setupMessageHandlers(ws);
				const connectDurationMs = this._connectedTime - (this._connectStartTime ?? this._connectedTime);
				this._logService.debug(`[ChatWebSocketManager] Connected for conversation ${this._conversationId} turn ${this._turnId}`);
				ChatWebSocketTelemetrySender.sendConnectedTelemetry(this._telemetryService, {
					conversationId: this._conversationId,
					turnId: this._turnId,
					requestId: this.requestId,
					gitHubRequestId: this.gitHubRequestId,
					connectDurationMs,
				});
				resolve();
			};

			const onError = (event: ErrorEvent) => {
				cleanup();
				this._state = ConnectionState.Closed;
				this._responseHeaders = connection.responseHeaders;
				this._responseStatusCode = connection.responseStatusCode;
				this._responseStatusText = connection.responseStatusText;
				const errorMessage = event.error ? `${event.message}: ${collectSingleLineErrorMessage(event.error)}` : event.message || 'WebSocket error';
				const connectDurationMs = Date.now() - (this._connectStartTime ?? Date.now());
				this._logService.error(`[ChatWebSocketManager] Connection error for conversation ${this._conversationId} turn ${this._turnId}: ${errorMessage}`);
				ChatWebSocketTelemetrySender.sendConnectErrorTelemetry(this._telemetryService, {
					conversationId: this._conversationId,
					turnId: this._turnId,
					requestId: this.requestId,
					gitHubRequestId: this.gitHubRequestId,
					error: errorMessage,
					connectDurationMs,
					responseStatusCode: this._responseStatusCode,
					responseStatusText: this._responseStatusText,
				});
				reject(new Error(errorMessage));
			};

			const onClose = (event: CloseEvent) => {
				cleanup();
				this._state = ConnectionState.Closed;
				this._responseHeaders = connection.responseHeaders;
				this._responseStatusCode = connection.responseStatusCode;
				this._responseStatusText = connection.responseStatusText;
				const connectDurationMs = Date.now() - (this._connectStartTime ?? Date.now());
				const closeCodeDescription = wsCloseCodeToString(event.code);
				this._logService.debug(`[ChatWebSocketManager] Connection closed during setup for conversation ${this._conversationId} turn ${this._turnId} (code: ${event.code} ${closeCodeDescription}, reason: ${event.reason || '<empty>'}, wasClean: ${event.wasClean})`);
				ChatWebSocketTelemetrySender.sendCloseDuringSetupTelemetry(this._telemetryService, {
					conversationId: this._conversationId,
					turnId: this._turnId,
					requestId: this.requestId,
					gitHubRequestId: this.gitHubRequestId,
					closeCode: event.code,
					closeReason: closeCodeDescription,
					closeEventReason: event.reason,
					closeEventWasClean: String(event.wasClean),
					connectDurationMs,
				});
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

			const receivedMessageCharacters = event.data.length;
			this._totalReceivedMessageCount += 1;
			this._totalReceivedCharacters += receivedMessageCharacters;
			const connectionDurationMs = Date.now() - (this._connectedTime ?? Date.now());

			let parsed: OpenAI.Responses.ResponseStreamEvent | CAPIWebSocketErrorEvent;
			try {
				parsed = JSON.parse(event.data);
			} catch (error) {
				const parseErrorMessage = collectSingleLineErrorMessage(error) || 'Failed to parse websocket message';
				this._logService.error(`[ChatWebSocketManager] Failed to parse message for conversation ${this._conversationId} turn ${this._turnId}: ${parseErrorMessage}`);
				ChatWebSocketTelemetrySender.sendMessageParseErrorTelemetry(this._telemetryService, {
					conversationId: this._conversationId,
					turnId: this._turnId,
					requestId: this.requestId,
					gitHubRequestId: this.gitHubRequestId,
					error: parseErrorMessage,
					connectionDurationMs,
					totalSentMessageCount: this._totalSentMessageCount,
					totalReceivedMessageCount: this._totalReceivedMessageCount,
					receivedMessageCharacters,
					totalSentCharacters: this._totalSentCharacters,
					totalReceivedCharacters: this._totalReceivedCharacters,
				});
				return;
			}

			if (!isCAPIWebSocketError(parsed) && parsed.type === 'response.completed') {
				this._statefulMarker = parsed.response.id;
			}

			this._activeRequest?.handleEvent(parsed);
		});

		ws.addEventListener('close', (event) => {
			this._state = ConnectionState.Closed;
			const connectionDurationMs = Date.now() - (this._connectedTime ?? Date.now());
			const closeCodeDescription = wsCloseCodeToString(event.code);
			this._logService.debug(`[ChatWebSocketManager] Connection closed for conversation ${this._conversationId} turn ${this._turnId} (code: ${event.code} ${closeCodeDescription}, reason: ${event.reason || '<empty>'}, wasClean: ${event.wasClean})`);
			ChatWebSocketTelemetrySender.sendCloseTelemetry(this._telemetryService, {
				conversationId: this._conversationId,
				turnId: this._turnId,
				requestId: this.requestId,
				gitHubRequestId: this.gitHubRequestId,
				closeCode: event.code,
				closeReason: closeCodeDescription,
				closeEventReason: event.reason,
				closeEventWasClean: String(event.wasClean),
				connectionDurationMs,
				totalSentMessageCount: this._totalSentMessageCount,
				totalReceivedMessageCount: this._totalReceivedMessageCount,
				totalSentCharacters: this._totalSentCharacters,
				totalReceivedCharacters: this._totalReceivedCharacters,
			});
			const errorMessage = this._pendingErrorMessage;
			this._pendingErrorMessage = undefined;
			this._activeRequest?.handleConnectionClose(event.code, event.reason, errorMessage);
			this._activeRequest = undefined;
		});

		ws.addEventListener('error', (event) => {
			const errorMessage = event.error ? `${event.message}: ${collectSingleLineErrorMessage(event.error)}` : event.message || 'WebSocket error';
			const connectionDurationMs = Date.now() - (this._connectedTime ?? Date.now());
			this._logService.error(`[ChatWebSocketManager] Error for conversation ${this._conversationId} turn ${this._turnId}: ${errorMessage}`);
			ChatWebSocketTelemetrySender.sendErrorTelemetry(this._telemetryService, {
				conversationId: this._conversationId,
				turnId: this._turnId,
				requestId: this.requestId,
				gitHubRequestId: this.gitHubRequestId,
				error: errorMessage,
				connectionDurationMs,
				totalSentMessageCount: this._totalSentMessageCount,
				totalReceivedMessageCount: this._totalReceivedMessageCount,
				totalSentCharacters: this._totalSentCharacters,
				totalReceivedCharacters: this._totalReceivedCharacters,
			});
			this._pendingErrorMessage ??= errorMessage;
		});
	}

	sendRequest(body: IEndpointBody, options: IChatWebSocketRequestOptions, token: CancellationToken): IChatWebSocketRequestHandle {
		if (!this._ws || this._state !== ConnectionState.Open) {
			throw new Error('WebSocket is not connected');
		}

		const statefulMarkerMatched = this._statefulMarker === body.previous_response_id;
		const previousResponseIdUnset = body.previous_response_id === undefined;
		const hasCompactionData = body.input?.some(item => item?.type === 'compaction') ?? false;
		const statefulMarkerPrefix = this._statefulMarker?.slice(0, 5).concat('...') ?? '<none>';
		const previousResponsePrefix = body.previous_response_id?.slice(0, 5).concat('...') ?? '<none>';
		if (statefulMarkerMatched) {
			this._logService.trace(`[ChatWebSocketManager] WebSocket stateful marker matches previous_response_id (${previousResponsePrefix})`);
		} else {
			this._logService.info(`[ChatWebSocketManager] WebSocket stateful marker (${statefulMarkerPrefix}) does not match previous_response_id (${previousResponsePrefix})`);
		}

		// Cancel any previous in-flight request
		this._activeRequest?.handleSuperseded();

		const requestStartTime = Date.now();
		const requestStartSentMessageCount = this._totalSentMessageCount;
		const requestStartReceivedMessageCount = this._totalReceivedMessageCount;
		const requestStartSentCharacters = this._totalSentCharacters;
		const requestStartReceivedCharacters = this._totalReceivedCharacters;
		const request = new ChatWebSocketActiveRequest(this._configurationService, this._logService);
		request.onDidSettle(({ outcome, closeCode, closeReason, serverErrorMessage, serverErrorCode }) => {
			const connectionDurationMs = Date.now() - (this._connectedTime ?? Date.now());
			const requestDurationMs = Date.now() - requestStartTime;
			const requestSentMessageCount = this._totalSentMessageCount - requestStartSentMessageCount;
			const requestReceivedMessageCount = this._totalReceivedMessageCount - requestStartReceivedMessageCount;
			const requestSentCharacters = this._totalSentCharacters - requestStartSentCharacters;
			const requestReceivedCharacters = this._totalReceivedCharacters - requestStartReceivedCharacters;
			ChatWebSocketTelemetrySender.sendRequestOutcomeTelemetry(this._telemetryService, {
				conversationId: this._conversationId,
				turnId: this._turnId,
				requestId: this.requestId,
				gitHubRequestId: this.gitHubRequestId,
				requestOutcome: outcome,
				statefulMarkerMatched,
				previousResponseIdUnset,
				hasCompactionData,
				connectionDurationMs,
				requestDurationMs,
				totalSentMessageCount: this._totalSentMessageCount,
				totalReceivedMessageCount: this._totalReceivedMessageCount,
				totalSentCharacters: this._totalSentCharacters,
				totalReceivedCharacters: this._totalReceivedCharacters,
				requestSentMessageCount,
				requestReceivedMessageCount,
				requestSentCharacters,
				requestReceivedCharacters,
				closeCode,
				closeReason,
				serverErrorMessage,
				serverErrorCode,
			});
		});
		this._activeRequest = request;

		// Handle cancellation
		const cancelDisposable = token.onCancellationRequested(() => {
			if (this._activeRequest === request) {
				request.handleCancellation();
				this._activeRequest = undefined;
			}
		});
		request.done.finally(() => cancelDisposable.dispose()).catch(() => { });

		const { stream: _, ...rest } = body;
		const message = {
			type: 'response.create' as const,
			...rest,
			initiator: options.userInitiated ? 'user' : 'agent',
		};
		const serializedMessage = JSON.stringify(message);
		const sentMessageCharacters = serializedMessage.length;
		this._totalSentMessageCount += 1;
		this._totalSentCharacters += sentMessageCharacters;

		const connectionDurationMs = Date.now() - (this._connectedTime ?? Date.now());
		this._logService.debug(`[ChatWebSocketManager] Sending request for conversation ${this._conversationId} turn ${this._turnId} (totalSentMessageCount: ${this._totalSentMessageCount}, sentMessageCharacters: ${sentMessageCharacters})`);
		ChatWebSocketTelemetrySender.sendRequestSentTelemetry(this._telemetryService, {
			conversationId: this._conversationId,
			turnId: this._turnId,
			requestId: this.requestId,
			gitHubRequestId: this.gitHubRequestId,
			statefulMarkerMatched,
			previousResponseIdUnset,
			hasCompactionData,
			connectionDurationMs,
			totalSentMessageCount: this._totalSentMessageCount,
			totalReceivedMessageCount: this._totalReceivedMessageCount,
			sentMessageCharacters,
			totalSentCharacters: this._totalSentCharacters,
			totalReceivedCharacters: this._totalReceivedCharacters,
		});
		this._ws.send(serializedMessage);

		return request;
	}

	override dispose(): void {
		this._activeRequest?.handleConnectionDisposed();
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

	private readonly _onCAPIError = new Emitter<CAPIWebSocketErrorEvent>();
	readonly onCAPIError = this._onCAPIError.event;

	private readonly _onError = new Emitter<Error>();
	readonly onError = this._onError.event;

	private _resolveFirstEvent!: (event: OpenAI.Responses.ResponseStreamEvent | CAPIWebSocketErrorEvent) => void;
	private _rejectFirstEvent!: (err: Error) => void;
	private _firstEventSettled = false;
	readonly firstEvent: Promise<OpenAI.Responses.ResponseStreamEvent | CAPIWebSocketErrorEvent>;

	private _resolve!: () => void;
	private _reject!: (err: Error) => void;
	private _settled = false;
	private _onDidSettle?: (result: { outcome: ChatWebSocketRequestOutcome; closeCode?: number; closeReason?: string; serverErrorMessage?: string; serverErrorCode?: string }) => void;

	readonly done: Promise<void>;

	constructor(
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
	) {
		this.done = new Promise<void>((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
		this.firstEvent = new Promise<OpenAI.Responses.ResponseStreamEvent | CAPIWebSocketErrorEvent>((resolve, reject) => {
			this._resolveFirstEvent = resolve;
			this._rejectFirstEvent = reject;
		});
	}

	onDidSettle(callback: (result: { outcome: ChatWebSocketRequestOutcome; closeCode?: number; closeReason?: string; serverErrorMessage?: string; serverErrorCode?: string }) => void): void {
		this._onDidSettle = callback;
	}

	handleEvent(event: OpenAI.Responses.ResponseStreamEvent | CAPIWebSocketErrorEvent): void {
		if (this._settled) {
			return;
		}

		// E.g.: "github.copilot.chat.advanced.debug.simulateWebSocketResponse": "{\"type\":\"error\",\"error\":{\"code\":\"user_global_rate_limited:enterprise\",\"message\":\"Rate limit exceeded\"}}"
		// E.g.: "github.copilot.chat.advanced.debug.simulateWebSocketResponse": "{\"type\":\"error\",\"error\":{\"code\":\"service_unavailable\",\"message\":\"service temporarily unavailable, please retry\"}}"
		const simulateResponse = this._configurationService.getConfig(ConfigKey.TeamInternal.DebugSimulateWebSocketResponse);
		if (simulateResponse) {
			try {
				event = JSON.parse(simulateResponse);
				this._logService.info(`[ChatWebSocketManager] Simulating WebSocket response event: ${simulateResponse}`);
			} catch (e) {
				this._logService.error(`[ChatWebSocketManager] Failed to parse simulated WebSocket response: ${collectSingleLineErrorMessage(e)}`);
			}
		}

		if (!this._firstEventSettled) {
			this._firstEventSettled = true;
			this._resolveFirstEvent(event);
		}

		if (isCAPIWebSocketError(event)) {
			this._finalizeCAPIError(event);
			return;
		}

		this._onEvent.fire(event);

		const outcome = getStreamTerminatingOutcome(event);
		if (outcome) {
			this._finalizeSuccess(outcome);
		}
	}

	handleConnectionClose(code: number, reason: string, errorMessage?: string): void {
		if (this._settled) {
			return;
		}
		const error = errorMessage
			? new Error(`${errorMessage} (close code: ${code} ${wsCloseCodeToString(code)}${reason ? `, reason: ${reason}` : ''})`)
			: new Error(`WebSocket closed (code: ${code} ${wsCloseCodeToString(code)}${reason ? `, reason: ${reason}` : ''})`);
		this._finalizeError('connection_closed', error, code, reason);
	}

	handleSuperseded(): void {
		if (this._settled) {
			return;
		}
		this._finalizeError('superseded', new Error('Request superseded by new request'));
	}

	handleCancellation(): void {
		if (this._settled) {
			return;
		}
		this._finalizeError('canceled', new CancellationError());
	}

	handleConnectionDisposed(): void {
		if (this._settled) {
			return;
		}
		this._finalizeError('connection_disposed', new Error('Connection disposed'));
	}

	private _finalizeSuccess(outcome: ChatWebSocketRequestOutcome): void {
		this._settled = true;
		this._onDidSettle?.({ outcome });
		this._resolve();
		this._dispose();
	}

	private _finalizeCAPIError(event: CAPIWebSocketErrorEvent): void {
		const { code, message } = event.error;
		this._onCAPIError.fire(event);
		this._settled = true;
		this._onDidSettle?.({ outcome: 'error_response', serverErrorMessage: message, serverErrorCode: code });
		this._reject(new Error(`${message} (${code})`));
		this._dispose();
	}

	private _finalizeError(outcome: ChatWebSocketRequestOutcome, error: Error, closeCode?: number, closeReason?: string, serverErrorMessage?: string, serverErrorCode?: string): void {
		if (!this._firstEventSettled) {
			this._firstEventSettled = true;
			this._rejectFirstEvent(error);
		}
		this._onError.fire(error);
		this._settled = true;
		this._onDidSettle?.({ outcome, closeCode, closeReason, serverErrorMessage, serverErrorCode });
		this._reject(error);
		this._dispose();
	}

	private _dispose(): void {
		this._onEvent.dispose();
		this._onCAPIError.dispose();
		this._onError.dispose();
	}
}
