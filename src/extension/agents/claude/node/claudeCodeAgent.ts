/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Options, Query, SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { isLocation } from '../../../../util/common/types';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable, DisposableMap } from '../../../../util/vs/base/common/lifecycle';
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
import { IClaudeCodeSdkService } from './claudeCodeSdkService';

// Manages Claude Code agent interactions and language model server lifecycle
export class ClaudeAgentManager extends Disposable {
	private _langModelServer: LanguageModelServer | undefined;
	private _sessions = this._register(new DisposableMap<string, ClaudeCodeSession>());

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

	public async handleRequest(claudeSessionId: string | undefined, request: vscode.ChatRequest, _context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult & { claudeSessionId?: string }> {
		try {
			// Get server config, start server if needed
			const serverConfig = (await this.getLangModelServer()).getConfig();

			const sessionIdForLog = claudeSessionId ?? 'new';
			this.logService.trace(`[ClaudeAgentManager] Handling request for sessionId=${sessionIdForLog}.`);
			let session: ClaudeCodeSession;
			if (claudeSessionId && this._sessions.has(claudeSessionId)) {
				this.logService.trace(`[ClaudeAgentManager] Reusing Claude session ${claudeSessionId}.`);
				session = this._sessions.get(claudeSessionId)!;
			} else {
				this.logService.trace(`[ClaudeAgentManager] Creating Claude session for sessionId=${sessionIdForLog}.`);
				const newSession = this.instantiationService.createInstance(ClaudeCodeSession, serverConfig, claudeSessionId);
				if (newSession.sessionId) {
					this._sessions.set(newSession.sessionId, newSession);
				}
				session = newSession;
			}

			await session.invoke(
				this.resolvePrompt(request),
				request.toolInvocationToken,
				stream,
				token
			);

			// Store the session if sessionId was assigned during invoke
			if (session.sessionId && !this._sessions.has(session.sessionId)) {
				this.logService.trace(`[ClaudeAgentManager] Tracking Claude session ${claudeSessionId} -> ${session.sessionId}`);
				this._sessions.set(session.sessionId, session);
			}

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
		if (request.prompt.startsWith('/')) {
			return request.prompt; // likely a slash command, don't modify
		}

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

/**
 * Represents a queued chat request waiting to be processed by the Claude session
 */
interface QueuedRequest {
	readonly prompt: string;
	readonly stream: vscode.ChatResponseStream;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken;
	readonly token: vscode.CancellationToken;
	readonly deferred: DeferredPromise<void>;
}

/**
 * Represents the currently active request being processed
 */
interface CurrentRequest {
	readonly stream: vscode.ChatResponseStream;
	readonly toolInvocationToken: vscode.ChatParticipantToolToken;
	readonly token: vscode.CancellationToken;
}

export class ClaudeCodeSession extends Disposable {
	private static readonly DenyToolMessage = 'The user declined to run the tool';
	private _queryGenerator: Query | undefined;
	private _promptQueue: QueuedRequest[] = [];
	private _currentRequest: CurrentRequest | undefined;
	private _pendingPrompt: DeferredPromise<QueuedRequest> | undefined;
	private _abortController = new AbortController();

	constructor(
		private readonly serverConfig: ILanguageModelServerConfig,
		public sessionId: string | undefined,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IEnvService private readonly envService: IEnvService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IToolsService private readonly toolsService: IToolsService,
		@IClaudeCodeSdkService private readonly claudeCodeService: IClaudeCodeSdkService
	) {
		super();
	}

	public override dispose(): void {
		this._abortController.abort();
		this._promptQueue.forEach(req => req.deferred.error(new Error('Session disposed')));
		this._promptQueue = [];
		this._pendingPrompt?.error(new Error('Session disposed'));
		this._pendingPrompt = undefined;
		super.dispose();
	}

	/**
	 * Invokes the Claude Code session with a user prompt
	 * @param prompt The user's prompt text
	 * @param toolInvocationToken Token for invoking tools
	 * @param stream Response stream for sending results back to VS Code
	 * @param token Cancellation token for request cancellation
	 */
	public async invoke(
		prompt: string,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this._store.isDisposed) {
			throw new Error('Session disposed');
		}

		if (!this._queryGenerator) {
			await this._startSession();
		}

		// Add this request to the queue and wait for completion
		const deferred = new DeferredPromise<void>();
		const request: QueuedRequest = {
			prompt,
			stream,
			toolInvocationToken,
			token,
			deferred
		};

		this._promptQueue.push(request);

		// Handle cancellation
		token.onCancellationRequested(() => {
			const index = this._promptQueue.indexOf(request);
			if (index !== -1) {
				this._promptQueue.splice(index, 1);
				deferred.error(new Error('Request was cancelled'));
			}
		});

		// If there's a pending prompt request, fulfill it immediately
		if (this._pendingPrompt) {
			const pendingPrompt = this._pendingPrompt;
			this._pendingPrompt = undefined;
			pendingPrompt.complete(request);
		}

		return deferred.p;
	}

	/**
	 * Starts a new Claude Code session with the configured options
	 */
	private async _startSession(): Promise<void> {
		// Build options for the Claude Code SDK
		const isDebugEnabled = this.configService.getConfig(ConfigKey.Internal.ClaudeCodeDebugEnabled);
		this.logService.trace(`appRoot: ${this.envService.appRoot}`);
		const pathSep = isWindows ? ';' : ':';
		const options: Options = {
			cwd: this.workspaceService.getWorkspaceFolders().at(0)?.fsPath,
			abortController: this._abortController,
			executable: process.execPath as 'node', // get it to fork the EH node process
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: `http://localhost:${this.serverConfig.port}`,
				ANTHROPIC_API_KEY: this.serverConfig.nonce,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				USE_BUILTIN_RIPGREP: '0',
				PATH: `${this.envService.appRoot}/node_modules/@vscode/ripgrep/bin${pathSep}${process.env.PATH}`
			},
			resume: this.sessionId,
			canUseTool: async (name, input) => {
				return this._currentRequest ?
					this.canUseTool(name, input, this._currentRequest.toolInvocationToken) :
					{ behavior: 'deny', message: 'No active request' };
			},
			systemPrompt: {
				type: 'preset',
				preset: 'claude_code',
				append: 'Your responses will be rendered as markdown, so please reply with properly formatted markdown when appropriate. When replying with code or the name of a symbol, wrap it in backticks.'
			},
			settingSources: ['user', 'project', 'local'],
			...(isDebugEnabled && {
				stderr: data => {
					this.logService.trace(`claude-agent-sdk stderr: ${data}`);
				}
			})
		};

		this.logService.trace(`claude-agent-sdk: Starting query with options: ${JSON.stringify(options)}`);
		this._queryGenerator = await this.claudeCodeService.query({
			prompt: this._createPromptIterable(),
			options
		});

		// Start the message processing loop
		this._processMessages();
	}

	private async *_createPromptIterable(): AsyncIterable<SDKUserMessage> {
		while (true) {
			// Wait for a request to be available
			const request = await this._getNextRequest();

			this._currentRequest = {
				stream: request.stream,
				toolInvocationToken: request.toolInvocationToken,
				token: request.token
			};

			yield {
				type: 'user',
				message: {
					role: 'user',
					content: request.prompt
				},
				parent_tool_use_id: null,
				session_id: this.sessionId ?? ''
			};

			// Wait for this request to complete before yielding the next one
			await request.deferred.p;
		}
	}

	/**
	 * Gets the next request from the queue or waits for one to be available
	 * @returns Promise that resolves with the next queued request
	 */
	private async _getNextRequest(): Promise<QueuedRequest> {
		if (this._promptQueue.length > 0) {
			return this._promptQueue[0]; // Don't shift yet, keep for resolution
		}

		// Wait for a request to be queued
		this._pendingPrompt = new DeferredPromise<QueuedRequest>();
		return this._pendingPrompt.p;
	}

	/**
	 * Processes messages from the Claude Code query generator
	 * Routes messages to appropriate handlers and manages request completion
	 */
	private async _processMessages(): Promise<void> {
		try {
			const unprocessedToolCalls = new Map<string, Anthropic.ToolUseBlock>();
			for await (const message of this._queryGenerator!) {
				// Check if current request was cancelled
				if (this._currentRequest?.token.isCancellationRequested) {
					throw new Error('Request was cancelled');
				}

				this.logService.trace(`claude-agent-sdk Message: ${JSON.stringify(message, null, 2)}`);
				if (message.session_id) {
					this.sessionId = message.session_id;
				}

				if (message.type === 'assistant') {
					this.handleAssistantMessage(message, this._currentRequest!.stream, unprocessedToolCalls);
				} else if (message.type === 'user') {
					this.handleUserMessage(message, this._currentRequest!.stream, unprocessedToolCalls, this._currentRequest!.toolInvocationToken, this._currentRequest!.token);
				} else if (message.type === 'result') {
					this.handleResultMessage(message, this._currentRequest!.stream);
					// Resolve and remove the completed request
					if (this._promptQueue.length > 0) {
						const completedRequest = this._promptQueue.shift()!;
						completedRequest.deferred.complete();
					}
					this._currentRequest = undefined;
				}
			}
		} catch (error) {
			// Reject all pending requests
			this._promptQueue.forEach(req => req.deferred.error(error as Error));
			this._promptQueue = [];
			this._pendingPrompt?.error(error as Error);
			this._pendingPrompt = undefined;
		}
	}

	/**
	 * Handles assistant messages containing text content and tool use blocks
	 */
	private handleAssistantMessage(
		message: SDKAssistantMessage,
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
		message: SDKUserMessage,
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
		toolResult: Anthropic.Messages.ToolResultBlockParam,
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
		message: SDKResultMessage,
		stream: vscode.ChatResponseStream
	): void {
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
