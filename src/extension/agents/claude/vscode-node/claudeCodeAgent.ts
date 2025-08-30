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
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ILanguageModelServerConfig, LanguageModelServer } from '../../vscode-node/langModelServer';

// Manages Claude Code agent interactions and language model server lifecycle
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
	) {
		super();
	}

	public async handleRequest(claudeSessionId: string | undefined, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult & { claudeSessionId?: string }> {
		try {
			// Get server config, start server if needed
			const serverConfig = (await this.getLangModelServer()).getConfig();
			const session = this.instantiationService.createInstance(ClaudeCodeSession, serverConfig, claudeSessionId);
			await session.invoke(
				request.prompt,
				request.toolInvocationToken,
				stream,
				token
			);

			return {
				claudeSessionId: session.sessionId
			};
		} catch (invokeError) {
			this.logService.error(invokeError as Error);
			const errorMessage = (invokeError instanceof KnownClaudeError) ? invokeError.message : `Claude CLI Error: ${invokeError.message}`;
			return {
				errorDetails: { message: errorMessage },
			};
		}
	}
}

class KnownClaudeError extends Error { }

class ClaudeCodeSession {
	constructor(
		private readonly serverConfig: ILanguageModelServerConfig,
		public sessionId: string | undefined,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IEnvService private readonly envService: IEnvService
	) { }

	public async invoke(
		prompt: string,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		const abortController = new AbortController();
		token.onCancellationRequested(() => {
			abortController.abort();
		});

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
				ANTHROPIC_BASE_URL: `http://localhost:${this.serverConfig.port}`,
				ANTHROPIC_API_KEY: this.serverConfig.nonce,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				USE_BUILTIN_RIPGREP: '0',
				PATH: `${this.envService.appRoot}/node_modules/@vscode/ripgrep/bin${pathSep}${process.env.PATH}`
			},
			resume: this.sessionId, // doesn't work https://github.com/microsoft/vscode/issues/263111
			// permissionMode: 'acceptEdits',
			// pathToClaudeCodeExecutable: '/Users/roblou/code/claude-code/cli.js',
			canUseTool: async (name, input, opts) => {
				return this.canUseTool(name, input, toolInvocationToken);
			}
		};

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
			prompt: createPromptIterable(prompt, this.sessionId),
			options
		})) {
			this.logService.trace(`Claude CLI SDK Message: ${JSON.stringify(message, null, 2)}`);
			if (message.session_id) {
				this.sessionId = message.session_id;
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