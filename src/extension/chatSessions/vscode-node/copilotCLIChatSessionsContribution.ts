/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, l10n, Uri } from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { localize } from '../../../util/vs/nls';
import { ICopilotCLIModels } from '../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../agents/copilotcli/node/copilotcliSession';
import { ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { ConfirmationResult, CopilotChatSessionsProvider } from './copilotCloudSessionsProvider';

const MODELS_OPTION_ID = 'model';

// Track model selections per session
// TODO@rebornix: we should have proper storage for the session model preference (revisit with API)
const _sessionModel: Map<string, vscode.ChatSessionProviderOptionItem | undefined> = new Map();

namespace SessionIdForCLI {
	export function getResource(sessionId: string): vscode.Uri {
		return vscode.Uri.from({
			scheme: 'copilotcli', path: `/${sessionId}`,
		});
	}

	export function parse(resource: vscode.Uri): string {
		return resource.path.slice(1);
	}
}

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

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
			resource: SessionIdForCLI.getResource(session.id),
			label: session.label,
			tooltip: `Copilot CLI session: ${session.label}`,
			timing: {
				startTime: session.timestamp.getTime()
			},
			status: session.status ?? vscode.ChatSessionStatus.Completed,
		} satisfies vscode.ChatSessionItem));

		if (!token.isCancellationRequested) {
			const count = diskSessions.length;
			vscode.commands.executeCommand('setContext', 'github.copilot.chat.cliSessionsEmpty', count === 0);
		}

		return diskSessions;
	}

	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || 'GitHub Copilot CLI';
		await this.terminalIntegration.openTerminal(terminalName);
	}

	public async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const id = SessionIdForCLI.parse(sessionItem.resource);
		const terminalName = sessionItem.label || id;
		const cliArgs = ['--resume', id];
		await this.terminalIntegration.openTerminal(terminalName, cliArgs);
	}
}

export class CopilotCLIChatSessionContentProvider implements vscode.ChatSessionContentProvider {
	constructor(
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) {
	}

	async provideChatSessionContent(resource: Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const [models, defaultModel] = await Promise.all([
			this.copilotCLIModels.getAvailableModels(),
			this.copilotCLIModels.getDefaultModel()
		]);
		const copilotcliSessionId = SessionIdForCLI.parse(resource);
		const preferredModelId = _sessionModel.get(copilotcliSessionId)?.id;
		const preferredModel = (preferredModelId ? models.find(m => m.id === preferredModelId) : undefined) ?? defaultModel;
		if (!_sessionModel.get(copilotcliSessionId)) {
			_sessionModel.set(copilotcliSessionId, preferredModel);
		}
		const model = this.copilotCLIModels.toModelProvider(preferredModel.id);
		const session = await this.sessionService.getSession(copilotcliSessionId, model, true, token);
		if (!session) {
			return {
				history: [],
				requestHandler: undefined,
				options: {
					[MODELS_OPTION_ID]: defaultModel.id
				}
			};
		}
		const history = await session.getChatHistory();
		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options: {
				[MODELS_OPTION_ID]: _sessionModel.get(copilotcliSessionId)?.id ?? defaultModel.id
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
					items: await this.copilotCLIModels.getAvailableModels()
				}
			]
		};
	}

	// Handle option changes for a session (store current state in a map)
	async provideHandleOptionsChange(resource: Uri, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, token: vscode.CancellationToken) {
		const sessionId = SessionIdForCLI.parse(resource);
		console.log(token.isCancellationRequested);
		const models = await this.copilotCLIModels.getAvailableModels();
		for (const update of updates) {
			if (update.optionId === MODELS_OPTION_ID) {
				if (typeof update.value === 'undefined') {
					_sessionModel.set(sessionId, undefined);
				} else {
					const model = models.find(m => m.id === update.value);
					_sessionModel.set(sessionId, model);
					// Persist the user's choice to global state
					if (model) {
						this.copilotCLIModels.setDefaultModel(model);
					}
				}
			}
		}
	}
}

export class CopilotCLIChatSessionParticipant {
	constructor(
		private readonly cliPromptResolver: CopilotCLIPromptResolver,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
		private readonly cloudSessionProvider: CopilotChatSessionsProvider | undefined,
		private readonly summarizer: ChatSummarizerProvider,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@ILogService private readonly logService: ILogService,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@IGitService private readonly gitService: IGitService,
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		const { chatSessionContext } = context;
		if (!chatSessionContext) {
			if (request.acceptedConfirmationData || request.rejectedConfirmationData) {
				stream.warning(vscode.l10n.t('No chat session context available for confirmation data handling.'));
				return {};
			}

			/* Invoked from a 'normal' chat or 'cloud button' without CLI session context */
			// Handle confirmation data
			return await this.handlePushConfirmationData(request, context, stream, token);
		}
		const defaultModel = await this.copilotCLIModels.getDefaultModel();
		const { resource } = chatSessionContext.chatSessionItem;
		const preferredModel = _sessionModel.get(SessionIdForCLI.parse(resource));
		// For existing sessions we cannot fall back, as the model would info would be updated in _sessionModel
		const modelId = this.copilotCLIModels.toModelProvider(preferredModel?.id || defaultModel.id);

		if (chatSessionContext.isUntitled) {
			const { prompt, attachments } = await this.cliPromptResolver.resolvePrompt(request, token);
			const session = await this.sessionService.createSession(prompt, modelId, token);
			await session.handleRequest(prompt, attachments, request.toolInvocationToken, stream, undefined, token);

			this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { resource: SessionIdForCLI.getResource(session.sessionId), label: request.prompt });
			return {};
		}

