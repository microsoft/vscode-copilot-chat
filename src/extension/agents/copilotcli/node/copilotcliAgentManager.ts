/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentOptions, ModelProvider, Session, SessionEvent } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseThinkingProgressPart, LanguageModelTextPart } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { ICopilotCLISessionService } from './copilotcliSessionService';
import { PermissionRequest, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
import { ensureNodePtyShim } from './nodePtyShim';

export class CopilotCLIAgentManager extends Disposable {
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
		modelId: ModelProvider | undefined,
		token: vscode.CancellationToken
	): Promise<{ copilotcliSessionId: string | undefined }> {
		const isNewSession = !copilotcliSessionId;
		const sessionIdForLog = copilotcliSessionId ?? 'new';
		this.logService.trace(`[CopilotCLIAgentManager] Handling request for sessionId=${sessionIdForLog}.`);

		// Check if we already have a session wrapper
		let session = copilotcliSessionId ? this.sessionService.findSessionWrapper<CopilotCLISession>(copilotcliSessionId) : undefined;

		if (session) {
			this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${copilotcliSessionId}.`);
		} else {
			const sdkSession = await this.sessionService.getOrCreateSDKSession(copilotcliSessionId, request.prompt);
			session = this.instantiationService.createInstance(CopilotCLISession, sdkSession);
			this.sessionService.trackSessionWrapper(sdkSession.sessionId, session);
		}

		if (isNewSession) {
			this.sessionService.setPendingRequest(session.sessionId);
		}

		await session.invoke(request.prompt, request.toolInvocationToken, stream, modelId, token);

		return { copilotcliSessionId: session.sessionId };
	}
}

export class CopilotCLISession extends Disposable {
	private _abortController = new AbortController();
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();
	public readonly sessionId: string;

	constructor(
		private readonly _sdkSession: Session,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IToolsService private readonly toolsService: IToolsService,
		@IEnvService private readonly envService: IEnvService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();
		this.sessionId = _sdkSession.sessionId;
	}

	public override dispose(): void {
		this._abortController.abort();
		super.dispose();
	}

	async *query(prompt: string, options: AgentOptions): AsyncGenerator<SessionEvent> {
		// Ensure node-pty shim exists before importing SDK
		// @github/copilot has hardcoded: import{spawn}from"node-pty"
		await ensureNodePtyShim(this.extensionContext.extensionPath, this.envService.appRoot);

		// Dynamically import the SDK
		const { Agent } = await import('@github/copilot/sdk');
		const agent = new Agent(options);
		yield* agent.query(prompt);
	}

	public async invoke(
		prompt: string,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		modelId: ModelProvider | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this._store.isDisposed) {
			throw new Error('Session disposed');
		}

		this.logService.trace(`[CopilotCLISession] Invoking session ${this.sessionId}`);
		const copilotToken = await this._authenticationService.getCopilotToken();

		const options: AgentOptions = {
			modelProvider: modelId ?? {
				type: 'anthropic',
				model: 'claude-sonnet-4.5',
			},
			abortController: this._abortController,
			// TODO@rebornix handle workspace properly
			workingDirectory: this.workspaceService.getWorkspaceFolders().at(0)?.fsPath,
			copilotToken: copilotToken.token,
			env: {
				...process.env,
				COPILOTCLI_DISABLE_NONESSENTIAL_TRAFFIC: '1'
			},
			requestPermission: async (permissionRequest) => {
				return await this.requestPermission(permissionRequest, toolInvocationToken);
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

	private _toolNames = new Map<string, string>();
	private async _processEvent(
		event: SessionEvent,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken
	): Promise<void> {
		this.logService.trace(`CopilotCLI Event: ${JSON.stringify(event, null, 2)}`);

		switch (event.type) {
			case 'assistant.turn_start':
			case 'assistant.turn_end': {
				this._toolNames.clear();
				break;
			}

			case 'assistant.message': {
				if (event.data.content.length) {
					stream.markdown(event.data.content);
				}
				break;
			}

			case 'tool.execution_start': {
				const responsePart = processToolExecutionStart(event, this._toolNames, this._pendingToolInvocations);
				if (responsePart instanceof ChatResponseThinkingProgressPart) {
					stream.push(responsePart);
				}
				const toolName = this._toolNames.get(event.data.toolCallId) || '<unknown>';
				this.logService.trace(`Start Tool ${toolName}`);
				break;
			}

			case 'tool.execution_complete': {
				const responsePart = processToolExecutionComplete(event, this._pendingToolInvocations);
				if (responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
					stream.push(responsePart);
				}

				const toolName = this._toolNames.get(event.data.toolCallId) || '<unknown>';
				const success = `success: ${event.data.success}`;
				const error = event.data.error ? `error: ${event.data.error.code},${event.data.error.message}` : '';
				const result = event.data.result ? `result: ${event.data.result?.content}` : '';
				const parts = [success, error, result].filter(part => part.length > 0).join(', ');
				this.logService.trace(`Complete Tool ${toolName}, ${parts}`);
				break;
			}

			case 'session.error': {
				this.logService.error(`CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
				stream.markdown(`\n\n❌ Error: ${event.data.message}`);
				break;
			}
		}
	}

	private async requestPermission(
		permissionRequest: PermissionRequest,
		toolInvocationToken: vscode.ChatParticipantToolToken
	): Promise<{ kind: 'approved' } | { kind: 'denied-interactively-by-user' }> {
		try {
			const result = await this.toolsService.invokeTool(ToolName.CoreConfirmationTool, {
				input: this.getConfirmationToolParams(permissionRequest),
				toolInvocationToken,
			}, CancellationToken.None);

			const firstResultPart = result.content.at(0);
			if (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes') {
				return { kind: 'approved' };
			}
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		}

		return { kind: 'denied-interactively-by-user' };
	}

	private getConfirmationToolParams(permissionRequest: Record<string, unknown>) {
		if (permissionRequest.kind === 'shell') {
			return {
				title: permissionRequest.intention || 'Copilot CLI Permission Request',
				message: permissionRequest.fullCommandText || `\`\`\`\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
				confirmationType: 'terminal',
				terminalCommand: permissionRequest.fullCommandText as string | undefined

			};
		}

		if (permissionRequest.kind === 'write') {
			return {
				title: permissionRequest.intention || 'Copilot CLI Permission Request',
				message: permissionRequest.fileName ? `Edit ${permissionRequest.fileName}` : `\`\`\`\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
				confirmationType: 'basic'
			};
		}

		if (permissionRequest.kind === 'mcp') {
			const serverName = permissionRequest.serverName as string | undefined;
			const toolTitle = permissionRequest.toolTitle as string | undefined;
			const toolName = permissionRequest.toolName as string | undefined;
			const args = permissionRequest.args;

			return {
				title: toolTitle || `MCP Tool: ${toolName || 'Unknown'}`,
				message: serverName
					? `Server: ${serverName}\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
					: `\`\`\`json\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
				confirmationType: 'basic'
			};
		}

		return {
			title: 'Copilot CLI Permission Request',
			message: `\`\`\`\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
			confirmationType: 'basic'
		};
	}
}
