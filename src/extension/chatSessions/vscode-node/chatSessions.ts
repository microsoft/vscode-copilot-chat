/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../platform/env/common/envService';
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
import { CopilotCLIAgentManager } from '../../agents/copilotcli/node/copilotcliAgentManager';
import { CopilotCLISessionService, ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';
import { ILanguageModelServer, LanguageModelServer } from '../../agents/node/langModelServer';
import { IExtensionContribution } from '../../common/contributions';
import { prExtensionInstalledContextKey } from '../../contextKeys/vscode-node/contextKeys.contribution';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { GHPR_EXTENSION_ID } from '../vscode/chatSessionsUriHandler';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider } from './claudeChatSessionItemProvider';
import { ClaudeChatSessionParticipant } from './claudeChatSessionParticipant';
import { CopilotCLIChatSessionContentProvider, CopilotCLIChatSessionItemProvider, CopilotCLIChatSessionParticipant, registerCLIChatCommands } from './copilotCLIChatSessionsContribution';
import { CopilotCLITerminalIntegration, ICopilotCLITerminalIntegration } from './copilotCLITerminalIntegration';
import { CopilotChatSessionsProvider } from './copilotCloudSessionsProvider';
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
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvService private readonly envService: IEnvService,
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

		// Register or unregister based on initial configuration and changes
		const copilotSessionsProvider = this.updateCopilotCloudRegistration();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.Internal.CopilotCloudEnabled.fullyQualifiedId)) {
				this.updateCopilotCloudRegistration();
			}
		}));

		// Copilot CLI sessions provider
		const copilotCLISessionService = claudeAgentInstaService.createInstance(CopilotCLISessionService);

		const copilotcliAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[ICopilotCLISessionService, copilotCLISessionService],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
				[ICopilotCLITerminalIntegration, new SyncDescriptor(CopilotCLITerminalIntegration)],
			));

		const copilotcliSessionItemProvider = this._register(copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionItemProvider));
		this._register(vscode.chat.registerChatSessionItemProvider(this.copilotcliSessionType, copilotcliSessionItemProvider));
		const copilotcliAgentManager = this._register(copilotcliAgentInstaService.createInstance(CopilotCLIAgentManager));
		const copilotcliChatSessionContentProvider = copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionContentProvider);
		const summarizer = copilotcliAgentInstaService.createInstance(ChatSummarizerProvider);

		const copilotcliChatSessionParticipant = copilotcliAgentInstaService.createInstance(
			CopilotCLIChatSessionParticipant,
			copilotcliAgentManager,
			copilotCLISessionService,
			copilotcliSessionItemProvider,
			copilotSessionsProvider,
			summarizer
		);
		const copilotcliParticipant = vscode.chat.createChatParticipant(this.copilotcliSessionType, copilotcliChatSessionParticipant.createHandler());
		this._register(vscode.chat.registerChatSessionContentProvider(this.copilotcliSessionType, copilotcliChatSessionContentProvider, copilotcliParticipant));
		this._register(registerCLIChatCommands(copilotcliSessionItemProvider, copilotCLISessionService));
	}

	private updateCopilotCloudRegistration() {
		if (!this.copilotAgentInstaService) {
			return;
		}
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.CopilotCloudEnabled);

		if (enabled && !this.copilotCloudRegistrations) {
			// Update context key for PR extension installed status
			vscode.commands.executeCommand('setContext', prExtensionInstalledContextKey, this.isPullRequestExtensionInstalled());

			// Register the Copilot Cloud chat participant
			this.copilotCloudRegistrations = new DisposableStore();
			const copilotSessionsProvider = this.copilotCloudRegistrations.add(
				this.copilotAgentInstaService.createInstance(CopilotChatSessionsProvider)
			);
			this.copilotCloudRegistrations.add(
				vscode.chat.registerChatSessionItemProvider(CopilotChatSessionsProvider.TYPE, copilotSessionsProvider)
			);
			this.copilotCloudRegistrations.add(
				vscode.chat.registerChatSessionContentProvider(
					CopilotChatSessionsProvider.TYPE,
					copilotSessionsProvider,
					copilotSessionsProvider.chatParticipant,
					{ supportsInterruptions: true }
				)
			);
			this.copilotCloudRegistrations.add(
				vscode.commands.registerCommand('github.copilot.cloud.sessions.refresh', () => {
					copilotSessionsProvider.refresh();
				})
			);
			this.copilotCloudRegistrations.add(
				vscode.commands.registerCommand('github.copilot.cloud.sessions.openInBrowser', async (chatSessionItem: vscode.ChatSessionItem) => {
					copilotSessionsProvider.openSessionsInBrowser(chatSessionItem);
				})
			);
			// Proxy commands that require the PR extension
			this.copilotCloudRegistrations.add(
				vscode.commands.registerCommand('github.copilot.cloud.sessions.proxy.checkoutFromDescription', async (ctx: { path: string } | undefined) => {
					await this.installPullRequestExtension();
					try {
						await vscode.commands.executeCommand('pr.checkoutFromDescription', ctx?.path);
					} catch (e) {
						this.logService.error(`checkoutFromDescription failed: ${e}`);
					}
				})
			);
			this.copilotCloudRegistrations.add(
				vscode.commands.registerCommand('github.copilot.cloud.sessions.proxy.applyChangesFromDescription', async (ctx: { path: string } | undefined) => {
					await this.installPullRequestExtension();
					try {
						await vscode.commands.executeCommand('pr.applyChangesFromDescription', ctx?.path);
					} catch (e) {
						this.logService.error(`applyChangesFromDescription failed: ${e}`);
					}
				})
			);
			this.copilotCloudRegistrations.add(
				vscode.commands.registerCommand(CLOSE_SESSION_PR_CMD, async (ctx: CrossChatSessionWithPR) => {
					// Close PR using GitHub API directly (no extension required)
					try {
						const success = await this.octoKitService.closePullRequest(
							ctx.pullRequestDetails.repository.owner.login,
							ctx.pullRequestDetails.repository.name,
							ctx.pullRequestDetails.number);
						if (!success) {
							this.logService.error(`${CLOSE_SESSION_PR_CMD}: Failed to close PR #${ctx.pullRequestDetails.number}`);
						}
						copilotSessionsProvider.refresh();
					} catch (e) {
						this.logService.error(`${CLOSE_SESSION_PR_CMD}: Exception ${e}`);
					}
				})
			);

			return copilotSessionsProvider;
		} else if (!enabled && this.copilotCloudRegistrations) {
			this.copilotCloudRegistrations.dispose();
			this.copilotCloudRegistrations = undefined;
		}
	}

	/**
	 * Check if the GitHub Pull Request extension is installed
	 */
	private isPullRequestExtensionInstalled(): boolean {
		const extension = vscode.extensions.getExtension(GHPR_EXTENSION_ID);
		return extension !== undefined;
	}

	/**
	 * Install the GitHub Pull Request extension if not already installed.
	 * Waits up to 10 seconds for the extension to be available after installation.
	 * @throws Error if the extension installation times out
	 */
	private async installPullRequestExtension(): Promise<void> {
		if (this.isPullRequestExtensionInstalled()) {
			return;
		}

		// Install pre-release version for insiders builds
		const isInsiders = this.envService.getEditorInfo().version.includes('insider');
		const installOptions = { enable: true, installPreReleaseVersion: isInsiders };

		this.logService.info(`Installing GitHub Pull Request extension (prerelease: ${isInsiders})...`);
		await vscode.commands.executeCommand('workbench.extensions.installExtension', GHPR_EXTENSION_ID, installOptions);

		// Poll for extension availability
		const maxWaitTime = 10_000; // 10 seconds
		const pollInterval = 100; // 100ms
		let elapsed = 0;

		while (elapsed < maxWaitTime) {
			if (this.isPullRequestExtensionInstalled()) {
				vscode.window.showInformationMessage(vscode.l10n.t('GitHub Pull Request extension installed successfully.'));
				await vscode.commands.executeCommand('setContext', prExtensionInstalledContextKey, true);
				this.logService.info('GitHub Pull Request extension installed successfully.');
				return;
			}
			await new Promise(resolve => setTimeout(resolve, pollInterval));
			elapsed += pollInterval;
		}

		// Installation timed out
		const error = new Error('GitHub Pull Request extension installation timed out.');
		this.logService.error(error.message);
		throw error;
	}
}
