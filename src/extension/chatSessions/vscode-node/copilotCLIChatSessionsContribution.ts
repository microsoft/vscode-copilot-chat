/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SweCustomAgent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, Uri } from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitService } from '../../../platform/git/common/gitService';
import { toGitUri } from '../../../platform/git/common/utils';
import { ILogService } from '../../../platform/log/common/logService';
import { ParsedPromptFile, PromptFileParser } from '../../../platform/promptFiles/common/promptsService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { disposableTimeout } from '../../../util/vs/base/common/async';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable, IReference } from '../../../util/vs/base/common/lifecycle';
import { isEqual } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ToolCall } from '../../agents/copilotcli/common/copilotCLITools';
import { COPILOT_CLI_DEFAULT_AGENT_ID, ICopilotCLIAgents, ICopilotCLIModels, ICopilotCLISDK } from '../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../agents/copilotcli/node/copilotcliSession';
import { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { PermissionRequest, requestPermission } from '../../agents/copilotcli/node/permissionHelpers';
import { ChatVariablesCollection, isPromptFile } from '../../prompt/common/chatVariablesCollection';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { IToolsService } from '../../tools/common/toolsService';
import { ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { CopilotCloudSessionsProvider } from './copilotCloudSessionsProvider';

const AGENTS_OPTION_ID = 'agent';
const MODELS_OPTION_ID = 'model';
const ISOLATION_OPTION_ID = 'isolation';

const UncommittedChangesStep = 'uncommitted-changes';
type ConfirmationResult = { step: string; accepted: boolean; metadata?: CLIConfirmationMetadata };
interface CLIConfirmationMetadata {
	prompt: string;
	references?: readonly vscode.ChatPromptReference[];
	chatContext: vscode.ChatContext;
}

// Track model selections per session
// TODO@rebornix: we should have proper storage for the session model preference (revisit with API)
const _sessionModel: Map<string, vscode.ChatSessionProviderOptionItem | undefined> = new Map();

export class CopilotCLIWorktreeManager {
	static COPILOT_CLI_DEFAULT_ISOLATION_MEMENTO_KEY = 'github.copilot.cli.sessionIsolation';
	static COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';

	private _sessionIsolation: Map<string, boolean> = new Map();
	private _sessionWorktrees: Map<string, string> = new Map();
	constructor(
		@IGitService private readonly gitService: IGitService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	async createWorktree(stream?: vscode.ChatResponseStream): Promise<string | undefined> {
		if (!stream) {
			return this.tryCreateWorktree();
		}

		return new Promise<string | undefined>((resolve) => {
			stream.progress(vscode.l10n.t('Creating isolated worktree for Copilot CLI session...'), async progress => {
				const result = await this.tryCreateWorktree(progress);
				resolve(result);
				if (result) {
					return vscode.l10n.t('Created isolated worktree at {0}', result);
				}
				return undefined;
			});
		});
	}

	private async tryCreateWorktree(progress?: vscode.Progress<vscode.ChatResponsePart>): Promise<string | undefined> {
		try {
			const repository = this.gitService.activeRepository.get();
			if (!repository) {
				progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory')));
				return undefined;
			}
			const worktreePath = await this.gitService.createWorktree(repository.rootUri);
			if (worktreePath) {
				return worktreePath;
			}
			progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory')));
			return undefined;
		} catch (error) {
			progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Error creating worktree for isolation: {0}', error instanceof Error ? error.message : String(error))));
			return undefined;
		}
	}

	async storeWorktreePath(sessionId: string, workingDirectory: string): Promise<void> {
		this._sessionWorktrees.set(sessionId, workingDirectory);
		const sessionWorktrees = this.extensionContext.globalState.get<Record<string, string>>(CopilotCLIWorktreeManager.COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY, {});
		sessionWorktrees[sessionId] = workingDirectory;
		await this.extensionContext.globalState.update(CopilotCLIWorktreeManager.COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY, sessionWorktrees);
	}

	getWorktreePath(sessionId: string): string | undefined {
		let workingDirectory = this._sessionWorktrees.get(sessionId);
		if (!workingDirectory) {
			const sessionWorktrees = this.extensionContext.globalState.get<Record<string, string>>(CopilotCLIWorktreeManager.COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY, {});
			workingDirectory = sessionWorktrees[sessionId];
			if (workingDirectory) {
				this._sessionWorktrees.set(sessionId, workingDirectory);
			}
		}
		return workingDirectory;
	}

	getWorktreeRelativePath(sessionId: string): string | undefined {
		const worktreePath = this.getWorktreePath(sessionId);
		if (!worktreePath) {
			return undefined;
		}

		// TODO@rebornix, @osortega: read the workingtree name from git extension
		const lastIndex = worktreePath.lastIndexOf('/');
		return worktreePath.substring(lastIndex + 1);

	}

	getDefaultIsolationPreference(): boolean {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLIIsolationEnabled)) {
			return false;
		}
		return this.extensionContext.globalState.get<boolean>(CopilotCLIWorktreeManager.COPILOT_CLI_DEFAULT_ISOLATION_MEMENTO_KEY, false);
	}

	getIsolationPreference(sessionId: string): boolean {
		if (!this._sessionIsolation.has(sessionId)) {
			const defaultIsolation = this.getDefaultIsolationPreference();
			this._sessionIsolation.set(sessionId, defaultIsolation);
		}
		return this._sessionIsolation.get(sessionId) ?? false;
	}

	async setIsolationPreference(sessionId: string, enabled: boolean): Promise<void> {
		this._sessionIsolation.set(sessionId, enabled);
		await this.extensionContext.globalState.update(CopilotCLIWorktreeManager.COPILOT_CLI_DEFAULT_ISOLATION_MEMENTO_KEY, enabled);
	}
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
		readonly worktreeManager: CopilotCLIWorktreeManager,
		@ICopilotCLISessionService private readonly copilotcliSessionService: ICopilotCLISessionService,
		@ICopilotCLITerminalIntegration private readonly terminalIntegration: ICopilotCLITerminalIntegration,
		@IGitService private readonly gitService: IGitService,
		@IRunCommandExecutionService private readonly commandExecutionService: IRunCommandExecutionService,
	) {
		super();
		this._register(this.terminalIntegration);
		this._register(this.copilotcliSessionService.onDidChangeSessions(() => {
			this.notifySessionsChange();
		}));
	}

	public notifySessionsChange(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public swap(original: vscode.ChatSessionItem, modified: vscode.ChatSessionItem): void {
		this._onDidCommitChatSessionItem.fire({ original, modified });
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this.copilotcliSessionService.getAllSessions(token);
		const diskSessions = await Promise.all(sessions.map(async session => this._toChatSessionItem(session)));

		const count = diskSessions.length;
		this.commandExecutionService.executeCommand('setContext', 'github.copilot.chat.cliSessionsEmpty', count === 0);

		return diskSessions;
	}

	private async _toChatSessionItem(session: ICopilotCLISessionItem): Promise<vscode.ChatSessionItem> {
		const resource = SessionIdForCLI.getResource(session.id);
		const worktreePath = this.worktreeManager.getWorktreePath(session.id);
		const worktreeRelativePath = this.worktreeManager.getWorktreeRelativePath(session.id);

		const label = session.label;
		const tooltipLines = [vscode.l10n.t(`Background agent session: {0}`, label)];
		let description: vscode.MarkdownString | undefined;
		let statistics: { files: number; insertions: number; deletions: number } | undefined;

		if (worktreePath && worktreeRelativePath) {
			// Description
			description = new vscode.MarkdownString(`$(list-tree) ${worktreeRelativePath}`);
			description.supportThemeIcons = true;

			// Tooltip
			tooltipLines.push(vscode.l10n.t(`Worktree: {0}`, worktreeRelativePath));

			// Statistics
			statistics = await this.gitService.diffIndexWithHEADShortStats(Uri.file(worktreePath));
		}
		const status = session.status ?? vscode.ChatSessionStatus.Completed;

		return {
			resource,
			label,
			description,
			tooltip: tooltipLines.join('\n'),
			timing: session.timing,
			statistics,
			status
		} satisfies vscode.ChatSessionItem;
	}

	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || vscode.l10n.t('Copilot CLI');
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
		private readonly worktreeManager: CopilotCLIWorktreeManager,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	async provideChatSessionContent(resource: Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const copilotcliSessionId = SessionIdForCLI.parse(resource);
		const [models, defaultModel, sessionAgent, defaultAgent] = await Promise.all([
			this.copilotCLIModels.getAvailableModels(),
			this.copilotCLIModels.getDefaultModel(),
			this.copilotCLIAgents.getSessionAgent(copilotcliSessionId),
			this.copilotCLIAgents.getDefaultAgent()
		]);
		const isUntitled = copilotcliSessionId.startsWith('untitled-');
		const preferredModelId = _sessionModel.get(copilotcliSessionId)?.id ?? defaultModel?.id;

		const workingDirectoryValue = this.worktreeManager.getWorktreePath(copilotcliSessionId);
		const workingDirectory = workingDirectoryValue ? URI.file(workingDirectoryValue) : undefined;
		const isolationEnabled = this.worktreeManager.getIsolationPreference(copilotcliSessionId);
		const existingSession = isUntitled ? undefined : await this.sessionService.getSession(copilotcliSessionId, { workingDirectory, isolationEnabled, readonly: true }, token);
		const selectedModelId = (await existingSession?.object?.getSelectedModelId()) ?? preferredModelId;
		const selectedModel = selectedModelId ? models.find(m => m.id === selectedModelId) : undefined;
		const options: Record<string, string | vscode.ChatSessionProviderOptionItem> = {};

		options[AGENTS_OPTION_ID] = sessionAgent ?? defaultAgent;

		if (preferredModelId) {
			options[MODELS_OPTION_ID] = preferredModelId;
		}

		if (!existingSession && this.configurationService.getConfig(ConfigKey.Advanced.CLIIsolationEnabled)) {
			options[ISOLATION_OPTION_ID] = isolationEnabled ? 'enabled' : 'disabled';
		} else if (existingSession && workingDirectory && this.configurationService.getConfig(ConfigKey.Advanced.CLIIsolationEnabled)) {
			// For existing sessions with a worktree, show the worktree branch name as a locked option
			const worktreeRelativePath = this.worktreeManager.getWorktreeRelativePath(copilotcliSessionId);
			if (worktreeRelativePath) {
				options[ISOLATION_OPTION_ID] = {
					id: 'enabled',
					name: worktreeRelativePath,
					locked: true,
					icon: new vscode.ThemeIcon('git-branch')
				};
			}
		}
		const history = existingSession?.object?.getChatHistory() || [];
		existingSession?.dispose();
		if (!_sessionModel.get(copilotcliSessionId) && selectedModel) {
			_sessionModel.set(copilotcliSessionId, selectedModel);
		}

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options: options
		};
	}

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		const isolationItems = [
			{ id: 'enabled', name: 'Isolated' },
			{ id: 'disabled', name: 'Workspace' }
		];

		const [models, agents] = await Promise.all([
			this.copilotCLIModels.getAvailableModels(),
			this.copilotCLIAgents.getAgents()
		]);
		const agentItems: vscode.ChatSessionProviderOptionItem[] = [
			{ id: COPILOT_CLI_DEFAULT_AGENT_ID, name: l10n.t('Agent') }
		];
		agents.forEach(agent => {
			agentItems.push({ id: agent.name, name: agent.displayName || agent.description || agent.name });
		});

		return {
			optionGroups: [
				{
					id: AGENTS_OPTION_ID,
					name: 'Agent',
					description: 'Set Agent',
					items: agentItems
				},
				{
					id: MODELS_OPTION_ID,
					name: 'Model',
					description: 'Pick Model',
					items: models
				},
				{
					id: ISOLATION_OPTION_ID,
					name: 'Isolation',
					description: 'Enable worktree isolation for this session',
					items: isolationItems
				}
			]
		};
	}

	// Handle option changes for a session (store current state in a map)
	async provideHandleOptionsChange(resource: Uri, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, token: vscode.CancellationToken): Promise<void> {
		const sessionId = SessionIdForCLI.parse(resource);
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
			} else if (update.optionId === AGENTS_OPTION_ID) {
				this.copilotCLIAgents.setDefaultAgent(update.value);
				this.copilotCLIAgents.trackSessionAgent(sessionId, update.value);
			} else if (update.optionId === ISOLATION_OPTION_ID) {
				// Handle isolation option changes
				await this.worktreeManager.setIsolationPreference(sessionId, update.value === 'enabled');
			}
		}
	}
}

