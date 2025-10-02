/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { Disposable, DisposableMap } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ILanguageModelServerConfig, LanguageModelServer } from '../../node/langModelServer';
import { ICopilotCLISdkService, type AgentOptions, type SDKEvent } from './copilotcliClient';
import { createCopilotCLIToolInvocation } from './copilotcliToolInvocationFormatter';

export class CopilotCLIAgentManager extends Disposable {
	private _langModelServer: LanguageModelServer | undefined;
	private _sessions = this._register(new DisposableMap<string, CopilotCLISession>());

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

	/**
	 * Find session by SDK session ID
	 */
	public findSession(sessionId: string): CopilotCLISession | undefined {
		return this._sessions.get(sessionId);
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

		let session: CopilotCLISession;
		if (copilotcliSessionId && this._sessions.has(copilotcliSessionId)) {
			this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${copilotcliSessionId}.`);
			session = this._sessions.get(copilotcliSessionId)!;
		} else {
			this.logService.trace(`[CopilotCLIAgentManager] Creating CopilotCLI session for sessionId=${sessionIdForLog}.`);
			const newSession = this.instantiationService.createInstance(CopilotCLISession, serverConfig, copilotcliSessionId);
			if (newSession.sessionId) {
				this._sessions.set(newSession.sessionId, newSession);
			}
			session = newSession;
		}

		await session.invoke(request.prompt, request.toolInvocationToken, stream, token);

		// Store the session if sessionId was assigned during invoke
		if (session.sessionId && !this._sessions.has(session.sessionId)) {
			this.logService.trace(`[CopilotCLIAgentManager] Tracking CopilotCLI session ${copilotcliSessionId} -> ${session.sessionId}`);
			this._sessions.set(session.sessionId, session);
		}

		return { copilotcliSessionId: session.sessionId };
	}
}

export class CopilotCLISession extends Disposable {
	private _abortController = new AbortController();
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();

	constructor(
		private readonly serverConfig: ILanguageModelServerConfig,
		public sessionId: string | undefined,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ICopilotCLISdkService private readonly copilotcliSdkService: ICopilotCLISdkService
	) {
		super();
	}

	public override dispose(): void {
		this._abortController.abort();
		super.dispose();
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
			requestPermission: async (permissionRequest) => {
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
			}
		};

		try {
			for await (const event of this.copilotcliSdkService.query(prompt, options)) {
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