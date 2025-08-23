/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { Options, query } from '@anthropic-ai/claude-code';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { findLast } from '../../../../util/vs/base/common/arraysFind';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseTurn } from '../../../../vscodeTypes';
import { LanguageModelServer } from '../../vscode-node/langModelServer';
import { PermissionMcpServer } from './permissionMcp';

export class ClaudeAgentManager extends Disposable {
	private _langModelServer: LanguageModelServer | undefined;
	private _permissionMcpServer: PermissionMcpServer | undefined;
	private async getLangModelServer(): Promise<LanguageModelServer> {
		if (!this._langModelServer) {
			this._langModelServer = this.instantiationService.createInstance(LanguageModelServer);
			await this._langModelServer.start();
		}

		if (!this._permissionMcpServer) {
			const serverConfig = this._langModelServer.getConfig();
			this._permissionMcpServer = this.instantiationService.createInstance(PermissionMcpServer, serverConfig.port);
			this._langModelServer.registerHandler('/mcp', (req, res, body) => this._permissionMcpServer!.handleMcp(req, res, body));
		}

		return this._langModelServer;
	}

	constructor(
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService
	) {
		super();
	}

	public async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const lastMessage = findLast(context.history, msg => msg instanceof ChatResponseTurn) as ChatResponseTurn | undefined;
		const sessionId = lastMessage?.result?.metadata?.sessionId;
		try {
			const result = await this.invokeClaudeWithSDK(request.toolInvocationToken, request.prompt, sessionId, token, undefined, stream);

			return { metadata: { command: request.command || 'default', sessionId: result.sessionId } };
		} catch (invokeError) {
			// Handle specific invocation errors
			const errorMessage = (invokeError as Error).message;
			stream.markdown(`❌ **Claude CLI Error**: ${errorMessage}`);

			// Log for debugging
			this.logService.error(invokeError as Error);
			return { metadata: { command: request.command || 'default' } };
		}
	}

	/**
	 * Internal function to invoke Claude using the Claude Code SDK
	 */
	private async invokeClaudeWithSDK(toolInvocationToken: any, prompt: string, existingSessionId: string | undefined, token: vscode.CancellationToken, allowedTools?: string[], stream?: vscode.ChatResponseStream): Promise<{ sessionId?: string }> {
		const abortController = new AbortController();
		token.onCancellationRequested(() => {
			abortController.abort();
		});

		// Build options for the Claude Code SDK
		const serverConfig = (await this.getLangModelServer()).getConfig();
		this._permissionMcpServer?.setToolInvocationToken(toolInvocationToken as vscode.ChatParticipantToolToken);
		const options: Options = {
			// allowedTools: uniqueTools,
			cwd: this.workspaceService.getWorkspaceFolders().at(0)?.fsPath,
			abortController,
			executable: process.execPath as 'node',
			// TODO- have to do this so that the sdk doesn't try to use import.meta.url, which won't work in this commonJS context
			pathToClaudeCodeExecutable: path.join(__dirname, '../node_modules/@anthropic-ai/claude-code/cli.js'),
			// pathToClaudeCodeExecutable: '/Users/roblou/code/claude-code/cli.js',
			env: {
				...process.env,
				DEBUG: '1',
				ANTHROPIC_BASE_URL: `http://localhost:${serverConfig.port}`,
				ANTHROPIC_API_KEY: serverConfig.nonce
			},
			// permissionMode: 'acceptEdits',
			permissionPromptToolName: 'mcp__permission__get_permission',
			mcpServers: {
				permission: {
					type: 'http',
					url: `http://localhost:${serverConfig.port}/mcp`,
					headers: {
						vscode_nonce: serverConfig.nonce
					}
				}
			}
		};

		// Add resume session if provided
		if (existingSessionId) {
			options.resume = existingSessionId;
		}

		let sessionId: string | undefined;
		let hasStartedResponse = false;

		try {
			this.logService.trace(`Claude CLI SDK: Starting query with options: ${JSON.stringify(options)}`);

			for await (const message of query({
				prompt,
				options
			})) {
				this.logService.trace(`Claude CLI SDK Message: ${JSON.stringify(message, null, 2)}`);

				// Extract session ID if present
				if (message.session_id) {
					sessionId = message.session_id;
				}

				// Handle different SDK message types
				if (stream) {
					if (message.type === 'assistant') {
						// Assistant message with content
						const content = message.message.content;
						if (Array.isArray(content)) {
							for (const item of content) {
								if (item.type === 'text' && item.text) {
									if (!hasStartedResponse) {
										hasStartedResponse = true;
									}
									stream.markdown(item.text);
								}
							}
						}
					} else if (message.type === 'result') {
						// Final result message
						if (message.subtype === 'success' && message.result) {
							if (!hasStartedResponse) {
								stream.markdown(message.result);
							}
						} else if (message.subtype === 'error_max_turns') {
							stream.progress(`⚠️ Maximum turns reached (${message.num_turns})`);
						} else if (message.subtype === 'error_during_execution') {
							stream.progress(`❌ Error during execution (${message.num_turns} turns)`);
						}
					}
				}
			}

			return { sessionId };
		} catch (error) {
			if (error instanceof Error) {
				if (error.name === 'AbortError' || error.message.includes('aborted')) {
					throw new Error('Claude CLI invocation was cancelled');
				}
				throw new Error(`Claude CLI SDK error: ${error.message}`);
			}
			throw error;
		}
	}
}