		if (!preferredModel) {
			this.logService.error(`No model preference found for CLI session ${SessionIdForCLI.parse(resource)}`);
		}

		const sessionId = SessionIdForCLI.parse(resource);
		const session = await this.sessionService.getSession(sessionId, modelId, false, token);
		if (!session) {
			stream.warning(vscode.l10n.t('Chat session not found.'));
			return {};
		}

		if (request.acceptedConfirmationData || request.rejectedConfirmationData) {
			return await this.handleConfirmationData(session, request, context, stream, token);
		}

		if (request.prompt.startsWith('/delegate')) {
			await this.handleDelegateCommand(session, request, context, stream, token);
			return {};
		}

		const { prompt, attachments } = await this.cliPromptResolver.resolvePrompt(request, token);
		await session.handleRequest(prompt, attachments, request.toolInvocationToken, stream, modelId, token);
		return {};
	}

	private async handleDelegateCommand(session: ICopilotCLISession, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		if (!this.cloudSessionProvider) {
			stream.warning(localize('copilotcli.missingCloudAgent', "No cloud agent available"));
			return;
		}

		// Check for uncommitted changes
		const currentRepository = this.gitService.activeRepository.get();
		const hasChanges = (currentRepository?.changes?.indexChanges && currentRepository.changes.indexChanges.length > 0);
		if (hasChanges) {
			stream.warning(localize('copilotcli.uncommittedChanges', "You have uncommitted changes in your workspace. The cloud agent will start from the last committed state. Consider committing your changes first if you want to include them."));
		}

		const history = await this.summarizer.provideChatSummary(context, token);
		const prompt = request.prompt.substring('/delegate'.length).trim();
		const metadata = { prompt, history, chatContext: context };
		if (!await this.cloudSessionProvider.tryHandleUncommittedChanges(metadata, stream, token)) {
			const prInfo = await this.cloudSessionProvider.createDelegatedChatSession(metadata, stream, token);
			if (prInfo) {
				await this.recordPushToSession(session, request.prompt, prInfo, token);
			}
		}
	}
	private async handleConfirmationData(session: ICopilotCLISession, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		const results: ConfirmationResult[] = [];
		results.push(...(request.acceptedConfirmationData?.map(data => ({ step: data.step, accepted: true, metadata: data?.metadata })) ?? []));
		results.push(...((request.rejectedConfirmationData ?? []).filter(data => !results.some(r => r.step === data.step)).map(data => ({ step: data.step, accepted: false, metadata: data?.metadata }))));

		for (const data of results) {
			switch (data.step) {
				case 'uncommitted-changes':
					{
						if (!data.accepted || !data.metadata) {
							stream.markdown(vscode.l10n.t('Cloud agent delegation request cancelled.'));
							return {};
						}
						const prInfo = await this.cloudSessionProvider?.createDelegatedChatSession({
							prompt: data.metadata.prompt,
							history: data.metadata.history,
							chatContext: context
						}, stream, token);
						if (prInfo) {
							await this.recordPushToSession(session, request.prompt, prInfo, token);
						}
						return {};
					}
				default:
					stream.warning(`Unknown confirmation step: ${data.step}\n\n`);
					break;
			}
		}
		return {};
	}

	private async handlePushConfirmationData(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		const prompt = request.prompt;
		const history = context.chatSummary?.history ?? await this.summarizer.provideChatSummary(context, token);

		const requestPrompt = history ? `${prompt}\n**Summary**\n${history}` : prompt;
		const { sessionId } = await this.sessionService.createSession(requestPrompt, undefined, token);

		await vscode.commands.executeCommand('vscode.open', SessionIdForCLI.getResource(sessionId));
		await vscode.commands.executeCommand('workbench.action.chat.submit', { inputValue: requestPrompt });
		return {};
	}

	private async recordPushToSession(
		session: ICopilotCLISession,
		userPrompt: string,
		prInfo: { uri: string; title: string; description: string; author: string; linkTag: string },
		token: vscode.CancellationToken
	): Promise<void> {
		const assistantMessage = `GitHub Copilot cloud agent has begun working on your request. Follow its progress in the associated chat and pull request.\n<pr_metadata uri="${prInfo.uri}" title="${escapeXml(prInfo.title)}" description="${escapeXml(prInfo.description)}" author="${escapeXml(prInfo.author)}" linkTag="${escapeXml(prInfo.linkTag)}"/>`;

		session.addUserMessage(userPrompt);
		session.addUserAssistantMessage(assistantMessage);
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
		if (sessionItem?.resource) {
			const deleteLabel = l10n.t('Delete');
			const result = await vscode.window.showWarningMessage(
				l10n.t('Are you sure you want to delete the session?'),
				{ modal: true },
				deleteLabel
			);

			if (result === deleteLabel) {
				const id = SessionIdForCLI.parse(sessionItem.resource);
				await copilotCLISessionService.deleteSession(id);
				copilotcliSessionItemProvider.refresh();
			}
		}
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.resumeInTerminal', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.resource) {
			await copilotcliSessionItemProvider.resumeCopilotCLISessionInTerminal(sessionItem);
		}
	}));

	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.newTerminalSession', async () => {
		await copilotcliSessionItemProvider.createCopilotCLITerminal();
	}));
	return disposableStore;
}