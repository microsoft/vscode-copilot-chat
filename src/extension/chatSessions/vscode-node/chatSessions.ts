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
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';
import { OpenCodeAgentManager } from '../../agents/opencode/node/opencodeAgentManager';
import { OpenCodeClient } from '../../agents/opencode/node/opencodeClient';
import { OpenCodeServerManager } from '../../agents/opencode/node/opencodeServerManager';
import { IOpenCodeSessionService, OpenCodeSessionService } from '../../agents/opencode/node/opencodeSessionService';
import { IExtensionContribution } from '../../common/contributions';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider, ClaudeSessionDataStore } from './claudeChatSessionItemProvider';
import { OpenCodeChatSessionContentProvider } from './opencodeChatSessionContentProvider';
import { OpenCodeChatSessionItemProvider, OpenCodeSessionDataStore } from './opencodeChatSessionItemProvider';

export class ChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'chatSessions';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// === Claude Integration ===
		const claudeAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[IClaudeCodeSessionService, new SyncDescriptor(ClaudeCodeSessionService)]));

		const sessionStore = claudeAgentInstaService.createInstance(ClaudeSessionDataStore);
		const sessionItemProvider = this._register(claudeAgentInstaService.createInstance(ClaudeChatSessionItemProvider, sessionStore));
		this._register(vscode.chat.registerChatSessionItemProvider('claude-code', sessionItemProvider));
		this._register(vscode.commands.registerCommand('github.copilot.claude.sessions.refresh', () => {
			sessionItemProvider.refresh();
		}));

		const claudeAgentManager = this._register(claudeAgentInstaService.createInstance(ClaudeAgentManager));
		const chatSessionContentProvider = claudeAgentInstaService.createInstance(ClaudeChatSessionContentProvider, claudeAgentManager, sessionStore);
		this._register(vscode.chat.registerChatSessionContentProvider('claude-code', chatSessionContentProvider));

		// === OpenCode Integration ===
		const openCodeServerManager = this._register(instantiationService.createInstance(OpenCodeServerManager));
		const openCodeClient = this._register(instantiationService.createInstance(OpenCodeClient));
		const opencodeAgentManager = this._register(
			instantiationService.createInstance(OpenCodeAgentManager, openCodeServerManager, openCodeClient)
		);
		const opencodeInstaService = instantiationService.createChild(
			new ServiceCollection(
				[IOpenCodeSessionService, new SyncDescriptor(OpenCodeSessionService, [openCodeClient, openCodeServerManager])]
			)
		);

		const opencodeSessionStore = opencodeInstaService.createInstance(OpenCodeSessionDataStore);
		const opencodeSessionItemProvider = this._register(
			opencodeInstaService.createInstance(OpenCodeChatSessionItemProvider, opencodeSessionStore)
		);
		this._register(vscode.chat.registerChatSessionItemProvider('opencode', opencodeSessionItemProvider));
		this._register(vscode.commands.registerCommand('github.copilot.opencode.sessions.refresh', () => {
			opencodeSessionItemProvider.refresh();
		}));


		const opencodeChatSessionContentProvider = opencodeInstaService.createInstance(
			OpenCodeChatSessionContentProvider,
			opencodeAgentManager,
			opencodeSessionStore
		);
		this._register(vscode.chat.registerChatSessionContentProvider('opencode', opencodeChatSessionContentProvider));
	}
}
