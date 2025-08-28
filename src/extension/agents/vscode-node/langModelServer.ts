/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import * as http from 'http';
import * as vscode from 'vscode';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { AnthropicAdapterFactory } from './adapters/anthropicAdapter';
import { IAgentStreamBlock, IProtocolAdapter, IProtocolAdapterFactory, IStreamingContext } from './adapters/types';

export interface IServerConfig {
	port: number;
	nonce: string;
}

export class LanguageModelServer {
	private server: http.Server;
	private config: IServerConfig;
	private adapterFactories: Map<string, IProtocolAdapterFactory>;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider
	) {
		this.config = {
			port: 0, // Will be set to random available port
			nonce: 'vscode-lm-' + generateUuid()
		};
		this.adapterFactories = new Map();
		this.adapterFactories.set('/v1/messages', new AnthropicAdapterFactory());

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
				const adapterFactory = this.getAdapterFactoryForPath(req.url || '');
				if (adapterFactory) {
					try {
						const body = await this.readRequestBody(req);

						// Create new adapter instance for this request
						const adapter = adapterFactory.createAdapter();

						// Verify nonce for authentication
						const authKey = adapter.extractAuthKey(req.headers);
						if (authKey !== this.config.nonce) {
							this.logService.trace(`[LanguageModelServer] Invalid auth key`);
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
		try {
			const parsedUrl = new URL(url, 'http://localhost');
			return parsedUrl.pathname;
		} catch {
			return url.split('?')[0];
		}
	}

	private getAdapterFactoryForPath(url: string): IProtocolAdapterFactory | undefined {
		const pathname = this.parseUrlPathname(url);
		return this.adapterFactories.get(pathname);
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

	private async handleChatRequest(adapter: IProtocolAdapter, body: string, res: http.ServerResponse): Promise<void> {
		try {
			const parsedRequest = adapter.parseRequest(body);

			const endpoints = await this.endpointProvider.getAllChatEndpoints();

			if (endpoints.length === 0) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'No language models available' }));
				return;
			}

			const selectedEndpoint = this.selectEndpoint(endpoints, parsedRequest.model);
			if (!selectedEndpoint) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: 'No model found matching criteria'
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
				// Create streaming context with only essential shared data
				const context: IStreamingContext = {
					requestId: `req_${Math.random().toString(36).substr(2, 20)}`,
					modelId: selectedEndpoint.model
				};

				// Send initial events if adapter supports them
				if (adapter.generateInitialEvents) {
					const initialEvents = adapter.generateInitialEvents(context);
					for (const event of initialEvents) {
						res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
					}
				}

				// Make the chat request using IChatEndpoint; stream via finishedCb
				// Stream chunks via finishedCb; no need to track a response flag.
				// Map any provided tools (from adapter) into OpenAI-style function tools for endpoints
				const openAiTools: OpenAiFunctionTool[] | undefined = parsedRequest.options?.tools?.map(t => ({
					type: 'function',
					function: {
						name: t.name,
						description: t.description,
						parameters: t.inputSchema ?? {}
					}
				}));

				const userInitiatedRequest = parsedRequest.messages.at(-1)?.role === Raw.ChatRole.User;
				await selectedEndpoint.makeChatRequest2({
					debugName: 'agentLanguageModelService',
					messages: parsedRequest.messages,
					finishedCb: async (_fullText, _index, delta) => {
						if (tokenSource.token.isCancellationRequested) {
							return 0; // stop
						}
						// Emit text deltas
						if (delta.text) {
							const textData: IAgentStreamBlock = {
								type: 'text',
								content: delta.text
							};
							for (const event of adapter.formatStreamResponse(textData, context)) {
								res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
							}
						}
						// Emit tool calls if present
						if (delta.copilotToolCalls && delta.copilotToolCalls.length > 0) {
							for (const call of delta.copilotToolCalls) {
								let input: object = {};
								try { input = call.arguments ? JSON.parse(call.arguments) : {}; } catch { input = {}; }
								const toolData: IAgentStreamBlock = {
									type: 'tool_call',
									callId: call.id,
									name: call.name,
									input
								};
								for (const event of adapter.formatStreamResponse(toolData, context)) {
									res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
								}
							}
						}
						return undefined;
					},
					location: ChatLocation.Agent,
					requestOptions: openAiTools && openAiTools.length ? { tools: openAiTools } : undefined,
					userInitiatedRequest
				}, tokenSource.token);

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

	private selectEndpoint(endpoints: readonly IChatEndpoint[], requestedModel?: string): IChatEndpoint | undefined {
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
			let selectedEndpoint = endpoints.find(e => e.family === mappedModel || e.model === mappedModel);

			// If not found, try to find by partial match for Anthropic models
			if (!selectedEndpoint && requestedModel.startsWith('claude-3-5-haiku')) {
				selectedEndpoint = endpoints.find(e => e.model.includes('gpt-4o-mini')) ?? endpoints.find(e => e.model.includes('mini'));
			} else if (!selectedEndpoint && requestedModel.startsWith('claude-sonnet-4')) {
				selectedEndpoint = endpoints.find(e => e.model.includes('claude-sonnet-4')) ?? endpoints.find(e => e.model.includes('claude'));
			}

			return selectedEndpoint;
		}

		// Use first available model if no criteria specified
		return endpoints[0];
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
					// this.logService.trace(`Server nonce: ${this.config.nonce}`);
					resolve();
				}
			});
		});
	}

	public stop(): void {
		this.server.close();
	}

	public getConfig(): IServerConfig {
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
