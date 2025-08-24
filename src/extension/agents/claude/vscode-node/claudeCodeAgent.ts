/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Options, SDKUserMessage } from '@anthropic-ai/claude-code';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { findLast } from '../../../../util/vs/base/common/arraysFind';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseTurn } from '../../../../vscodeTypes';
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
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IEnvService private readonly envService: IEnvService
	) {
		super();
	}

	public async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		let sessionId = this.getSessionIdFromHistory(context);
		try {
			const result = await this.invokeClaudeWithSDK(request.toolInvocationToken, request.prompt, sessionId, stream, token);
			sessionId = result.sessionId;
		} catch (invokeError) {
			this.logService.error(invokeError as Error);
			const errorMessage = (invokeError instanceof KnownClaudeError) ? invokeError.message : `Claude CLI Error: ${invokeError.message}`;
			return {
				errorDetails: { message: errorMessage },
				metadata: { sessionId }
			};
		}

		return {
			metadata: { sessionId }
		};
	}

	private getSessionIdFromHistory(context: vscode.ChatContext): string | undefined {
		const lastMessage = findLast(context.history, msg => msg instanceof ChatResponseTurn) as ChatResponseTurn | undefined;
		const sessionId = lastMessage?.result?.metadata?.sessionId;
		return sessionId;
	}

	/**
	 * Internal function to invoke Claude using the Claude Code SDK
	 */
	private async invokeClaudeWithSDK(toolInvocationToken: vscode.ChatParticipantToolToken, prompt: string, existingSessionId: string | undefined, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<{ sessionId?: string }> {
		const abortController = new AbortController();
		token.onCancellationRequested(() => {
			abortController.abort();
		});

		// Get server config, start server if needed
		const serverConfig = (await this.getLangModelServer()).getConfig();

		// Build options for the Claude Code SDK
		// process.env.DEBUG = '1'; // debug messages from sdk.mjs
		const isDebugEnabled = this.configService.getConfig(ConfigKey.Internal.ClaudeCodeDebugEnabled);
		this.logService.trace(`appRoot: ${vscode.env.appRoot}`);
		const pathSep = isWindows ? ';' : ':';
		const options: Options = {
			// allowedTools: uniqueTools,
			cwd: this.workspaceService.getWorkspaceFolders().at(0)?.fsPath,
			abortController,
			executable: process.execPath as 'node', // get it to fork the EH node process
			env: {
				...process.env,
				...(isDebugEnabled ? { DEBUG: '1' } : {}),
				ANTHROPIC_BASE_URL: `http://localhost:${serverConfig.port}`,
				ANTHROPIC_API_KEY: serverConfig.nonce,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				USE_BUILTIN_RIPGREP: '0',
				PATH: `${this.envService.appRoot}/node_modules/@vscode/ripgrep/bin${pathSep}${process.env.PATH}`
			},
			// permissionMode: 'acceptEdits',
			// pathToClaudeCodeExecutable: '/Users/roblou/code/claude-code/cli.js',
			canUseTool: async (name, input, opts) => {
				return this.canUseTool(name, input, toolInvocationToken);
			}
		};

		// Add resume session if provided
		if (existingSessionId) {
			options.resume = existingSessionId;
		}

		let sessionId: string | undefined;

		this.logService.trace(`Claude CLI SDK: Starting query with options: ${JSON.stringify(options)}`);
		const { query } = await import('@anthropic-ai/claude-code');
		const def = new DeferredPromise<void>();
		async function* createPromptIterable(promptText: string, sessionId?: string): AsyncIterable<SDKUserMessage> {
			yield {
				type: 'user',
				message: {
					role: 'user',
					content: promptText
				},
				parent_tool_use_id: null,
				session_id: sessionId ?? ''
			};

			// Workaround https://github.com/anthropics/claude-code/issues/4775
			await def.p;
		}

		for await (const message of query({
			prompt: createPromptIterable(prompt, existingSessionId),
			options
		})) {
			this.logService.trace(`Claude CLI SDK Message: ${JSON.stringify(message, null, 2)}`);
			if (message.session_id) {
				sessionId = message.session_id;
			}

			if (message.type === 'assistant') {
				for (const item of message.message.content) {
					if (item.type === 'text' && item.text) {
						stream.markdown(item.text);
					} else if (item.type === 'tool_use') {
						// currentToolTask?.complete();
						// currentToolTask = new DeferredPromise();
						stream.markdown(`\n\n🛠️ Using tool: ${item.name}...`);
						stream.prepareToolInvocation(item.name);
					}
				}
			} else if (message.type === 'user') {
				if (Array.isArray(message.message.content)) {
					for (const item of message.message.content) {
						if (item.type === 'tool_result') {
							// currentToolTask?.complete();
						}
					}
				}
			} else if (message.type === 'result') {
				def.complete();
				if (message.subtype === 'error_max_turns') {
					stream.progress(`⚠️ Maximum turns reached (${message.num_turns})`);
				} else if (message.subtype === 'error_during_execution') {
					throw new KnownClaudeError(`Error during execution`);
				}
			}
		}

		return { sessionId };
	}

	/**
	 * Handles tool permission requests by showing a confirmation dialog to the user
	 */
	private async canUseTool(toolName: string, input: Record<string, unknown>, toolInvocationToken: vscode.ChatParticipantToolToken): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
		this.logService.trace(`Claude CLI SDK: canUseTool: ${toolName}`);
		try {
			await vscode.lm.invokeTool('vscode_get_confirmation', {
				input: {
					title: `Use ${toolName}?`,
					message: `\`\`\`\n${JSON.stringify(input, null, 2)}\n\`\`\``
				},
				toolInvocationToken,
			});
			return {
				behavior: 'allow',
				updatedInput: input
			};
		} catch {
			return {
				behavior: 'deny',
				message: 'The user declined to run the tool'
			};
		}
	}
}

class KnownClaudeError extends Error { }