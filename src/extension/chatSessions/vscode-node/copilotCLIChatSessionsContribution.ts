/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Attachment, SweCustomAgent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, Uri, workspace } from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IGitService, RepoContext } from '../../../platform/git/common/gitService';
import { toGitUri } from '../../../platform/git/common/utils';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptsService, ParsedPromptFile } from '../../../platform/promptFiles/common/promptsService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { disposableTimeout } from '../../../util/vs/base/common/async';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable, IReference, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { basename, isEqual } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ToolCall } from '../../agents/copilotcli/common/copilotCLITools';
import { IChatDelegationSummaryService } from '../../agents/copilotcli/common/delegationSummaryService';
import { COPILOT_CLI_DEFAULT_AGENT_ID, ICopilotCLIAgents, ICopilotCLIModels, ICopilotCLISDK } from '../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../agents/copilotcli/node/copilotcliSession';
import { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { PermissionRequest, requestPermission } from '../../agents/copilotcli/node/permissionHelpers';
import { ChatVariablesCollection, isPromptFile } from '../../prompt/common/chatVariablesCollection';
import { IToolsService } from '../../tools/common/toolsService';
import { ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { CopilotCloudSessionsProvider } from './copilotCloudSessionsProvider';
import { convertReferenceToVariable } from './copilotPromptReferences';

const AGENTS_OPTION_ID = 'agent';
const MODELS_OPTION_ID = 'model';
const ISOLATION_OPTION_ID = 'isolation';

const disabledIsolation: Readonly<vscode.ChatSessionProviderOptionItem> = {
	id: 'disabled',
	name: 'Workspace',
	description: vscode.l10n.t('Use the current workspace for this session')
};
const disabledIsolationLocked: Readonly<vscode.ChatSessionProviderOptionItem> = { ...disabledIsolation, locked: true };

function getLockedIsolationOption(name: string): vscode.ChatSessionProviderOptionItem {
	return {
		id: 'enabled',
		name,
		description: vscode.l10n.t('Using worktree for this session'),
		locked: true,
		icon: new vscode.ThemeIcon('worktree')
	};
}

const UncommittedChangesStep = 'uncommitted-changes';
type ConfirmationResult = { step: string; accepted: boolean; metadata?: CLIConfirmationMetadata };
interface CLIConfirmationMetadata {
	prompt: string;
	references?: readonly vscode.ChatPromptReference[];
	chatContext: vscode.ChatContext;
}

// Track untitled session models.
// When we start new sessions, we don't have the real session id, we have a temporary untitled id.
// Or if we open an existing session and change the model, we need to track that as well, until its used (after which its stored in session).
// We also need this when we open a session and later run it.
// When opening the session for readonly mode we store it here and when run the session we read from here instead of opening session in readonly mode again.
const _sessionModel: Map<string, string | undefined> = new Map();

// When we start an untitled CLI session, the id of the session is `untitled:xyz`
// As soon as we create a CLI session we have the real session id, lets say `cli-1234`
// Once the session completes, this untitled session `untitled:xyz` will get swapped with the real session id `cli-1234`
// However if the session items provider is called while the session is still running, we need to return the same old `untitled:xyz` session id back to core.
// There's an issue in core (about holding onto ref of the Chat Model).
// As a temporary solution, return the same untitled session id back to core until the session is completed.
const _untitledSessionIdMap = new Map<string, string>();

// Right now it's expensive to get the sessions stats in some cases, specially for worktrees.
// We should cache them until we get a new request
const CachedSessionStats = new ResourceMap<vscode.ChatSessionChangedFile[]>();

function isUntitledSessionId(sessionId: string): boolean {
	return sessionId.startsWith('untitled:') || sessionId.startsWith('untitled-');
}

export class CopilotCLIWorktreeManager {
	static COPILOT_CLI_DEFAULT_ISOLATION_MEMENTO_KEY = 'github.copilot.cli.sessionIsolation';
	static COPILOT_CLI_SESSION_WORKTREE_MEMENTO_KEY = 'github.copilot.cli.sessionWorktrees';

	private _sessionIsolation: Map<string, boolean> = new Map();
	private _sessionWorktrees: Map<string, string> = new Map();
	constructor(
		@IGitService private readonly gitService: IGitService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
	) { }

	isSupported() {
		const repository = this.gitService.activeRepository.get();
		return !!repository;
	}

	async createWorktree(stream?: vscode.ChatResponseStream): Promise<string | undefined> {
		if (!stream) {
			return this.tryCreateWorktree();
		}

		return new Promise<string | undefined>((resolve) => {
			stream.progress(vscode.l10n.t('Creating isolated worktree for Background Agent session...'), async progress => {
				const result = await this.tryCreateWorktree(progress);
				resolve(result);
				if (result) {
					return vscode.l10n.t('Created isolated worktree at {0}', basename(Uri.file(result)));
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

			const branchPrefix = workspace.getConfiguration('git').get<string>('branchPrefix') ?? '';
			const branch = `${branchPrefix}copilot-worktree-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
			const worktreePath = await this.gitService.createWorktree(repository.rootUri, { branch });
			if (worktreePath) {
				return worktreePath;
			}
			progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Failed to create worktree for isolation, using default workspace directory')));
			return undefined;
		} catch (error) {
			progress?.report(new vscode.ChatResponseWarningPart(vscode.l10n.t('Error creating worktree for isolation: {0}', error instanceof Error ? error.message : String(error))));
			this.logService.error(error, 'Error creating worktree for isolation');
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
		if (!this.isSupported()) {
			return false;
		}
		return this.extensionContext.globalState.get<boolean>(CopilotCLIWorktreeManager.COPILOT_CLI_DEFAULT_ISOLATION_MEMENTO_KEY, true);
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
		CachedSessionStats.clear();
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
		const resource = SessionIdForCLI.getResource(_untitledSessionIdMap.get(session.id) ?? session.id);
		const worktreePath = this.worktreeManager.getWorktreePath(session.id);
		const worktreeRelativePath = this.worktreeManager.getWorktreeRelativePath(session.id);

		const label = session.label;
		let badge: vscode.MarkdownString | undefined;
		let changes: vscode.ChatSessionItem['changes'] | undefined;

		if (worktreePath && worktreeRelativePath) {
			const worktreeUri = Uri.file(worktreePath);
			// Badge
			badge = new vscode.MarkdownString(`$(worktree) ${worktreeRelativePath}`);
			badge.supportThemeIcons = true;

			// Statistics
			const stats = await this.getStatisticsForWorktree(worktreeUri);
			if (stats && stats.length > 0) {
				CachedSessionStats.set(resource, stats);
				changes = stats;
			}
		}
		const status = session.status ?? vscode.ChatSessionStatus.Completed;

		return {
			resource,
			label,
			badge,
			timing: session.timing,
			changes,
			status
		} satisfies vscode.ChatSessionItem;
	}

	private async getStatisticsForWorktree(worktreeUri: Uri): Promise<vscode.ChatSessionChangedFile[]> {
		const repository = await this.gitService.getRepository(worktreeUri, false);
		if (!repository?.changes) {
			return [];
		}

		const details: vscode.ChatSessionChangedFile[] = [];
		for (const change of [...repository.changes.indexChanges, ...repository.changes.workingTree]) {
			try {
				const fileStats = await this.gitService.diffIndexWithHEADShortStats(change.uri);
				details.push(new vscode.ChatSessionChangedFile(
					change.uri,
					fileStats?.insertions ?? 0,
					fileStats?.deletions ?? 0,
					change.originalUri
				));
			} catch (error) { }
		}
		return details;
	}

	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || vscode.l10n.t('Background Agent');
		await this.terminalIntegration.openTerminal(terminalName);
	}

	public async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const id = SessionIdForCLI.parse(sessionItem.resource);
		const terminalName = sessionItem.label || id;
		const cliArgs = ['--resume', id];
		await this.terminalIntegration.openTerminal(terminalName, cliArgs);
	}
}

export class CopilotCLIChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;
	constructor(
		private readonly worktreeManager: CopilotCLIWorktreeManager,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) {
		super();
	}

	public notifySessionOptionsChange(resource: vscode.Uri, updates: ReadonlyArray<{ optionId: string; value: string | vscode.ChatSessionProviderOptionItem }>): void {
		this._onDidChangeChatSessionOptions.fire({ resource, updates });
	}

	async provideChatSessionContent(resource: Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const copilotcliSessionId = SessionIdForCLI.parse(resource);
		const workingDirectoryValue = this.worktreeManager.getWorktreePath(copilotcliSessionId);
		const workingDirectory = workingDirectoryValue ? URI.file(workingDirectoryValue) : undefined;
		const isolationEnabled = this.worktreeManager.getIsolationPreference(copilotcliSessionId);

		const [defaultModel, sessionAgent, defaultAgent, existingSession] = await Promise.all([
			this.copilotCLIModels.getDefaultModel(),
			this.copilotCLIAgents.getSessionAgent(copilotcliSessionId),
			this.copilotCLIAgents.getDefaultAgent(),
			isUntitledSessionId(copilotcliSessionId) ? Promise.resolve(undefined) : this.sessionService.getSession(copilotcliSessionId, { workingDirectory, isolationEnabled, readonly: true }, token)
		]);

		// If we have session in _sessionModel, use that (faster as its in memory), else get from existing session.
		const model = (existingSession ? (_sessionModel.get(copilotcliSessionId) ?? await existingSession.object.getSelectedModelId()) : _sessionModel.get(copilotcliSessionId)) ?? defaultModel;

		const options: Record<string, string | vscode.ChatSessionProviderOptionItem> = {};

		options[AGENTS_OPTION_ID] = sessionAgent ?? defaultAgent;

		// Possible there are no models (e.g. all models have been turned off by policy or the like).
		if (model) {
			options[MODELS_OPTION_ID] = model;
		}

		if (!existingSession || !this.worktreeManager.isSupported()) {
			options[ISOLATION_OPTION_ID] = this.worktreeManager.isSupported() && isolationEnabled ? 'enabled' : 'disabled';
		} else if (existingSession && workingDirectory) {
			// For existing sessions with a worktree, show the worktree branch name as a locked option
			const worktreeRelativePath = this.worktreeManager.getWorktreeRelativePath(copilotcliSessionId);
			if (worktreeRelativePath) {
				options[ISOLATION_OPTION_ID] = getLockedIsolationOption(worktreeRelativePath);
			} else {
				options[ISOLATION_OPTION_ID] = disabledIsolationLocked;
			}
		} else if (existingSession) {
			options[ISOLATION_OPTION_ID] = disabledIsolationLocked;
		}

		const history = existingSession?.object?.getChatHistory() || [];
		existingSession?.dispose();
		// Always keep track of this in memory.
		// We need this when we create the session later for execution.
		_sessionModel.set(copilotcliSessionId, model);

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options: options
		};
	}

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		const isolationItems = [
			{ id: 'enabled', name: 'Worktree', description: vscode.l10n.t('Use a git worktree for this session') },
			disabledIsolation
		];

		const [models, agents] = await Promise.all([
			this.copilotCLIModels.getModels(),
			this.copilotCLIAgents.getAgents()
		]);
		const hasAgents = agents.length > 0;
		const modelItems: vscode.ChatSessionProviderOptionItem[] = models;
		const agentItems: vscode.ChatSessionProviderOptionItem[] = [
			{ id: COPILOT_CLI_DEFAULT_AGENT_ID, name: l10n.t('Agent') }
		];
		agents.forEach(agent => {
			agentItems.push({ id: agent.name, name: agent.displayName || agent.name, description: agent.description });
		});

		const options = {
			optionGroups: [
				{
					id: MODELS_OPTION_ID,
					name: vscode.l10n.t('Model'),
					description: vscode.l10n.t('Pick Model'),
					items: modelItems
				}
			]
		};
		if (this.worktreeManager.isSupported()) {
			options.optionGroups.push({
				id: ISOLATION_OPTION_ID,
				name: vscode.l10n.t('Isolation'),
				description: vscode.l10n.t('Choose Worktree or Workspace for this session'),
				items: isolationItems
			});
		}
		if (hasAgents) {
			options.optionGroups.unshift({
				id: AGENTS_OPTION_ID,
				name: vscode.l10n.t('Agent'),
				description: vscode.l10n.t('Set Agent'),
				items: agentItems
			});
		}
		return options;
	}

	// Handle option changes for a session (store current state in a map)
	async provideHandleOptionsChange(resource: Uri, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, token: vscode.CancellationToken): Promise<void> {
		const sessionId = SessionIdForCLI.parse(resource);
		for (const update of updates) {
			if (update.optionId === MODELS_OPTION_ID) {
				void this.copilotCLIModels.setDefaultModel(update.value);
				_sessionModel.set(sessionId, update.value);
			} else if (update.optionId === AGENTS_OPTION_ID) {
				void this.copilotCLIAgents.setDefaultAgent(update.value);
				void this.copilotCLIAgents.trackSessionAgent(sessionId, update.value);
			} else if (update.optionId === ISOLATION_OPTION_ID) {
				// Handle isolation option changes
				await this.worktreeManager.setIsolationPreference(sessionId, update.value === 'enabled');
			}
		}
	}
}

const WAIT_FOR_NEW_SESSION_TO_GET_USED = 5 * 60 * 1000; // 5 minutes

export class CopilotCLIChatSessionParticipant extends Disposable {
	private CLI_MOVE_CHANGES = vscode.l10n.t('Move Changes');
	private CLI_COPY_CHANGES = vscode.l10n.t('Copy Changes');
	private CLI_SKIP_CHANGES = vscode.l10n.t('Skip Changes');
	private CLI_CANCEL = vscode.l10n.t('Cancel');
	private readonly untitledSessionIdMapping = new Map<string, string>();
	constructor(
		private readonly contentProvider: CopilotCLIChatSessionContentProvider,
		private readonly promptResolver: CopilotCLIPromptResolver,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
		private readonly cloudSessionProvider: CopilotCloudSessionsProvider | undefined,
		private readonly worktreeManager: CopilotCLIWorktreeManager,
		@IGitService private readonly gitService: IGitService,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IToolsService private readonly toolsService: IToolsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICopilotCLISDK private readonly copilotCLISDK: ICopilotCLISDK,
		@ILogService private readonly logService: ILogService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@IChatDelegationSummaryService private readonly chatDelegationSummaryService: IChatDelegationSummaryService,
	) {
		super();
	}

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private readonly previousReferences = new Map<string, vscode.ChatPromptReference[]>();
	private readonly contextForRequest = new Map<string, { prompt: string; attachments: Attachment[] }>();
	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
		const { chatSessionContext } = context;
		const disposables = new DisposableStore();
		let sessionResource: vscode.Uri | undefined;
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
			const currentRepository = this.gitService.activeRepository?.get();
			if (!chatSessionContext) {
				// Invoked from a 'normal' chat or 'cloud button' without CLI session context
				// Or cases such as delegating from Regular chat to CLI chat
				// Handle confirmation data
				return await this.handlePushConfirmationData(request, context, stream, token, currentRepository);
			}

			const isUntitled = chatSessionContext.isUntitled;
			const hasUncommittedChanges = currentRepository?.changes && (currentRepository.changes.indexChanges.length > 0 || currentRepository.changes.workingTree.length > 0);
			if (isUntitled && hasUncommittedChanges && confirmationResults.length === 0) {
				// initial request for untitled cli editor w/ uncomitted changes
				return this.generateUncommittedChangesConfirmation(request, context, stream, token);
			}

			if (isUntitled && hasUncommittedChanges && confirmationResults.length > 0) {
				return await this.handleWorktreeConfirmationResponse(request, confirmationResults, context, stream, token);
			}
			const { resource } = chatSessionContext.chatSessionItem;
			sessionResource = resource;
			const id = SessionIdForCLI.parse(resource);
			const additionalReferences = this.previousReferences.get(id) || [];
			this.previousReferences.delete(id);
			const [modelId, agent] = await Promise.all([
				this.getModelId(id, request, false, token),
				this.getAgent(id, request, token),
			]);
			if (isUntitled && (modelId || agent)) {
				const promptFile = request ? await this.getPromptInfoFromRequest(request, token) : undefined;
				if (promptFile) {
					const changes: { optionId: string; value: string }[] = [];
					if (agent) {
						changes.push({ optionId: AGENTS_OPTION_ID, value: agent.name });
					}
					if (modelId) {
						changes.push({ optionId: MODELS_OPTION_ID, value: modelId });
					}
					if (changes.length > 0) {
						this.contentProvider.notifySessionOptionsChange(resource, changes);
					}
				}
			}
			const session = await this.getOrCreateSession(request, chatSessionContext, modelId, agent, stream, disposables, token);
			if (!session || token.isCancellationRequested) {
				return {};
			}
			if (isUntitled && session.object.options.isolationEnabled && session.object.options.workingDirectory && this.worktreeManager.isSupported()) {
				const changes: { optionId: string; value: vscode.ChatSessionProviderOptionItem }[] = [];
				// For existing sessions with a worktree, show the worktree branch name as a locked option
				const worktreeRelativePath = this.worktreeManager.getWorktreeRelativePath(session.object.sessionId);
				if (worktreeRelativePath) {
					changes.push({ optionId: ISOLATION_OPTION_ID, value: getLockedIsolationOption(worktreeRelativePath) });
					this.contentProvider.notifySessionOptionsChange(resource, changes);
				}
			} else if (isUntitled && (!session.object.options.isolationEnabled || !this.worktreeManager.isSupported())) {
				const changes: { optionId: string; value: vscode.ChatSessionProviderOptionItem }[] = [];
				changes.push({ optionId: ISOLATION_OPTION_ID, value: disabledIsolationLocked });
				this.contentProvider.notifySessionOptionsChange(resource, changes);
			}

			this.copilotCLIAgents.trackSessionAgent(session.object.sessionId, agent?.name);
			if (isUntitled) {
				_untitledSessionIdMap.set(session.object.sessionId, id);
				disposables.add(toDisposable(() => _untitledSessionIdMap.delete(session.object.sessionId)));
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

			// Check if we have context stored for this request (created in createCLISessionAndSubmitRequest, work around)
			const contextForRequest = this.contextForRequest.get(session.object.sessionId);
			this.contextForRequest.delete(session.object.sessionId);
			if (request.prompt.startsWith('/delegate')) {
				await this.handleDelegateCommand(session.object, request, context, stream, token);
			} else if (contextForRequest) {
				// This is a request that was created in createCLISessionAndSubmitRequest with attachments already resolved.
				const { prompt, attachments } = contextForRequest;
				this.contextForRequest.delete(session.object.sessionId);
				await session.object.handleRequest(request.id, prompt, attachments, modelId, token);
			} else {
				// Construct the full prompt with references to be sent to CLI.
				const { prompt, attachments } = await this.promptResolver.resolvePrompt(request, undefined, additionalReferences, session.object.options.isolationEnabled, session.object.options.workingDirectory, token);
				await session.object.handleRequest(request.id, prompt, attachments, modelId, token);
			}

			if (isUntitled && !token.isCancellationRequested) {
				// Delete old information stored for untitled session id.
				_sessionModel.delete(id);
				_sessionModel.set(session.object.sessionId, modelId);
				this.untitledSessionIdMapping.delete(id);
				_untitledSessionIdMap.delete(session.object.sessionId);
				this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { resource: SessionIdForCLI.getResource(session.object.sessionId), label: request.prompt });
			}
			return {};
		} catch (ex) {
			if (isCancellationError(ex)) {
				return {};
			}
			throw ex;
		}
		finally {
			// Clean cached references for this session
			if (sessionResource) {
				CachedSessionStats.delete(sessionResource);
				this.sessionItemProvider.notifySessionsChange();
			}
			disposables.dispose();
		}
	}

	/**
	 * Gets the agent to be used.
	 * If creating a new session, then uses the agent configured in settings.
	 * If opening an existing session, then uses the agent associated with that session.
	 * If creating a new session with a prompt file that specifies an agent, then uses that agent.
	 * If the prompt file specifies tools, those tools override the agent's default tools.
	 */
	private async getAgent(sessionId: string | undefined, request: vscode.ChatRequest | undefined, token: vscode.CancellationToken): Promise<SweCustomAgent | undefined> {
		const [sessionAgent, defaultAgent, promptFile] = await Promise.all([
			sessionId ? this.copilotCLIAgents.getSessionAgent(sessionId) : Promise.resolve(undefined),
			this.copilotCLIAgents.getDefaultAgent(),
			request ? this.getPromptInfoFromRequest(request, token) : Promise.resolve(undefined)
		]);

		const agent = await this.copilotCLIAgents.resolveAgent(sessionAgent ?? defaultAgent);

		// If we have a prompt file that specifies an agent or tools, use that.
		if (promptFile?.header?.agent || Array.isArray(promptFile?.header?.tools)) {
			const customAgent = promptFile.header.agent ? await this.copilotCLIAgents.resolveAgent(promptFile.header.agent) : undefined;
			const agentToUse = customAgent ?? agent;
			if (agentToUse) {
				if (Array.isArray(promptFile.header.tools)) {
					agentToUse.tools = promptFile.header.tools;
				}
				return agentToUse;
			}
		}

		return agent;
	}

	private async getPromptInfoFromRequest(request: vscode.ChatRequest, token: vscode.CancellationToken): Promise<ParsedPromptFile | undefined> {
		const promptFile = new ChatVariablesCollection(request.references).find(isPromptFile);
		if (!promptFile || !URI.isUri(promptFile.reference.value)) {
			return undefined;
		}
		try {
			return await this.promptsService.parseFile(promptFile.reference.value, token);
		} catch (ex) {
			this.logService.error(`Failed to parse the prompt file: ${promptFile.reference.value.toString()}`, ex);
			return undefined;
		}
	}

	private async getOrCreateSession(request: vscode.ChatRequest, chatSessionContext: vscode.ChatSessionContext, model: string | undefined, agent: SweCustomAgent | undefined, stream: vscode.ChatResponseStream, disposables: DisposableStore, token: vscode.CancellationToken): Promise<IReference<ICopilotCLISession> | undefined> {
		const { resource } = chatSessionContext.chatSessionItem;
		const existingSessionId = this.untitledSessionIdMapping.get(SessionIdForCLI.parse(resource));
		const id = existingSessionId ?? SessionIdForCLI.parse(resource);
		const isNewSession = chatSessionContext.isUntitled && !existingSessionId;
		const isolationEnabled = this.worktreeManager.getIsolationPreference(id);
		const workingDirectoryValue = isNewSession || !isolationEnabled ?
			(isolationEnabled ? await this.worktreeManager.createWorktree(stream) : await this.copilotCLISDK.getDefaultWorkingDirectory().then(dir => dir?.fsPath)) :
			this.worktreeManager.getWorktreePath(id);
		const workingDirectory = workingDirectoryValue ? Uri.file(workingDirectoryValue) : undefined;

		const session = isNewSession ?
			await this.sessionService.createSession({ model, workingDirectory, isolationEnabled, agent }, token) :
			await this.sessionService.getSession(id, { model, workingDirectory, isolationEnabled, readonly: false, agent }, token);
		this.sessionItemProvider.notifySessionsChange();

		if (!session) {
			stream.warning(vscode.l10n.t('Chat session not found.'));
			return undefined;
		}

		if (isNewSession) {
			this.untitledSessionIdMapping.set(id, session.object.sessionId);
		}
		if (isNewSession && workingDirectory && isolationEnabled) {
			await this.worktreeManager.storeWorktreePath(session.object.sessionId, workingDirectory.fsPath);
		}
		disposables.add(session.object.attachStream(stream));
		disposables.add(session.object.attachPermissionHandler(async (permissionRequest: PermissionRequest, toolCall: ToolCall | undefined, token: vscode.CancellationToken) => requestPermission(this.instantiationService, permissionRequest, toolCall, this.toolsService, request.toolInvocationToken, token)));


		return session;
	}

	/**
	 *
	 * @param preferModelInRequest
	 * If true, will prefer model specified in request over session model.
	 * This is useful when delegating from another chat session, and we want to preserve the model in the previous chat editor/session.
	 */
	private async getModelId(sessionId: string | undefined, request: vscode.ChatRequest | undefined, preferModelInRequest: boolean, token: vscode.CancellationToken): Promise<string | undefined> {
		const promptFile = request ? await this.getPromptInfoFromRequest(request, token) : undefined;
		if (promptFile?.header?.model) {
			const model = await this.copilotCLIModels.resolveModel(promptFile.header.model);
			if (model) {
				return model;
			}
		}

		// If we have a session, get the model from there
		if (sessionId) {
			const sessionModelId = _sessionModel.get(sessionId);
			if (sessionModelId) {
				return sessionModelId;
			}
		}

		// Get model from request.
		const preferredModelInRequest = preferModelInRequest && request?.model?.id ? await this.copilotCLIModels.resolveModel(request.model.id) : undefined;
		if (preferredModelInRequest) {
			return preferredModelInRequest;
		}

		return await this.copilotCLIModels.getDefaultModel();
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
		token: vscode.CancellationToken,
		currentRepository: RepoContext | undefined
	): Promise<vscode.ChatResult | void> {
		// Check if this is a confirmation response
		const confirmationResults = this.getAcceptedRejectedConfirmationData(request);
		if (confirmationResults.length > 0) {
			return await this.handleWorktreeConfirmationResponse(request, confirmationResults, context, stream, token);
		}

		if (!currentRepository) {
			// No isolation, proceed without worktree
			return await this.createCLISessionAndSubmitRequest(request, undefined, request.references, context, undefined, false, stream, token);
		}

		// Check for uncommitted changes
		const hasUncommittedChanges = currentRepository.changes && (currentRepository.changes.indexChanges.length > 0 || currentRepository.changes.workingTree.length > 0);
		if (!hasUncommittedChanges) {
			// No uncommitted changes, create worktree and proceed
			return await this.createCLISessionAndSubmitRequest(request, undefined, request.references, context, undefined, true, stream, token);
		}
		return this.generateUncommittedChangesConfirmation(request, context, stream, token);
	}

	private generateUncommittedChangesConfirmation(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): vscode.ChatResult | void {
		const message =
			vscode.l10n.t('Background Agent will work in an isolated worktree to implement your requested changes.')
			+ '\n\n'
			+ vscode.l10n.t('This workspace has uncommitted changes. Should these changes be included in the new worktree?');

		const buttons = [
			this.CLI_COPY_CHANGES,
			this.CLI_MOVE_CHANGES,
			this.CLI_SKIP_CHANGES,
			this.CLI_CANCEL
		];

		stream.confirmation(
			vscode.l10n.t('Delegate to Background Agent'),
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
			stream.markdown(vscode.l10n.t('Background Agent delegation cancelled.'));
			return {};
		}

		const moveChanges = selection === this.CLI_MOVE_CHANGES.toUpperCase();
		const copyChanges = selection === this.CLI_COPY_CHANGES.toUpperCase();
		const prompt = uncommittedChangesData.metadata.prompt;

		if ((moveChanges || copyChanges) && this.worktreeManager.isSupported()) {
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
							deleteFromSource: moveChanges,
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
			return await this.createCLISessionAndSubmitRequest(request, prompt, references, context, undefined, this.worktreeManager.isSupported(), stream, token);
		}
	}

	private async createCLISessionAndSubmitRequest(
		request: vscode.ChatRequest,
		userPrompt: string | undefined,
		otherReferences: readonly vscode.ChatPromptReference[] | undefined,
		context: vscode.ChatContext,
		workingDirectory: Uri | undefined,
		isolationEnabled: boolean,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		let summary: string | undefined;
		const requestPromptPromise = (async () => {
			if (this.hasHistoryToSummarize(context.history)) {
				stream.progress(vscode.l10n.t('Analyzing chat history'));
				summary = await this.chatDelegationSummaryService.summarize(context, token);
				summary = summary ? `**Summary**\n${summary}` : undefined;
			}

			// Give priority to userPrompt if provided (e.g., from confirmation metadata)
			userPrompt = userPrompt || request.prompt;
			return summary ? `${userPrompt}\n${summary}` : userPrompt;
		})();

		const getWorkingDirectory = async () => {
			// Create worktree if isolation is enabled and we don't have one yet
			if (isolationEnabled && !workingDirectory) {
				const workTreePath = await this.worktreeManager.createWorktree(stream);
				workingDirectory = workTreePath ? URI.file(workTreePath) : undefined;
			}

			// Fallback to default directory if worktree creation failed
			if (!isolationEnabled && !workingDirectory) {
				workingDirectory = await this.copilotCLISDK.getDefaultWorkingDirectory();
			}
		};

		const getWorkingDirectoryPromise = getWorkingDirectory();
		const [{ prompt, attachments, references }, model, agent] = await Promise.all([
			requestPromptPromise.then(async prompt => {
				await getWorkingDirectoryPromise;
				return this.promptResolver.resolvePrompt(request, prompt, (otherReferences || []).concat([]), isolationEnabled, workingDirectory, token);
			}),
			this.getModelId(undefined, request, true, token), // prefer model in request, as we're delegating from another session here.
			this.getAgent(undefined, undefined, token),
			getWorkingDirectoryPromise
		]);

		const session = await this.sessionService.createSession({ workingDirectory, isolationEnabled, agent, model }, token);
		void this.copilotCLIAgents.trackSessionAgent(session.object.sessionId, agent?.name);
		if (summary) {
			void this.chatDelegationSummaryService.trackSummaryUsage(session.object.sessionId, summary);
		}
		// Do not await, we want this code path to be as fast as possible.
		if (isolationEnabled && workingDirectory) {
			void this.worktreeManager.storeWorktreePath(session.object.sessionId, workingDirectory.fsPath);
		}

		try {
			this.contextForRequest.set(session.object.sessionId, { prompt, attachments });
			this.sessionItemProvider.notifySessionsChange();
			await vscode.commands.executeCommand('workbench.action.chat.openSessionWithPrompt.copilotcli', {
				resource: SessionIdForCLI.getResource(session.object.sessionId),
				prompt: userPrompt || request.prompt,
				attachedContext: references.map(ref => convertReferenceToVariable(ref, attachments))
			});
		} catch {
			this.contextForRequest.delete(session.object.sessionId);
			// TODO@rebornix: handle potential missing command
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
		}

		stream.markdown(vscode.l10n.t('A background agent has begun working on your request. Follow its progress in the sessions list.'));

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
		const assistantMessage = `A cloud agent has begun working on your request. Follow its progress in the associated chat and pull request.\n<pr_metadata uri="${prInfo.uri.toString()}" title="${escapeXml(prInfo.title)}" description="${escapeXml(prInfo.description)}" author="${escapeXml(prInfo.author)}" linkTag="${escapeXml(prInfo.linkTag)}"/>`;
		session.addUserAssistantMessage(assistantMessage);
	}
}

export function registerCLIChatCommands(copilotcliSessionItemProvider: CopilotCLIChatSessionItemProvider, copilotCLISessionService: ICopilotCLISessionService, gitService: IGitService): IDisposable {
	const disposableStore = new DisposableStore();
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

		const title = vscode.l10n.t('Background Agent ({0})', sessionWorktreeName);
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

	const applyChanges = async (sessionItemOrResource?: vscode.ChatSessionItem | vscode.Uri) => {
		const resource = sessionItemOrResource instanceof vscode.Uri
			? sessionItemOrResource
			: sessionItemOrResource?.resource;

		if (!resource) {
			return;
		}

		const sessionId = SessionIdForCLI.parse(resource);
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

		copilotcliSessionItemProvider.notifySessionsChange(); // pick up new git state
	};

	disposableStore.add(vscode.commands.registerCommand('github.copilot.chat.applyCopilotCLIAgentSessionChanges', applyChanges));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.chat.applyCopilotCLIAgentSessionChanges.apply', applyChanges));
	return disposableStore;
}
