/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ClaudeAgentManager } from '../../agents/claude/vscode-node/claudeCodeAgent';
import { IExtensionContribution } from '../../common/contributions';
import { ClaudeChatSessionItemProvider } from './claudeChatSessionItemProvider';

export class ChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'chatSessions';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		// @IRequestLogger requestLogger: IRequestLogger,
	) {
		super();

		this._register(vscode.chat.registerChatSessionItemProvider('claude-code', instantiationService.createInstance(ClaudeChatSessionItemProvider)));

		const claudeAgentManager = instantiationService.createInstance(ClaudeAgentManager);
		this._register(vscode.chat.registerChatSessionContentProvider('claude-code', {
			provideChatSessionContent: async (sessionId, token) => {
				return {
					history: [],
					requestHandler: (request, context, response, token) => {
						return claudeAgentManager.handleRequest(request, context, response, token);
					}
				};
			}
		}));
	}
}