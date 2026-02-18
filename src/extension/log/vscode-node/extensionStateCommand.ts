/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IToolsService } from '../../tools/common/toolsService';

export class ExtensionStateCommandContribution extends Disposable {
	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@IToolsService private readonly _toolsService: IToolsService,
	) {
		super();

		this._register(vscode.commands.registerCommand('github.copilot.debug.extensionState', async () => {
			await this._logExtensionState();
		}));
	}

	private async _logExtensionState(): Promise<void> {
		const lines: string[] = [
			'[ExtensionState] ===============================================================',
			'[ExtensionState] INCLUDE THIS INFORMATION IF YOU ARE OPENING AN ISSUE',
			'[ExtensionState] ===============================================================',
		];

		// Auth state
		const hasAnySession = !!this._authenticationService.anyGitHubSession;
		const hasPermissiveSession = !!this._authenticationService.permissiveGitHubSession;
		const hasCopilotToken = !!this._authenticationService.copilotToken;
		lines.push(`  Auth: anyGitHubSession=${hasAnySession}, repoGitHubSession=${hasPermissiveSession}, copilotToken=${hasCopilotToken}`);

		// Username
		const session = this._authenticationService.anyGitHubSession;
		if (session) {
			lines.push(`  Username: ${session.account.label}`);
		} else {
			lines.push('  Username: (not signed in) - check the GitHub Authentication output channel for more details');
		}

		// Proxy setup
		const proxySupport = vscode.workspace.getConfiguration('http').get<string>('proxySupport', 'override');
		const proxyUrl = vscode.workspace.getConfiguration('http').get<string>('proxy', '');
		lines.push(`  Proxy: http.proxySupport=${proxySupport}, http.proxy=${proxyUrl ? '(configured)' : '(not configured)'}`);

		if (session) {
			// Language models
			try {
				const endpoints = await this._endpointProvider.getAllChatEndpoints();
				lines.push(`  Language models loaded: ${endpoints.length > 0} (count: ${endpoints.length})`);
			} catch (e) {
				lines.push(`  Language models loaded: false (error: ${e})`);
			}

			// Copilot chat provider registration
			try {
				const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
				lines.push(`  Copilot chat provider registered: ${copilotModels.length > 0} (models: ${copilotModels.length})`);
			} catch (e) {
				lines.push(`  Copilot chat provider registered: false (error: ${e})`);
			}

			// Copilot embeddings model registration
			const copilotEmbeddings = vscode.lm.embeddingModels.filter(m => m.startsWith('copilot.'));
			lines.push(`  Copilot embeddings model registered: ${copilotEmbeddings.length > 0} (models: [${copilotEmbeddings.join(', ')}])`);

			// Tools
			const toolCount = this._toolsService.tools.length;
			lines.push(`  Tools loaded: ${toolCount > 0} (count: ${toolCount})`);
		}

		lines.push('[ExtensionState] ===============================================================');

		this._logService.info(lines.join('\n'));
	}
}
