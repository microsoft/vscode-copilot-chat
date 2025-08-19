/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { DeferredPromise } from '../../../util/vs/base/common/async';
import { Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableMap } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { CodexClient } from './codexProto';

export class CodexAgentManager extends Disposable {
	// TODO Need to have sessionId on ChatRequest to use onDidDisposeChatSession to clean up Codex clients
	private _codexClients = this._register(new DisposableMap<string, CodexClient>());

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IToolsService private readonly toolsService: IToolsService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService
	) {
		super();
	}

	public async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, progress: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const lastEntry = context.history.at(-1);
		const historySessionId: string = lastEntry instanceof vscode.ChatResponseTurn ? lastEntry.result.metadata?.codexSessionId : undefined;

		let codexClient: CodexClient | undefined;
		if (historySessionId) {
			codexClient = this._codexClients.get(historySessionId);
			if (!codexClient) {
				this.logService.warn(`No Codex client found for session ID: ${historySessionId}`);
			}
		}

		const sessionId = historySessionId || generateUuid();
		if (!codexClient) {
			this.logService.info(`Starting new Codex client for session ID: ${sessionId}`);
			codexClient = this.instantiationService.createInstance(CodexClient);
			this._codexClients.set(sessionId, codexClient);

			const configuredP = Event.toPromise(Event.filter(codexClient.onEvent, e => e.msg.type === 'session_configured'));
			// Start Codex if not already started
			const cwd = this.workspaceService.getWorkspaceFolders().at(0)?.fsPath;
			await codexClient.start(cwd || '');
			await configuredP;
		}

		const responseDoneDeferred = new DeferredPromise();
		let eventListener: vscode.Disposable | undefined;
		try {
			// Set up event handling
			eventListener = codexClient.onEvent(async event => {
				const eventMsg = event.msg;
				switch (eventMsg.type) {
					case 'agent_message':
						progress.markdown(eventMsg.message);
						break;
					case 'error':
						progress.markdown(`❌ **Error:** ${eventMsg.message}`);
						break;
					case 'task_started':
						// progress.markdown('🚀 **Task started**');
						break;
					case 'task_complete': {
						// const completedMsg = eventMsg.last_agent_message
						// 	? `✅ **Task completed:** ${eventMsg.last_agent_message}`
						// 	: '✅ **Task completed**';
						// progress.markdown(completedMsg);
						responseDoneDeferred.complete(undefined);
						break;
					}
					case 'token_count':
						// progress.markdown(`📊 **Tokens:** ${eventMsg.total_tokens} total (${eventMsg.input_tokens} input, ${eventMsg.output_tokens} output)`);
						break;
					case 'agent_reasoning':
						progress.markdown(`🧠 **Reasoning:** ${eventMsg.text}`);
						break;
					case 'session_configured':
						// progress.markdown(`⚙️ **Session configured** with model: ${event.model}`);
						break;
					case 'exec_approval_request': {
						const commandStr = eventMsg.command.join(' ');
						// progress.markdown(`⚠️ **Approval needed for command:** \`${commandStr}\``);

						let gotApproval;
						try {
							await this.toolsService.invokeTool(ToolName.ConfirmationTool, { input: { message: 'Run command?', detail: commandStr }, toolInvocationToken: request.toolInvocationToken }, token);
							gotApproval = true;
						} catch (error) {
							this.logService.error(error, 'Codex command approval failed');
							gotApproval = false;
						}
						codexClient.sendExecApproval(gotApproval ? 'approved' : 'denied', event.id);

						break;
					}
					case 'apply_patch_approval_request': {
						const fileCount = Object.keys(eventMsg.changes).length;
						progress.markdown(`📝 **Giving approval for patch:** ${fileCount} file(s) to modify`);
						// Auto-approve for demo purposes
						codexClient.sendPatchApproval('approved', event.id);
						break;
					}
					case 'exec_command_begin': {
						const cmd = eventMsg.command.join(' ');
						progress.markdown(`⚡ **Executing:** \`${cmd}\``);
						break;
					}
					case 'exec_command_end':
						if (eventMsg.exit_code === 0) {
							// progress.markdown('✅ **Command completed successfully**');
						} else {
							// progress.markdown(`❌ **Command failed** (exit code: ${eventMsg.exit_code})`);
						}
						break;
					case 'exec_command_output_delta':
						// progress.markdown(`📜 **Command output:** ${Buffer.from(eventMsg.chunk).toString('utf-8')}`);
						break;
					case 'patch_apply_begin': {
						const changeCount = Object.keys(eventMsg.changes).length;
						progress.markdown(`🔄 **Applying patch** to ${changeCount} file(s)...`);
						break;
					}
					case 'patch_apply_end':
						if (eventMsg.success) {
							progress.markdown('✅ **Patch applied successfully**');
						} else {
							progress.markdown('❌ **Patch failed to apply**');
						}
						break;
					default:
						// Handle any other event types
						progress.markdown(`📢 **Event:** ${JSON.stringify(eventMsg)}`);
						break;
				}
				progress.markdown('\n\n');
			});

			// Clean up event listener when request is cancelled
			token.onCancellationRequested(() => {
				eventListener?.dispose();
			});

			// Send the user's message to Codex
			await codexClient.sendUserInput(request.prompt);

			await responseDoneDeferred.p;
			return {
				metadata: { codexSessionId: sessionId },
			};
		} catch (error) {
			progress.markdown(`❌ **Failed to start Codex:** ${error}`);
			return {};
		} finally {
			// Single-use listener
			eventListener?.dispose();
		}
	}
}