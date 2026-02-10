/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Attachment, SweCustomAgent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler, ChatSessionProviderOptionItem, Uri } from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { INativeEnvService } from '../../../platform/env/common/envService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitService, RepoContext } from '../../../platform/git/common/gitService';
import { toGitUri } from '../../../platform/git/common/utils';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptsService, ParsedPromptFile } from '../../../platform/promptFiles/common/promptsService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { isUri } from '../../../util/common/types';
import { DeferredPromise, disposableTimeout } from '../../../util/vs/base/common/async';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable, IReference, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { relative } from '../../../util/vs/base/common/path';
import { basename, dirname, extUri, isEqual } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ToolCall } from '../../agents/copilotcli/common/copilotCLITools';
import { IChatDelegationSummaryService } from '../../agents/copilotcli/common/delegationSummaryService';
import { ICopilotCLIAgents, ICopilotCLIModels } from '../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../agents/copilotcli/node/copilotcliSession';
import { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { PermissionRequest, requestPermission } from '../../agents/copilotcli/node/permissionHelpers';
import { ICopilotCLISessionTracker } from '../../agents/copilotcli/vscode-node/copilotCLISessionTracker';
import { ChatVariablesCollection, isPromptFile } from '../../prompt/common/chatVariablesCollection';
import { IToolsService } from '../../tools/common/toolsService';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { ChatSessionWorktreeProperties, IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { FolderRepositoryMRUEntry, IFolderRepositoryManager } from '../common/folderRepositoryManager';
import { isUntitledSessionId } from '../common/utils';
import { convertReferenceToVariable } from './copilotCLIPromptReferences';
import { ICopilotCLITerminalIntegration, TerminalOpenLocation } from './copilotCLITerminalIntegration';
import { CopilotCloudSessionsProvider } from './copilotCloudSessionsProvider';

const AGENTS_OPTION_ID = 'agent';
const MODELS_OPTION_ID = 'model';
const REPOSITORY_OPTION_ID = 'repository';
const OPEN_REPOSITORY_COMMAND_ID = 'github.copilot.cli.sessions.openRepository';
const MAX_MRU_ENTRIES = 10;

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
		@ICopilotCLISessionTracker private readonly sessionTracker: ICopilotCLISessionTracker,
		@ICopilotCLITerminalIntegration private readonly terminalIntegration: ICopilotCLITerminalIntegration,
		@IChatSessionWorktreeService private readonly worktreeManager: IChatSessionWorktreeService,
		@IRunCommandExecutionService private readonly commandExecutionService: IRunCommandExecutionService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IChatSessionWorkspaceFolderService private readonly workspaceFolderService: IChatSessionWorkspaceFolderService,
		@IGitService private readonly gitSevice: IGitService,
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
		if (
			isUntitledSessionId(sessionId) ||			// always show untitled sessions
			vscode.workspace.isAgentSessionsWorkspace	// always all sessions in agent sessions workspace
		) {
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

	private shouldShowBadge(): boolean {
		const repositories = this.gitSevice.repositories
			.filter(repository => repository.kind !== 'worktree');

		// Empty window or workspace that contains multiple repositories
		return vscode.workspace.workspaceFolders === undefined || repositories.length > 1;
	}

	private async _toChatSessionItem(session: ICopilotCLISessionItem): Promise<vscode.ChatSessionItem> {
		const resource = SessionIdForCLI.getResource(_untitledSessionIdMap.get(session.id) ?? session.id);
		const worktreeProperties = this.worktreeManager.getWorktreeProperties(session.id);

		const label = session.label;

		// Badge
		let badge: vscode.MarkdownString | undefined;
		if (worktreeProperties?.repositoryPath && this.shouldShowBadge()) {
			const repositoryPathUri = vscode.Uri.file(worktreeProperties.repositoryPath);
			badge = new vscode.MarkdownString(`$(folder) ${basename(repositoryPathUri)}`);
			badge.supportThemeIcons = true;
		}

		// Statistics
		const changes: vscode.ChatSessionChangedFile2[] = [];
		if (worktreeProperties) {
			const worktreeChanges = await this.worktreeManager.getWorktreeChanges(session.id) ?? [];
			changes.push(...worktreeChanges.map(change => new vscode.ChatSessionChangedFile2(
				vscode.Uri.file(change.filePath),
				change.originalFilePath
					? toGitUri(vscode.Uri.file(change.originalFilePath), worktreeProperties.baseCommit)
					: undefined,
				change.modifiedFilePath
					? toGitUri(vscode.Uri.file(change.modifiedFilePath), worktreeProperties.branchName)
					: undefined,
				change.statistics.additions,
				change.statistics.deletions)));
		}

		// Status
		const status = session.status ?? vscode.ChatSessionStatus.Completed;

		// Metadata
		const metadata = {
			branchName: worktreeProperties?.branchName,
			repositoryPath: worktreeProperties?.repositoryPath,
			worktreePath: worktreeProperties?.worktreePath
		} satisfies { readonly [key: string]: unknown };

		return {
			resource,
			label,
			badge,
			timing: session.timing,
			changes,
			status,
			metadata
		} satisfies vscode.ChatSessionItem;
	}

	public async createCopilotCLITerminal(location: TerminalOpenLocation = 'editor', name?: string): Promise<void> {
		// TODO@rebornix should be set by CLI
		const terminalName = name || process.env.COPILOTCLI_TERMINAL_TITLE || l10n.t('Background Agent');
		await this.terminalIntegration.openTerminal(terminalName, [], undefined, location);
	}

	public async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const id = SessionIdForCLI.parse(sessionItem.resource);
		const existingTerminal = await this.sessionTracker.getTerminal(SessionIdForCLI.parse(sessionItem.resource));
		if (existingTerminal) {
			existingTerminal.show();
			return;
		}

		const terminalName = sessionItem.label || id;
		const cliArgs = ['--resume', id];
		const worktreeProperties = this.worktreeManager.getWorktreeProperties(id);
		const workspaceFolder = this.workspaceFolderService.getSessionWorkspaceFolder(id);
		const token = new vscode.CancellationTokenSource();
		try {
			const cwd = worktreeProperties?.worktreePath ?? workspaceFolder?.fsPath ?? (await this.copilotcliSessionService.getSessionWorkingDirectory(id, token.token))?.fsPath;
			await this.terminalIntegration.openTerminal(terminalName, cliArgs, cwd);
		} finally {
			token.dispose();
		}
	}
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
		@IPromptsService private readonly promptsService: IPromptsService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@IGitService private readonly gitService: IGitService,
		@IFolderRepositoryManager private readonly folderRepositoryManager: IFolderRepositoryManager
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

	private async getDefaultUntitledSessionRepositoryOption(copilotcliSessionId: string, token: vscode.CancellationToken) {
		const repositories = this.isUntitledWorkspace() ? folderMRUToChatProviderOptions(this.folderRepositoryManager.getFolderMRU()) : this.getRepositoryOptionItems();
		// Use FolderRepositoryManager to get folder/repository info (no trust check needed for UI population)
		const folderInfo = await this.folderRepositoryManager.getFolderRepository(copilotcliSessionId, undefined, token);
		const uri = folderInfo.repository ?? folderInfo.folder;
		if (uri) {
			return uri;
		} else if (repositories.length) {
			// No folder selected yet for this untitled session - use MRU or first available
			const lastUsedFolderId = this.folderRepositoryManager.getLastUsedFolderIdInUntitledWorkspace();
			const firstRepo = (lastUsedFolderId && repositories.find(repo => repo.id === lastUsedFolderId)?.id) ?? repositories[0].id;
			return Uri.file(firstRepo);
		}
		return undefined;
	}

	async provideChatSessionContent(resource: Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const copilotcliSessionId = SessionIdForCLI.parse(resource);
		const workingDirectoryValue = this.copilotCLIWorktreeManagerService.getWorktreePath(copilotcliSessionId);
		const workingDirectory = workingDirectoryValue ? workingDirectoryValue : undefined;
		const isolationEnabled = workingDirectoryValue ? true : false; // If theres' a worktree, that means isolation was enabled.

		const [defaultModel, sessionAgent, defaultAgent, existingSession] = await Promise.all([
			this.copilotCLIModels.getDefaultModel(),
			this.copilotCLIAgents.getSessionAgent(copilotcliSessionId),
			this.copilotCLIAgents.getDefaultAgent(),
			isUntitledSessionId(copilotcliSessionId) ? Promise.resolve(undefined) : this.sessionService.getSession(copilotcliSessionId, { workingDirectory, isolationEnabled, readonly: true }, token),
		]);
		const repositories = this.isUntitledWorkspace() ? folderMRUToChatProviderOptions(this.folderRepositoryManager.getFolderMRU()) : this.getRepositoryOptionItems();

		// If we have session in _sessionModel, use that (faster as its in memory), else get from existing session.
		const model = (existingSession ? (_sessionModel.get(copilotcliSessionId) ?? await existingSession.object.getSelectedModelId()) : _sessionModel.get(copilotcliSessionId)) ?? await this.getCustomAgentModel(defaultAgent, token) ?? defaultModel;

		const options: Record<string, string | vscode.ChatSessionProviderOptionItem> = {};

		options[AGENTS_OPTION_ID] = sessionAgent ?? defaultAgent;

		// Possible there are no models (e.g. all models have been turned off by policy or the like).
		if (model) {
			options[MODELS_OPTION_ID] = model;
		}

		// Use FolderRepositoryManager to get folder/repository info (no trust check needed for UI population)
		if (isUntitledSessionId(copilotcliSessionId)) {
			const defaultRepo = await this.getDefaultUntitledSessionRepositoryOption(copilotcliSessionId, token);
			if (defaultRepo) {
				options[REPOSITORY_OPTION_ID] = defaultRepo.fsPath;
				// Use the manager to track the selection for untitled sessions
				this.folderRepositoryManager.setUntitledSessionFolder(copilotcliSessionId, defaultRepo);
			}
		} else {
			const folderInfo = await this.folderRepositoryManager.getFolderRepository(copilotcliSessionId, undefined, token);
			const folderOrRepoId = folderInfo.repository?.fsPath ?? folderInfo.folder?.fsPath;
			const existingItem = folderOrRepoId ? repositories.find(repo => repo.id === folderOrRepoId) : undefined;
			if (existingItem) {
				options[REPOSITORY_OPTION_ID] = {
					...existingItem,
					locked: true
				};
			} else if (folderInfo.repository) {
				options[REPOSITORY_OPTION_ID] = {
					...toRepositoryOptionItem(folderInfo.repository),
					locked: true
				};
			} else if (folderInfo.folder) {
				const folderName = this.workspaceService.getWorkspaceFolderName(folderInfo.folder) || basename(folderInfo.folder);
				options[REPOSITORY_OPTION_ID] = {
					...toWorkspaceFolderOptionItem(folderInfo.folder, folderName),
					locked: true
				};
			} else {
				// Existing session with no folder info - show unknown
				let folderName = l10n.t('Unknown');
				if (this.workspaceService.getWorkspaceFolders().length === 1) {
					folderName = this.workspaceService.getWorkspaceFolderName(this.workspaceService.getWorkspaceFolders()[0]) || folderName;
				}
				options[REPOSITORY_OPTION_ID] = {
					id: '',
					name: folderName,
					icon: new vscode.ThemeIcon('folder'),
					locked: true
				};
			}
			const worktreeProperties = this.copilotCLIWorktreeManagerService.getWorktreeProperties(copilotcliSessionId);
			// Ensure that the repository for the background session is opened. This is needed
			// when the background session is opened in the empty window so that we can access
			// the changes of the background session.
			if (worktreeProperties?.repositoryPath) {
				await this.gitService.getRepository(vscode.Uri.file(worktreeProperties.repositoryPath));
			}
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
			const repositories = this.folderRepositoryManager.getFolderMRU();
			const items = folderMRUToChatProviderOptions(repositories);
			items.splice(MAX_MRU_ENTRIES); // Limit to max entries
			const commands: vscode.Command[] = [];
			commands.push({
				command: OPEN_REPOSITORY_COMMAND_ID,
				title: l10n.t('Browse folders...')
			});

			optionGroups.push({
				id: REPOSITORY_OPTION_ID,
				name: l10n.t('Folder'),
				description: l10n.t('Pick Folder'),
				items,
				commands
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
		if (workspaceFolders.length) {
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
			} else if (update.optionId === REPOSITORY_OPTION_ID && typeof update.value === 'string' && isUntitledSessionId(sessionId)) {
				const folder = vscode.Uri.file(update.value);
				if ((await checkPathExists(folder, this.fileSystem))) {
					this.folderRepositoryManager.setUntitledSessionFolder(sessionId, folder);
				} else {
					await this.folderRepositoryManager.deleteMRUEntry(folder);
					const message = l10n.t('The path \'{0}\' does not exist on this computer.', folder.fsPath);
					vscode.window.showErrorMessage(l10n.t('Path does not exist'), { modal: true, detail: message });
					const defaultRepo = await this.getDefaultUntitledSessionRepositoryOption(sessionId, token);
					if (defaultRepo && !isEqual(folder, defaultRepo)) {
						this.folderRepositoryManager.setUntitledSessionFolder(sessionId, defaultRepo);
						const changes: { optionId: string; value: string }[] = [];
						changes.push({ optionId: REPOSITORY_OPTION_ID, value: defaultRepo.fsPath });
						this.notifySessionOptionsChange(resource, changes);
					}
					this.notifyProviderOptionsChange();
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
				if (!(await checkFileExists(agentFile, this.fileSystem))) {
					continue;
				}
				const parsedFile = await this.promptsService.parseFile(agentFile, token);
				const modelsFromHeader = parsedFile.header?.model;
				if (!modelsFromHeader) {
					continue;
				}
				const modelId = await getModelFromPromptFile(modelsFromHeader, this.copilotCLIModels);
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

async function checkFileExists(filePath: Uri, fileSystem: IFileSystemService): Promise<boolean> {
	try {
		const stat = await fileSystem.stat(filePath);
		return stat.type === vscode.FileType.File;
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
		@IFolderRepositoryManager private readonly folderRepositoryManager: IFolderRepositoryManager,
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
					"chatRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The unique chat request ID." },
					"hasChatSessionItem": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Invoked with a chat session item." },
					"isUntitled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Indicates if the chat session is untitled." },
					"hasDelegatePrompt": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Indicates if the prompt is a /delegate command." }
				}
			*/
			this.telemetryService.sendMSFTTelemetryEvent('copilotcli.chat.invoke', {
				chatRequestId: request.id,
				hasChatSessionItem: String(!!chatSessionContext?.chatSessionItem),
				isUntitled: String(chatSessionContext?.isUntitled),
				hasDelegatePrompt: String(request.prompt.startsWith('/delegate'))
			});

			await this.lockRepoOptionForSession(context, token);

			if (!chatSessionContext) {
				// Delegating from another chat session
				return await this.handleDelegationFromAnotherChat(request, context, stream, token);
			}

			const { resource } = chatSessionContext.chatSessionItem;
			const id = SessionIdForCLI.parse(resource);
			const isUntitled = chatSessionContext.isUntitled;

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

			const sessionResult = await this.getOrCreateSession(request, chatSessionContext, modelId, agent, stream, disposables, token);
			const session = sessionResult.session;
			if (!session || token.isCancellationRequested) {
				// If user didn't trust, then reset the session options to make it read-write.
				if (!sessionResult.trusted) {
					await this.unlockRepoOptionForSession(context, token);
				}
				return {};
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

			// Lock the repo option with more accurate information.
			// Previously we just updated it with details of the folder.
			// If user has selected a repo, then update with repo information (right icons, etc).
			if (isUntitled) {
				void this.lockRepoOptionForSession(context, token);
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
				// Construct the full prompt with references to be sent to CLI.
				const { prompt, attachments } = await this.promptResolver.resolvePrompt(request, undefined, [], session.object.options.isolationEnabled, session.object.options.workingDirectory, token);
				await session.object.handleRequest(request.id, prompt, attachments, modelId, token);
				await this.commitWorktreeChangesIfNeeded(session.object, token);
			}

			if (isUntitled && !token.isCancellationRequested) {
				// Delete old information stored for untitled session id.
				_sessionModel.delete(id);
				_sessionModel.set(session.object.sessionId, modelId);
				this.untitledSessionIdMapping.delete(id);
				_untitledSessionIdMap.delete(session.object.sessionId);
				this.folderRepositoryManager.deleteUntitledSessionFolder(id);
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
			if (chatSessionContext?.chatSessionItem.resource) {
				this.sessionItemProvider.notifySessionsChange();
			}
			disposables.dispose();
		}
	}

	private async lockRepoOptionForSession(context: vscode.ChatContext, token: vscode.CancellationToken) {
		const { chatSessionContext } = context;
		if (!chatSessionContext?.isUntitled) {
			return;
		}
		const { resource } = chatSessionContext.chatSessionItem;
		// If we have a real session id that was mapped to this untitled session, then use that.
		// This way we can get the latest information associated with the real session.
		const parsedId = SessionIdForCLI.parse(resource);
		const id = _untitledSessionIdMap.get(parsedId) ?? parsedId;
		const folderInfo = await this.folderRepositoryManager.getFolderRepository(id, undefined, token);
		if (folderInfo.folder) {
			const folderName = basename(folderInfo.folder);
			const option = folderInfo.repository ? toRepositoryOptionItem(folderInfo.repository) : toWorkspaceFolderOptionItem(folderInfo.folder, folderName);
			const change = { optionId: REPOSITORY_OPTION_ID, value: { ...option, locked: true } };
			this.contentProvider.notifySessionOptionsChange(resource, [change]);
		}
	}

	private async unlockRepoOptionForSession(context: vscode.ChatContext, token: vscode.CancellationToken) {
		const { chatSessionContext } = context;
		if (!chatSessionContext?.isUntitled) {
			return;
		}
		const { resource } = chatSessionContext.chatSessionItem;
		const id = SessionIdForCLI.parse(resource);
		const folderInfo = await this.folderRepositoryManager.getFolderRepository(id, undefined, token);
		if (folderInfo.folder) {
			const option = folderInfo.repository?.fsPath ?? folderInfo.folder.fsPath;
			const change = { optionId: REPOSITORY_OPTION_ID, value: option };
			this.contentProvider.notifySessionOptionsChange(resource, [change]);
		}
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

	private async getOrCreateSession(request: vscode.ChatRequest, chatSessionContext: vscode.ChatSessionContext, model: string | undefined, agent: SweCustomAgent | undefined, stream: vscode.ChatResponseStream, disposables: DisposableStore, token: vscode.CancellationToken): Promise<{ session: IReference<ICopilotCLISession> | undefined; trusted: boolean }> {
		const { resource } = chatSessionContext.chatSessionItem;
		const existingSessionId = this.untitledSessionIdMapping.get(SessionIdForCLI.parse(resource));
		const id = existingSessionId ?? SessionIdForCLI.parse(resource);
		const isNewSession = chatSessionContext.isUntitled && !existingSessionId;

		const { isolationEnabled, workingDirectory, worktreeProperties, cancelled, trusted } = await this.getOrInitializeWorkingDirectory(chatSessionContext, stream, request.toolInvocationToken, token);
		if (cancelled || token.isCancellationRequested) {
			return { session: undefined, trusted };
		}

		const session = isNewSession ?
			await this.sessionService.createSession({ model, workingDirectory, isolationEnabled, agent }, token) :
			await this.sessionService.getSession(id, { model, workingDirectory, isolationEnabled, readonly: false, agent }, token);
		this.sessionItemProvider.notifySessionsChange();

		if (!session) {
			stream.warning(l10n.t('Chat session not found.'));
			return { session: undefined, trusted };
		}
		this.logService.info(`Using Copilot CLI session: ${session.object.sessionId} (isNewSession: ${isNewSession}, isolationEnabled: ${isolationEnabled}, workingDirectory: ${workingDirectory}, worktreePath: ${worktreeProperties?.worktreePath})`);
		if (isNewSession) {
			this.untitledSessionIdMapping.set(id, session.object.sessionId);
			if (worktreeProperties) {
				void this.copilotCLIWorktreeManagerService.setWorktreeProperties(session.object.sessionId, worktreeProperties);
			}
		}
		if (session.object.options.workingDirectory && !session.object.options.isolationEnabled) {
			void this.workspaceFolderService.trackSessionWorkspaceFolder(session.object.sessionId, session.object.options.workingDirectory.fsPath);
		}
		disposables.add(session.object.attachStream(stream));
		disposables.add(session.object.attachPermissionHandler(async (permissionRequest: PermissionRequest, toolCall: ToolCall | undefined, token: vscode.CancellationToken) => requestPermission(this.instantiationService, permissionRequest, toolCall, this.toolsService, request.toolInvocationToken, token)));


		return { session, trusted };
	}

	/**
	 *
	 * @param preferModelInRequest
	 * If true, will prefer model specified in request over session model.
	 * This is useful when delegating from another chat session, and we want to preserve the model in the previous chat editor/session.
	 */
	private async getModelId(sessionId: string | undefined, request: vscode.ChatRequest | undefined, preferModelInRequest: boolean, token: vscode.CancellationToken): Promise<string | undefined> {
		const promptFile = request ? await this.getPromptInfoFromRequest(request, token) : undefined;
		const model = promptFile?.header?.model ? await getModelFromPromptFile(promptFile.header.model, this.copilotCLIModels) : undefined;
		if (model) {
			return model;
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

	private async handleDelegationFromAnotherChat(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult | void> {
		return await this.createCLISessionAndSubmitRequest(request, undefined, request.references, context, stream, token);
	}

	private async getOrInitializeWorkingDirectory(
		chatSessionContext: vscode.ChatSessionContext | undefined,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): Promise<{
		isolationEnabled: boolean;
		workingDirectory: Uri | undefined;
		worktreeProperties: ChatSessionWorktreeProperties | undefined;
		cancelled: boolean;
		trusted: boolean;
	}> {
		let workingDirectory: Uri | undefined;
		let worktreeProperties: ChatSessionWorktreeProperties | undefined;

		if (chatSessionContext) {
			const existingSessionId = this.untitledSessionIdMapping.get(SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource));
			const id = existingSessionId ?? SessionIdForCLI.parse(chatSessionContext.chatSessionItem.resource);
			const isNewSession = chatSessionContext.isUntitled && !existingSessionId;

			if (isNewSession) {
				// Use FolderRepositoryManager to initialize folder/repository with worktree creation
				const folderInfo = await this.folderRepositoryManager.initializeFolderRepository(id, { stream, toolInvocationToken }, token);

				if (folderInfo.trusted === false || folderInfo.cancelled) {
					return { isolationEnabled: false, workingDirectory: undefined, worktreeProperties: undefined, cancelled: true, trusted: folderInfo.trusted !== false };
				}

				workingDirectory = folderInfo.worktree ?? folderInfo.folder;
				worktreeProperties = folderInfo.worktreeProperties;
			} else {
				// Existing session - use getFolderRepository for resolution with trust check
				const folderInfo = await this.folderRepositoryManager.getFolderRepository(id, { promptForTrust: true, stream }, token);

				if (folderInfo.trusted === false) {
					return { isolationEnabled: false, workingDirectory: undefined, worktreeProperties: undefined, cancelled: true, trusted: false };
				}

				workingDirectory = folderInfo.worktree ?? folderInfo.folder;
				worktreeProperties = folderInfo.worktree ? this.copilotCLIWorktreeManagerService.getWorktreeProperties(id) : undefined;
			}
		} else {
			// No chat session context (e.g., delegation) - initialize with active repository
			const folderInfo = await this.folderRepositoryManager.initializeFolderRepository(undefined, { stream, toolInvocationToken }, token);

			if (folderInfo.trusted === false || folderInfo.cancelled) {
				return { isolationEnabled: false, workingDirectory: undefined, worktreeProperties: undefined, cancelled: true, trusted: folderInfo.trusted !== false };
			}

			workingDirectory = folderInfo.worktree ?? folderInfo.folder;
			worktreeProperties = folderInfo.worktreeProperties;
		}

		const isolationEnabled = !!worktreeProperties;
		return { isolationEnabled, workingDirectory, worktreeProperties, cancelled: false, trusted: true };
	}

	private async createCLISessionAndSubmitRequest(
		request: vscode.ChatRequest,
		userPrompt: string | undefined,
		otherReferences: readonly vscode.ChatPromptReference[] | undefined,
		context: vscode.ChatContext,
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
			this.getOrInitializeWorkingDirectory(undefined, stream, request.toolInvocationToken, token),
			this.getModelId(undefined, request, true, token), // prefer model in request, as we're delegating from another session here.
			this.getAgent(undefined, undefined, token)
		]);

		if (cancelled || token.isCancellationRequested) {
			stream.markdown(l10n.t('Background Agent delegation cancelled.'));
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
		if (session.object.options.workingDirectory && !session.object.options.isolationEnabled) {
			void this.workspaceFolderService.trackSessionWorkspaceFolder(session.object.sessionId, session.object.options.workingDirectory.fsPath);
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

export function registerCLIChatCommands(copilotcliSessionItemProvider: CopilotCLIChatSessionItemProvider, copilotCLISessionService: ICopilotCLISessionService, copilotCLIWorktreeManagerService: IChatSessionWorktreeService, gitService: IGitService, copilotCliWorkspaceSession: IChatSessionWorkspaceFolderService, contentProvider: CopilotCLIChatSessionContentProvider, folderRepositoryManager: IFolderRepositoryManager, envService: INativeEnvService, fileSystemService: IFileSystemService): IDisposable {
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
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.newSession', async () => {
		await copilotcliSessionItemProvider.createCopilotCLITerminal('editor', l10n.t('Copilot CLI'));
	}));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.cli.newSessionToSide', async () => {
		await copilotcliSessionItemProvider.createCopilotCLITerminal('editorBeside', l10n.t('Copilot CLI'));
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
	async function selectFolder() {
		// Open folder picker dialog
		const folderUris = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: l10n.t('Open Folder...'),
		});

		return folderUris && folderUris.length > 0 ? folderUris[0] : undefined;
	}
	disposableStore.add(vscode.commands.registerCommand(OPEN_REPOSITORY_COMMAND_ID, async (sessionItemResource?: vscode.Uri) => {
		if (!sessionItemResource) {
			return;
		}

		let selectedFolderUri: Uri | undefined = undefined;
		const mruItems = folderRepositoryManager.getFolderMRU();

		if (mruItems.length === 0) {
			selectedFolderUri = await selectFolder();
		} else {
			type RecentFolderQuickPickItem = vscode.QuickPickItem & ({ folderUri: vscode.Uri; openFolder: false } | { folderUri: undefined; openFolder: true });
			const items: RecentFolderQuickPickItem[] = mruItems
				.filter(item => !item.isUntitledSessionSelection)
				.map(item => {
					const optionItem = item.repository
						? toRepositoryOptionItem(item.folder)
						: toWorkspaceFolderOptionItem(item.folder, basename(item.folder));

					return {
						label: optionItem.name,
						description: `~/${relative(envService.userHome.fsPath, item.folder.fsPath)}`,
						iconPath: optionItem.icon,
						folderUri: item.folder,
						openFolder: false
					};
				});

			items.unshift({
				label: l10n.t('Open Folder...'),
				iconPath: new vscode.ThemeIcon('folder-opened'),
				folderUri: undefined,
				openFolder: true
			}, {
				kind: vscode.QuickPickItemKind.Separator,
				label: '',
				folderUri: undefined,
				openFolder: true
			});

			const selectedFolder = new DeferredPromise<Uri | undefined>();
			const disposables = new DisposableStore();
			const quickPick = disposables.add(vscode.window.createQuickPick<RecentFolderQuickPickItem>());
			quickPick.items = items;
			quickPick.placeholder = l10n.t('Select a recent folder');
			quickPick.matchOnDescription = true;
			quickPick.ignoreFocusOut = true;
			quickPick.matchOnDetail = true;
			quickPick.show();
			disposables.add(quickPick.onDidHide(() => {
				selectedFolder.complete(undefined);
			}));
			disposables.add(quickPick.onDidAccept(async () => {
				if (quickPick.selectedItems.length === 0 && !quickPick.value) {
					selectedFolder.complete(undefined);
					quickPick.hide();
				} else if (quickPick.selectedItems.length && quickPick.selectedItems[0].folderUri) {
					selectedFolder.complete(quickPick.selectedItems[0].folderUri);
					quickPick.hide();
				} else if (quickPick.selectedItems.length && quickPick.selectedItems[0].openFolder) {
					selectedFolder.complete(await selectFolder());
					quickPick.hide();
				} else if (quickPick.value) {
					const fileOrFolder = vscode.Uri.file(quickPick.value);
					try {
						const stat = await vscode.workspace.fs.stat(fileOrFolder);
						let directory: Uri | undefined = undefined;
						if (stat.type & vscode.FileType.Directory) {
							quickPick.hide();
							directory = fileOrFolder;
						} else if (stat.type & vscode.FileType.File) {
							directory = dirname(fileOrFolder);
						}
						if (directory) {
							// Possible user selected a folder thats inside an existing workspace folder.
							selectedFolder.complete(vscode.workspace.getWorkspaceFolder(directory)?.uri || directory);
							quickPick.hide();
						}
					} catch {
						// ignore
					}
				}
			}));
			selectedFolderUri = await selectedFolder.p;
			disposables.dispose();
		}

		if (!selectedFolderUri) {
			return;
		}
		if (!(await checkPathExists(selectedFolderUri, fileSystemService))) {
			const message = l10n.t('The path \'{0}\' does not exist on this computer.', selectedFolderUri.fsPath);
			vscode.window.showErrorMessage(l10n.t('Path does not exist'), { modal: true, detail: message });
			return;
		}

		const sessionId = SessionIdForCLI.parse(sessionItemResource);
		folderRepositoryManager.setUntitledSessionFolder(sessionId, selectedFolderUri);

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

		try {
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
		} catch (error) {
			vscode.window.showErrorMessage(l10n.t('Failed to apply changes to the current workspace. Please stage or commit your changes in the current workspace and try again.'), { modal: true });
		}
	};

	disposableStore.add(vscode.commands.registerCommand('github.copilot.chat.applyCopilotCLIAgentSessionChanges', applyChanges));
	disposableStore.add(vscode.commands.registerCommand('github.copilot.chat.applyCopilotCLIAgentSessionChanges.apply', applyChanges));
	return disposableStore;
}

async function getModelFromPromptFile(models: readonly string[], copilotCLIModels: ICopilotCLIModels): Promise<string | undefined> {
	for (const model of models) {
		let modelId = await copilotCLIModels.resolveModel(model);
		if (modelId) {
			return modelId;
		}
		// Sometimes the models can contain ` (Copilot)` suffix, try stripping that and resolving again.
		if (!model.includes('(')) {
			continue;
		}
		modelId = await copilotCLIModels.resolveModel(model.substring(0, model.indexOf('(')).trim());
		if (modelId) {
			return modelId;
		}
	}
	return undefined;
}


function folderMRUToChatProviderOptions(mruItems: FolderRepositoryMRUEntry[]): ChatSessionProviderOptionItem[] {
	return mruItems.map((item) => {
		if (item.repository) {
			return toRepositoryOptionItem(item.folder);
		} else {
			return toWorkspaceFolderOptionItem(item.folder, basename(item.folder));
		}
	});

}


/**
 * Check if a path exists and is a directory.
 */
async function checkPathExists(filePath: vscode.Uri, fileSystemService: IFileSystemService): Promise<boolean> {
	try {
		const stat = await fileSystemService.stat(filePath);
		return stat.type === vscode.FileType.Directory;
	} catch {
		return false;
	}
}
