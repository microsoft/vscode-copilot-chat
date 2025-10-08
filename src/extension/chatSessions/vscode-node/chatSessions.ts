/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
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
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider } from './claudeChatSessionItemProvider';
import { ClaudeChatSessionParticipant } from './claudeChatSessionParticipant';
import { CopilotCLIChatSessionContentProvider } from './copilotcliChatSessionContentProvider';
import { CopilotCLIChatSessionItemProvider } from './copilotcliChatSessionItemProvider';
import { CopilotCLIChatSessionParticipant } from './copilotcliChatSessionParticipant';

export class ChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'chatSessions';
	readonly claudeSessionType = 'claude-code';
	readonly copilotcliSessionType = 'copilotcli';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
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
		const copilotCLISessionService = claudeAgentInstaService.createInstance(CopilotCLISessionService);
		this._register(vscode.chat.registerChatSessionContentProvider(this.claudeSessionType, chatSessionContentProvider, chatParticipant));

		const copilotcliAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[ICopilotCLISessionService, copilotCLISessionService],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
			));

		const copilotcliSessionItemProvider = this._register(copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionItemProvider));
		this._register(vscode.chat.registerChatSessionItemProvider(this.copilotcliSessionType, copilotcliSessionItemProvider));
		this._register(vscode.commands.registerCommand('github.copilot.copilotcli.sessions.refresh', () => {
			copilotcliSessionItemProvider.refresh();
		}));
		this._register(vscode.commands.registerCommand('github.copilot.cli.sessions.refresh', () => {
			copilotcliSessionItemProvider.refresh();
		}));
		this._register(vscode.commands.registerCommand('github.copilot.cli.sessions.delete', async (sessionItem?: vscode.ChatSessionItem) => {
			if (sessionItem?.id) {
				const result = await vscode.window.showWarningMessage(
					`Are you sure you want to delete the session?`,
					{ modal: true },
					'Delete',
					'Cancel'
				);

				if (result === 'Delete') {
					await copilotCLISessionService.deleteSession(sessionItem.id);
				}
			}
		}));
		this._register(vscode.commands.registerCommand('github.copilot.cli.sessions.resumeInTerminal', async (sessionItem?: vscode.ChatSessionItem) => {
			if (sessionItem?.id) {
				await this.resumeCopilotCLISessionInTerminal(sessionItem);
			}
		}));

		this._register(vscode.commands.registerCommand('github.copilot.cli.sessions.newTerminalSession', async () => {
			await this.createCopilotCLITerminal();
		}));

		const copilotcliAgentManager = this._register(copilotcliAgentInstaService.createInstance(CopilotCLIAgentManager));
		const copilotcliChatSessionContentProvider = copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionContentProvider);
		const copilotcliChatSessionParticipant = new CopilotCLIChatSessionParticipant(this.copilotcliSessionType, copilotcliAgentManager, copilotcliSessionItemProvider);
		const copilotcliParticipant = vscode.chat.createChatParticipant(this.copilotcliSessionType, copilotcliChatSessionParticipant.createHandler());
		this._register(vscode.chat.registerChatSessionContentProvider(this.copilotcliSessionType, copilotcliChatSessionContentProvider, copilotcliParticipant));
	}

	private async createCopilotCLITerminal(): Promise<void> {
		const terminalName = process.env.COPILOTCLI_TERMINAL_TITLE || 'Copilot CLI';
		await this.createAndExecuteInTerminal(terminalName, 'copilot');
	}

	private async resumeCopilotCLISessionInTerminal(sessionItem: vscode.ChatSessionItem): Promise<void> {
		const terminalName = `Copilot CLI - ${sessionItem.label || sessionItem.id}`;
		const command = `copilot --resume ${sessionItem.id}`;
		await this.createAndExecuteInTerminal(terminalName, command);
	}

	private async createAndExecuteInTerminal(terminalName: string, command: string): Promise<void> {
		const existingTerminal = vscode.window.terminals.find(t => t.name === terminalName);
		if (existingTerminal) {
			existingTerminal.show();
			return;
		}

		const terminal = vscode.window.createTerminal({
			name: terminalName,
			iconPath: new vscode.ThemeIcon('terminal'),
			location: { viewColumn: vscode.ViewColumn.Active },
		});

		terminal.show();

		// Wait for shell integration to be available
		const shellIntegrationTimeout = 3000; // 3 seconds
		let shellIntegrationAvailable = false;

		const integrationPromise = new Promise<void>((resolve) => {
			const disposable = vscode.window.onDidChangeTerminalShellIntegration(e => {
				if (e.terminal === terminal && e.shellIntegration) {
					shellIntegrationAvailable = true;
					disposable.dispose();
					resolve();
				}
			});

			setTimeout(() => {
				disposable.dispose();
				resolve();
			}, shellIntegrationTimeout);
		});

		await integrationPromise;

		if (shellIntegrationAvailable && terminal.shellIntegration) {
			terminal.shellIntegration.executeCommand(command);
		} else {
			terminal.sendText(command);
		}
	}
}