/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGitService } from '../../../platform/git/common/gitService';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { OctoKitService } from '../../../platform/github/common/octoKitServiceImpl';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../util/vs/platform/instantiation/common/serviceCollection';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { ClaudeCodeSdkService, IClaudeCodeSdkService } from '../../agents/claude/node/claudeCodeSdkService';
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';
import { CopilotCLIModels, CopilotCLISDK, ICopilotCLIModels, ICopilotCLISDK } from '../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../agents/copilotcli/node/copilotcliPromptResolver';
import { CopilotCLISessionService, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { CopilotCLIMCPHandler, ICopilotCLIMCPHandler } from '../../agents/copilotcli/node/mcpHandler';
import { ILanguageModelServer, LanguageModelServer } from '../../agents/node/langModelServer';
import { IExtensionContribution } from '../../common/contributions';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider } from './claudeChatSessionItemProvider';
import { ClaudeChatSessionParticipant } from './claudeChatSessionParticipant';
import { CopilotCLIChatSessionContentProvider, CopilotCLIChatSessionItemProvider, CopilotCLIChatSessionParticipant, CopilotCLIWorktreeManager, registerCLIChatCommands } from './copilotCLIChatSessionsContribution';
import { CopilotCLITerminalIntegration, ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { CopilotCloudSessionsProvider } from './copilotCloudSessionsProvider';
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
	) {
		super();

		// #region Claude Code Chat Sessions
		const claudeAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[IClaudeCodeSessionService, new SyncDescriptor(ClaudeCodeSessionService)],
				[IClaudeCodeSdkService, new SyncDescriptor(ClaudeCodeSdkService)],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
			));

		const sessionItemProvider = this._register(claudeAgentInstaService.createInstance(ClaudeChatSessionItemProvider));
		this._register(vscode.chat.registerChatSessionItemProvider(ClaudeChatSessionItemProvider.claudeSessionType, sessionItemProvider));
		this._register(vscode.commands.registerCommand('github.copilot.claude.sessions.refresh', () => {
			sessionItemProvider.refresh();
		}));

		const claudeAgentManager = this._register(claudeAgentInstaService.createInstance(ClaudeAgentManager));
		const chatSessionContentProvider = claudeAgentInstaService.createInstance(ClaudeChatSessionContentProvider);
		const claudeChatSessionParticipant = claudeAgentInstaService.createInstance(ClaudeChatSessionParticipant, ClaudeChatSessionItemProvider.claudeSessionType, claudeAgentManager, sessionItemProvider);
		const chatParticipant = vscode.chat.createChatParticipant(ClaudeChatSessionItemProvider.claudeSessionType, claudeChatSessionParticipant.createHandler());
		this._register(vscode.chat.registerChatSessionContentProvider(ClaudeChatSessionItemProvider.claudeSessionType, chatSessionContentProvider, chatParticipant));

		// #endregion

		// Copilot Cloud Agent - conditionally register based on configuration
		this.copilotAgentInstaService = instantiationService.createChild(new ServiceCollection(
			[IOctoKitService, new SyncDescriptor(OctoKitService)],
			[IPullRequestFileChangesService, new SyncDescriptor(PullRequestFileChangesService)],
		));
		const cloudSessionProvider = this.registerCopilotCloudAgent();
		const copilotcliAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[ICopilotCLISessionService, new SyncDescriptor(CopilotCLISessionService)],
				[ICopilotCLIModels, new SyncDescriptor(CopilotCLIModels)],
				[ICopilotCLISDK, new SyncDescriptor(CopilotCLISDK)],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
				[ICopilotCLITerminalIntegration, new SyncDescriptor(CopilotCLITerminalIntegration)],
				[ICopilotCLIMCPHandler, new SyncDescriptor(CopilotCLIMCPHandler)],
			));

		const copilotCLIWorktreeManager = copilotcliAgentInstaService.createInstance(CopilotCLIWorktreeManager);
		const copilotcliSessionItemProvider = this._register(copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionItemProvider, copilotCLIWorktreeManager));
		this._register(vscode.chat.registerChatSessionItemProvider(this.copilotcliSessionType, copilotcliSessionItemProvider));
		const promptResolver = copilotcliAgentInstaService.createInstance(CopilotCLIPromptResolver);
		const copilotcliChatSessionContentProvider = copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionContentProvider, copilotCLIWorktreeManager);
		const summarizer = copilotcliAgentInstaService.createInstance(ChatSummarizerProvider);
		const gitService = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(IGitService));

		const copilotcliChatSessionParticipant = copilotcliAgentInstaService.createInstance(
			CopilotCLIChatSessionParticipant,
			promptResolver,
			copilotcliSessionItemProvider,
			cloudSessionProvider,
			summarizer,
			copilotCLIWorktreeManager
		);
		const copilotCLISessionService = copilotcliAgentInstaService.invokeFunction(accessor => accessor.get(ICopilotCLISessionService));
		const copilotcliParticipant = vscode.chat.createChatParticipant(this.copilotcliSessionType, copilotcliChatSessionParticipant.createHandler());
		this._register(vscode.chat.registerChatSessionContentProvider(this.copilotcliSessionType, copilotcliChatSessionContentProvider, copilotcliParticipant));
		this._register(registerCLIChatCommands(copilotcliSessionItemProvider, copilotCLISessionService, gitService));
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
			vscode.commands.registerCommand('github.copilot.cloud.sessions.refresh', () => {
				cloudSessionsProvider.refresh();
			})
		);
		this.copilotCloudRegistrations.add(
			vscode.commands.registerCommand('github.copilot.cloud.sessions.openInBrowser', async (chatSessionItem: vscode.ChatSessionItem) => {
				cloudSessionsProvider.openSessionsInBrowser(chatSessionItem);
			})
		);
		this.copilotCloudRegistrations.add(
			vscode.commands.registerCommand(CLOSE_SESSION_PR_CMD, async (ctx: CrossChatSessionWithPR) => {
				try {
					const success = await this.octoKitService.closePullRequest(
						ctx.pullRequestDetails.repository.owner.login,
						ctx.pullRequestDetails.repository.name,
						ctx.pullRequestDetails.number);
					if (!success) {
						this.logService.error(`${CLOSE_SESSION_PR_CMD}: Failed to close PR #${ctx.pullRequestDetails.number}`);
					}
					cloudSessionsProvider.refresh();
				} catch (e) {
					this.logService.error(`${CLOSE_SESSION_PR_CMD}: Exception ${e}`);
				}
			})
		);
		return cloudSessionsProvider;
	}
}
