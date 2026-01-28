/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Attachment, SweCustomAgent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, ChatSessionProviderOptionItem, Uri } from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitService, RepoContext } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptsService, ParsedPromptFile } from '../../../platform/promptFiles/common/promptsService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { isUri } from '../../../util/common/types';
import { disposableTimeout, raceCancellation } from '../../../util/vs/base/common/async';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable, IReference, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { ResourceMap, ResourceSet } from '../../../util/vs/base/common/map';
import { basename, extUri, isEqual } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ToolCall } from '../../agents/copilotcli/common/copilotCLITools';
import { IChatDelegationSummaryService } from '../../agents/copilotcli/common/delegationSummaryService';
import { ICopilotCLIAgents, ICopilotCLIModels } from '../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../agents/copilotcli/node/copilotcliSession';
import { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { PermissionRequest, requestPermission } from '../../agents/copilotcli/node/permissionHelpers';
import { createTimeout } from '../../inlineEdits/common/common';
import { ChatVariablesCollection, isPromptFile } from '../../prompt/common/chatVariablesCollection';
import { IToolsService } from '../../tools/common/toolsService';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { isUntitledSessionId } from '../common/utils';
import { convertReferenceToVariable } from './copilotCLIPromptReferences';
import { ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { CopilotCloudSessionsProvider } from './copilotCloudSessionsProvider';

const AGENTS_OPTION_ID = 'agent';
const MODELS_OPTION_ID = 'model';
const REPOSITORY_OPTION_ID = 'repository';
const OPEN_REPOSITORY_COMMAND_ID = 'github.copilot.cli.sessions.openRepository';

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

// We want to keep track of the date/time when a repo was added.
const untitledWorkspaceRepositories = new ResourceMap<number>();
// We want to keep track of the date/time when a folder was added.
const untitledWorkspaceFodlers = new ResourceMap<number>();

const listOfKnownRepos = new ResourceSet();

const untrustedFolderMessage = l10n.t('The selected folder is not trusted. Please trust the folder to continue with the {0}.', 'Background Agent');

let lastUsedFolderIdInUntitledWorkspace: string | undefined;

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
		@IChatSessionWorktreeService private readonly worktreeManager: IChatSessionWorktreeService,
		@IRunCommandExecutionService private readonly commandExecutionService: IRunCommandExecutionService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IChatSessionWorkspaceFolderService private readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
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
		const sessions = await this.copilotcliSessionService.getAllSessions(this.shouldShowSession.bind(this), token);
		const diskSessions = await Promise.all(sessions.map(async session => this._toChatSessionItem(session)));

		const count = diskSessions.length;
		this.commandExecutionService.executeCommand('setContext', 'github.copilot.chat.cliSessionsEmpty', count === 0);

		return diskSessions;
	}

	private shouldShowSession(sessionId: string): boolean | undefined {
		if (isUntitledSessionId(sessionId)) {
			return true;
		}
		// If we have a workspace folder for this and the workspace folder belongs to one of the open workspace folders, show it.
		const workspaceFolder = this.workspaceFolderService.getSessionWorkspaceFolder(sessionId);
		if (workspaceFolder && this.workspaceService.getWorkspaceFolders().length) {
			return !!this.workspaceService.getWorkspaceFolder(workspaceFolder);
		}
		// If we have a git worktree and the worktree's repo belongs to one of the workspace folders, show it.
		const worktree = this.worktreeManager.getWorktreeProperties(sessionId);
		if (worktree && this.workspaceService.getWorkspaceFolders().length) {
			// If we have a repository path, then its easy to tell whether this should be displayed or hidden.
			return !!this.workspaceService.getWorkspaceFolder(URI.file(worktree.repositoryPath));
		}
		// Unless we are in an empty window, exclude sessions without workspace folder or git repo association.
		if (this.workspaceService.getWorkspaceFolders().length) {
			return false;
		}
		return undefined;
	}

	private async _toChatSessionItem(session: ICopilotCLISessionItem): Promise<vscode.ChatSessionItem> {
		const resource = SessionIdForCLI.getResource(_untitledSessionIdMap.get(session.id) ?? session.id);
		const worktreeProperties = this.worktreeManager.getWorktreeProperties(session.id);

		const label = session.label;

		// Badge
		let badge: vscode.MarkdownString | undefined;
		if (worktreeProperties?.branchName) {
			badge = new vscode.MarkdownString(`$(worktree) ${worktreeProperties.branchName}`);
			badge.supportThemeIcons = true;
		}

		// Statistics
		const changes = await this.worktreeManager.getWorktreeChanges(session.id);

		// Status
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

	public async createCopilotCLITerminal(): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || l10n.t('Background Agent');
		await this.terminalIntegration.openTerminal(terminalName);
	}

	public async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const id = SessionIdForCLI.parse(sessionItem.resource);
		const terminalName = sessionItem.label || id;
		const cliArgs = ['--resume', id];
		await this.terminalIntegration.openTerminal(terminalName, cliArgs);
	}
}

async function trackSelectedFolderOrRepo(sessionId: string, id: string, workspaceFolderService: IChatSessionWorkspaceFolderService, copilotCLIWorktreeManagerService: IChatSessionWorktreeService): Promise<void> {
	// Lets always assume the selection is a workspace folder.
	// This is to avoid opening the repo and checking if its a git repo or not
	// Doing that causes side effects of displaying Git Repo in SCM when user has done nothing, but just selected something.
	await workspaceFolderService.trackSessionWorkspaceFolder(sessionId, id);
}

