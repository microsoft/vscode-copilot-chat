/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as stream from 'stream';
import * as undici from 'undici';
import { IEnvService } from '../../env/common/envService';
import { FetchOptions, HeadersImpl, IHeaders, ReportFetchEvent, Response, WebSocketConnection, WebSocketConnectOptions } from '../common/fetcherService';
import { BaseFetchFetcher } from './baseFetchFetcher';

export class NodeFetchFetcher extends BaseFetchFetcher {

	static readonly ID = 'node-fetch' as const;

	constructor(
		envService: IEnvService,
		reportEvent: ReportFetchEvent = () => { },
		userAgentLibraryUpdate?: (original: string) => string,
	) {
		super(getFetch(), envService, NodeFetchFetcher.ID, reportEvent, userAgentLibraryUpdate);
	}

	getUserAgentLibrary(): string {
		return NodeFetchFetcher.ID;
	}

	override async fetch(url: string, options: FetchOptions): Promise<Response> {
		try {
			return await super.fetch(url, options);
		} catch (e) {
			if (isGracefulGoawayError(e)) {
				await this.disconnectAll();
				return await super.fetch(url, options);
			}
			throw e;
		}
	}

	override async disconnectAll(): Promise<void> {
		const currentAgent = agent;
		if (currentAgent) {
			agent = undefined;
			await currentAgent.close();
		}
	}

	isInternetDisconnectedError(_e: any): boolean {
		return false;
	}
	isFetcherError(e: any): boolean {
		const code = e?.code || e?.cause?.code;
		return code && ['EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT'].includes(code);
	}
}

/**
 * Detects a graceful HTTP/2 GOAWAY error (error code 0 = NO_ERROR).
 * These occur during server-side connection draining
 * and are safe to retry on a new connection.
 */
export function isGracefulGoawayError(e: any): boolean {
	const message = String(e?.message || '');
	const causeMessage = String(e?.cause?.message || '');
	const combined = message + ' ' + causeMessage;
	if (combined.includes('GOAWAY') && combined.includes('code 0')) {
		return true;
	}
	return false;
}

function getFetch(): typeof globalThis.fetch {
	const fetch = (globalThis as any).__vscodePatchedFetch || globalThis.fetch;
	return function (input: string | URL | globalThis.Request, init?: RequestInit) {
		return fetch(input, { dispatcher: getOrCreateAgent(), ...init });
	};
}

function getOrCreateAgent(): undici.Agent {
	if (!agent) {
		agent = new undici.Agent({ allowH2: true });
	}
	return agent;
}

// Mutable agent reference — recreated on disconnectAll() to ensure fresh connections.
let agent: undici.Agent | undefined;

export function createWebSocket(url: string, options?: WebSocketConnectOptions): WebSocketConnection {
	const wsAgent = new undici.Agent();
	const originalDispatch = wsAgent.dispatch;
	let responseHeaders: IHeaders = new HeadersImpl({});
	let responseStatusCode: number | undefined;
	let responseStatusText: string | undefined;
	wsAgent.dispatch = function (dispatchOptions: undici.Dispatcher.DispatchOptions, handler: undici.Dispatcher.DispatchHandler): boolean {
		const wrappedHandler: undici.Dispatcher.DispatchHandler = {
			...handler,
			onUpgrade(statusCode: number, rawHeaders: Buffer[] | string[] | null, socket: stream.Duplex) {
				responseStatusCode = statusCode;
				if (rawHeaders) {
					responseHeaders = HeadersImpl.fromMap(parseRawHeaders(rawHeaders));
				}
				return handler.onUpgrade?.(statusCode, rawHeaders, socket);
			},
			onHeaders(statusCode: number, rawHeaders: Buffer[], resume: () => void, statusText: string) {
				responseStatusCode = statusCode;
				responseStatusText = statusText;
				if (rawHeaders) {
					responseHeaders = HeadersImpl.fromMap(parseRawHeaders(rawHeaders));
				}
				return handler.onHeaders?.(statusCode, rawHeaders, resume, statusText) ?? true;
			},
		};
		return originalDispatch.call(this, dispatchOptions, wrappedHandler);
	};

	const webSocket = new WebSocket(url, {
		headers: options?.headers,
		dispatcher: wsAgent as any,
	});

	webSocket.addEventListener('close', () => {
		wsAgent.destroy().catch(() => { });
	});

	return {
		webSocket,
		get responseHeaders() {
			const wsResponseHeaders = (webSocket as { responseHeaders?: Record<string, string | string[] | undefined> }).responseHeaders;
			return wsResponseHeaders ? new HeadersImpl(wsResponseHeaders) : responseHeaders;
		},
		get responseStatusCode() {
			return (webSocket as { responseStatusCode?: number }).responseStatusCode ?? responseStatusCode;
		},
		get responseStatusText() {
			return (webSocket as { responseStatusText?: string }).responseStatusText ?? responseStatusText;
		}
	};
}

function parseRawHeaders(rawHeaders: readonly (Buffer | string)[]): Map<string, string> {
	const headers = new Map<string, string>();
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		const name = rawHeaders[i].toString().toLowerCase();
		const value = rawHeaders[i + 1].toString();
		const existing = headers.get(name);
		headers.set(name, existing !== undefined ? `${existing}, ${value}` : value);
	}
	return headers;
}
