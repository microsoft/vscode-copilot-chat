/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, l10n } from 'vscode';
import { isLocation } from '../../../util/common/types';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { localize } from '../../../util/vs/nls';
import { CopilotCLIAgentManager } from '../../agents/copilotcli/node/copilotcliAgentManager';
import { ExtendedChatRequest, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { buildChatHistoryFromEvents, parseChatMessagesToEvents, stripReminders } from '../../agents/copilotcli/node/copilotcliToolInvocationFormatter';
import { ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';

export class CopilotCLIChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {
	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;
	constructor(
		@ICopilotCLISessionService private readonly copilotcliSessionService: ICopilotCLISessionService,
		@ICopilotCLITerminalIntegration private readonly terminalIntegration: ICopilotCLITerminalIntegration,
	) {
		super();
		this._register(this.terminalIntegration);
		this._register(this.copilotcliSessionService.onDidChangeSessions(() => {
			this.refresh();
		}));
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public swap(original: vscode.ChatSessionItem, modified: vscode.ChatSessionItem): void {
		this._onDidCommitChatSessionItem.fire({ original, modified });
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this.copilotcliSessionService.getAllSessions(token);
		const diskSessions = sessions.map(session => ({
			id: session.id,
			label: session.label,
			tooltip: `Copilot CLI session: ${session.label}`,
			timing: {
				startTime: session.timestamp.getTime()
			},
			status: this.copilotcliSessionService.getSessionStatus(session.id) ?? vscode.ChatSessionStatus.Completed,
		} satisfies vscode.ChatSessionItem));

		return diskSessions;
	}

	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || 'Copilot CLI';
		await this.terminalIntegration.openTerminal(terminalName);
	}

	public async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const terminalName = sessionItem.label || sessionItem.id;
		const cliArgs = ['--resume', sessionItem.id];
		await this.terminalIntegration.openTerminal(terminalName, cliArgs);
	}
}

export class CopilotCLIChatSessionContentProvider implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly copilotcliAgentManager: CopilotCLIAgentManager,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) { }

	async provideChatSessionContent(copilotcliSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const existingSession = copilotcliSessionId && await this.sessionService.getSession(copilotcliSessionId, token);
		const sdkSession = existingSession ? existingSession.sdkSession : undefined;
		const chatMessages = sdkSession ? await sdkSession.getChatMessages() : [];
		const events = parseChatMessagesToEvents(chatMessages);

		const history = existingSession ? buildChatHistoryFromEvents(events) : [];

		// Check if there's a pending request for this new session
		const pendingRequest = this.sessionService.getPendingRequest(copilotcliSessionId);

		const activeResponseCallback = pendingRequest
			? async (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
				this.sessionService.clearPendingRequest(copilotcliSessionId);
				this.sessionService.setSessionStatus(copilotcliSessionId, vscode.ChatSessionStatus.InProgress);
				await this.copilotcliAgentManager.handleRequest(
					copilotcliSessionId,
					pendingRequest.request,
					pendingRequest.context,
					stream,
					token
				);
				this.sessionService.setSessionStatus(copilotcliSessionId, vscode.ChatSessionStatus.Completed);
			}
			: undefined;

		// If there's a pending request, add it to the history as the first request turn
		if (pendingRequest) {
			const request = pendingRequest.request;
			const requestTurn = new vscode.ChatRequestTurn2(
				stripReminders(request.prompt),
				undefined,
				[...request.references],
				'',
				[],
				undefined
			);
			history.push(requestTurn);
		}

		return {
			history,
			activeResponseCallback,
			requestHandler: undefined,
		};
	}
}