export class CopilotCLIChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;
	private readonly _onDidChangeChatSessionProviderOptions = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionProviderOptions = this._onDidChangeChatSessionProviderOptions.event;
	constructor(
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@IChatSessionWorktreeService private readonly copilotCLIWorktreeManagerService: IChatSessionWorktreeService,
		@IChatSessionWorkspaceFolderService private readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@IGitService private readonly gitService: IGitService
	) {
		super();

		const originalRepos = this.getRepositoryOptionItems().length;
		this._register(this.gitService.onDidFinishInitialization(() => {
			if (originalRepos !== this.getRepositoryOptionItems().length) {
				this._onDidChangeChatSessionProviderOptions.fire();
			}
		}));
		this._register(this.gitService.onDidOpenRepository(() => {
			if (originalRepos !== this.getRepositoryOptionItems().length) {
				this._onDidChangeChatSessionProviderOptions.fire();
			}
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._onDidChangeChatSessionProviderOptions.fire();
		}));
		this._register(this.copilotCLIAgents.onDidChangeAgents(() => {
			this._onDidChangeChatSessionProviderOptions.fire();
		}));
	}

	public notifySessionOptionsChange(resource: vscode.Uri, updates: ReadonlyArray<{ optionId: string; value: string | vscode.ChatSessionProviderOptionItem }>): void {
		this._onDidChangeChatSessionOptions.fire({ resource, updates });
	}

	public notifyProviderOptionsChange(): void {
		this._onDidChangeChatSessionProviderOptions.fire();
	}

	async provideChatSessionContent(resource: Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const copilotcliSessionId = SessionIdForCLI.parse(resource);
		const workingDirectoryValue = this.copilotCLIWorktreeManagerService.getWorktreePath(copilotcliSessionId);
		const workingDirectory = workingDirectoryValue ? workingDirectoryValue : undefined;
		const isolationEnabled = workingDirectoryValue ? true : false; // If theres' a worktree, that means isolation was enabled.

		const [defaultModel, sessionAgent, defaultAgent, existingSession, repositories] = await Promise.all([
			this.copilotCLIModels.getDefaultModel(),
			this.copilotCLIAgents.getSessionAgent(copilotcliSessionId),
			this.copilotCLIAgents.getDefaultAgent(),
			isUntitledSessionId(copilotcliSessionId) ? Promise.resolve(undefined) : this.sessionService.getSession(copilotcliSessionId, { workingDirectory, isolationEnabled, readonly: true }, token),
			this.isUntitledWorkspace() ? this.getRepositoryOptionItemsForUntitledWorkspace() : Promise.resolve(this.getRepositoryOptionItems())
		]);

		// If we have session in _sessionModel, use that (faster as its in memory), else get from existing session.
		const model = (existingSession ? (_sessionModel.get(copilotcliSessionId) ?? await existingSession.object.getSelectedModelId()) : _sessionModel.get(copilotcliSessionId)) ?? await this.getCustomAgentModel(defaultAgent, token) ?? defaultModel;

		const options: Record<string, string | vscode.ChatSessionProviderOptionItem> = {};

		options[AGENTS_OPTION_ID] = sessionAgent ?? defaultAgent;

		// Possible there are no models (e.g. all models have been turned off by policy or the like).
		if (model) {
			options[MODELS_OPTION_ID] = model;
		}

		const worktreeProperties = this.copilotCLIWorktreeManagerService.getWorktreeProperties(copilotcliSessionId);
		const repository = worktreeProperties ? Uri.file(worktreeProperties.repositoryPath) : undefined;
		const sessionWorkspaceFolder = this.workspaceFolderService.getSessionWorkspaceFolder(copilotcliSessionId);

		if (repository) {
			if (isUntitledSessionId(copilotcliSessionId)) {
				options[REPOSITORY_OPTION_ID] = repository.fsPath;
			} else {
				options[REPOSITORY_OPTION_ID] = {
					...toRepositoryOptionItem(repository),
					locked: true
				};
			}
		} else if (sessionWorkspaceFolder) {
			if (isUntitledSessionId(copilotcliSessionId)) {
				options[REPOSITORY_OPTION_ID] = sessionWorkspaceFolder.fsPath;
			} else {
				const folderName = this.workspaceService.getWorkspaceFolderName(sessionWorkspaceFolder) || basename(sessionWorkspaceFolder);
				options[REPOSITORY_OPTION_ID] = {
					...toWorkspaceFolderOptionItem(sessionWorkspaceFolder, folderName),
					locked: true
				};
			}
		} else if (isUntitledSessionId(copilotcliSessionId)) {
			if (repositories.length) {
				const firstRepo = (lastUsedFolderIdInUntitledWorkspace && repositories.find(repo => repo.id === lastUsedFolderIdInUntitledWorkspace)?.id) ?? repositories[0].id;
				options[REPOSITORY_OPTION_ID] = firstRepo;
				await trackSelectedFolderOrRepo(copilotcliSessionId, firstRepo, this.workspaceFolderService, this.copilotCLIWorktreeManagerService);
			}
		} else {
			// This is an existing session without a worktree, display current workspace folder.
			options[REPOSITORY_OPTION_ID] = {
				id: '',
				name: this.workspaceService.getWorkspaceFolders().length === 1 ? this.workspaceService.getWorkspaceFolderName(this.workspaceService.getWorkspaceFolders()[0]) : l10n.t('Current Workspace'),
				icon: new vscode.ThemeIcon('repo'),
				locked: true
			};
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
		const [models, defaultModel] = await Promise.all([
			this.copilotCLIModels.getModels(),
			this.copilotCLIModels.getDefaultModel(),
		]);
		const modelItems: vscode.ChatSessionProviderOptionItem[] = models.map(model => ({
			id: model.id,
			name: model.name,
			description: model.multiplier !== undefined ? `${model.multiplier}x` : undefined,
			default: model.id === defaultModel
		}));

		const optionGroups: vscode.ChatSessionProviderOptions['optionGroups'] = [
			{
				id: MODELS_OPTION_ID,
				name: l10n.t('Model'),
				description: l10n.t('Pick Model'),
				items: modelItems
			}
		];

		// Handle repository options based on workspace type
		if (this.isUntitledWorkspace()) {
			// For untitled workspaces, show last used repositories and "Open Repository..." command
			const repositories = await this.getRepositoryOptionItemsForUntitledWorkspace();
			optionGroups.push({
				id: REPOSITORY_OPTION_ID,
				name: l10n.t('Folder'),
				description: l10n.t('Pick Folder'),
				items: repositories,
				commands: [{
					command: OPEN_REPOSITORY_COMMAND_ID,
					title: l10n.t('Open Folder...')
				}]
			});
		} else {
			const repositories = this.getRepositoryOptionItems();
			if (repositories.length > 1) {
				optionGroups.push({
					id: REPOSITORY_OPTION_ID,
					name: l10n.t('Folder'),
					description: l10n.t('Pick Folder'),
					items: repositories
				});
			}
		}

		return {
			optionGroups
		};
	}

	/**
	 * Check if the current workspace is untitled (has no workspace folders).
	 */
	private isUntitledWorkspace(): boolean {
		return this.workspaceService.getWorkspaceFolders().length === 0;
	}

	private getRepositoryOptionItems() {
		// Exclude worktrees from the repository list
		const repositories = this.gitService.repositories
			.filter(repository => repository.kind !== 'worktree');

		const repoItems = repositories
			.map(repository => toRepositoryOptionItem(repository));

		// In multi-root workspaces, also include workspace folders that don't have any git repos
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length > 1) {
			// Find workspace folders that contain git repos
			const foldersWithRepos = new Set<string>();
			for (const repo of repositories) {
				const folder = this.workspaceService.getWorkspaceFolder(repo.rootUri);
				if (folder) {
					foldersWithRepos.add(folder.fsPath);
				}
			}

			// Add workspace folders that don't have any git repos
			for (const folder of workspaceFolders) {
				if (!foldersWithRepos.has(folder.fsPath)) {
					const folderName = this.workspaceService.getWorkspaceFolderName(folder);
					repoItems.push(toWorkspaceFolderOptionItem(folder, folderName));
				}
			}
		}

		return repoItems.sort((a, b) => a.name.localeCompare(b.name));
	}

	private _repositoryOptionItemsForUntitledWorkspace: Promise<ChatSessionProviderOptionItem[]> | undefined;

	/**
	 * Get repository option items for untitled workspaces using last used repositories.
	 */
	private async getRepositoryOptionItemsForUntitledWorkspace(): Promise<ChatSessionProviderOptionItem[]> {
		const currentValue = this._repositoryOptionItemsForUntitledWorkspace;
		// Re-query in case some folders changed or new items have been added.
		this._repositoryOptionItemsForUntitledWorkspace = this.getRepositoryOptionItemsForUntitledWorkspaceImpl();
		// Always return cached value for faster loading.
		return currentValue ?? this._repositoryOptionItemsForUntitledWorkspace;
	}

	private async getRepositoryOptionItemsForUntitledWorkspaceImpl(): Promise<ChatSessionProviderOptionItem[]> {
		const latestReposAndFolders: { uri: Uri; type: 'repo' | 'folder'; lastUsed: number }[] = [];
		const seenUris = new ResourceSet();

		untitledWorkspaceRepositories.forEach((lastUsed, uri) => {
			seenUris.add(uri);
			latestReposAndFolders.push({ uri, type: 'repo', lastUsed });
		});

		untitledWorkspaceFodlers.forEach((lastUsed, uri) => {
			seenUris.add(uri);
			latestReposAndFolders.push({ uri, type: 'folder', lastUsed });
		});

		// Last used git repositories
		for (const repo of this.gitService.getRecentRepositories()) {
			if (seenUris.has(repo.rootUri)) {
				continue;
			}
			seenUris.add(repo.rootUri);
			listOfKnownRepos.add(repo.rootUri);
			latestReposAndFolders.push({ uri: repo.rootUri, type: 'repo', lastUsed: repo.lastAccessTime });
		}

		// Last used workspace folders without git repos
		for (const repo of this.workspaceFolderService.getRecentFolders()) {
			if (seenUris.has(repo.folder)) {
				continue;
			}
			seenUris.add(repo.folder);
			latestReposAndFolders.push({ uri: repo.folder, type: 'folder', lastUsed: repo.lastAccessTime });
		}

		// Filter out items that no longer exist.
		const latest10ReposAndFolders: { uri: Uri; type: 'repo' | 'folder'; lastUsed: number }[] = [];
		await Promise.all(latestReposAndFolders.slice(0, 20).map(async (repoAccess) => {
			if (await checkPathExists(repoAccess.uri, this.fileSystem)) {
				latest10ReposAndFolders.push(repoAccess);
			}
		}));

		// Sort by last used time descending and take top 10
		latest10ReposAndFolders.sort((a, b) => b.lastUsed - a.lastUsed);
		const latestReposAndFoldersLimited = latest10ReposAndFolders.slice(0, 10);

		return latestReposAndFoldersLimited.map((repoAccess) => {
			if (repoAccess.type === 'folder') {
				return toWorkspaceFolderOptionItem(repoAccess.uri, basename(repoAccess.uri));
			} else {
				return toRepositoryOptionItem(repoAccess.uri);
			}
		});
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
				const agent = update.value ? await this.copilotCLIAgents.resolveAgent(update.value) : undefined;
				if (agent?.name) {
					await this.selectAgentModel(resource, agent, token);
				}
			} else if (update.optionId === REPOSITORY_OPTION_ID && typeof update.value === 'string') {
				await trackSelectedFolderOrRepo(sessionId, update.value, this.workspaceFolderService, this.copilotCLIWorktreeManagerService);
				if (this.isUntitledWorkspace()) {
					lastUsedFolderIdInUntitledWorkspace = update.value;
				}
			}
		}
	}

	async getCustomAgentModel(agentId: string, token: vscode.CancellationToken): Promise<string | undefined> {
		const agent = agentId ? await this.copilotCLIAgents.resolveAgent(agentId) : undefined;
		if (!agent) {
			return;
		}
		for (const workspaceFolder of this.workspaceService.getWorkspaceFolders()) {
			const agentFile = URI.joinPath(workspaceFolder, '.github', 'agents', agent.name + '.agent.md');
			try {
				if (!(await checkPathExists(agentFile, this.fileSystem))) {
					continue;
				}
				const parsedFile = await this.promptsService.parseFile(agentFile, token);
				if (!parsedFile.header?.model) {
					continue;
				}
				let modelId = await this.copilotCLIModels.resolveModel(parsedFile.header.model);
				if (modelId) {
					return modelId;
				}
				// Sometimes the models can contain ` (Copilot)` suffix, try stripping that and resolving again.
				if (!parsedFile.header.model.includes('(')) {
					continue;
				}
				modelId = await this.copilotCLIModels.resolveModel(parsedFile.header.model.substring(0, parsedFile.header.model.indexOf('(')).trim());
				if (modelId) {
					return modelId;
				}
			} catch {
				continue;
			}
		}
	}

	async selectAgentModel(resource: Uri, agent: SweCustomAgent, token: vscode.CancellationToken): Promise<void> {
		const agentModel = await this.getCustomAgentModel(agent.name, token);
		if (agentModel) {
			const sessionId = SessionIdForCLI.parse(resource);
			_sessionModel.set(sessionId, agentModel);
		}
	}
}

