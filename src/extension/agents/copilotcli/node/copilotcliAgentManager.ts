/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentOptions, Attachment, ModelProvider, Session, SessionEvent } from '@github/copilot/sdk';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IEnvService } from '../../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable, DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseThinkingProgressPart, LanguageModelTextPart, Uri } from '../../../../vscodeTypes';
import { IToolsService } from '../../../tools/common/toolsService';
import { CopilotCLIPromptResolver } from './copilotcliPromptResolver';
import { ICopilotCLISessionService } from './copilotcliSessionService';
import { getAffectedUrisForEditTool, processToolExecutionComplete, processToolExecutionStart } from './copilotcliToolInvocationFormatter';
import { getCopilotLogger } from './logger';
import { ensureNodePtyShim } from './nodePtyShim';
import { getConfirmationToolParams, PermissionRequest } from './permissionHelpers';

export class CopilotCLIAgentManager extends Disposable {
	constructor(
		private readonly promptResolver: CopilotCLIPromptResolver,
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

		const { prompt, attachments } = await this.promptResolver.resolvePrompt(request, token);
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
}

export class CopilotCLISession extends Disposable {
	private _abortController = new AbortController();
	private _pendingToolInvocations = new Map<string, vscode.ChatToolInvocationPart>();
	public readonly sessionId: string;
	private _toolsWithPossibleFileEdits = new Map<string, ResourceMap<void>>();
	private _filesEditedByTool = new ResourceMap<string>();
	private _ongoingEdits = new Map<string, { complete: () => void; onDidComplete: Promise<void> }>();
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
		const disposables = new DisposableStore();

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
				return await this.requestPermission(permissionRequest, stream, disposables, toolInvocationToken, token);
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
		} finally {
			disposables.dispose();
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
				this._filesEditedByTool.clear();
				this._toolsWithPossibleFileEdits.clear();
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
				const affectedUris = getAffectedUrisForEditTool(event.data.toolName, event.data.arguments);
				affectedUris.forEach(uri => this._filesEditedByTool.set(uri, event.data.toolCallId));
				this.logService.trace(`Start Tool ${toolName || '<unknown>'}`);
				break;
			}

			case 'tool.execution_complete': {
				const wasEditTool = this._onDidEditTool(event.data.toolCallId);
				const responsePart = processToolExecutionComplete(event, this._pendingToolInvocations);
				if (!wasEditTool && responsePart && !(responsePart instanceof ChatResponseThinkingProgressPart)) {
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

	private async _onWillEditTool(toolId: string, uri: Uri, stream: vscode.ChatResponseStream, disposables: DisposableStore, token: CancellationToken): Promise<unknown> {
		if (!stream.externalEdit) {
			return;
		}

		return new Promise(proceedWithEdit => {
			const deferred = new DeferredPromise<void>();
			const cancelListen = disposables.add(token.onCancellationRequested(() => {
				this._ongoingEdits.delete(toolId);
				deferred.complete();
			}));
			const onDidComplete = Promise.resolve(stream.externalEdit(uri, async () => {
				proceedWithEdit({});
				await deferred.p;
				cancelListen.dispose();
			}));

			this._ongoingEdits.set(toolId, { onDidComplete, complete: () => deferred.complete() });
		});
	}

	private async _onDidEditTool(toolId: string) {
		const ongoingEdit = this._ongoingEdits.get(toolId);
		if (ongoingEdit) {
			ongoingEdit.complete();
			ongoingEdit.onDidComplete.finally(() => {
				this._ongoingEdits.delete(toolId);
			});
			return true;
		}
		return false;
	}

	private async requestPermission(
		permissionRequest: PermissionRequest,
		stream: vscode.ChatResponseStream,
		disposables: DisposableStore,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: CancellationToken
	): Promise<{ kind: 'approved' } | { kind: 'denied-interactively-by-user' }> {
		try {
			const { tool, input } = getConfirmationToolParams(permissionRequest);
			const result = await this.toolsService.invokeTool(tool,
				{ input, toolInvocationToken },
				CancellationToken.None);

			const firstResultPart = result.content.at(0);
			if (firstResultPart instanceof LanguageModelTextPart && firstResultPart.value === 'yes') {
				if (permissionRequest.kind === 'write' && permissionRequest.fileName) {
					const file = Uri.file(permissionRequest.fileName);
					const toolId = this._filesEditedByTool.get(file);
					if (toolId) {
						await this._onWillEditTool(toolId, file, stream, disposables, token);
					}
				}
				return { kind: 'approved' };
			}
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Permission request error: ${error}`);
		}

		return { kind: 'denied-interactively-by-user' };
	}
}
