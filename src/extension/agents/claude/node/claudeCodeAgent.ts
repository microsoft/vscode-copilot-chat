/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Options, SDKUserMessage } from '@anthropic-ai/claude-code';
import Anthropic from '@anthropic-ai/sdk';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { isLocation } from '../../../../util/common/types';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { isWindows } from '../../../../util/vs/base/common/platform';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { isFileOkForTool } from '../../../tools/node/toolUtils';
import { ILanguageModelServerConfig, LanguageModelServer } from '../../node/langModelServer';
import { ClaudeToolNames, IExitPlanModeInput, ITodoWriteInput } from '../common/claudeTools';
import { createFormattedToolInvocation } from '../common/toolInvocationFormatter';

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
				this.resolvePrompt(request),
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
			stream.markdown('❌ Error: ' + errorMessage);
			return {
				// This currently can't be used by the sessions API https://github.com/microsoft/vscode/issues/263111
				errorDetails: { message: errorMessage },
			};
		}
	}

	private resolvePrompt(request: vscode.ChatRequest): string {
		const extraRefsTexts: string[] = [];
		let prompt = request.prompt;
		request.references.forEach(ref => {
			const valueText = URI.isUri(ref.value) ?
				ref.value.fsPath :
				isLocation(ref.value) ?
					`${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}` :
					undefined;
			if (valueText) {
				if (ref.range) {
					prompt = prompt.slice(0, ref.range[0]) + valueText + prompt.slice(ref.range[1]);
				} else {
					extraRefsTexts.push(`- ${valueText}`);
				}
			}
		});

		if (extraRefsTexts.length > 0) {
			prompt = `<system-reminder>\nThe user provided the following references:\n${extraRefsTexts.join('\n')}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n` + prompt;
		}

		return prompt;
	}
}

class KnownClaudeError extends Error { }

class ClaudeCodeSession {
	private static DenyToolMessage = 'The user declined to run the tool';

