/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { localize } from '../../../util/vs/nls';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../util/vs/platform/instantiation/common/serviceCollection';
import { ClaudeAgentManager } from '../../agents/claude/node/claudeCodeAgent';
import { ClaudeCodeSdkService, IClaudeCodeSdkService } from '../../agents/claude/node/claudeCodeSdkService';
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';
import { ILanguageModelServer, LanguageModelServer } from '../../agents/node/langModelServer';
import { IExtensionContribution } from '../../common/contributions';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider } from './claudeChatSessionItemProvider';

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
		const chatParticipant = vscode.chat.createChatParticipant(this.sessionType, async (request, context, stream, token) => {
			const create = async () => {
				const { claudeSessionId } = await claudeAgentManager.handleRequest(undefined, request, context, stream, token);
				if (!claudeSessionId) {
					stream.warning(localize('claude.failedToCreateSession', "Failed to create a new Claude Code session."));
					return;
				}
				return claudeSessionId;
			};
			const { chatSessionContext } = context;
			if (chatSessionContext) {
				if (chatSessionContext.isUntitled) {
					/* New, empty session */
					const claudeSessionId = await create();
					if (claudeSessionId) {
						// Tell UI to replace with claude-backed session
						sessionItemProvider.swap(chatSessionContext.chatSessionItem, { id: claudeSessionId, label: request.prompt ?? 'Claude Code' });
					}
					return {};
				}
				/* Existing session */
				const { id } = chatSessionContext.chatSessionItem;
				await claudeAgentManager.handleRequest(id, request, context, stream, token);
			} else {
				/* Via @claude */
				// TODO: Think about how this should work
				stream.markdown(localize('claude.viaAtClaude', "Start a new Claude Code session"));
				stream.button({ command: `workbench.action.chat.openNewSessionEditor.${this.sessionType}`, title: localize('claude.startNewSession', "Start Session") });
			}
		});
		this._register(vscode.chat.registerChatSessionContentProvider(this.sessionType, chatSessionContentProvider, chatParticipant));
	}
}