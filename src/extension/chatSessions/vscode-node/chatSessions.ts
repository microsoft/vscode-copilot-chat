/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
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
import { ILanguageModelServer, LanguageModelServer } from '../../agents/node/langModelServer';
import { IExtensionContribution } from '../../common/contributions';
import { IChatSessionWorkspaceFolderService } from '../common/chatSessionWorkspaceFolderService';
import { IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { IFolderRepositoryManager } from '../common/folderRepositoryManager';
import { ChatSessionWorkspaceFolderService } from './chatSessionWorkspaceFolderServiceImpl';
import { ChatSessionWorktreeService } from './chatSessionWorktreeServiceImpl';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider } from './claudeChatSessionItemProvider';
import { ClaudeFolderRepositoryManager } from './folderRepositoryManagerImpl';
// Azure-only fork: removed Copilot CLI, cloud sessions, PR integration (GitHub-dependent)


// Azure-only fork: removed CrossChatSessionWithPR, cloud sessions, CLI agent, PR integration
export class ChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'chatSessions';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
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
		try {
			this._register(vscode.chat.registerChatSessionItemProvider(ClaudeChatSessionItemProvider.claudeSessionType, sessionItemProvider));
		} catch (e) {
			this._logService.warn(`ChatSessionsContrib: registerChatSessionItemProvider unavailable: ${(e as Error).message}`);
		}

		const claudeAgentManager = this._register(claudeAgentInstaService.createInstance(ClaudeAgentManager));
		const chatSessionContentProvider = this._register(claudeAgentInstaService.createInstance(ClaudeChatSessionContentProvider));
		const chatParticipant = vscode.chat.createChatParticipant(ClaudeChatSessionItemProvider.claudeSessionType, chatSessionContentProvider.createHandler(ClaudeChatSessionItemProvider.claudeSessionType, claudeAgentManager, sessionItemProvider));
		chatParticipant.iconPath = new vscode.ThemeIcon('claude');
		try {
			this._register(vscode.chat.registerChatSessionContentProvider(ClaudeChatSessionItemProvider.claudeSessionType, chatSessionContentProvider, chatParticipant));
		} catch (e) {
			this._logService.warn(`ChatSessionsContrib: registerChatSessionContentProvider unavailable: ${(e as Error).message}`);
		}

		this._logService.info('ChatSessionsContrib: Claude Code sessions initialized (Azure-only fork)');
		// #endregion
	}
}
