/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, l10n, Uri } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitService } from '../../../platform/git/common/gitService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { localize } from '../../../util/vs/nls';
import { CopilotCLIAgentManager } from '../../agents/copilotcli/node/copilotcliAgentManager';
import { ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { buildChatHistoryFromEvents } from '../../agents/copilotcli/node/copilotcliToolInvocationFormatter';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { ConfirmationResult, CopilotChatSessionsProvider } from './copilotCloudSessionsProvider';

const MODELS_OPTION_ID = 'model';
const ISOLATION_OPTION_ID = 'isolation';

// Track model selections per session
// TODO@rebornix: we should have proper storage for the session model preference (revisit with API)
const _sessionModel: Map<string, vscode.ChatSessionProviderOptionItem | undefined> = new Map();

// Track isolation settings per session
const _sessionIsolation: Map<string, boolean> = new Map();

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

const COPILOT_CLI_MODEL_MEMENTO_KEY = 'github.copilot.cli.sessionModel';
const COPILOT_CLI_ISOLATION_MEMENTO_KEY = 'github.copilot.cli.sessionIsolation.';

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
			resource: SessionIdForCLI.getResource(session.id),
			label: session.label,
			tooltip: `Copilot CLI session: ${session.label}`,
			timing: {
				startTime: session.timestamp.getTime()
			},
			status: this.copilotcliSessionService.getSessionStatus(session.id) ?? vscode.ChatSessionStatus.Completed,
		} satisfies vscode.ChatSessionItem));

		const count = diskSessions.length;
		vscode.commands.executeCommand('setContext', 'github.copilot.chat.cliSessionsEmpty', count === 0);

		return diskSessions;
	}

	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || 'Copilot CLI';
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
		@IConfigurationService private readonly configurationService: IConfigurationService
	) { }

	/**
	 * Check if isolation is enabled for a session
	 */
	public isIsolationEnabled(sessionId: string): boolean {
		return _sessionIsolation.get(sessionId) ?? false;
	}

	async provideChatSessionContent(resource: Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const copilotcliSessionId = SessionIdForCLI.parse(resource);
		if (!_sessionModel.get(copilotcliSessionId)) {
			// Get the user's preferred model from global state, default to claude-sonnet-4.5
			const preferredModelId = this.extensionContext.globalState.get<string>(COPILOT_CLI_MODEL_MEMENTO_KEY, this.defaultModel.id);
			const preferredModel = this.availableModels.find(m => m.id === preferredModelId) ?? this.defaultModel; // fallback to claude-sonnet-4.5
			_sessionModel.set(copilotcliSessionId, preferredModel);

			// Get the user's preferred isolation setting from global state, default to disabled
			const isolationEnabled = this.extensionContext.globalState.get<boolean>(COPILOT_CLI_ISOLATION_MEMENTO_KEY, false);
			_sessionIsolation.set(copilotcliSessionId, isolationEnabled);
		}

		const existingSession = await this.sessionService.getSession(copilotcliSessionId, token);
		const events = await existingSession?.sdkSession.getEvents();
		const history = buildChatHistoryFromEvents(events || []);
		const options: Record<string, string> = {
			[MODELS_OPTION_ID]: _sessionModel.get(copilotcliSessionId)?.id ?? this.defaultModel.id,
		};

		if (!existingSession && this.configurationService.getConfig(ConfigKey.Internal.CLIIsolationEnabled)) {
			options[ISOLATION_OPTION_ID] = this.isIsolationEnabled(copilotcliSessionId) ? 'enabled' : 'disabled';
		}

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options: options
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
				},
				{
					id: ISOLATION_OPTION_ID,
					name: 'Isolation',
					description: 'Enable worktree isolation for this session',
					items: [
						{ id: 'enabled', name: 'Isolated' },
						{ id: 'disabled', name: 'Workspace' }
					]
				}
			]
		};
	}

	// Handle option changes for a session (store current state in a map)
	provideHandleOptionsChange(resource: Uri, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, token: vscode.CancellationToken): void {
		const sessionId = SessionIdForCLI.parse(resource);
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
			} else if (update.optionId === ISOLATION_OPTION_ID) {
				// Handle isolation option changes
				if (update.value === 'enabled') {
					_sessionIsolation.set(sessionId, true);
				} else {
					_sessionIsolation.set(sessionId, false);
				}
			}
		}
	}
}

export class CopilotCLIChatSessionParticipant {
	constructor(
		private readonly copilotcliAgentManager: CopilotCLIAgentManager,
		private readonly sessionService: ICopilotCLISessionService,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
		private readonly cloudSessionProvider: CopilotChatSessionsProvider | undefined,
		private readonly summarizer: ChatSummarizerProvider,
		@IGitService private readonly gitService: IGitService
	) { }

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		if (request.acceptedConfirmationData || request.rejectedConfirmationData) {
			return await this.handleConfirmationData(request, context, stream, token);
		}

