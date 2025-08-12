/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ClaudeCodeInvoker } from './claudeCodeInvoker';

export class ClaudeAgentManager extends Disposable {
	// private _codexClients = this._register(new DisposableMap<string, CodexClient>());

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	public async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const lastMessage = context.history[context.history.length - 1] as any;
		const sessionId = lastMessage?.result?.metadata?.sessionId;
		try {
			// Default behavior - send prompt to Claude CLI
			stream.progress('Sending request to Claude...');

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

		} catch (err) {
			handleError(err, stream);
			return { metadata: { command: request.command || 'default' } };
		}
	}

	/**
	 * Internal function to invoke Claude using the Claude Code SDK
	 */
	private async invokeClaudeWithSDK(prompt: string, existingSessionId: string | undefined, token: vscode.CancellationToken, allowedTools?: string[], stream?: vscode.ChatResponseStream): Promise<{ sessionId?: string }> {
		// Dynamic import of the Claude Code SDK
		// const { query } = await import("@anthropic-ai/claude-code");

		const defaultTools = ['Edit', 'Write', 'MultiEdit']; // Always allow these tools
		const allTools = allowedTools ? [...defaultTools, ...allowedTools] : defaultTools;

		// Remove duplicates while preserving order
		const uniqueTools = [...new Set(allTools)];

		// Create abort controller from VS Code cancellation token
		const abortController = new AbortController();
		token.onCancellationRequested(() => {
			abortController.abort();
		});

		// Build options for the Claude Code SDK
		const options: {
			// pathToClaudeCodeExecutable: string;
			maxTurns?: number;
			allowedTools?: string[];
			cwd?: string;
			resume?: string;
		} = {
			// pathToClaudeCodeExecutable: join(__dirname, "../src/claude-bootstrap.js"), // Path to the bootstrap script
			// maxTurns: 3,
			allowedTools: uniqueTools,
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
		};

		// Add resume session if provided
		if (existingSessionId) {
			options.resume = existingSessionId;
		}

		let sessionId: string | undefined;
		let hasStartedResponse = false;

		try {
			this.logService.trace(`Claude CLI SDK: Starting query with options: ${JSON.stringify(options)}`);

			const invoker = this.instantiationService.createInstance(ClaudeCodeInvoker);

			// Process messages from the Claude Code SDK
			for await (const message of invoker.query({
				prompt,
				abortController,
				options
			})) {
				this.logService.trace(`Claude CLI SDK Message: ${JSON.stringify(message, null, 2)}`);

				// Extract session ID if present
				if (message.session_id) {
					sessionId = message.session_id;
				}

				// Handle different SDK message types
				if (stream) {
					if (message.type === 'system' && message.subtype === 'init') {
						// System initialization
						const toolCount = message.tools?.length || 0;
						const model = message.model || 'unknown';
						stream.progress(`🚀 Claude CLI initialized with ${model} (${toolCount} tools available)`);
					} else if (message.type === 'assistant' && message.message) {
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
							const inputTokens = usage.input_tokens || 0;
							const outputTokens = usage.output_tokens || 0;
							const cacheTokens = usage.cache_read_input_tokens || 0;
							if (cacheTokens > 0) {
								stream.progress(`📊 Tokens: ${inputTokens} input, ${outputTokens} output, ${cacheTokens} cached`);
							} else {
								stream.progress(`📊 Tokens: ${inputTokens} input, ${outputTokens} output`);
							}
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
							stream.progress(`✅ Response completed (${message.num_turns} turns, $${message.total_cost_usd.toFixed(4)})`);
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

/**
 * Handle errors that occur during Claude CLI invocation
 */
function handleError(err: Error, stream: vscode.ChatResponseStream): void {
	if (err.message?.includes('Failed to start Claude CLI')) {
		stream.markdown(`❌ **Claude CLI Error**: ${err.message}\n\nPlease ensure that:\n1. Claude CLI is installed\n2. The 'claude' command is available in your PATH\n3. You have proper authentication set up for Claude CLI`);
	} else if (err.message?.includes('cancelled')) {
		stream.markdown('🚫 Claude CLI invocation was cancelled.');
	} else {
		stream.markdown(`❌ **Error**: ${err.message || 'An unexpected error occurred while invoking Claude CLI.'}`);
	}
}