const WAIT_FOR_NEW_SESSION_TO_GET_USED = 5 * 60 * 1000; // 5 minutes

export class CopilotCLIChatSessionParticipant extends Disposable {
	private CLI_INCLUDE_CHANGES = vscode.l10n.t('Include Changes');
	private CLI_SKIP_CHANGES = vscode.l10n.t('Skip Changes');
	private CLI_CANCEL = vscode.l10n.t('Cancel');

	constructor(
		private readonly promptResolver: CopilotCLIPromptResolver,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
		private readonly cloudSessionProvider: CopilotCloudSessionsProvider | undefined,
		private readonly summarizer: ChatSummarizerProvider,
		private readonly worktreeManager: CopilotCLIWorktreeManager,
		@IGitService private readonly gitService: IGitService,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IToolsService private readonly toolsService: IToolsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		super();
	}

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private readonly previousReferences = new Map<string, vscode.ChatPromptReference[]>();
	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		const { chatSessionContext } = context;
		const disposables = new DisposableStore();
		try {

			/* __GDPR__
				"copilotcli.chat.invoke" : {
					"owner": "joshspicer",
					"comment": "Event sent when a CopilotCLI chat request is made.",
					"hasChatSessionItem": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Invoked with a chat session item." },
					"isUntitled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Indicates if the chat session is untitled." },
					"hasDelegatePrompt": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Indicates if the prompt is a /delegate command." }
				}
			*/
			this.telemetryService.sendMSFTTelemetryEvent('copilotcli.chat.invoke', {
				hasChatSessionItem: String(!!chatSessionContext?.chatSessionItem),
				isUntitled: String(chatSessionContext?.isUntitled),
				hasDelegatePrompt: String(request.prompt.startsWith('/delegate'))
			});

			const confirmationResults = this.getAcceptedRejectedConfirmationData(request);
			if (!chatSessionContext) {
				// Invoked from a 'normal' chat or 'cloud button' without CLI session context
				// Or cases such as delegating from Regular chat to CLI chat
				// Handle confirmation data
				return await this.handlePushConfirmationData(request, context, stream, token);
			}

			const isUntitled = chatSessionContext.isUntitled;
			const { resource } = chatSessionContext.chatSessionItem;
			const id = SessionIdForCLI.parse(resource);
			const additionalReferences = this.previousReferences.get(id) || [];
			this.previousReferences.delete(id);
			const [modelId, agent] = await Promise.all([
				this.getModelId(id, request),
				this.getAgent(id, request),
			]);
			const session = await this.getOrCreateSession(request, chatSessionContext, modelId, agent, stream, disposables, token);
			if (!session || token.isCancellationRequested) {
				return {};
			}
			this.copilotCLIAgents.trackSessionAgent(session.object.sessionId, agent?.name);
			if (isUntitled) {
				// The SDK doesn't save the session as no messages were added,
				// If we dispose this here, then we will not be able to find this session later.
				// So leave this session alive till it gets used using the `getSession` API later
				this._register(disposableTimeout(() => session.dispose(), WAIT_FOR_NEW_SESSION_TO_GET_USED));
			} else {
				disposables.add(session);
			}

			if (!isUntitled && confirmationResults.length) {
				return await this.handleConfirmationData(request, session.object, request.prompt, confirmationResults, context, stream, token);
			}

			if (request.prompt.startsWith('/delegate')) {
				await this.handleDelegateCommand(session.object, request, context, stream, token);
			} else {
				// Construct the full prompt with references to be sent to CLI.
				const { prompt, attachments } = await this.promptResolver.resolvePrompt(request, undefined, additionalReferences, session.object.options.isolationEnabled, token);
				await session.object.handleRequest(request.id, prompt, attachments, modelId, token);
			}

			if (isUntitled && !token.isCancellationRequested) {
				this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { resource: SessionIdForCLI.getResource(session.object.sessionId), label: request.prompt ?? 'CopilotCLI' });
			}
			return {};
		} catch (ex) {
			if (isCancellationError(ex)) {
				return {};
			}
			throw ex;
		}
		finally {
			disposables.dispose();
		}
	}

	/**
	 * Gets the agent to be used.
	 * If creating a new session, then uses the agent configured in settings.
	 * If opening an existing session, then uses the agent associated with that session.
	 * If creating a new session with a prompt file that specifies an agent, then uses that agent.
	 */
	private async getAgent(sessionId: string | undefined, request: vscode.ChatRequest | undefined): Promise<SweCustomAgent | undefined> {
		const promptFile = request ? await this.getPromptInfoFromRequest(request) : undefined;
		if (promptFile?.header?.agent) {
			const agent = await this.copilotCLIAgents.resolveAgent(promptFile.header.agent);
			if (agent) {
				return agent;
			}
		}

		const [sessionAgent, defaultAgent] = await Promise.all([
			sessionId ? this.copilotCLIAgents.getSessionAgent(sessionId) : Promise.resolve(undefined),
			this.copilotCLIAgents.getDefaultAgent()
		]);
		return this.copilotCLIAgents.resolveAgent(sessionAgent ?? defaultAgent);
	}

	private async getPromptInfoFromRequest(request: vscode.ChatRequest): Promise<ParsedPromptFile | undefined> {
		const promptFile = new ChatVariablesCollection(request.references).find(isPromptFile);
		if (!promptFile || !URI.isUri(promptFile.reference.value)) {
			return undefined;
		}
		try {
			const doc = await this.workspaceService.openTextDocument(promptFile.reference.value);
			return new PromptFileParser().parse(promptFile.reference.value, doc.getText());
		} catch (ex) {
			this.logService.error(`Failed to parse the prompt file: ${promptFile.reference.value.toString()}`, ex);
			return undefined;
		}
	}

	private async getOrCreateSession(request: vscode.ChatRequest, chatSessionContext: vscode.ChatSessionContext, model: string | undefined, agent: SweCustomAgent | undefined, stream: vscode.ChatResponseStream, disposables: DisposableStore, token: vscode.CancellationToken): Promise<IReference<ICopilotCLISession> | undefined> {
		const { resource } = chatSessionContext.chatSessionItem;
		const id = SessionIdForCLI.parse(resource);

		const isolationEnabled = this.worktreeManager.getIsolationPreference(id);
		const workingDirectoryValue = chatSessionContext.isUntitled ?
			(isolationEnabled ? await this.worktreeManager.createWorktree(stream) : await this.copilotCLISDK.getDefaultWorkingDirectory().then(dir => dir?.fsPath)) :
			this.worktreeManager.getWorktreePath(id);
		const workingDirectory = workingDirectoryValue ? Uri.file(workingDirectoryValue) : undefined;

		const session = chatSessionContext.isUntitled ?
			await this.sessionService.createSession({ model, workingDirectory, isolationEnabled, agent }, token) :
			await this.sessionService.getSession(id, { model, workingDirectory, isolationEnabled, readonly: false, agent }, token);
		this.sessionItemProvider.notifySessionsChange();

		if (!session) {
			stream.warning(vscode.l10n.t('Chat session not found.'));
			return undefined;
		}

		if (chatSessionContext.isUntitled && workingDirectory && isolationEnabled) {
			await this.worktreeManager.storeWorktreePath(session.object.sessionId, workingDirectory.fsPath);
		}
		disposables.add(session.object.attachStream(stream));
		disposables.add(session.object.attachPermissionHandler(async (permissionRequest: PermissionRequest, toolCall: ToolCall | undefined, token: vscode.CancellationToken) => requestPermission(this.instantiationService, permissionRequest, toolCall, this.toolsService, request.toolInvocationToken, token)));


		return session;
	}

	private async getModelId(sessionId: string | undefined, request: vscode.ChatRequest | undefined): Promise<string | undefined> {
		const promptFile = request ? await this.getPromptInfoFromRequest(request) : undefined;
		const modelId = promptFile?.header?.model;
		if (modelId) {
			const models = await this.copilotCLIModels.getAvailableModels();
			const model = models.find(m => m.id === modelId);
			if (model) {
				return model.id;
			}
		}

		const preferredModelId = (sessionId ? _sessionModel.get(sessionId)?.id : undefined) ?? (await this.copilotCLIModels.getDefaultModel())?.id;
		return preferredModelId ? this.copilotCLIModels.toModelProvider(preferredModelId) : undefined;
	}

	private async handleDelegateCommand(session: ICopilotCLISession, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		if (!this.cloudSessionProvider) {
			stream.warning(vscode.l10n.t('No cloud agent available'));
			return;
		}

		// Check for uncommitted changes
		const currentRepository = this.gitService.activeRepository.get();
		const hasChanges = (currentRepository?.changes?.indexChanges && currentRepository.changes.indexChanges.length > 0);

		if (hasChanges) {
			stream.warning(vscode.l10n.t('You have uncommitted changes in your workspace. The cloud agent will start from the last committed state. Consider committing your changes first if you want to include them.'));
		}

		const prompt = request.prompt.substring('/delegate'.length).trim();

		const prInfo = await this.cloudSessionProvider.delegate(request, stream, context, token, { prompt, chatContext: context });
		if (prInfo) {
			await this.recordPushToSession(session, request.prompt, prInfo);
		}

	}

	private getAcceptedRejectedConfirmationData(request: vscode.ChatRequest): ConfirmationResult[] {
		const results: ConfirmationResult[] = [];
		results.push(...(request.acceptedConfirmationData?.map(data => ({ step: data.step, accepted: true, metadata: data?.metadata })) ?? []));
		results.push(...((request.rejectedConfirmationData ?? []).filter(data => !results.some(r => r.step === data.step)).map(data => ({ step: data.step, accepted: false, metadata: data?.metadata }))));

		return results;
	}

	private async handleConfirmationData(request: vscode.ChatRequest, session: ICopilotCLISession, prompt: string, results: ConfirmationResult[], context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		const uncommittedChangesData = results.find(data => data.step === UncommittedChangesStep);
		if (!uncommittedChangesData) {
			stream.warning(`Unknown confirmation step: ${results.map(r => r.step).join(', ')}\n\n`);
			return {};
		}

		if (!uncommittedChangesData.accepted || !uncommittedChangesData.metadata) {
			stream.markdown(vscode.l10n.t('Cloud agent delegation request cancelled.'));
			return {};
		}

		const prInfo = await this.cloudSessionProvider?.delegate(request, stream, context, token, uncommittedChangesData.metadata);
		if (prInfo) {
			await this.recordPushToSession(session, prompt, prInfo);
		}
		return {};
	}

	private async handlePushConfirmationData(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		// Check if this is a confirmation response
		const confirmationResults = this.getAcceptedRejectedConfirmationData(request);
		if (confirmationResults.length > 0) {
			return await this.handleWorktreeConfirmationResponse(request, confirmationResults, context, stream, token);
		}

		// Initial request - check isolation setting first
		const isolationEnabled = this.configurationService.getConfig(ConfigKey.Advanced.CLIIsolationEnabled);
		if (!isolationEnabled) {
			// No isolation, proceed without worktree
			return await this.createCLISessionAndSubmitRequest(request, undefined, request.references, context, undefined, false, stream, token);
		}

		// Check for uncommitted changes
		const currentRepository = this.gitService.activeRepository?.get();
		const hasUncommittedChanges = currentRepository?.changes && (currentRepository.changes.indexChanges.length > 0 || currentRepository.changes.workingTree.length > 0);
		if (!hasUncommittedChanges) {
			// No uncommitted changes, create worktree and proceed
			return await this.createCLISessionAndSubmitRequest(request, undefined, request.references, context, undefined, true, stream, token);
		}

		const message =
			vscode.l10n.t('Copilot CLI agent will work in an isolated worktree to implement your requested changes.')
			+ '\n\n'
			+ vscode.l10n.t('This workspace has uncommitted changes. Should these changes be included in the new worktree?');

		const buttons = [
			this.CLI_INCLUDE_CHANGES,
			this.CLI_SKIP_CHANGES,
			this.CLI_CANCEL
		];

		stream.confirmation(
			vscode.l10n.t('Delegate to Copilot CLI agent'),
			message,
			{
				step: UncommittedChangesStep,
				metadata: {
					prompt: request.prompt,
					references: request.references,
					chatContext: context,
				} satisfies CLIConfirmationMetadata
			},
			buttons
		);

		return {};
	}

	private async handleWorktreeConfirmationResponse(
		request: vscode.ChatRequest,
		results: ConfirmationResult[],
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		const uncommittedChangesData = results.find(data => data.step === UncommittedChangesStep);
		if (!uncommittedChangesData || !uncommittedChangesData.metadata) {
			stream.warning(vscode.l10n.t('Invalid confirmation data.'));
			return {};
		}
		const references = uncommittedChangesData.metadata.references?.length ? uncommittedChangesData.metadata.references : request.references;
		const selection = (request.prompt?.split(':')[0] || '').trim().toUpperCase();

		if (!selection || selection === this.CLI_CANCEL.toUpperCase() || token.isCancellationRequested) {
			stream.markdown(vscode.l10n.t('Copilot CLI agent delegation cancelled.'));
			return {};
		}

		const includeChanges = selection.includes(this.CLI_INCLUDE_CHANGES.toUpperCase());
		const prompt = uncommittedChangesData.metadata.prompt;

		if (includeChanges) {
			// Create worktree first
			stream.progress(vscode.l10n.t('Creating worktree...'));
			const worktreePathValue = await this.worktreeManager.createWorktree(stream);
			const worktreePath = worktreePathValue ? URI.file(worktreePathValue) : undefined;
			if (!worktreePath) {
				stream.warning(vscode.l10n.t('Failed to create worktree. Proceeding without isolation.'));
				return await this.createCLISessionAndSubmitRequest(request, prompt, references, context, undefined, false, stream, token);
			}

			// Migrate changes from active repository to worktree
			const activeRepository = this.gitService.activeRepository.get();
			if (activeRepository) {
				try {
					stream.progress(vscode.l10n.t('Migrating changes to worktree...'));
					// Wait for the worktree repository to be ready
					const worktreeRepo = await new Promise<typeof activeRepository | undefined>((resolve) => {
						const disposable = this.gitService.onDidOpenRepository(repo => {
							if (isEqual(repo.rootUri, worktreePath)) {
								disposable.dispose();
								resolve(repo);
							}
						});

						this.gitService.getRepository(worktreePath).then(repo => {
							if (repo) {
								disposable.dispose();
								resolve(repo);
							}
						});

						setTimeout(() => {
							disposable.dispose();
							resolve(undefined);
						}, 10_000);
					});

					if (!worktreeRepo) {
						stream.warning(vscode.l10n.t('Failed to get worktree repository. Proceeding without migration.'));
					} else {
						await this.gitService.migrateChanges(worktreeRepo.rootUri, activeRepository.rootUri, {
							confirmation: false,
							deleteFromSource: true,
							untracked: true
						});
						stream.markdown(vscode.l10n.t('Changes migrated to worktree.'));
					}
				} catch (error) {
					// Continue even if migration fails
					stream.warning(vscode.l10n.t('Failed to migrate some changes: {0}. Continuing with worktree creation.', error instanceof Error ? error.message : String(error)));
				}
			}

			return await this.createCLISessionAndSubmitRequest(request, prompt, references, context, worktreePath, true, stream, token);
		} else {
			// Skip changes, just create worktree without migration
			return await this.createCLISessionAndSubmitRequest(request, prompt, references, context, undefined, true, stream, token);
		}
	}

	private async createCLISessionAndSubmitRequest(
		request: vscode.ChatRequest,
		userPrompt: string | undefined,
		references: readonly vscode.ChatPromptReference[] | undefined,
		context: vscode.ChatContext,
		workingDirectory: Uri | undefined,
		isolationEnabled: boolean,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		let history: string | undefined;

		if (this.hasHistoryToSummarize(context.history)) {
			stream.progress(vscode.l10n.t('Analyzing chat history'));
			history = await this.summarizer.provideChatSummary(context, token);
		}

		// Give priority to userPrompt if provided (e.g., from confirmation metadata)
		userPrompt = userPrompt || request.prompt;
		const requestPrompt = history ? `${userPrompt}\n**Summary**\n${history}` : userPrompt;

		// Create worktree if isolation is enabled and we don't have one yet
		if (isolationEnabled && !workingDirectory) {
			const workTreePath = await this.worktreeManager.createWorktree(stream);
			workingDirectory = workTreePath ? URI.file(workTreePath) : undefined;
		}

		// Fallback to default directory if worktree creation failed
		if (!workingDirectory && !isolationEnabled) {
			workingDirectory = await this.copilotCLISDK.getDefaultWorkingDirectory();
		}
		const [{ prompt, attachments }, model, agent] = await Promise.all([
			this.promptResolver.resolvePrompt(request, requestPrompt, (references || []).concat([]), isolationEnabled, token),
			this.getModelId(undefined, undefined),
			this.getAgent(undefined, undefined),
		]);

		const session = await this.sessionService.createSession({ workingDirectory, isolationEnabled, agent, model }, token);
		this.copilotCLIAgents.trackSessionAgent(session.object.sessionId, agent?.name);

		// Do not await, we want this code path to be as fast as possible.
		if (isolationEnabled && workingDirectory) {
			void this.worktreeManager.storeWorktreePath(session.object.sessionId, workingDirectory.fsPath);
		}

		// We don't want to block the caller anymore.
		// The caller is most likely a chat editor or the like.
		// Now that we've delegated it to a session, we can get out of here.
		// Else if the request takes say 10 minutes, the caller would be blocked for that long.
		session.object.handleRequest(request.id, prompt, attachments, model, token)
			.catch(error => {
				this.logService.error(`Failed to handle CLI session request: ${error}`);
				// Optionally: stream.error(error) to notify the user
			})
			.finally(() => {
				session.dispose();
			});

		stream.markdown(vscode.l10n.t('{0} agent has begun working on your request. Follow its progress in the Agents View.', 'Background Agent'));

		return {};
	}

	private hasHistoryToSummarize(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): boolean {
		if (!history || history.length === 0) {
			return false;
		}
		const allResponsesEmpty = history.every(turn => {
			if (turn instanceof vscode.ChatResponseTurn) {
				return turn.response.length === 0;
			}
			return true;
		});
		return !allResponsesEmpty;
	}

	private async recordPushToSession(
		session: ICopilotCLISession,
		userPrompt: string,
		prInfo: { uri: vscode.Uri; title: string; description: string; author: string; linkTag: string }
	): Promise<void> {
		// Add user message event
		session.addUserMessage(userPrompt);

		// Add assistant message event with embedded PR metadata
		const assistantMessage = `GitHub Copilot cloud agent has begun working on your request. Follow its progress in the associated chat and pull request.\n<pr_metadata uri="${prInfo.uri.toString()}" title="${escapeXml(prInfo.title)}" description="${escapeXml(prInfo.description)}" author="${escapeXml(prInfo.author)}" linkTag="${escapeXml(prInfo.linkTag)}"/>`;
		session.addUserAssistantMessage(assistantMessage);
	}
}

