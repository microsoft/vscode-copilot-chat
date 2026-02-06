/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as crypto from 'crypto';
import type * as express from 'express';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ILogger } from '../../../../platform/log/common/logService';

interface McpProviderOptions {
	id: string;
	serverLabel: string;
	serverVersion: string;
	registerTools: (server: McpServer) => Promise<void> | void;
	registerPushNotifications?: () => Promise<void> | void;
}

interface DisposableLike {
	dispose: () => void;
}

const transports: Record<string, StreamableHTTPServerTransport> = {};

let _logger: ILogger | undefined;

export function initInProcHttpServer(logger: ILogger): void {
	_logger = logger;
}

function registerTransport(sessionId: string, transport: StreamableHTTPServerTransport): void {
	transports[sessionId] = transport;
	_logger?.info(`Client connected: ${sessionId}`);
}

function unregisterTransport(sessionId: string): void {
	delete transports[sessionId];
	_logger?.info(`Client disconnected: ${sessionId}`);
}

function getTransport(sessionId: string): StreamableHTTPServerTransport | undefined {
	return transports[sessionId];
}

export function broadcastNotification(method: string, params: Record<string, unknown>): void {
	const message = {
		jsonrpc: '2.0' as const,
		method,
		params,
	};

	const sessionCount = Object.keys(transports).length;
	_logger?.trace(`Broadcasting notification "${method}" to ${sessionCount} client(s)`);

	for (const sessionId in transports) {
		transports[sessionId].send(message).catch(() => {
			_logger?.debug(`Failed to send notification "${method}" to client ${sessionId}`);
		});
	}
}

class AsyncLazy<T> {
	private _value: T | undefined;
	private _promise: Promise<T> | undefined;

	constructor(private readonly factory: () => Promise<T>) { }

	get value(): Promise<T> {
		if (this._value !== undefined) {
			return Promise.resolve(this._value);
		}

		if (this._promise) {
			return this._promise;
		}

		this._promise = this.factory().then(value => {
			this._value = value;
			return value;
		});

		return this._promise;
	}
}

export async function startInProcHttpServer(
	mcpOptions: McpProviderOptions,
): Promise<{ disposable: DisposableLike; serverUri: vscode.Uri; headers: Record<string, string> }> {
	let socketPath: string | undefined;

	_logger?.debug(`Starting MCP HTTP server for ${mcpOptions.serverLabel}...`);

	try {
		const nonce = crypto.randomUUID();
		socketPath = await getRandomSocketPath();
		_logger?.trace(`Generated socket path: ${socketPath}`);

		const expressModule = (await expressLazy.value) as unknown as {
			default?: typeof import('express');
		} & typeof import('express');
		const expressApp = expressModule.default || expressModule;

		const app: express.Application = (expressApp as () => express.Application)();

		app.use(expressApp.json());
		app.use((req: express.Request, res: express.Response, next: express.NextFunction) =>
			authMiddleware(nonce, req, res, next),
		);

		app.post('/mcp', (req: express.Request, res: express.Response) => handlePost(mcpOptions, req, res));
		app.get('/mcp', handleGetDelete);
		app.delete('/mcp', handleGetDelete);

		const httpServer = app.listen(socketPath);
		_logger?.debug('HTTP server listening on socket');

		// Register push notifications if provided
		if (mcpOptions.registerPushNotifications) {
			_logger?.debug('Registering push notifications...');
			await Promise.resolve(mcpOptions.registerPushNotifications());
		}

		return {
			disposable: {
				dispose: () => {
					_logger?.info('Shutting down MCP server...');
					for (const sessionId in transports) {
						void transports[sessionId].close();
						unregisterTransport(sessionId);
					}

					if (httpServer.listening) {
						httpServer.close();
						httpServer.closeAllConnections();
					}

					void tryCleanupSocket(socketPath);
					_logger?.debug('MCP server shutdown complete');
				},
			},
			serverUri: vscode.Uri.from({
				scheme: os.platform() === 'win32' ? 'pipe' : 'unix',
				path: socketPath,
				fragment: '/mcp',
			}),
			headers: {
				Authorization: `Nonce ${nonce}`,
			},
		};
	} catch (err) {
		void tryCleanupSocket(socketPath);
		throw err;
	}
}

