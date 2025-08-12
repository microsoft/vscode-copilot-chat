/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { AnthropicAdapter, OpenAIAdapter, ProtocolAdapter, StreamingContext } from './adapters';

export interface ServerTextLineResponse {
	type: 'text';
	content: string;
}
export interface ServerToolCallResponse {
	type: 'tool_call';
	callId: string;
	name: string;
	input: object;
}

interface ServerConfig {
	port: number;
	nonce: string;
}

class LanguageModelServer {
	private server: http.Server;
	private config: ServerConfig;
	private adapters: Map<string, ProtocolAdapter>;

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.config = {
			port: 0, // Will be set to random available port
			nonce: 'vscode-nonce'
		};
		this.adapters = new Map();
		this.adapters.set('/v1/chat/completions', new OpenAIAdapter());
		this.adapters.set('/v1/messages', new AnthropicAdapter());

		this.server = this.createServer();
	}

	private createServer(): http.Server {
		return http.createServer(async (req, res) => {
			this.logService.trace(`Received request: ${req.method} ${req.url}`);

			// Set CORS headers
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nonce');

			if (req.method === 'OPTIONS') {
				res.writeHead(200);
				res.end();
				return;
			}

			if (req.method === 'GET' && req.url === '/models') {
				await this.handleModelsRequest(req, res);
				return;
			}

			if (req.method === 'POST') {
				const adapter = this.getAdapterForPath(req.url || '');
				if (adapter) {
					try {
						const body = await this.readRequestBody(req);

						// Verify nonce for authentication
						const authKey = adapter.extractAuthKey(req.headers);
						if (authKey !== this.config.nonce) {
							res.writeHead(401, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ error: 'Invalid authentication' }));
							return;
						}

						await this.handleChatRequest(adapter, body, res);
					} catch (error) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({
							error: 'Internal server error',
							details: error instanceof Error ? error.message : String(error)
						}));
					}
					return;
				}
			}

			if (req.method === 'GET' && req.url === '/') {
				res.writeHead(200);
				res.end('Hello from LanguageModelServer');
				return;
			}

			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
		});
	}

	private parseUrlPathname(url: string): string {
		// Parse URL safely to get just the pathname, ignoring query parameters
		try {
			// Create a URL object with a dummy base to handle relative URLs
			const parsedUrl = new URL(url, 'http://localhost');
			return parsedUrl.pathname;
		} catch {
			// Fallback: if URL parsing fails, use simple string split
			return url.split('?')[0];
		}
	}

	private getAdapterForPath(url: string): ProtocolAdapter | undefined {
		const pathname = this.parseUrlPathname(url);

		// Direct lookup in the adapters map
		return this.adapters.get(pathname);
	}

	private async readRequestBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = '';
			req.on('data', chunk => {
				body += chunk.toString();
			});
			req.on('end', () => {
				resolve(body);
			});
			req.on('error', reject);
		});
	}

	private async handleChatRequest(adapter: ProtocolAdapter, body: string, res: http.ServerResponse): Promise<void> {
		try {
			// Parse request using the adapter
			const parsedRequest = adapter.parseRequest(body);

			// Get available language models
			const models = await vscode.lm.selectChatModels();

			if (models.length === 0) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'No language models available' }));
				return;
			}

			// Select model based on request criteria
			const selectedModel = this.selectModel(models, parsedRequest.model);

			if (!selectedModel) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: 'No model found matching criteria',
					availableModels: models.map(m => ({
						id: m.id,
						name: m.name,
						vendor: m.vendor,
						family: m.family,
						version: m.version
					}))
				}));
				return;
			}

			// Set up streaming response
			res.writeHead(200, {
				'Content-Type': adapter.getContentType(),
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Access-Control-Allow-Origin': '*'
			});

			// Create cancellation token for the request
			const tokenSource = new vscode.CancellationTokenSource();

			// Handle client disconnect
			res.on('close', () => {
				tokenSource.cancel();
			});

			try {
				// Create streaming context
				const context: StreamingContext = {
					requestId: `req_${Math.random().toString(36).substr(2, 20)}`,
					modelId: selectedModel.id,
					currentBlockIndex: 0,
					hasTextBlock: false,
					hadToolCalls: false,
					outputTokens: 0
				};

				// Send initial events if adapter supports them
				if (adapter.generateInitialEvents) {
					const initialEvents = adapter.generateInitialEvents(context);
					for (const event of initialEvents) {
						res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
					}
				}

				// Make the chat request
				const chatResponse = await selectedModel.sendRequest(
					parsedRequest.messages,
					parsedRequest.options || {},
					tokenSource.token
				);

				// Stream the response using the adapter
				for await (const part of chatResponse.stream) {
					if (tokenSource.token.isCancellationRequested) {
						break;
					}

					if (part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolCallPart) {
						const events = adapter.formatStreamResponse(part, context);
						for (const event of events) {
							res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
						}
					}
				}

				// Send final events
				const finalEvents = adapter.generateFinalEvents(context);
				for (const event of finalEvents) {
					res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
				}

				res.end();
			} catch (error) {
				if (error instanceof vscode.LanguageModelError) {
					res.write(JSON.stringify({
						error: 'Language model error',
						code: error.code,
						message: error.message,
						cause: error.cause
					}));
				} else {
					res.write(JSON.stringify({
						error: 'Request failed',
						message: error instanceof Error ? error.message : String(error)
					}));
				}
				res.end();
			} finally {
				tokenSource.dispose();
			}

		} catch (error) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: 'Failed to process chat request',
				details: error instanceof Error ? error.message : String(error)
			}));
		}
	}

	private selectModel(models: readonly vscode.LanguageModelChat[], requestedModel?: string): vscode.LanguageModelChat | undefined {
		if (requestedModel) {
			// Handle model mapping
			let mappedModel = requestedModel;
			if (requestedModel.startsWith('claude-3-5-haiku')) {
				mappedModel = 'gpt-4o-mini';
			}
			if (requestedModel.startsWith('claude-sonnet-4')) {
				mappedModel = 'claude-sonnet-4';
			}

			// Try to find exact match first
			let selectedModel = models.find(m => m.id === mappedModel);

			// If not found, try to find by partial match for Anthropic models
			if (!selectedModel && requestedModel.startsWith('claude-3-5-haiku')) {
				selectedModel = models.find(m => m.id.includes('gpt-4o-mini')) || models.find(m => m.vendor === 'copilot');
			} else if (!selectedModel && requestedModel.startsWith('claude-sonnet-4')) {
				selectedModel = models.find(m => m.id.includes('claude-sonnet-4')) || models.find(m => m.vendor === 'copilot');
			}

			return selectedModel;
		}

		// Use first available model if no criteria specified
		return models[0];
	}

	private async handleModelsRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			// Verify nonce from X-Nonce header
			const nonce = req.headers['x-nonce'];
			if (nonce !== this.config.nonce) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid nonce' }));
				return;
			}

			const models = await this.getAvailableModels();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(models));
		} catch (error) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: 'Failed to get available models',
				details: error instanceof Error ? error.message : String(error)
			}));
		}
	}

	public async start(): Promise<void> {
		return new Promise((resolve) => {
			this.server.listen(0, 'localhost', () => {
				const address = this.server.address();
				if (address && typeof address === 'object') {
					this.config.port = address.port;
					this.logService.trace(`Language Model Server started on http://localhost:${this.config.port}`);
					this.logService.trace(`Server nonce: ${this.config.nonce}`);
					resolve();
				}
			});
		});
	}

	public stop(): void {
		this.server.close();
	}

	public getConfig(): ServerConfig {
		return { ...this.config };
	}

	public async getAvailableModels(): Promise<Array<{
		id: string;
		name: string;
		vendor: string;
		family: string;
		version: string;
		maxInputTokens: number;
	}>> {
		try {
			const models = await vscode.lm.selectChatModels();
			return models.map(m => ({
				id: m.id,
				name: m.name,
				vendor: m.vendor,
				family: m.family,
				version: m.version,
				maxInputTokens: m.maxInputTokens
			}));
		} catch (error) {
			this.logService.error('Failed to get available models:', error);
			return [];
		}
	}
}

export { LanguageModelServer, ServerConfig };
