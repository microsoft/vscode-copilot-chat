/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../platform/env/common/envService';
import { IOctoKitService } from '../../../platform/github/common/githubService';
import { OctoKitService } from '../../../platform/github/common/octoKitServiceImpl';
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

export class ChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'chatSessions';
	readonly claudeSessionType = 'claude-code';
	readonly copilotcliSessionType = 'copilotcli';

	private copilotCloudRegistrations: DisposableStore | undefined;
	private copilotAgentInstaService: IInstantiationService | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvService private readonly envService: IEnvService,
	) {
		super();
		const claudeAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[IClaudeCodeSessionService, new SyncDescriptor(ClaudeCodeSessionService)],
				[IClaudeCodeSdkService, new SyncDescriptor(ClaudeCodeSdkService)],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
			));

		const sessionItemProvider = this._register(claudeAgentInstaService.createInstance(ClaudeChatSessionItemProvider));
		this._register(vscode.chat.registerChatSessionItemProvider(this.claudeSessionType, sessionItemProvider));
		this._register(vscode.commands.registerCommand('github.copilot.claude.sessions.refresh', () => {
			sessionItemProvider.refresh();
		}));

		const claudeAgentManager = this._register(claudeAgentInstaService.createInstance(ClaudeAgentManager));
		const chatSessionContentProvider = claudeAgentInstaService.createInstance(ClaudeChatSessionContentProvider);
		const claudeChatSessionParticipant = claudeAgentInstaService.createInstance(ClaudeChatSessionParticipant, this.claudeSessionType, claudeAgentManager, sessionItemProvider);
		const chatParticipant = vscode.chat.createChatParticipant(this.claudeSessionType, claudeChatSessionParticipant.createHandler());
		this._register(vscode.chat.registerChatSessionContentProvider(this.claudeSessionType, chatSessionContentProvider, chatParticipant));

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
			this.copilotcliSessionType,
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
			this.copilotCloudRegistrations.add(
				vscode.commands.registerCommand('github.copilot.cloud.sessions.proxy.checkoutFromDescription', async (ctx: { path: string } | undefined) => {
					await this.installPullRequestExtension();
					try {
						await vscode.commands.executeCommand('pr.checkoutFromDescription', ctx?.path);
					} catch (e) {
						vscode.window.showErrorMessage((e as Error).message);
					}
				})
			);
			this.copilotCloudRegistrations.add(
				vscode.commands.registerCommand('github.copilot.cloud.sessions.proxy.applyChangesFromDescription', async (ctx: { path: string } | undefined) => {
					await this.installPullRequestExtension();
					try {
						await vscode.commands.executeCommand('pr.applyChangesFromDescription', ctx?.path);
					} catch (e) {
						vscode.window.showErrorMessage((e as Error).message);
					}
				})
			);

			return copilotSessionsProvider;
		} else if (!enabled && this.copilotCloudRegistrations) {
			this.copilotCloudRegistrations.dispose();
			this.copilotCloudRegistrations = undefined;
		}
	}

	private isPullRequestExtensionInstalled(): boolean {
		const extension = vscode.extensions.getExtension(GHPR_EXTENSION_ID);
		return extension !== undefined;
	}

	private async installPullRequestExtension() {
		if (this.isPullRequestExtensionInstalled()) {
			return;
		}
		const isInsiders = this.envService.getEditorInfo().version.includes('insider');
		const installOptions = { enable: true, installPreReleaseVersion: isInsiders };
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
			throw new Error('Extension installation timed out.');
		}
		await vscode.commands.executeCommand('setContext', prExtensionInstalledContextKey, true);
	}
}
