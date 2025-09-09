/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../../util/vs/platform/instantiation/common/serviceCollection';
import { IExtensionContribution } from '../../../common/contributions';
import { IOpenCodeAgentManager, OpenCodeAgentManager } from '../node/opencodeAgentManager';
import { IOpenCodeClient, OpenCodeClient } from '../node/opencodeClient';
import { IOpenCodeServerManager, OpenCodeServerManager } from '../node/opencodeServerManager';
import { IOpenCodeSessionService, OpenCodeSessionService } from '../node/opencodeSessionService';
import { OpenCodeChatSessionContentProvider } from './opencodeContentProvider';
import { OpenCodeChatSessionItemProvider, OpenCodeSessionDataStore } from './opencodeItemProvider';

/**
 * OpenCode integration contribution for VS Code chat sessions
 * Registers OpenCode chat session providers and services
 */
export class OpenCodeContribution extends Disposable implements IExtensionContribution {
	readonly id = 'openCodeChatSessions';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// Create OpenCode-specific service collection
		const opencodeInstaService = instantiationService.createChild(
			new ServiceCollection(
				[IOpenCodeServerManager, new SyncDescriptor(OpenCodeServerManager)],
				[IOpenCodeClient, new SyncDescriptor(OpenCodeClient)],
				[IOpenCodeSessionService, new SyncDescriptor(OpenCodeSessionService)],
				[IOpenCodeAgentManager, new SyncDescriptor(OpenCodeAgentManager)]
			)
		);

		// Create and register session data store
		const sessionStore = opencodeInstaService.createInstance(OpenCodeSessionDataStore);

		// Create and register session item provider
		const sessionItemProvider = this._register(
			opencodeInstaService.createInstance(OpenCodeChatSessionItemProvider, sessionStore)
		);
		this._register(vscode.chat.registerChatSessionItemProvider('opencode', sessionItemProvider));

		// Register refresh command for OpenCode sessions
		this._register(vscode.commands.registerCommand('github.copilot.opencode.sessions.refresh', () => {
			sessionItemProvider.refresh();
		}));

		// Create and register agent manager
		const opencodeAgentManager = this._register(
			opencodeInstaService.createInstance(OpenCodeAgentManager)
		);

		// Create and register session content provider
		const chatSessionContentProvider = opencodeInstaService.createInstance(
			OpenCodeChatSessionContentProvider,
			opencodeAgentManager,
			sessionStore
		);
		this._register(vscode.chat.registerChatSessionContentProvider('opencode', chatSessionContentProvider));
	}
}