export function registerCLIChatCommands(copilotcliSessionItemProvider: CopilotCLIChatSessionItemProvider, copilotCLISessionService: ICopilotCLISessionService, gitService: IGitService): IDisposable {
	const disposableStore = new DisposableStore();
	disposableStore.add(vscode.commands.registerCommand('github.copilot.copilotcli.sessions.refresh', () => {
		copilotcliSessionItemProvider.notifySessionsChange();
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.refresh', () => {
		copilotcliSessionItemProvider.notifySessionsChange();
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.delete', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.resource) {
			const id = SessionIdForCLI.parse(sessionItem.resource);
			const worktreePath = copilotcliSessionItemProvider.worktreeManager.getWorktreePath(id);

			const confirmMessage = worktreePath
				? l10n.t('Are you sure you want to delete the session and its associated worktree?')
				: l10n.t('Are you sure you want to delete the session?');

			const deleteLabel = l10n.t('Delete');
			const result = await vscode.window.showWarningMessage(
				confirmMessage,
				{ modal: true },
				deleteLabel
			);

			if (result === deleteLabel) {
				await copilotCLISessionService.deleteSession(id);

				if (worktreePath) {
					try {
						const repository = gitService.activeRepository.get();
						if (!repository) {
							throw new Error(vscode.l10n.t('No active repository found to delete worktree.'));
						}
						await gitService.deleteWorktree(repository.rootUri, worktreePath);
					} catch (error) {
						vscode.window.showErrorMessage(vscode.l10n.t('Failed to delete worktree: {0}', error instanceof Error ? error.message : String(error)));
					}
				}

				copilotcliSessionItemProvider.notifySessionsChange();
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
	disposableStore.add(vscode.commands.registerCommand('agentSession.copilotcli.openChanges', async (sessionItemResource?: vscode.Uri) => {
		if (!sessionItemResource) {
			return;
		}

		const sessionId = SessionIdForCLI.parse(sessionItemResource);
		const sessionWorktree = copilotcliSessionItemProvider.worktreeManager.getWorktreePath(sessionId);
		const sessionWorktreeName = copilotcliSessionItemProvider.worktreeManager.getWorktreeRelativePath(sessionId);

		if (!sessionWorktree || !sessionWorktreeName) {
			return;
		}

		const repository = await gitService.getRepository(Uri.file(sessionWorktree));
		if (!repository?.changes) {
			return;
		}

		const title = vscode.l10n.t('Copilot CLI ({0})', sessionWorktreeName);
		const multiDiffSourceUri = Uri.parse(`copilotcli-worktree-changes:/${sessionId}`);
		const resources = repository.changes.indexChanges.map(change => {
			switch (change.status) {
				case 1 /* Status.INDEX_ADDED */:
					return {
						originalUri: undefined,
						modifiedUri: change.uri
					};
				case 2 /* Status.INDEX_DELETED */:
					return {
						originalUri: toGitUri(change.uri, 'HEAD'),
						modifiedUri: undefined
					};
				default:
					return {
						originalUri: toGitUri(change.uri, 'HEAD'),
						modifiedUri: change.uri
					};
			}
		});

		await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', { multiDiffSourceUri, title, resources });
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.chat.applyCopilotCLIAgentSessionChanges', async (sessionItemResource?: vscode.Uri) => {
		if (!sessionItemResource) {
			return;
		}

		const sessionId = SessionIdForCLI.parse(sessionItemResource);
		const sessionWorktree = copilotcliSessionItemProvider.worktreeManager.getWorktreePath(sessionId);

		if (!sessionWorktree) {
			return;
		}

		const sessionWorktreeUri = Uri.file(sessionWorktree);
		const activeRepository = gitService.activeRepository.get();
		if (!activeRepository) {
			return;
		}

		// Migrate the changes from the worktree to the main repository
		await gitService.migrateChanges(activeRepository.rootUri, sessionWorktreeUri, {
			confirmation: false,
			deleteFromSource: false,
			untracked: true
		});
	}));
	return disposableStore;
}
