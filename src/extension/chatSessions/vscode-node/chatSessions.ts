/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEnvService, INativeEnvService } from '../../../platform/env/common/envService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IGitService } from '../../../platform/git/common/gitService';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { OctoKitService } from '../../../platform/github/common/octoKitServiceImpl';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../util/vs/platform/instantiation/common/serviceCollection';
import { ClaudeToolPermissionService, IClaudeToolPermissionService } from '../../agents/claude/common/claudeToolPermissionService';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { ClaudeCodeModels, IClaudeCodeModels } from '../../agents/claude/node/claudeCodeModels';
import { ClaudeCodeSdkService, IClaudeCodeSdkService } from '../../agents/claude/node/claudeCodeSdkService';
import { ClaudeSessionStateService, IClaudeSessionStateService } from '../../agents/claude/node/claudeSessionStateService';
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../agents/claude/node/sessionParser/claudeCodeSessionService';
import { ClaudeSlashCommandService, IClaudeSlashCommandService } from '../../agents/claude/vscode-node/claudeSlashCommandService';
import { ChatDelegationSummaryService, IChatDelegationSummaryService } from '../../agents/copilotcli/common/delegationSummaryService';
import { CopilotCLIAgents, CopilotCLIModels, CopilotCLISDK, ICopilotCLIAgents, ICopilotCLIModels, ICopilotCLISDK } from '../../agents/copilotcli/node/copilotCli';
import { CopilotCLIImageSupport, ICopilotCLIImageSupport } from '../../agents/copilotcli/node/copilotCLIImageSupport';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { CopilotCLISessionService, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { CopilotCLIMCPHandler, ICopilotCLIMCPHandler } from '../../agents/copilotcli/node/mcpHandler';
import { CopilotCLIContrib, getServices } from '../../agents/copilotcli/vscode-node/contribution';
import { ILanguageModelServer, LanguageModelServer } from '../../agents/node/langModelServer';
import { IExtensionContribution } from '../../common/contributions';
import { prExtensionInstalledContextKey } from '../../contextKeys/vscode-node/contextKeys.contribution';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { IFolderRepositoryManager } from '../common/folderRepositoryManager';
import { GHPR_EXTENSION_ID } from '../vscode/chatSessionsUriHandler';
import { ChatSessionWorkspaceFolderService } from './chatSessionWorkspaceFolderServiceImpl';
import { ChatSessionWorktreeService } from './chatSessionWorktreeServiceImpl';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider } from './claudeChatSessionItemProvider';
import { CopilotCLIChatSessionContentProvider, CopilotCLIChatSessionItemProvider, CopilotCLIChatSessionParticipant, registerCLIChatCommands } from './copilotCLIChatSessionsContribution';
import { CopilotCLITerminalIntegration, ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { CopilotCloudSessionsProvider } from './copilotCloudSessionsProvider';
import { ClaudeFolderRepositoryManager, CopilotCLIFolderRepositoryManager } from './folderRepositoryManagerImpl';
import { GrowthChatSessionProvider } from './growthChatSessionProvider';
import { PRContentProvider } from './prContentProvider';
import { IPullRequestFileChangesService, PullRequestFileChangesService } from './pullRequestFileChangesService';


// https://github.com/microsoft/vscode-pull-request-github/blob/8a5c9a145cd80ee364a3bed9cf616b2bd8ac74c2/src/github/copilotApi.ts#L56-L71
export interface CrossChatSessionWithPR extends vscode.ChatSessionItem {
	pullRequestDetails: {
		id: string;
		number: number;
		repository: {
			owner: {
				login: string;
			};
			name: string;
		};
	};
}

const CLOSE_SESSION_PR_CMD = 'github.copilot.cloud.sessions.proxy.closeChatSessionPullRequest';
export class ChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'chatSessions';
	readonly copilotcliSessionType = 'copilotcli';

	private copilotCloudRegistrations: DisposableStore | undefined;
	private copilotAgentInstaService: IInstantiationService | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IOctoKitService private readonly octoKitService: IOctoKitService,
		@IEnvService private readonly envService: IEnvService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();

		// #region Claude Code Chat Sessions
		const claudeAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[IClaudeCodeSessionService, new SyncDescriptor(ClaudeCodeSessionService)],
				[IClaudeCodeSdkService, new SyncDescriptor(ClaudeCodeSdkService)],
				[IClaudeCodeModels, new SyncDescriptor(ClaudeCodeModels)],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
				[IClaudeToolPermissionService, new SyncDescriptor(ClaudeToolPermissionService)],
				[IClaudeSessionStateService, new SyncDescriptor(ClaudeSessionStateService)],
				[IClaudeSlashCommandService, new SyncDescriptor(ClaudeSlashCommandService)],
				[IChatSessionWorktreeService, new SyncDescriptor(ChatSessionWorktreeService)],
				[IChatSessionWorkspaceFolderService, new SyncDescriptor(ChatSessionWorkspaceFolderService)],
				[IFolderRepositoryManager, new SyncDescriptor(ClaudeFolderRepositoryManager)],
			));

		const sessionItemProvider = this._register(claudeAgentInstaService.createInstance(ClaudeChatSessionItemProvider));
		this._register(vscode.chat.registerChatSessionItemProvider(ClaudeChatSessionItemProvider.claudeSessionType, sessionItemProvider));

		const claudeAgentManager = this._register(claudeAgentInstaService.createInstance(ClaudeAgentManager));
		const chatSessionContentProvider = this._register(claudeAgentInstaService.createInstance(ClaudeChatSessionContentProvider, claudeAgentManager, sessionItemProvider));
		const chatParticipant = vscode.chat.createChatParticipant(ClaudeChatSessionItemProvider.claudeSessionType, chatSessionContentProvider.createHandler());
		chatParticipant.iconPath = new vscode.ThemeIcon('claude');
		this._register(vscode.chat.registerChatSessionContentProvider(ClaudeChatSessionItemProvider.claudeSessionType, chatSessionContentProvider, chatParticipant));

		// #endregion

		// Copilot Cloud Agent - conditionally register based on configuration
		const summarizer = instantiationService.createInstance(ChatSummarizerProvider);
		const delegationSummary = instantiationService.createInstance(ChatDelegationSummaryService, summarizer);
		this._register(vscode.workspace.registerTextDocumentContentProvider(delegationSummary.scheme, {
			provideTextDocumentContent: (uri: vscode.Uri): string | undefined => delegationSummary.provideTextDocumentContent(uri)
		}));
		this.copilotAgentInstaService = instantiationService.createChild(new ServiceCollection(
			[IOctoKitService, new SyncDescriptor(OctoKitService)],
			[IChatDelegationSummaryService, delegationSummary],
			[IPullRequestFileChangesService, new SyncDescriptor(PullRequestFileChangesService)],
		));
		const cloudSessionProvider = this.registerCopilotCloudAgent();
		const copilotcliAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[ICopilotCLIImageSupport, new SyncDescriptor(CopilotCLIImageSupport)],
				[ICopilotCLISessionService, new SyncDescriptor(CopilotCLISessionService)],
				[IChatDelegationSummaryService, delegationSummary],
				[ICopilotCLIModels, new SyncDescriptor(CopilotCLIModels)],
				[ICopilotCLISDK, new SyncDescriptor(CopilotCLISDK)],
				[ICopilotCLIAgents, new SyncDescriptor(CopilotCLIAgents)],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
				[ICopilotCLITerminalIntegration, new SyncDescriptor(CopilotCLITerminalIntegration)],
				[IChatSessionWorktreeService, new SyncDescriptor(ChatSessionWorktreeService)],
				[IChatSessionWorkspaceFolderService, new SyncDescriptor(ChatSessionWorkspaceFolderService)],
				[ICopilotCLIMCPHandler, new SyncDescriptor(CopilotCLIMCPHandler)],
				[IFolderRepositoryManager, new SyncDescriptor(CopilotCLIFolderRepositoryManager)],
				...getServices()
			));

		const copilotcliSessionItemProvider = this._register(copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionItemProvider));
		this._register(vscode.chat.registerChatSessionItemProvider(this.copilotcliSessionType, copilotcliSessionItemProvider));
		const copilotcliChatSessionContentProvider = copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionContentProvider);
		const promptResolver = copilotcliAgentInstaService.createInstance(CopilotCLIPromptResolver);
		const gitService = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(IGitService));

		const copilotcliChatSessionParticipant = this._register(copilotcliAgentInstaService.createInstance(
			CopilotCLIChatSessionParticipant,
			copilotcliChatSessionContentProvider,
			promptResolver,
			copilotcliSessionItemProvider,
			cloudSessionProvider
		));
		const copilotCLISessionService = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(ICopilotCLISessionService));
		const copilotCLIWorktreeManagerService = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(IChatSessionWorktreeService));
		const copilotCLIWorkspaceFolderSessions = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(IChatSessionWorkspaceFolderService));
		const folderRepositoryManager = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(IFolderRepositoryManager));
		const nativeEnvService = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(INativeEnvService));
		const fileSystemService = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(IFileSystemService));
		this._register(copilotcliAgentInstaService.createInstance(CopilotCLIContrib));

		const copilotcliParticipant = vscode.chat.createChatParticipant(this.copilotcliSessionType, copilotcliChatSessionParticipant.createHandler());
		this._register(vscode.chat.registerChatSessionContentProvider(this.copilotcliSessionType, copilotcliChatSessionContentProvider, copilotcliParticipant));
		this._register(registerCLIChatCommands(copilotcliSessionItemProvider, copilotCLISessionService, copilotCLIWorktreeManagerService, gitService, copilotCLIWorkspaceFolderSessions, copilotcliChatSessionContentProvider, folderRepositoryManager, nativeEnvService, fileSystemService));

		// #region Growth Chat Sessions
		if (configurationService.getConfig(ConfigKey.GrowthMessagesEnabled)) {
			const growthProvider = this._register(instantiationService.createInstance(GrowthChatSessionProvider));
			this._register(vscode.chat.registerChatSessionItemProvider(GrowthChatSessionProvider.sessionType, growthProvider));
			const growthParticipant = vscode.chat.createChatParticipant(GrowthChatSessionProvider.sessionType, growthProvider.createHandler());
			growthParticipant.iconPath = new vscode.ThemeIcon('lightbulb');
			this._register(vscode.chat.registerChatSessionContentProvider(GrowthChatSessionProvider.sessionType, growthProvider, growthParticipant));
		}
		// #endregion
	}

	private registerCopilotCloudAgent() {
		if (!this.copilotAgentInstaService) {
			return;
		}
		if (this.copilotCloudRegistrations) {
			this.copilotCloudRegistrations.dispose();
			this.copilotCloudRegistrations = undefined;
		}
		this.copilotCloudRegistrations = new DisposableStore();
		this.copilotCloudRegistrations.add(
			this.copilotAgentInstaService.createInstance(PRContentProvider)
		);
		const cloudSessionsProvider = this.copilotCloudRegistrations.add(
			this.copilotAgentInstaService.createInstance(CopilotCloudSessionsProvider)
		);
		this.copilotCloudRegistrations.add(
			vscode.chat.registerChatSessionItemProvider(CopilotCloudSessionsProvider.TYPE, cloudSessionsProvider)
		);
		this.copilotCloudRegistrations.add(
			vscode.chat.registerChatSessionContentProvider(
				CopilotCloudSessionsProvider.TYPE,
				cloudSessionsProvider,
				cloudSessionsProvider.chatParticipant,
				{ supportsInterruptions: true }
			)
		);
		this.copilotCloudRegistrations.add(
			vscode.commands.registerCommand('github.copilot.cloud.resetWorkspaceConfirmations', () => {
				cloudSessionsProvider.resetWorkspaceContext();
			})
		);
		this.copilotCloudRegistrations.add(
			vscode.commands.registerCommand('github.copilot.cloud.sessions.openInBrowser', async (chatSessionItem: vscode.ChatSessionItem) => {
				cloudSessionsProvider.openSessionInBrowser(chatSessionItem);
			})
		);
		this.copilotCloudRegistrations.add(
			vscode.commands.registerCommand(CLOSE_SESSION_PR_CMD, async (ctx: CrossChatSessionWithPR) => {
				try {
					const success = await this.octoKitService.closePullRequest(
						ctx.pullRequestDetails.repository.owner.login,
						ctx.pullRequestDetails.repository.name,
						ctx.pullRequestDetails.number,
						{ createIfNone: true });
					if (!success) {
						this.logService.error(`${CLOSE_SESSION_PR_CMD}: Failed to close PR #${ctx.pullRequestDetails.number}`);
					}
					cloudSessionsProvider.refresh();
				} catch (e) {
					this.logService.error(`${CLOSE_SESSION_PR_CMD}: Exception ${e}`);
				}
			})
		);
		this.copilotCloudRegistrations.add(
			vscode.commands.registerCommand('github.copilot.cloud.sessions.installPRExtension', async () => {
				await this.installPullRequestExtension();
			})
		);
		return cloudSessionsProvider;
	}

	private isPullRequestExtensionInstalled(): boolean {
		return vscode.extensions.getExtension(GHPR_EXTENSION_ID) !== undefined;
	}

	private async installPullRequestExtension(): Promise<void> {
		if (this.isPullRequestExtensionInstalled()) {
			return;
		}
		try {
			const isInsiders = this.envService.getEditorInfo().version.includes('insider');
			const installOptions = { enable: true, installPreReleaseVersion: isInsiders, justification: vscode.l10n.t('Enable additional pull request features, such as checking out and applying changes.') };
			await vscode.commands.executeCommand('workbench.extensions.installExtension', GHPR_EXTENSION_ID, installOptions);
			const maxWaitTime = 10_000; // 10 seconds
			const pollInterval = 100; // 100ms
			let elapsed = 0;
			while (elapsed < maxWaitTime) {
				if (this.isPullRequestExtensionInstalled()) {
					vscode.window.showInformationMessage(vscode.l10n.t('GitHub Pull Request extension installed successfully.'));
					break;
				}
				await new Promise(resolve => setTimeout(resolve, pollInterval));
				elapsed += pollInterval;
			}
			if (!this.isPullRequestExtensionInstalled()) {
				vscode.window.showWarningMessage(vscode.l10n.t('GitHub Pull Request extension is taking longer than expected to install.'));
			}
			await vscode.commands.executeCommand('setContext', prExtensionInstalledContextKey, true);
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to install GitHub Pull Request extension: {0}', error instanceof Error ? error.message : String(error)));
		}
	}
}
