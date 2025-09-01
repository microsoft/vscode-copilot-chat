/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../util/vs/platform/instantiation/common/serviceCollection';
import { ClaudeCodeSessionService, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';
import { ClaudeAgentManager } from '../../agents/claude/vscode-node/claudeCodeAgent';
import { IExtensionContribution } from '../../common/contributions';
import { ClaudeChatSessionItemProvider, ClaudeSessionDataStore } from './claudeChatSessionItemProvider';
import { ClaudeChatSessionContentProvider } from './claudeChatSessionContentProvider';

export class ChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'chatSessions';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const claudeAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[IClaudeCodeSessionService, new SyncDescriptor(ClaudeCodeSessionService)]));

		const sessionStore = claudeAgentInstaService.createInstance(ClaudeSessionDataStore);
		const sessionItemProvider = this._register(claudeAgentInstaService.createInstance(ClaudeChatSessionItemProvider, sessionStore));
		this._register(vscode.chat.registerChatSessionItemProvider('claude-code', sessionItemProvider));

		const claudeAgentManager = this._register(claudeAgentInstaService.createInstance(ClaudeAgentManager));
		const chatSessionContentProvider = claudeAgentInstaService.createInstance(ClaudeChatSessionContentProvider, claudeAgentManager, sessionStore);
		this._register(vscode.chat.registerChatSessionContentProvider('claude-code', chatSessionContentProvider));
	}
}
