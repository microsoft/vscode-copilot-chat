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
import { CopilotCLISdkService, ICopilotCLISdkService } from '../../agents/copilotcli/node/copilotcliClient';
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
	readonly sessionType = 'claude-code';

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
		this._register(vscode.chat.registerChatSessionItemProvider(this.sessionType, sessionItemProvider));
		this._register(vscode.commands.registerCommand('github.copilot.claude.sessions.refresh', () => {
			sessionItemProvider.refresh();
		}));

		const claudeAgentManager = this._register(claudeAgentInstaService.createInstance(ClaudeAgentManager));
		const chatSessionContentProvider = claudeAgentInstaService.createInstance(ClaudeChatSessionContentProvider);
		const claudeChatSessionParticipant = claudeAgentInstaService.createInstance(ClaudeChatSessionParticipant, this.sessionType, claudeAgentManager, sessionItemProvider);
		const chatParticipant = vscode.chat.createChatParticipant(this.sessionType, claudeChatSessionParticipant.createHandler());
		this._register(vscode.chat.registerChatSessionContentProvider(this.sessionType, chatSessionContentProvider, chatParticipant));

		const copilotcliAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[ICopilotCLISessionService, new SyncDescriptor(CopilotCLISessionService)],
				[ICopilotCLISdkService, new SyncDescriptor(CopilotCLISdkService)],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
			));

		const copilotcliSessionItemProvider = this._register(copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionItemProvider));
		this._register(vscode.chat.registerChatSessionItemProvider('copilotcli', copilotcliSessionItemProvider));
		this._register(vscode.commands.registerCommand('github.copilot.copilotcli.sessions.refresh', () => {
			copilotcliSessionItemProvider.refresh();
		}));

		const copilotcliAgentManager = this._register(copilotcliAgentInstaService.createInstance(CopilotCLIAgentManager));
		const copilotcliChatSessionContentProvider = copilotcliAgentInstaService.createInstance(CopilotCLIChatSessionContentProvider);
		const copilotcliChatSessionParticipant = new CopilotCLIChatSessionParticipant('copilotcli', copilotcliAgentManager, copilotcliSessionItemProvider);
		const copilotcliParticipant = vscode.chat.createChatParticipant('copilotcli', copilotcliChatSessionParticipant.createHandler());
		this._register(vscode.chat.registerChatSessionContentProvider('copilotcli', copilotcliChatSessionContentProvider, copilotcliParticipant));
	}
}