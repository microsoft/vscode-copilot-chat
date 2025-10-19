/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, l10n } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { isLocation } from '../../../util/common/types';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { localize } from '../../../util/vs/nls';
import { CopilotCLIAgentManager } from '../../agents/copilotcli/node/copilotcliAgentManager';
import { ExtendedChatRequest, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { buildChatHistoryFromEvents } from '../../agents/copilotcli/node/copilotcliToolInvocationFormatter';
import { ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';

const MODELS_OPTION_ID = 'model';

// Track model selections per session
// TODO@rebornix: we should have proper storage for the session model preference (revisit with API)
const _sessionModel: Map<string, vscode.ChatSessionProviderOptionItem | undefined> = new Map();

/**
 * Convert a model ID to a ModelProvider object for the Copilot CLI SDK
 */
function getModelProvider(modelId: string | undefined): { type: 'anthropic' | 'openai'; model: string } | undefined {
	if (!modelId) {
		return undefined;
	}

	// Map model IDs to their provider and model name
	if (modelId.startsWith('claude-')) {
		return {
			type: 'anthropic',
			model: modelId
		};
	} else if (modelId.startsWith('gpt-')) {
		return {
			type: 'openai',
			model: modelId
		};
	}

	return undefined;
}

const COPILOT_CLI_MODEL_MEMENTO_KEY = 'github.copilot.cli.sessionModel';

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
		const diskSessions = sessions.filter(session => !this.copilotcliSessionService.isPendingRequest(session.id) && !session.isEmpty).map(session => ({
			id: session.id,
			resource: undefined,
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
	private readonly availableModels: vscode.ChatSessionProviderOptionItem[] = [
		{
			id: 'claude-sonnet-4.5',
			name: 'Claude Sonnet 4.5'
		},
		{
			id: 'claude-sonnet-4',
			name: 'Claude Sonnet 4'
		},
		{
			id: 'gpt-5',
			name: 'GPT-5'
		}
	];

	private get defaultModel(): vscode.ChatSessionProviderOptionItem {
		return this.availableModels[0];
	}

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) { }

	async provideChatSessionContent(copilotcliSessionId: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		if (!_sessionModel.get(copilotcliSessionId)) {
			// Get the user's preferred model from global state, default to claude-sonnet-4.5
			const preferredModelId = this.extensionContext.globalState.get<string>(COPILOT_CLI_MODEL_MEMENTO_KEY, this.defaultModel.id);
			const preferredModel = this.availableModels.find(m => m.id === preferredModelId) ?? this.defaultModel; // fallback to claude-sonnet-4.5
			_sessionModel.set(copilotcliSessionId, preferredModel);
		}

		const existingSession = await this.sessionService.getSession(copilotcliSessionId, token);
		const events = await existingSession?.sdkSession.getEvents();
		const history = buildChatHistoryFromEvents(events || []);

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options: {
				[MODELS_OPTION_ID]: _sessionModel.get(copilotcliSessionId)?.id ?? this.defaultModel.id
			}
		};
	}

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		return {
			optionGroups: [
				{
					id: MODELS_OPTION_ID,
					name: 'Model',
					description: 'Select the language model to use',
					items: this.availableModels
				}
			]
		};
	}

	// Handle option changes for a session (store current state in a map)
	provideHandleOptionsChange(sessionId: string, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, token: vscode.CancellationToken): void {
		for (const update of updates) {
			if (update.optionId === MODELS_OPTION_ID) {
				if (typeof update.value === 'undefined') {
					_sessionModel.set(sessionId, undefined);
				} else {
					const model = this.availableModels.find(m => m.id === update.value);
					_sessionModel.set(sessionId, model);
					// Persist the user's choice to global state
					if (model) {
						this.extensionContext.globalState.update(COPILOT_CLI_MODEL_MEMENTO_KEY, model.id);
					}
				}
			}
		}
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
				const { copilotcliSessionId } = await this.copilotcliAgentManager.handleRequest(undefined, processedRequest, context, stream, undefined, token);
				if (!copilotcliSessionId) {
					stream.warning(localize('copilotcli.failedToCreateSession', "Failed to create a new CopilotCLI session."));
					return {};
				}
				if (copilotcliSessionId) {
					this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { id: copilotcliSessionId, resource: undefined, label: processedRequest.prompt ?? 'CopilotCLI' });
					this.sessionService.clearPendingRequest(copilotcliSessionId);
				}
				return {};
			}

			const { id } = chatSessionContext.chatSessionItem;
			this.sessionService.setSessionStatus(id, vscode.ChatSessionStatus.InProgress);
			await this.copilotcliAgentManager.handleRequest(id, processedRequest, context, stream, getModelProvider(_sessionModel.get(id)?.id), token);
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