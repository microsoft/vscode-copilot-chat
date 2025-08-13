/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Props, query } from '@anthropic-ai/claude-code';
import * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelServer } from '../../vscode-node/langModelServer';

export class ClaudeAgentManager extends Disposable {
	private _langModelServer: LanguageModelServer | undefined;
	private async getLangModelServer(): Promise<LanguageModelServer> {
		if (!this._langModelServer) {
			this._langModelServer = this.instantiationService.createInstance(LanguageModelServer);
			await this._langModelServer.start();
		}
		return this._langModelServer;
	}

	constructor(
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
	}

	public async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const lastMessage = context.history[context.history.length - 1] as any;
		const sessionId = lastMessage?.result?.metadata?.sessionId;
		try {
			// Parse the query for special commands like /allowedTools
			const result = await this.invokeClaudeWithSDK(request.prompt, sessionId, token, undefined, stream);

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
	private async invokeClaudeWithSDK(prompt: string, existingSessionId: string | undefined, token: vscode.CancellationToken, allowedTools?: string[], stream?: vscode.ChatResponseStream): Promise<{ sessionId?: string }> {
		// Dynamic import of the Claude Code SDK
		// const { query } = await import("@anthropic-ai/claude-code");

		// const defaultTools = ['Edit', 'Write', 'MultiEdit']; // Always allow these tools
		// const allTools = allowedTools ? [...defaultTools, ...allowedTools] : defaultTools;

		// Remove duplicates while preserving order
		const uniqueTools = undefined; // [...new Set(allTools)];

		// Create abort controller from VS Code cancellation token
		const abortController = new AbortController();
		token.onCancellationRequested(() => {
			abortController.abort();
		});

		// Build options for the Claude Code SDK
		const serverConfig = (await this.getLangModelServer()).getConfig();
		const options: Props['options'] & { env: typeof process.env } = {
			allowedTools: uniqueTools,
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
			abortController,
			// executable: process.execPath as 'node',
			executable: 'node',
			// pathToClaudeCodeExecutable: path.join(__dirname, '../node_modules/@anthropic-ai/claude-code/cli.js'),
			pathToClaudeCodeExecutable: '/Users/roblou/code/claude-code/cli.js',
			env: {
				...process.env,
				DEBUG: '1',
				ANTHROPIC_BASE_URL: `http://localhost:${serverConfig.port}`,
				ANTHROPIC_API_KEY: serverConfig.nonce
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

			// Process messages from the Claude Code SDK

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
					if (message.type === 'assistant' && message.message) {
						// Assistant message with content
						const content = message.message.content;
						if (Array.isArray(content)) {
							for (const item of content) {
								if (item.type === 'text' && item.text) {
									if (!hasStartedResponse) {
										hasStartedResponse = true;
										stream.progress('💭 Claude is responding...');
									}
									stream.markdown(item.text);
								} else if (item.type === 'tool_use') {
									stream.progress(`🔧 Claude is using ${item.name} tool...`);
								}
							}
						}
						// Show token usage if available
						const usage = message.message.usage;
						if (usage) {
							// const inputTokens = usage.input_tokens || 0;
							// const outputTokens = usage.output_tokens || 0;
							// const cacheTokens = usage.cache_read_input_tokens || 0;
							// if (cacheTokens > 0) {
							// 	stream.progress(`📊 Tokens: ${inputTokens} input, ${outputTokens} output, ${cacheTokens} cached`);
							// } else {
							// 	stream.progress(`📊 Tokens: ${inputTokens} input, ${outputTokens} output`);
							// }
						}
					} else if (message.type === 'user' && message.message) {
						// Tool result from user (system response to tool use)
						const content = message.message.content;
						if (Array.isArray(content)) {
							for (const item of content) {
								if (item.type === 'tool_result' && item.tool_use_id) {
									const contentStr = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
									if (contentStr?.includes('successfully')) {
										stream.progress('✅ Tool executed successfully');
									} else if (contentStr?.includes('error') || contentStr?.includes('failed')) {
										stream.progress('❌ Tool execution failed');
									} else {
										stream.progress('🔄 Tool execution completed');
									}
								}
							}
						}
					} else if (message.type === 'result') {
						// Final result message
						if (message.subtype === 'success' && message.result) {
							if (!hasStartedResponse) {
								stream.markdown(message.result);
							}
							// stream.progress(`✅ Response completed (${message.num_turns} turns, $${message.total_cost_usd.toFixed(4)})`);
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