		const { chatSessionContext } = context;
		if (chatSessionContext) {
			if (chatSessionContext.isUntitled) {
				const untitledCopilotcliSessionId = SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource);
				const isolationEnabled = _sessionIsolation.get(untitledCopilotcliSessionId) ?? false;
				let workingDirectory: string | undefined;
				if (isolationEnabled) {
					try {
						const worktreePath = await vscode.commands.executeCommand('git.createWorktreeWithDefaults') as string | undefined;
						if (worktreePath) {
							workingDirectory = worktreePath;
							stream.progress(vscode.l10n.t('Created isolated worktree at {0}', worktreePath));
						} else {
							stream.warning(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory'));
						}
					} catch (error) {
						stream.warning(vscode.l10n.t('Error creating worktree for isolation: {0}', error instanceof Error ? error.message : String(error)));
					}
				}

				const { copilotcliSessionId } = await this.copilotcliAgentManager.handleRequest(undefined, request, context, stream, undefined, workingDirectory, token);
				if (!copilotcliSessionId) {
					stream.warning(localize('copilotcli.failedToCreateSession', "Failed to create a new CopilotCLI session."));
					return {};
				}
				if (copilotcliSessionId) {
					this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { resource: SessionIdForCLI.getResource(copilotcliSessionId), label: request.prompt ?? 'CopilotCLI' });
					this.sessionService.clearPendingRequest(copilotcliSessionId);
				}
				return {};
			}

			const { resource } = chatSessionContext.chatSessionItem;
			const id = SessionIdForCLI.parse(resource);

			if (request.prompt.startsWith('/delegate')) {
				if (!this.cloudSessionProvider) {
					stream.warning(localize('copilotcli.missingCloudAgent', "No cloud agent available"));
					return {};
				}

				// Check for uncommitted changes
				const currentRepository = this.gitService.activeRepository.get();
				const hasChanges = (currentRepository?.changes?.indexChanges && currentRepository.changes.indexChanges.length > 0);

				if (hasChanges) {
					stream.warning(localize('copilotcli.uncommittedChanges', "You have uncommitted changes in your workspace. The cloud agent will start from the last committed state. Consider committing your changes first if you want to include them."));
				}

				const history = await this.summarizer.provideChatSummary(context, token);
				const prompt = request.prompt.substring('/delegate'.length).trim();
				if (!await this.cloudSessionProvider.tryHandleUncommittedChanges({
					prompt: prompt,
					history: history,
					chatContext: context
				}, stream, token)) {
					const prInfo = await this.cloudSessionProvider.createDelegatedChatSession({
						prompt,
						history,
						chatContext: context
					}, stream, token);
					if (prInfo) {
						await this.recordPushToSession(id, request.prompt, prInfo, token);
					}
					return {};
				} else {
					return {};
				}
			}

			this.sessionService.setSessionStatus(id, vscode.ChatSessionStatus.InProgress);
			await this.copilotcliAgentManager.handleRequest(id, request, context, stream, getModelProvider(_sessionModel.get(id)?.id), undefined, token);
			this.sessionService.setSessionStatus(id, vscode.ChatSessionStatus.Completed);
			return {};
		}

		/* Invoked from a 'normal' chat or 'cloud button' without CLI session context */
		// Handle confirmation data
		return await this.handlePushConfirmationData(request, context, stream, token);
	}

	private async handleConfirmationData(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		const results: ConfirmationResult[] = [];
		results.push(...(request.acceptedConfirmationData?.map(data => ({ step: data.step, accepted: true, metadata: data?.metadata })) ?? []));
		results.push(...((request.rejectedConfirmationData ?? []).filter(data => !results.some(r => r.step === data.step)).map(data => ({ step: data.step, accepted: false, metadata: data?.metadata }))));
		const { chatSessionContext } = context;
		if (!chatSessionContext) {
			stream.warning(vscode.l10n.t('No chat session context available for confirmation data handling.'));
			return {};
		}

		const { resource } = chatSessionContext.chatSessionItem;
		const id = SessionIdForCLI.parse(resource);
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
							await this.recordPushToSession(id, request.prompt, prInfo, token);
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
		const sdkSession = await this.sessionService.getOrCreateSDKSession(undefined, requestPrompt);

		await vscode.commands.executeCommand('vscode.open', SessionIdForCLI.getResource(sdkSession.sessionId));
		await vscode.commands.executeCommand('workbench.action.chat.submit', { inputValue: requestPrompt });
		return {};
	}

	private async recordPushToSession(
		sessionId: string,
		userPrompt: string,
		prInfo: { uri: string; title: string; description: string; author: string; linkTag: string },
		token: vscode.CancellationToken
	): Promise<void> {
		const session = await this.sessionService.getSession(sessionId, token);
		if (!session) {
			return;
		}

		// Add user message event
		session.sdkSession.addEvent({
			type: 'user.message',
			data: {
				content: userPrompt
			}
		});

		// Add assistant message event with embedded PR metadata
		const assistantMessage = `GitHub Copilot cloud agent has begun working on your request. Follow its progress in the associated chat and pull request.\n<pr_metadata uri="${prInfo.uri}" title="${escapeXml(prInfo.title)}" description="${escapeXml(prInfo.description)}" author="${escapeXml(prInfo.author)}" linkTag="${escapeXml(prInfo.linkTag)}"/>`;
		session.sdkSession.addEvent({
			type: 'assistant.message',
			data: {
				messageId: `msg_${Date.now()}`,
				content: assistantMessage
			}
		});
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