async function checkPathExists(filePath: Uri, fileSystem: IFileSystemService): Promise<boolean> {
	try {
		await fileSystem.stat(filePath);
		return true;
	} catch (error) {
		return false;
	}
}

function toRepositoryOptionItem(repository: RepoContext | Uri, isDefault: boolean = false): ChatSessionProviderOptionItem {
	const repositoryUri = isUri(repository) ? repository : repository.rootUri;
	const repositoryIcon = isUri(repository) ? 'repo' : repository.kind === 'repository' ? 'repo' : 'archive';
	const repositoryName = repositoryUri.path.split('/').pop() ?? repositoryUri.toString();

	return {
		id: repositoryUri.fsPath,
		name: repositoryName,
		icon: new vscode.ThemeIcon(repositoryIcon),
		default: isDefault
	} satisfies vscode.ChatSessionProviderOptionItem;
}


function toWorkspaceFolderOptionItem(workspaceFolderUri: URI, name: string): ChatSessionProviderOptionItem {
	return {
		id: workspaceFolderUri.fsPath,
		name: name,
		icon: new vscode.ThemeIcon('folder'),
	} satisfies vscode.ChatSessionProviderOptionItem;
}

const WAIT_FOR_NEW_SESSION_TO_GET_USED = 5 * 60 * 1000; // 5 minutes
const CLI_MOVE_CHANGES = l10n.t('Move Changes');
const CLI_COPY_CHANGES = l10n.t('Copy Changes');
const CLI_SKIP_CHANGES = l10n.t('Skip Changes');
const CLI_CANCEL = l10n.t('Cancel');