function authMiddleware(nonce: string, req: express.Request, res: express.Response, next: express.NextFunction): void {
	if (req.headers.authorization !== `Nonce ${nonce}`) {
		_logger?.debug(`Unauthorized request to ${req.method} ${req.path}`);
		res.status(401).send('Unauthorized');
		return;
	}

	next();
}

async function handlePost(mcpOptions: McpProviderOptions, req: express.Request, res: express.Response): Promise<void> {
	const sessionId = req.headers['mcp-session-id'] as string | undefined;
	_logger?.trace(`POST /mcp request, sessionId: ${sessionId ?? '(none)'}`);

	const isInitializeRequest = await isInitializeRequestLazy.value;
	const { StreamableHTTPServerTransport } = await streamableHttpLazy.value;

	let transport: StreamableHTTPServerTransport;
	const existingTransport = sessionId ? getTransport(sessionId) : undefined;
	if (sessionId && existingTransport) {
		transport = existingTransport;
	} else if (!sessionId && isInitializeRequest(req.body)) {
		_logger?.debug('Creating new MCP session...');
		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: newSessionId => {
				registerTransport(newSessionId, transport);
			},
			onsessionclosed: closedSessionId => {
				unregisterTransport(closedSessionId);
			},
			enableDnsRebindingProtection: true,
			allowedHosts: ['localhost'],
		});

		const { McpServer } = await mcpServerLazy.value;
		const server = new McpServer({
			name: mcpOptions.id,
			title: mcpOptions.serverLabel,
			version: mcpOptions.serverVersion,
		});

		try {
			_logger?.debug('Registering MCP tools...');
			await Promise.resolve(mcpOptions.registerTools(server));
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			_logger?.error(`Failed to register MCP tools: ${errMsg}`);
			res.status(500).json({
				jsonrpc: '2.0',
				error: {
					code: -32000,
					message: `Failed to register MCP tools: ${errMsg}`,
				},
				id: null,
			});
			return;
		}

		await server.connect(transport);
	} else {
		_logger?.debug('Bad request: No valid session ID provided');
		res.status(400).json({
			jsonrpc: '2.0',
			error: {
				code: -32000,
				message: 'Bad Request: No valid session ID provided',
			},
			id: null,
		});
		return;
	}

	await transport.handleRequest(req, res, req.body);
}

async function handleGetDelete(req: express.Request, res: express.Response): Promise<void> {
	const sessionId = req.headers['mcp-session-id'] as string | undefined;
	_logger?.trace(`${req.method} /mcp request, sessionId: ${sessionId ?? '(none)'}`);

	const transport = sessionId ? getTransport(sessionId) : undefined;
	if (!sessionId || !transport) {
		_logger?.debug(`Invalid or missing session ID for ${req.method} request`);
		res.status(400).send('Invalid or missing session ID');
		return;
	}

	await transport.handleRequest(req, res);
}

async function getRandomSocketPath(): Promise<string> {
	if (os.platform() === 'win32') {
		return `\\\\.\\pipe\\mcp-${crypto.randomUUID()}.sock`;
	} else {
		const prefix = path.join(os.tmpdir(), 'mcp-');
		const tempDir = await fs.mkdtemp(prefix);
		await fs.chmod(tempDir, 0o700);
		return path.join(tempDir, 'mcp.sock');
	}
}

async function tryCleanupSocket(socketPath: string | undefined): Promise<void> {
	try {
		if (os.platform() === 'win32') {
			return;
		}

		if (!socketPath) {
			return;
		}

		const dir = path.dirname(socketPath);
		await fs.rm(dir, { recursive: true, force: true });
	} catch {
		// Best effort
	}
}

const expressLazy = new AsyncLazy(async () => await import('express'));
const streamableHttpLazy = new AsyncLazy(async () => await import('@modelcontextprotocol/sdk/server/streamableHttp.js'));
const mcpServerLazy = new AsyncLazy(async () => await import('@modelcontextprotocol/sdk/server/mcp.js'));
const isInitializeRequestLazy = new AsyncLazy(async () => {
	const { isInitializeRequest } = await import('@modelcontextprotocol/sdk/types.js');
	return isInitializeRequest;
});
