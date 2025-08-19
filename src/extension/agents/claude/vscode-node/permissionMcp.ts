/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as http from 'node:http';
import { ChatParticipantToolToken, lm } from 'vscode';
import { ContributedToolName } from '../../../tools/common/toolNames';

/**
 * Stateless MCP handler that creates fresh server instances per request.
 * Use with langModelServer.setMcpHandler(createMcpHandler(token)).
 */
export class PermissionMcpServer {
	constructor(
		private readonly port: number
	) { }

	private _toolInvocationToken: ChatParticipantToolToken | undefined;
	public setToolInvocationToken(token: ChatParticipantToolToken): void {
		this._toolInvocationToken = token;
	}

	public async handleMcp(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
		try {
			// Parse JSON-RPC message
			let parsed: unknown;
			try {
				parsed = body ? JSON.parse(body) : undefined;
			} catch (e) {
				res.statusCode = 400;
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({
					jsonrpc: '2.0',
					error: { code: -32700, message: 'Parse error' },
					id: null
				}));
				return;
			}

			// Create fresh MCP server per request (fully stateless)
			const mcpServer = new McpServer({
				name: 'permission-tool-mcp',
				version: '0.0.1'
			});

			mcpServer.registerTool(
				'get_permission',
				{
					title: 'Ping',
					description: 'Responds with "pong".',
				},
				async (args, extra) => {
					try {
						lm.invokeTool(ContributedToolName.ConfirmationTool, {
							input: {
								message: `Run ${args.tool_name}?`,
								detail: `With args:\n\n\`\`\`${JSON.stringify(args, null, 2)}\n\`\`\``
							},
							toolInvocationToken: this._toolInvocationToken,
						});
						return {
							content: [{
								type: 'text' as const, text: JSON.stringify({
									"behavior": "allow",
									"updatedInput": args
								})
							}],
						};
					} catch { }

					return {
						content: [{
							type: 'text' as const, text: JSON.stringify({
								"behavior": "deny",
								"message": "because I don't want you to"
							})
						}],
					};
				}
			);

			// Create transport and handle request
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableDnsRebindingProtection: true,
				allowedHosts: [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
			});

			// Cleanup on close
			res.on('close', () => {
				try { transport.close(); } catch { /* noop */ }
				try { mcpServer.close(); } catch { /* noop */ }
			});

			await mcpServer.connect(transport);
			await transport.handleRequest(req as any, res as any, parsed as any);
		} catch (err) {
			try {
				res.statusCode = 500;
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({
					jsonrpc: '2.0',
					error: { code: -32603, message: 'Internal server error' },
					id: null
				}));
			} catch { /* ignore */ }
		}
	}
}
