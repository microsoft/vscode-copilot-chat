/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ClaudeAgentManager } from '../../agents/claude/vscode-node/claudeCodeAgent';
import { IExtensionContribution } from '../../common/contributions';
import { ChatSessionContentProvider } from './claudeChatSessionContentProvider';
import { ClaudeChatSessionItemProvider, ClaudeSessionDataStore } from './claudeChatSessionItemProvider';

export class ChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'chatSessions';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const sessionStore = instantiationService.createInstance(ClaudeSessionDataStore);
		const sessionItemProvider = this._register(instantiationService.createInstance(ClaudeChatSessionItemProvider, sessionStore));
		this._register(vscode.chat.registerChatSessionItemProvider('claude-code', sessionItemProvider));

		const claudeAgentManager = this._register(instantiationService.createInstance(ClaudeAgentManager));
		const chatSessionContentProvider = new ChatSessionContentProvider(claudeAgentManager, sessionStore);
		this._register(vscode.chat.registerChatSessionContentProvider('claude-code', chatSessionContentProvider));
	}
}