	constructor(
		private readonly serverConfig: ILanguageModelServerConfig,
		public sessionId: string | undefined,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IEnvService private readonly envService: IEnvService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IToolsService private readonly toolsService: IToolsService
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
		this.logService.trace(`appRoot: ${this.envService.appRoot}`);
		const pathSep = isWindows ? ';' : ':';
		const options: Options = {
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
			resume: this.sessionId,
			// permissionMode: 'acceptEdits',
			canUseTool: async (name, input, opts) => {
				return this.canUseTool(name, input, toolInvocationToken);
			},
			appendSystemPrompt: 'Your responses will be rendered as markdown, so please reply with properly formatted markdown when appropriate. When replying with code or the name of a symbol, wrap it in backticks.'
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

		const unprocessedToolCalls = new Map<string, Anthropic.ToolUseBlock>();
		for await (const message of query({
			prompt: createPromptIterable(prompt, this.sessionId),
			options
		})) {
			this.logService.trace(`Claude CLI SDK Message: ${JSON.stringify(message, null, 2)}`);
			if (message.session_id) {
				this.sessionId = message.session_id;
			}

			if (message.type === 'assistant') {
				this.handleAssistantMessage(message, stream, unprocessedToolCalls);
			} else if (message.type === 'user') {
				this.handleUserMessage(message, stream, unprocessedToolCalls, toolInvocationToken, token);
			} else if (message.type === 'result') {
				this.handleResultMessage(message, stream, def);
			}
		}
	}

	/**
	 * Handles assistant messages containing text content and tool use blocks
	 */
	private handleAssistantMessage(
		message: any, // Use any to avoid complex type issues with SDK types
		stream: vscode.ChatResponseStream,
		unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>
	): void {
		for (const item of message.message.content) {
			if (item.type === 'text' && item.text) {
				stream.markdown(item.text);
			} else if (item.type === 'tool_use') {
				// Don't show progress message for TodoWrite tool
				if (item.name !== ClaudeToolNames.TodoWrite) {
					stream.progress(`\n\n🛠️ Using tool: ${item.name}...`);
				}
				unprocessedToolCalls.set(item.id!, item as Anthropic.ToolUseBlock);
			}
		}
	}

	/**
	 * Handles user messages containing tool results
	 */
	private handleUserMessage(
		message: any, // Use any to avoid complex type issues with SDK types
		stream: vscode.ChatResponseStream,
		unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): void {
		if (Array.isArray(message.message.content)) {
			for (const toolResult of message.message.content) {
				if (toolResult.type === 'tool_result') {
					this.processToolResult(toolResult, stream, unprocessedToolCalls, toolInvocationToken, token);
				}
			}
		}
	}

	/**
	 * Processes individual tool results and handles special tool types
	 */
	private processToolResult(
		toolResult: any, // Use any to avoid complex type issues with Anthropic SDK types
		stream: vscode.ChatResponseStream,
		unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): void {
		const toolUse = unprocessedToolCalls.get(toolResult.tool_use_id!);
		if (!toolUse) {
			return;
		}

		unprocessedToolCalls.delete(toolResult.tool_use_id!);
		const invocation = createFormattedToolInvocation(toolUse, toolResult);
		if (toolResult?.content === ClaudeCodeSession.DenyToolMessage && invocation) {
			invocation.isConfirmed = false;
		}

		if (toolUse.name === ClaudeToolNames.TodoWrite) {
			this.processTodoWriteTool(toolUse, toolInvocationToken, token);
		}

		if (invocation) {
			stream.push(invocation);
		}
	}

	/**
	 * Handles the TodoWrite tool by converting Claude's todo format to the core todo list format
	 */
	private processTodoWriteTool(
		toolUse: Anthropic.ToolUseBlock,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): void {
		const input = toolUse.input as ITodoWriteInput;
		this.toolsService.invokeTool(ToolName.CoreManageTodoList, {
			input: {
				operation: 'write',
				todoList: input.todos.map((todo, i) => ({
					id: i,
					title: todo.content,
					description: '',
					status: todo.status === 'pending' ?
						'not-started' :
						(todo.status === 'in_progress' ?
							'in-progress' :
							'completed')
				} satisfies IManageTodoListToolInputParams['todoList'][number])),
			} satisfies IManageTodoListToolInputParams,
			toolInvocationToken,
		}, token);
	}

	/**
	 * Handles result messages that indicate completion or errors
	 */
	private handleResultMessage(
		message: any, // Use any to avoid complex type issues with SDK types
		stream: vscode.ChatResponseStream,
		def: DeferredPromise<void>
	): void {
		def.complete();
		if (message.subtype === 'error_max_turns') {
			stream.progress(`⚠️ Maximum turns reached (${message.num_turns})`);
		} else if (message.subtype === 'error_during_execution') {
			throw new KnownClaudeError(`Error during execution`);
		}
	}

	/**
	 * Handles tool permission requests by showing a confirmation dialog to the user
	 */
	private async canUseTool(toolName: string, input: Record<string, unknown>, toolInvocationToken: vscode.ChatParticipantToolToken): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
		this.logService.trace(`ClaudeCodeSession: canUseTool: ${toolName}(${JSON.stringify(input)})`);
		if (await this.canAutoApprove(toolName, input)) {
			this.logService.trace(`ClaudeCodeSession: auto-approving ${toolName}`);

			return {
				behavior: 'allow',
				updatedInput: input
			};
		}

		try {
			const result = await this.toolsService.invokeTool(ToolName.CoreConfirmationTool, {
				input: this.getConfirmationToolParams(toolName, input),
				toolInvocationToken,
			}, CancellationToken.None);
			const firstResultPart = result.content.at(0);
			if (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes') {
				return {
					behavior: 'allow',
					updatedInput: input
				};
			}
		} catch { }
		return {
			behavior: 'deny',
			message: ClaudeCodeSession.DenyToolMessage
		};
	}

	private getConfirmationToolParams(toolName: string, input: Record<string, unknown>): IConfirmationToolParams {
		if (toolName === ClaudeToolNames.Bash) {
			return {
				title: `Use ${toolName}?`,
				message: `\`\`\`\n${JSON.stringify(input, null, 2)}\n\`\`\``,
				confirmationType: 'terminal',
				terminalCommand: input.command as string | undefined
			};
		} else if (toolName === ClaudeToolNames.ExitPlanMode) {
			const plan = (input as unknown as IExitPlanModeInput).plan;
			return {
				title: `Ready to code?`,
				message: 'Here is Claude\'s plan:\n\n' + plan,
				confirmationType: 'basic'
			};
		}

		return {
			title: `Use ${toolName}?`,
			message: `\`\`\`\n${JSON.stringify(input, null, 2)}\n\`\`\``,
			confirmationType: 'basic'
		};
	}

	private async canAutoApprove(toolName: string, input: Record<string, unknown>): Promise<boolean> {
		if (toolName === ClaudeToolNames.Edit || toolName === ClaudeToolNames.Write || toolName === ClaudeToolNames.MultiEdit) {
			return await this.instantiationService.invokeFunction(isFileOkForTool, URI.file(input.file_path as string));
		}

		return false;
	}
}

/**
 * Tool params from core
 */
interface IConfirmationToolParams {
	readonly title: string;
	readonly message: string;
	readonly confirmationType?: 'basic' | 'terminal';
	readonly terminalCommand?: string;
}

interface IManageTodoListToolInputParams {
	readonly operation?: 'write' | 'read'; // Optional in write-only mode
	readonly todoList: readonly {
		readonly id: number;
		readonly title: string;
		readonly description: string;
		readonly status: 'not-started' | 'in-progress' | 'completed';
	}[];
}
