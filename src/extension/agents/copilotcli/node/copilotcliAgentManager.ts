/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentOptions, SDKEvent, Session } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ILanguageModelServerConfig, LanguageModelServer } from '../../node/langModelServer';
import { ICopilotCLISessionService } from './copilotcliSessionService';
import { createCopilotCLIToolInvocation } from './copilotcliToolInvocationFormatter';

export class CopilotCLIAgentManager extends Disposable {
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
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) {
		super();
	}

	/**
	 * Find session by SDK session ID
	 */
	public findSession(sessionId: string): CopilotCLISession | undefined {
		return this.sessionService.findSessionWrapper<CopilotCLISession>(sessionId);
	}

	async handleRequest(
		copilotcliSessionId: string | undefined,
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<{ copilotcliSessionId: string | undefined }> {
		const langModelServer = await this.getLangModelServer();
		const serverConfig = langModelServer.getConfig();

		const sessionIdForLog = copilotcliSessionId ?? 'new';
		this.logService.trace(`[CopilotCLIAgentManager] Handling request for sessionId=${sessionIdForLog}.`);

		// Check if we already have a session wrapper
		let session = copilotcliSessionId ? this.sessionService.findSessionWrapper<CopilotCLISession>(copilotcliSessionId) : undefined;

		if (session) {
			this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${copilotcliSessionId}.`);
		} else {
			const sdkSession = await this.sessionService.getOrCreateSDKSession(copilotcliSessionId);
			session = this.instantiationService.createInstance(CopilotCLISession, serverConfig, sdkSession);
			this.sessionService.trackSessionWrapper(sdkSession.id, session);
		}

		await session.invoke(request.prompt, request.toolInvocationToken, stream, token);

		return { copilotcliSessionId: session.sessionId };
	}
}

export class CopilotCLISession extends Disposable {
	private _abortController = new AbortController();
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();
	public readonly sessionId: string;

	constructor(
		private readonly serverConfig: ILanguageModelServerConfig,
		private readonly _sdkSession: Session,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		super();
		this.sessionId = _sdkSession.id;
	}

	public override dispose(): void {
		this._abortController.abort();
		super.dispose();
	}

	async *query(prompt: string, options: AgentOptions): AsyncGenerator<SDKEvent> {
		// Dynamically import the SDK
		const { Agent } = await import('@github/copilot/sdk');
		const agent = new Agent(options);
		yield* agent.query(prompt);
	}

	public async invoke(
		prompt: string,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this._store.isDisposed) {
			throw new Error('Session disposed');
		}

		this.logService.trace(`[CopilotCLISession] Invoking session ${this.sessionId}`);

		const options: AgentOptions = {
			modelProvider: {
				type: 'anthropic',
				model: 'claude-sonnet-4',
				apiKey: this.serverConfig.nonce,
				// baseUrl: `http://localhost:${this.serverConfig.port}`
			},
			abortController: this._abortController,
			workingDirectory: this.workspaceService.getWorkspaceFolders().at(0)?.fsPath,
			integrationId: 'vscode-chat-dev',
			hmac: process.env.HMAC_SECRET,
			env: {
				...process.env,
				COPILOTCLI_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				'copilot-integration-id': 'vscode-chat-dev',
			},
			requestPermission: async (_permissionRequest) => {
				return {
					kind: 'approved'
				};
			},
			logger: {
				isDebug: () => false,
				debug: (msg: string) => this.logService.debug(msg),
				log: (msg: string) => this.logService.trace(msg),
				info: (msg: string) => this.logService.info(msg),
				notice: (msg: string | Error) => this.logService.info(typeof msg === 'string' ? msg : msg.message),
				warning: (msg: string | Error) => this.logService.warn(typeof msg === 'string' ? msg : msg.message),
				error: (msg: string | Error) => this.logService.error(typeof msg === 'string' ? msg : msg.message),
				startGroup: () => { },
				endGroup: () => { }
			},
			session: this._sdkSession
		};

		try {
			for await (const event of this.query(prompt, options)) {
				if (token.isCancellationRequested) {
					break;
				}

				await this._processEvent(event, stream, toolInvocationToken);
			}
		} catch (error) {
			this.logService.error(`CopilotCLI session error: ${error}`);
			stream.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _processEvent(
		event: SDKEvent,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken
	): Promise<void> {
		this.logService.trace(`CopilotCLI Event: ${JSON.stringify(event, null, 2)}`);

		switch (event.type) {
			case 'thinking':
				// Progress indication
				stream.progress(event.content);
				break;

			case 'message':
				if (event.role === 'assistant') {
					stream.markdown(event.content);
				}
				break;

			case 'tool_use': {
				const pendingInvocation = createCopilotCLIToolInvocation(
					event.toolName,
					event.toolCallId,
					event.args
				);

				if (pendingInvocation && event.toolCallId) {
					this._pendingToolInvocations.set(event.toolCallId, pendingInvocation);
				}
				break;
			}
			case 'tool_result': {
				const toolCallId = event.toolCallId;
				let invocation = toolCallId ? this._pendingToolInvocations.get(toolCallId) : undefined;

				if (!invocation) {
					invocation = createCopilotCLIToolInvocation(
						event.toolName,
						toolCallId,
						{}, // We don't have the args in the result event
						event.result.resultType,
						event.result.error
					);
				} else {
					invocation.isConfirmed = true;
					invocation.isError = event.result.resultType === 'failure' || event.result.resultType === 'denied';
				}

				if (invocation) {
					stream.push(invocation);
				}

				if (toolCallId) {
					this._pendingToolInvocations.delete(toolCallId);
				}

				this.logService.trace(`Tool ${event.toolName} result: ${event.result.resultType}`);
				break;
			}

			case 'error':
				this.logService.error(`CopilotCLI error: ${event.error.message}`);
				stream.markdown(`\n\n❌ Error: ${event.error.message}`);
				break;
		}
	}
}