/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, ModelProvider, Session, SessionEvent, SessionOptions } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { DeferredPromise, raceCancellation } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ChatResponseThinkingProgressPart, LanguageModelTextPart } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { CopilotCLIPermissionsHandler } from './copilotCli';
import { PermissionRequest, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
import { ensureNodePtyShim } from './nodePtyShim';

export class CopilotCLISession extends DisposableStore {
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();
	public get sessionId(): string {
		return this.session.sessionId;
	}
	public get session(): Session {
		return this._session;
	}
	constructor(
		private readonly _permissionHandler: CopilotCLIPermissionsHandler,
		private readonly _session: Session,
		@ILogService private readonly _logService: ILogService,
		@IToolsService private readonly toolsService: IToolsService,
		@IEnvService private readonly envService: IEnvService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();
	}


	async getManager(options: SessionOptions) {
		// Ensure node-pty shim exists before importing SDK
		await ensureNodePtyShim(this.extensionContext.extensionPath, this.envService.appRoot, this._logService);

		// Dynamically import the SDK
		const { internal } = await import('@github/copilot/sdk');
		return new internal.CLISessionManager(options);
	}

	public async invoke(
		prompt: string,
		attachments: Attachment[],
		toolInvocationToken: vscode.ChatParticipantToolToken,
		stream: vscode.ChatResponseStream,
		modelId: ModelProvider | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Session disposed');
		}
		const disposables = this.add(new DisposableStore());
		try {
			disposables.add(this._permissionHandler.onDidRequestPermissions(async (permissionRequest) => {
				return await this.requestPermission(permissionRequest, toolInvocationToken);
			}));

			this._logService.trace(`[CopilotCLISession] Invoking session ${this._session.sessionId}`);

			const done = new DeferredPromise();
			const unsubscribe = this._session.on('*', (event: SessionEvent) => {
				// TODO @DonJayamanne Shouldn't we process these until the session aborts itself.
				if (token.isCancellationRequested) {
					return;
				}
				try {
					this._processEvent(event, stream);
				} catch (error) {
					this._logService.error(`CopilotCLI session error: ${error}`);
					stream.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					if (event.type === 'session.idle') {
						done.complete(undefined);
					}
				}
			});
			this.session.send({ prompt, attachments });

			disposables.add(toDisposable(() => unsubscribe()));
			await raceCancellation(done.p, token);
		} finally {
			disposables.dispose();
		}
	}

	private _toolNames = new Map<string, string>();
	private _processEvent(event: SessionEvent, stream: vscode.ChatResponseStream): void {
		this._logService.trace(`CopilotCLI Event: ${JSON.stringify(event, null, 2)}`);

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
				const toolName = this._toolNames.get(event.data.toolCallId);
				if (responsePart instanceof ChatResponseThinkingProgressPart) {
					stream.push(responsePart);
				}
				this._logService.trace(`Start Tool ${toolName || '<unknown>'}`);
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
				this._logService.trace(`Complete Tool ${toolName}, ${parts}`);
				break;
			}

			case 'session.error': {
				this._logService.error(`CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);
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
			const { tool, input } = this.getConfirmationToolParams(permissionRequest);
			const result = await this.toolsService.invokeTool(tool,
				{ input, toolInvocationToken },
				CancellationToken.None);

			const firstResultPart = result.content.at(0);
			if (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes') {
				return { kind: 'approved' };
			}
		} catch (error) {
			if (permissionRequest.kind === 'shell') {
				try {
					const tool = ToolName.CoreConfirmationTool;
					const input = {
						title: permissionRequest.intention || 'Copilot CLI Permission Request',
						message: permissionRequest.fullCommandText || `\`\`\`\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
						confirmationType: 'terminal',
						terminalCommand: permissionRequest.fullCommandText as string | undefined

					};
					const result = await this.toolsService.invokeTool(tool,
						{ input, toolInvocationToken },
						CancellationToken.None);

					const firstResultPart = result.content.at(0);
					if (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes') {
						return { kind: 'approved' };
					}
				} catch (error) {
					this._logService.error(`[CopilotCLISession](2) Permission request error: ${error}`);
				}
			}
			this._logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		}

		return { kind: 'denied-interactively-by-user' };
	}

	private getConfirmationToolParams(permissionRequest: Record<string, unknown>): { tool: string; input: unknown } {
		if (permissionRequest.kind === 'shell') {
			return {
				tool: ToolName.CoreTerminalConfirmationTool, input: {
					message: permissionRequest.intention || permissionRequest.fullCommandText || `\`\`\`\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
					command: permissionRequest.fullCommandText as string | undefined,
					isBackground: false
				}
			};
		}

		if (permissionRequest.kind === 'write') {
			return {
				tool: ToolName.CoreConfirmationTool,
				input: {

					title: permissionRequest.intention || 'Copilot CLI Permission Request',
					message: permissionRequest.fileName ? `Edit ${permissionRequest.fileName}` : `\`\`\`\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
					confirmationType: 'basic'
				}
			};
		}

		if (permissionRequest.kind === 'mcp') {
			const serverName = permissionRequest.serverName as string | undefined;
			const toolTitle = permissionRequest.toolTitle as string | undefined;
			const toolName = permissionRequest.toolName as string | undefined;
			const args = permissionRequest.args;

			return {
				tool: ToolName.CoreConfirmationTool,
				input: {

					title: toolTitle || `MCP Tool: ${toolName || 'Unknown'}`,
					message: serverName
						? `Server: ${serverName}\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
						: `\`\`\`json\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
					confirmationType: 'basic'
				}
			};
		}

		return {
			tool: ToolName.CoreConfirmationTool,
			input: {
				title: 'Copilot CLI Permission Request',
				message: `\`\`\`\n${JSON.stringify(permissionRequest, null, 2)}\n\`\`\``,
				confirmationType: 'basic'
			}
		};
	}
}