export class CopilotCLIChatSessionParticipant {
	constructor(
		private readonly sessionType: string,
		private readonly copilotcliAgentManager: CopilotCLIAgentManager,
		private readonly sessionService: ICopilotCLISessionService,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		// Resolve the prompt with references before processing
		const resolvedPrompt = this.resolvePrompt(request);
		const processedRequest: ExtendedChatRequest = { ...request, prompt: resolvedPrompt };

		const { chatSessionContext } = context;
		if (chatSessionContext) {
			if (chatSessionContext.isUntitled) {
				// Create a new session (just get the session ID, don't run the request yet)
				const newSdkSession = await this.sessionService.getOrCreateSDKSession(undefined, processedRequest.prompt);
				const copilotcliSessionId = newSdkSession?.sessionId;
				if (!copilotcliSessionId) {
					stream.warning(localize('copilotcli.failedToCreateSession', "Failed to create a new CopilotCLI session."));
					return {};
				}

				// Store the pending request that will be executed by activeResponseCallback
				this.sessionService.setPendingRequest(copilotcliSessionId, processedRequest, context);

				// Immediately swap to the new session (this will trigger provideChatSessionContent)
				this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { id: copilotcliSessionId, label: processedRequest.prompt ?? 'CopilotCLI' });
				return {};
			}

			const { id } = chatSessionContext.chatSessionItem;
			this.sessionService.setSessionStatus(id, vscode.ChatSessionStatus.InProgress);
			await this.copilotcliAgentManager.handleRequest(id, processedRequest, context, stream, token);
			this.sessionService.setSessionStatus(id, vscode.ChatSessionStatus.Completed);
			return {};
		}

		stream.markdown(localize('copilotcli.viaAtCopilotcli', "Start a new CopilotCLI session"));
		stream.button({ command: `workbench.action.chat.openNewSessionEditor.${this.sessionType}`, title: localize('copilotcli.startNewSession', "Start Session") });
		return {};
	}

	private resolvePrompt(request: vscode.ChatRequest): string {
		if (request.prompt.startsWith('/')) {
			return request.prompt; // likely a slash command, don't modify
		}

		const allRefsTexts: string[] = [];
		const prompt = request.prompt;
		// TODO@rebornix: filter out implicit references for now. Will need to figure out how to support `<reminder>` without poluting user prompt
		request.references.filter(ref => !ref.id.startsWith('vscode.prompt.instructions')).forEach(ref => {
			const valueText = URI.isUri(ref.value) ?
				ref.value.fsPath :
				isLocation(ref.value) ?
					`${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}` :
					undefined;
			if (valueText) {
				// Keep the original prompt untouched, just collect resolved paths
				const variableText = ref.range ? prompt.substring(ref.range[0], ref.range[1]) : undefined;
				if (variableText) {
					allRefsTexts.push(`- ${variableText} → ${valueText}`);
				} else {
					allRefsTexts.push(`- ${valueText}`);
				}
			}
		});

		if (allRefsTexts.length > 0) {
			return `<reminder>\nThe user provided the following references:\n${allRefsTexts.join('\n')}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</reminder>\n\n${prompt}`;
		}

		return prompt;
	}
}

export function registerCLIChatCommands(copilotcliSessionItemProvider: CopilotCLIChatSessionItemProvider, copilotCLISessionService: ICopilotCLISessionService): IDisposable {
	const disposableStore = new DisposableStore();
	disposableStore.add(vscode.commands.registerCommand('github.copilot.copilotcli.sessions.refresh', () => {
		copilotcliSessionItemProvider.refresh();
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.refresh', () => {
		copilotcliSessionItemProvider.refresh();
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.delete', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.id) {
			const deleteLabel = l10n.t('Delete');
			const result = await vscode.window.showWarningMessage(
				l10n.t('Are you sure you want to delete the session?'),
				{ modal: true },
				deleteLabel
			);

			if (result === deleteLabel) {
				await copilotCLISessionService.deleteSession(sessionItem.id);
				copilotcliSessionItemProvider.refresh();
			}
		}
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.resumeInTerminal', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.id) {
			await copilotcliSessionItemProvider.resumeCopilotCLISessionInTerminal(sessionItem);
		}
	}));

	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.newTerminalSession', async () => {
		await copilotcliSessionItemProvider.createCopilotCLITerminal();
	}));
	return disposableStore;
}