/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentOptions, Attachment, ModelProvider, Session, SessionEvent } from '@github/copilot/sdk';
import * as fs from 'fs/promises';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { isLocation } from '../../../../util/common/types';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatReferenceDiagnostic, ChatResponseThinkingProgressPart, LanguageModelTextPart } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { ICopilotCLISessionService } from './copilotcliSessionService';
import { PermissionRequest, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
import { getCopilotLogger } from './logger';
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

		const { prompt, attachments } = await this.resolvePrompt(request);
		// Check if we already have a session wrapper
		let session = copilotcliSessionId ? this.sessionService.findSessionWrapper<CopilotCLISession>(copilotcliSessionId) : undefined;

		if (session) {
			this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${copilotcliSessionId}.`);
		} else {
			const sdkSession = await this.sessionService.getOrCreateSDKSession(copilotcliSessionId, prompt);
			session = this.instantiationService.createInstance(CopilotCLISession, sdkSession);
			this.sessionService.trackSessionWrapper(sdkSession.sessionId, session);
		}

		if (isNewSession) {
			this.sessionService.setPendingRequest(session.sessionId);
		}

		await session.invoke(prompt, attachments, request.toolInvocationToken, stream, modelId, token);

		return { copilotcliSessionId: session.sessionId };
	}

	private async resolvePrompt(request: vscode.ChatRequest): Promise<{ prompt: string; attachments: Attachment[] }> {
		if (request.prompt.startsWith('/')) {
			return { prompt: request.prompt, attachments: [] }; // likely a slash command, don't modify
		}

		const attachments: Attachment[] = [];
		const allRefsTexts: string[] = [];
		const diagnosticTexts: string[] = [];
		const files: { path: string; name: string }[] = [];
		// TODO@rebornix: filter out implicit references for now. Will need to figure out how to support `<reminder>` without poluting user prompt
		request.references.filter(ref => !ref.id.startsWith('vscode.prompt.instructions')).forEach(ref => {
			if (ref.value instanceof ChatReferenceDiagnostic) {
				// Handle diagnostic reference
				for (const [uri, diagnostics] of ref.value.diagnostics) {
					if (uri.scheme !== 'file') {
						continue;
					}
					for (const diagnostic of diagnostics) {
						const severityMap: { [key: number]: string } = {
							0: 'error',
							1: 'warning',
							2: 'info',
							3: 'hint'
						};
						const severity = severityMap[diagnostic.severity] ?? 'error';
						const code = (typeof diagnostic.code === 'object' && diagnostic.code !== null) ? diagnostic.code.value : diagnostic.code;
						const codeStr = code ? ` [${code}]` : '';
						const line = diagnostic.range.start.line + 1;
						diagnosticTexts.push(`- ${severity}${codeStr} at ${uri.fsPath}:${line}: ${diagnostic.message}`);
						files.push({ path: uri.fsPath, name: path.basename(uri.fsPath) });
					}
				}
			} else {
				const uri = URI.isUri(ref.value) ? ref.value : isLocation(ref.value) ? ref.value.uri : undefined;
				if (!uri || uri.scheme !== 'file') {
					return;
				}
				const filePath = uri.fsPath;
				files.push({ path: filePath, name: ref.name || path.basename(filePath) });
				const valueText = URI.isUri(ref.value) ?
					ref.value.fsPath :
					isLocation(ref.value) ?
						`${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}` :
						undefined;
				if (valueText && ref.range) {
					// Keep the original prompt untouched, just collect resolved paths
					const variableText = request.prompt.substring(ref.range[0], ref.range[1]);
					allRefsTexts.push(`- ${variableText} → ${valueText}`);
				}
			}
		});

		await Promise.all(files.map(async (file) => {
			try {
				const stat = await fs.stat(file.path);
				const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined;
				if (!type) {
					this.logService.error(`[CopilotCLIAgentManager] Ignoring attachment as its not a file/directory (${file.path})`);
					return;
				}
				attachments.push({
					type,
					displayName: file.name,
					path: file.path
				});
			} catch (error) {
				this.logService.error(`[CopilotCLIAgentManager] Failed to attach ${file.path}: ${error}`);
			}
		}));

		const reminderParts: string[] = [];
		if (allRefsTexts.length > 0) {
			reminderParts.push(`The user provided the following references:\n${allRefsTexts.join('\n')}`);
		}
		if (diagnosticTexts.length > 0) {
			reminderParts.push(`The user provided the following diagnostics:\n${diagnosticTexts.join('\n')}`);
		}

		let prompt = request.prompt;
		if (reminderParts.length > 0) {
			prompt = `<reminder>\n${reminderParts.join('\n\n')}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</reminder>\n\n${prompt}`;
		}

		return { prompt, attachments };
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

	async *query(prompt: string, attachments: Attachment[], options: AgentOptions): AsyncGenerator<SessionEvent> {
		// Ensure node-pty shim exists before importing SDK
		// @github/copilot has hardcoded: import{spawn}from"node-pty"
		await ensureNodePtyShim(this.extensionContext.extensionPath, this.envService.appRoot);

		// Dynamically import the SDK
		const { Agent } = await import('@github/copilot/sdk');
		const agent = new Agent(options);
		yield* agent.query(prompt, attachments);
	}

	public async invoke(
		prompt: string,
		attachments: Attachment[],
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
			logger: getCopilotLogger(this.logService),
			session: this._sdkSession
		};

		try {
			for await (const event of this.query(prompt, attachments, options)) {
				if (token.isCancellationRequested) {
					break;
				}

				this._processEvent(event, stream, toolInvocationToken);
			}
		} catch (error) {
			this.logService.error(`CopilotCLI session error: ${error}`);
			stream.markdown(`\n\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _toolNames = new Map<string, string>();
	private _processEvent(
		event: SessionEvent,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken
	): void {
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
				const toolName = this._toolNames.get(event.data.toolCallId);
				if (responsePart instanceof ChatResponseThinkingProgressPart) {
					stream.push(responsePart);
				}
				this.logService.trace(`Start Tool ${toolName || '<unknown>'}`);
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
					this.logService.error(`[CopilotCLISession](2) Permission request error: ${error}`);
				}
			}
			this.logService.error(`[CopilotCLISession] Permission request error: ${error}`);
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