export class CopilotCLIChatSessionParticipant extends Disposable {
	private readonly untitledSessionIdMapping = new Map<string, string>();
	constructor(
		private readonly contentProvider: CopilotCLIChatSessionContentProvider,
		private readonly promptResolver: CopilotCLIPromptResolver,
		private readonly sessionItemProvider: CopilotCLIChatSessionItemProvider,
		private readonly cloudSessionProvider: CopilotCloudSessionsProvider | undefined,
		@IGitService private readonly gitService: IGitService,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
		@IChatSessionWorktreeService private readonly copilotCLIWorktreeManagerService: IChatSessionWorktreeService,
		@IChatSessionWorkspaceFolderService private readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IToolsService private readonly toolsService: IToolsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@IChatDelegationSummaryService private readonly chatDelegationSummaryService: IChatDelegationSummaryService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		super();
	}

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private readonly contextForRequest = new Map<string, { prompt: string; attachments: Attachment[] }>();
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
			let selectedRepository: RepoContext | undefined;
			if (chatSessionContext?.chatSessionItem) {
				if (chatSessionContext.isUntitled) {
					// Possible user selected a folder, and its possible the folder is a git repo
					const folder = this.workspaceFolderService.getSessionWorkspaceFolder(SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource));
					if (folder) {
						const { repository, trusted } = await this.getCachedRepository(folder);
						if (!trusted) {
							stream.warning(l10n.t('The selected folder is not trusted.'));
							return {};
						}
						selectedRepository = repository;
					}
				} else {
					// Existing session, get worktree repository, and no need to migrate changes.
				}
			} else if (this.workspaceService.getWorkspaceFolders().length === 1) {
				selectedRepository = this.gitService.activeRepository.get();
			}
			const hasUncommittedChanges = selectedRepository?.changes
				? (selectedRepository.changes.indexChanges.length > 0 || selectedRepository.changes.workingTree.length > 0)
				: false;

			if (!chatSessionContext) {
				// Delegating from another chat session
				return await this.handleDelegationFromAnotherChat(request, context, confirmationResults, hasUncommittedChanges, stream, token);
			}

			const { resource } = chatSessionContext.chatSessionItem;
			const id = SessionIdForCLI.parse(resource);
			const isUntitled = chatSessionContext.isUntitled;
			const uncommittedChangesAction = confirmationResults.length > 0 ? this.getConfirmationResult(request) : undefined;

			// Handle untitled sessions with uncommitted changes
			if (isUntitled && hasUncommittedChanges) {
				if (confirmationResults.length === 0) {
					// Show confirmation prompt
					return this.generateUncommittedChangesConfirmation(request, context, stream, true);
				}
			}
			// Check if user cancelled
			if (isUntitled && uncommittedChangesAction === 'cancel') {
				return {};
			}

			const [modelId, agent] = await Promise.all([
				this.getModelId(id, request, false, token),
				this.getAgent(id, request, token),
			]);
			if (isUntitled && (modelId || agent)) {
				const promptFile = await this.getPromptInfoFromRequest(request, token);
				if (promptFile) {
					const changes: { optionId: string; value: string }[] = [];
					changes.push({ optionId: AGENTS_OPTION_ID, value: agent?.name ?? '' });
					if (modelId) {
						changes.push({ optionId: MODELS_OPTION_ID, value: modelId });
					}
					if (changes.length > 0) {
						this.contentProvider.notifySessionOptionsChange(resource, changes);
					}
				}
			}

			const session = await this.getOrCreateSession(request, chatSessionContext, modelId, agent, uncommittedChangesAction !== 'cancel' ? uncommittedChangesAction : undefined, stream, disposables, token);
			if (!session || token.isCancellationRequested) {
				return {};
			}

			this.copilotCLIAgents.trackSessionAgent(session.object.sessionId, agent?.name);
			if (session.object.options.workingDirectory && !session.object.options.isolationEnabled) {
				const workspaceFolder = this.workspaceService.getWorkspaceFolder(session.object.options.workingDirectory);
				if (workspaceFolder) {
					void this.workspaceFolderService.trackSessionWorkspaceFolder(session.object.sessionId, workspaceFolder.fsPath);
				}
			}
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
				return await this.handleDelegationToCloudConfirmation(request, session.object, request.prompt, confirmationResults, context, stream, token);
			}

			// Check if we have context stored for this request (created in createCLISessionAndSubmitRequest, work around)
			const contextForRequest = this.contextForRequest.get(session.object.sessionId);
			this.contextForRequest.delete(session.object.sessionId);
			if (request.prompt.startsWith('/delegate')) {
				await this.handleDelegationToCloud(session.object, request, context, stream, token);
			} else if (contextForRequest) {
				// This is a request that was created in createCLISessionAndSubmitRequest with attachments already resolved.
				const { prompt, attachments } = contextForRequest;
				this.contextForRequest.delete(session.object.sessionId);
				await session.object.handleRequest(request.id, prompt, attachments, modelId, token);
				await this.commitWorktreeChangesIfNeeded(session.object, token);
			} else {
				// Get the original prompt from confirmation metadata if this is a confirmation response
				const originalPrompt = this.getUncommittedChangesConfirmationData(confirmationResults)?.metadata?.prompt;

				// Construct the full prompt with references to be sent to CLI.
				const { prompt, attachments } = await this.promptResolver.resolvePrompt(request, originalPrompt, [], session.object.options.isolationEnabled, session.object.options.workingDirectory, token);
				await session.object.handleRequest(request.id, prompt, attachments, modelId, token);
				await this.commitWorktreeChangesIfNeeded(session.object, token);
			}

			if (isUntitled && !token.isCancellationRequested) {
				// Delete old information stored for untitled session id.
				_sessionModel.delete(id);
				_sessionModel.set(session.object.sessionId, modelId);
				this.untitledSessionIdMapping.delete(id);
				_untitledSessionIdMap.delete(session.object.sessionId);
				// Use original prompt from confirmation metadata if available, otherwise use request.prompt
				const labelPrompt = this.getUncommittedChangesConfirmationData(confirmationResults)?.metadata?.prompt ?? request.prompt;
				this.sessionItemProvider.swap(chatSessionContext.chatSessionItem, { resource: SessionIdForCLI.getResource(session.object.sessionId), label: labelPrompt });
			}
			return {};
		} catch (ex) {
			if (isCancellationError(ex)) {
				return {};
			}
			throw ex;
		}
		finally {
			if (chatSessionContext?.chatSessionItem.resource) {
				this.sessionItemProvider.notifySessionsChange();
			}
			disposables.dispose();
		}
	}

	private readonly _repositoryCacheInEmptyWorkspace = new ResourceMap<{ repository: RepoContext | undefined; trusted: boolean }>();
	/**
	 * When using `getRepository` in an empty workspace, that requires special care.
	 * We shouldn't call that too often, as it results in displaying the Trust dialog.
	 * And if user doesn't trust, then we can't proceed. But if we call that multiple times, that results in multiple trust dialogs.
	 * Hence in the case of empty workspace, we cache the repository info.
	 */
	private async getCachedRepository(repoPath: Uri): Promise<{ repository: RepoContext | undefined; trusted: boolean }> {
		if (this.workspaceService.getWorkspaceFolders().length) {
			const repository = await this.gitService.getRepository(repoPath, true);
			return { repository, trusted: true };
		}

		const cachedRepo = this._repositoryCacheInEmptyWorkspace.get(repoPath);
		// If we have repo then it's trusted, let's get the latest information again by requesting the repo again.
		if (cachedRepo) {
			const repository = await this.gitService.getRepository(repoPath, true);
			return { repository, trusted: true };
		}
		// Ask the user if they trust the folder before we look for repos.
		const trusted = await this.workspaceService.requestResourceTrust({ uri: repoPath, message: untrustedFolderMessage });
		if (!trusted) {
			// User didn't trust, we can't proceed.
			const result = { repository: undefined, trusted: false };
			this._repositoryCacheInEmptyWorkspace.set(repoPath, result);
			return result;
		}
		const repository = await this.gitService.getRepository(repoPath, true);
		const result = repository ? { repository, trusted: true } : { repository: undefined, trusted: true };
		this._repositoryCacheInEmptyWorkspace.set(repoPath, result);
		return result;
	}

	private async commitWorktreeChangesIfNeeded(session: ICopilotCLISession, token: vscode.CancellationToken): Promise<void> {
		if (session.status === vscode.ChatSessionStatus.Completed && session.options.isolationEnabled && !token.isCancellationRequested) {
			// When isolation is enabled and we are using a git worktree, we either stage
			// or commit all changes in the working directory when the session is completed
			await this.copilotCLIWorktreeManagerService.handleRequestCompleted(session.sessionId);
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

	private async getOrCreateSession(request: vscode.ChatRequest, chatSessionContext: vscode.ChatSessionContext, model: string | undefined, agent: SweCustomAgent | undefined, uncommitedChangesAction: 'copy' | 'move' | 'skip' | undefined, stream: vscode.ChatResponseStream, disposables: DisposableStore, token: vscode.CancellationToken): Promise<IReference<ICopilotCLISession> | undefined> {
		const { resource } = chatSessionContext.chatSessionItem;
		const existingSessionId = this.untitledSessionIdMapping.get(SessionIdForCLI.parse(resource));
		const id = existingSessionId ?? SessionIdForCLI.parse(resource);
		const isNewSession = chatSessionContext.isUntitled && !existingSessionId;

		const { isolationEnabled, workingDirectory, worktreeProperties, cancelled } = await this.getOrInitializeWorkingDirectory(chatSessionContext, uncommitedChangesAction, stream, token);
		if (cancelled || token.isCancellationRequested) {
			return undefined;
		}

		const session = isNewSession ?
			await this.sessionService.createSession({ model, workingDirectory, isolationEnabled, agent }, token) :
			await this.sessionService.getSession(id, { model, workingDirectory, isolationEnabled, readonly: false, agent }, token);
		this.sessionItemProvider.notifySessionsChange();

		if (!session) {
			stream.warning(l10n.t('Chat session not found.'));
			return undefined;
		}
		this.logService.info(`Using Copilot CLI session: ${session.object.sessionId} (isNewSession: ${isNewSession}, isolationEnabled: ${isolationEnabled}, workingDirectory: ${workingDirectory}, worktreePath: ${worktreeProperties?.worktreePath}, changesAction: ${uncommitedChangesAction})`);
		if (isNewSession) {
			this.untitledSessionIdMapping.set(id, session.object.sessionId);
		}
		if (isNewSession && worktreeProperties) {
			void this.copilotCLIWorktreeManagerService.setWorktreeProperties(session.object.sessionId, worktreeProperties);
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

	private async handleDelegationToCloud(session: ICopilotCLISession, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		if (!this.cloudSessionProvider) {
			stream.warning(l10n.t('No cloud agent available'));
			return;
		}

		// Check for uncommitted changes
		const worktreeProperties = this.copilotCLIWorktreeManagerService.getWorktreeProperties(session.sessionId);
		const repositoryPath = worktreeProperties?.repositoryPath ? Uri.file(worktreeProperties.repositoryPath) : session.options.workingDirectory;
		const repository = repositoryPath ? await this.gitService.getRepository(repositoryPath) : undefined;
		const hasChanges = (repository?.changes?.indexChanges && repository.changes.indexChanges.length > 0);

		if (hasChanges) {
			stream.warning(l10n.t('You have uncommitted changes in your workspace. The cloud agent will start from the last committed state. Consider committing your changes first if you want to include them.'));
		}

		const prompt = request.prompt.substring('/delegate'.length).trim();

		const prInfo = await this.cloudSessionProvider.delegate(request, stream, context, token, { prompt, chatContext: context });
		await this.recordPushToSession(session, request.prompt, prInfo);

	}

	private getAcceptedRejectedConfirmationData(request: vscode.ChatRequest): ConfirmationResult[] {
		const results: ConfirmationResult[] = [];
		results.push(...(request.acceptedConfirmationData?.map(data => ({ step: data.step, accepted: true, metadata: data?.metadata })) ?? []));
		results.push(...((request.rejectedConfirmationData ?? []).filter(data => !results.some(r => r.step === data.step)).map(data => ({ step: data.step, accepted: false, metadata: data?.metadata }))));

		return results;
	}

	private async handleDelegationToCloudConfirmation(request: vscode.ChatRequest, session: ICopilotCLISession, prompt: string, results: ConfirmationResult[], context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		const uncommittedChangesData = results.find(data => data.step === UncommittedChangesStep);
		if (!uncommittedChangesData) {
			stream.warning(`Unknown confirmation step: ${results.map(r => r.step).join(', ')}\n\n`);
			return {};
		}

		if (!uncommittedChangesData.accepted || !uncommittedChangesData.metadata) {
			stream.markdown(l10n.t('Cloud agent delegation request cancelled.'));
			return {};
		}

		const prInfo = await this.cloudSessionProvider?.delegate(request, stream, context, token, uncommittedChangesData.metadata);
		if (prInfo) {
			await this.recordPushToSession(session, prompt, prInfo);
		}
		return {};
	}

	private async handleDelegationFromAnotherChat(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		confirmationResults: ConfirmationResult[],
		hasUncommittedChanges: boolean,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult | void> {
		// Check if this is a confirmation response
		if (confirmationResults.length > 0) {
			const uncommittedChangesData = this.getUncommittedChangesConfirmationData(confirmationResults);
			if (!uncommittedChangesData || !uncommittedChangesData.metadata) {
				stream.warning(l10n.t('Invalid confirmation data.'));
				return {};
			}
			const selection = this.getConfirmationResult(request);
			if (selection === 'cancel' || token.isCancellationRequested) {
				stream.markdown(l10n.t('Background Agent delegation cancelled.'));
				return {};
			}

			const prompt = uncommittedChangesData.metadata.prompt;
			const references = uncommittedChangesData.metadata.references?.length ? uncommittedChangesData.metadata.references : request.references;
			return await this.createCLISessionAndSubmitRequest(request, prompt, references, context, selection, stream, token);
		}

		// Check for uncommitted changes
		if (!hasUncommittedChanges) {
			return await this.createCLISessionAndSubmitRequest(request, undefined, request.references, context, undefined, stream, token);
		}

		return this.generateUncommittedChangesConfirmation(request, context, stream, false);
	}

	private generateUncommittedChangesConfirmation(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		isUntitled: boolean,
	): vscode.ChatResult | void {
		const message = isUntitled ?
			l10n.t('The selected repository has uncommitted changes. Should these changes be included in the new worktree?') :
			l10n.t('Background Agent will work in an isolated worktree to implement your requested changes.')
			+ '\n\n'
			+ l10n.t('The selected repository has uncommitted changes. Should these changes be included in the new worktree?');

		const buttons = [
			CLI_COPY_CHANGES,
			CLI_MOVE_CHANGES,
			CLI_SKIP_CHANGES,
			CLI_CANCEL
		];

		const title = isUntitled
			? l10n.t('Uncommitted Changes')
			: l10n.t('Delegate to Background Agent');

		stream.confirmation(
			title,
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

	private getConfirmationResult(request: vscode.ChatRequest): 'move' | 'copy' | 'skip' | 'cancel' {
		const selection = (request.prompt?.split(':')[0] || '').trim().toUpperCase();
		switch (selection) {
			case CLI_MOVE_CHANGES.toUpperCase():
				return 'move';
			case CLI_COPY_CHANGES.toUpperCase():
				return 'copy';
			case CLI_SKIP_CHANGES.toUpperCase():
				return 'skip';
			default:
				return 'cancel';
		}
	}

	private getUncommittedChangesConfirmationData(confirmationResults: ConfirmationResult[]): ConfirmationResult | undefined {
		return confirmationResults.find(data => data.step === UncommittedChangesStep);
	}

	private async getOrInitializeWorkingDirectory(
		chatSessionContext: vscode.ChatSessionContext | undefined,
		uncommittedChangesAction: 'move' | 'copy' | 'skip' | undefined,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<{
		isolationEnabled: boolean;
		workingDirectory: Uri | undefined;
		worktreeProperties: ChatSessionWorktreeProperties | undefined;
		cancelled: boolean;
	}> {
		const createWorkingTreeIfRequired = async (sessionId: string | undefined) => {
			// Check if the session has a workspace folder tracked (folder without git repo)
			const sessionWorkspaceFolder = sessionId ? this.workspaceFolderService.getSessionWorkspaceFolder(sessionId) : undefined;
			let selectedRepository: vscode.Uri | undefined;
			const workingDirectory = selectedRepository ? this.workspaceService.getWorkspaceFolder(selectedRepository) : undefined;

			// If user hasn't selected a repository, e.g. when delegating, then use the active repository.
			// But don't do this in a untitled/empty workspace folder (its possible to have a repo opened as a side effect of getRepository, that doesn't necessaily mean user wants to use that)
			if (!sessionId && !selectedRepository && !sessionWorkspaceFolder && this.workspaceService.getWorkspaceFolders().length === 1) {
				selectedRepository = this.gitService.activeRepository.get()?.rootUri;
			}

			if (!selectedRepository && sessionWorkspaceFolder) {

				// Possible we now have a git repo in this folder, check again.
				const { repository, trusted } = await this.getCachedRepository(sessionWorkspaceFolder);
				if (!trusted) {
					stream.warning(l10n.t('The selected folder is not trusted.'));
					return { workingDirectory: undefined, worktreeProperties: undefined, isWorkspaceFolderWithoutRepo: true, cancelled: true };
				}
				selectedRepository = repository?.rootUri;
				if (!(selectedRepository)) {
					// Workspace folder without git repo - no worktree can be created, use folder directly
					return { workingDirectory: sessionWorkspaceFolder, worktreeProperties: undefined, isWorkspaceFolderWithoutRepo: true, cancelled: false };
				}
			}

			if (!selectedRepository) {
				return { workingDirectory, worktreeProperties: undefined, isWorkspaceFolderWithoutRepo: false, cancelled: false };
			}

			// Note: The repository will already be trusted, Git Extension API only returns trusted repos.
			const worktreeProperties = await this.copilotCLIWorktreeManagerService.createWorktree(selectedRepository, stream);
			if (worktreeProperties) {
				return { workingDirectory: Uri.file(worktreeProperties.worktreePath), worktreeProperties, isWorkspaceFolderWithoutRepo: false, cancelled: false };
			} else {
				stream.warning(l10n.t('Failed to create worktree. Proceeding without isolation.'));
				return { workingDirectory, worktreeProperties: undefined, isWorkspaceFolderWithoutRepo: false, cancelled: false };
			}
		};

		let workingDirectory: Uri | undefined;
		let worktreeProperties: Awaited<ReturnType<IChatSessionWorktreeService['createWorktree']>> | undefined;
		let isolationEnabled = true;
		let isWorkspaceFolderWithoutRepo = false;
		let cancelled = false;

		if (chatSessionContext) {
			const existingSessionId = this.untitledSessionIdMapping.get(SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource));
			const id = existingSessionId ?? SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource);
			const isNewSession = chatSessionContext.isUntitled && !existingSessionId;

			if (isNewSession) {
				({ workingDirectory, worktreeProperties, isWorkspaceFolderWithoutRepo, cancelled } = await createWorkingTreeIfRequired(id));
				// Means we failed to create worktree or this is a workspace folder without git repo
				if (!worktreeProperties) {
					isolationEnabled = false;
				}
			} else {
				workingDirectory = this.copilotCLIWorktreeManagerService.getWorktreePath(id);
				const sessionWorkspaceFolder = this.workspaceFolderService.getSessionWorkspaceFolder(id);
				// Check if this is an existing session with a workspace folder (no git repo)
				if (!workingDirectory && sessionWorkspaceFolder) {
					workingDirectory = sessionWorkspaceFolder;
					isWorkspaceFolderWithoutRepo = true;
					isolationEnabled = false;
				}
			}
		} else {
			({ workingDirectory, worktreeProperties, isWorkspaceFolderWithoutRepo, cancelled } = await createWorkingTreeIfRequired(undefined));
			// Means we failed to create worktree or this is a workspace folder without git repo
			if (!worktreeProperties) {
				isolationEnabled = false;
			}
		}

		// Migrate changes from active repository to worktree (only if we have a worktree, not for workspace folders without git)
		if (worktreeProperties?.worktreePath && !isWorkspaceFolderWithoutRepo && (uncommittedChangesAction === 'move' || uncommittedChangesAction === 'copy')) {
			await this.moveOrCopyChangesToWorkTree(Uri.file(worktreeProperties.repositoryPath), Uri.file(worktreeProperties.worktreePath), uncommittedChangesAction, stream, token);
		}

		// If we failed to create a worktree or isolation is disabled, then isolation is false
		return { isolationEnabled, workingDirectory, worktreeProperties, cancelled };
	}

	private async moveOrCopyChangesToWorkTree(
		repositoryPath: Uri,
		worktreePath: Uri,
		moveOrCopyChanges: 'move' | 'copy',
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		// Migrate changes from active repository to worktree
		const activeRepository = await this.gitService.getRepository(repositoryPath);
		if (!activeRepository) {
			return;
		}
		const disposables = new DisposableStore();
		try {
			// Wait for the worktree repository to be ready
			stream.progress(l10n.t('Migrating changes to worktree...'));
			const worktreeRepo = await raceCancellation(new Promise<typeof activeRepository | undefined>((resolve) => {
				disposables.add(this.gitService.onDidOpenRepository(repo => {
					if (isEqual(repo.rootUri, worktreePath)) {
						resolve(repo);
					}
				}));

				this.gitService.getRepository(worktreePath).then(repo => {
					if (repo) {
						resolve(repo);
					}
				});

				disposables.add(createTimeout(10_000, () => resolve(undefined)));
			}), token);

			if (!worktreeRepo) {
				stream.warning(l10n.t('Failed to get worktree repository. Proceeding without migration.'));
			} else {
				await this.gitService.migrateChanges(worktreeRepo.rootUri, activeRepository.rootUri, {
					confirmation: false,
					deleteFromSource: moveOrCopyChanges === 'move',
					untracked: true
				});
				stream.markdown(l10n.t('Changes migrated to worktree.'));
			}
		} catch (error) {
			// Continue even if migration fails
			stream.warning(l10n.t('Failed to migrate some changes: {0}. Continuing with worktree creation.', error instanceof Error ? error.message : String(error)));
		} finally {
			disposables.dispose();
		}
	}

	private async createCLISessionAndSubmitRequest(
		request: vscode.ChatRequest,
		userPrompt: string | undefined,
		otherReferences: readonly vscode.ChatPromptReference[] | undefined,
		context: vscode.ChatContext,
		uncommittedChangesAction: 'move' | 'copy' | 'skip' | undefined,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		let summary: string | undefined;
		const requestPromptPromise = (async () => {
			if (this.hasHistoryToSummarize(context.history)) {
				stream.progress(l10n.t('Analyzing chat history'));
				summary = await this.chatDelegationSummaryService.summarize(context, token);
				summary = summary ? `**Summary**\n${summary}` : undefined;
			}

			// Give priority to userPrompt if provided (e.g., from confirmation metadata)
			userPrompt = userPrompt || request.prompt;
			return summary ? `${userPrompt}\n${summary}` : userPrompt;
		})();

		const [{ isolationEnabled, workingDirectory, worktreeProperties, cancelled }, model, agent] = await Promise.all([
			this.getOrInitializeWorkingDirectory(undefined, uncommittedChangesAction, stream, token),
			this.getModelId(undefined, request, true, token), // prefer model in request, as we're delegating from another session here.
			this.getAgent(undefined, undefined, token)
		]);

		if (cancelled || token.isCancellationRequested) {
			return {};
		}

		const { prompt, attachments, references } = await this.promptResolver.resolvePrompt(request, await requestPromptPromise, (otherReferences || []).concat([]), isolationEnabled, workingDirectory, token);

		const session = await this.sessionService.createSession({ workingDirectory, isolationEnabled, agent, model }, token);
		void this.copilotCLIAgents.trackSessionAgent(session.object.sessionId, agent?.name);
		if (summary) {
			const summaryRef = await this.chatDelegationSummaryService.trackSummaryUsage(session.object.sessionId, summary);
			if (summaryRef) {
				references.push(summaryRef);
			}
		}
		// Do not await, we want this code path to be as fast as possible.
		if (worktreeProperties) {
			void this.copilotCLIWorktreeManagerService.setWorktreeProperties(session.object.sessionId, worktreeProperties);
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
				.then(() => this.commitWorktreeChangesIfNeeded(session.object, token))
				.catch(error => {
					this.logService.error(`Failed to handle CLI session request: ${error}`);
					// Optionally: stream.error(error) to notify the user
				})
				.finally(() => {
					session.dispose();
				});
		}

		stream.markdown(l10n.t('A background agent has begun working on your request. Follow its progress in the sessions list.'));

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

export function registerCLIChatCommands(copilotcliSessionItemProvider: CopilotCLIChatSessionItemProvider, copilotCLISessionService: ICopilotCLISessionService, copilotCLIWorktreeManagerService: IChatSessionWorktreeService, gitService: IGitService, copilotCliWorkspaceSession: IChatSessionWorkspaceFolderService, contentProvider: CopilotCLIChatSessionContentProvider): IDisposable {
	const disposableStore = new DisposableStore();
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.delete', async (sessionItem?: vscode.ChatSessionItem) => {
		if (sessionItem?.resource) {
			const id = SessionIdForCLI.parse(sessionItem.resource);
			const worktree = copilotCLIWorktreeManagerService.getWorktreeProperties(id);
			const worktreePath = copilotCLIWorktreeManagerService.getWorktreePath(id);

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
				await copilotCliWorkspaceSession.deleteTrackedWorkspaceFolder(id);

				if (worktreePath) {
					try {
						const repository = worktree ? await gitService.getRepository(vscode.Uri.file(worktree.repositoryPath), true) : undefined;
						if (!repository) {
							throw new Error(l10n.t('No active repository found to delete worktree.'));
						}
						await gitService.deleteWorktree(repository.rootUri, worktreePath.fsPath);
					} catch (error) {
						vscode.window.showErrorMessage(l10n.t('Failed to delete worktree: {0}', error instanceof Error ? error.message : String(error)));
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
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.openWorktreeInNewWindow', async (sessionItem?: vscode.ChatSessionItem) => {
		if (!sessionItem?.resource) {
			return;
		}

		const id = SessionIdForCLI.parse(sessionItem.resource);
		const worktreePath = copilotCLIWorktreeManagerService.getWorktreePath(id);
		if (worktreePath) {
			await vscode.commands.executeCommand('vscode.openFolder', worktreePath, { forceNewWindow: true });
		}
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.sessions.openWorktreeInTerminal', async (sessionItem?: vscode.ChatSessionItem) => {
		if (!sessionItem?.resource) {
			return;
		}

		const id = SessionIdForCLI.parse(sessionItem.resource);
		const worktreePath = copilotCLIWorktreeManagerService.getWorktreePath(id);
		if (worktreePath) {
			vscode.window.createTerminal({ cwd: worktreePath }).show();
		}
	}));
	// Command to open a folder picker and select a repository for untitled workspaces
	disposableStore.add(vscode.commands.registerCommand(OPEN_REPOSITORY_COMMAND_ID, async (sessionItemResource?: vscode.Uri) => {
		if (!sessionItemResource) {
			return;
		}
		// Open folder picker dialog
		const folderUris = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: l10n.t('Open Folder...'),
		});

		if (!folderUris || folderUris.length === 0) {
			return;
		}

		const selectedFolderUri = folderUris[0];
		const sessionId = SessionIdForCLI.parse(sessionItemResource);

		await trackSelectedFolderOrRepo(sessionId, selectedFolderUri.fsPath, copilotCliWorkspaceSession, copilotCLIWorktreeManagerService);

		// Notify VS Code that the option changed
		contentProvider.notifySessionOptionsChange(sessionItemResource, [{
			optionId: REPOSITORY_OPTION_ID,
			value: selectedFolderUri.fsPath
		}]);

		// Notify that provider options have changed so the dropdown updates
		contentProvider.notifyProviderOptionsChange();
	}));

	const applyChanges = async (sessionItemOrResource?: vscode.ChatSessionItem | vscode.Uri) => {
		const resource = sessionItemOrResource instanceof vscode.Uri
			? sessionItemOrResource
			: sessionItemOrResource?.resource;

		if (!resource) {
			return;
		}

		// Apply changes
		const sessionId = SessionIdForCLI.parse(resource);
		await copilotCLIWorktreeManagerService.applyWorktreeChanges(sessionId);

		// Close the multi-file diff editor if it's open
		const worktreeProperties = copilotCLIWorktreeManagerService.getWorktreeProperties(sessionId);
		const worktreePath = worktreeProperties ? Uri.file(worktreeProperties.worktreePath) : undefined;

		if (worktreePath) {
			// Select the tabs to close
			const multiDiffTabToClose = vscode.window.tabGroups.all.flatMap(g => g.tabs)
				.filter(({ input }) => input instanceof vscode.TabInputTextMultiDiff && input.textDiffs.some(input =>
					extUri.isEqualOrParent(vscode.Uri.file(input.original.fsPath), worktreePath, true) ||
					extUri.isEqualOrParent(vscode.Uri.file(input.modified.fsPath), worktreePath, true)));

			if (multiDiffTabToClose.length > 0) {
				// Close the tabs
				await vscode.window.tabGroups.close(multiDiffTabToClose, true);
			}
		}

		// Pick up new git state
		copilotcliSessionItemProvider.notifySessionsChange();
	};

	disposableStore.add(vscode.commands.registerCommand('github.copilot.chat.applyCopilotCLIAgentSessionChanges', applyChanges));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.chat.applyCopilotCLIAgentSessionChanges.apply', applyChanges));
	return disposableStore;
}
