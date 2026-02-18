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
		const lines: string[] = ['[ExtensionState] Current extension state:'];

		// Auth state
		const hasAnySession = !!this._authenticationService.anyGitHubSession;
		const hasPermissiveSession = !!this._authenticationService.permissiveGitHubSession;
		const hasCopilotToken = !!this._authenticationService.copilotToken;
		lines.push(`  Auth: anyGitHubSession=${hasAnySession}, permissiveGitHubSession=${hasPermissiveSession}, copilotToken=${hasCopilotToken}`);

		// Username
		const session = this._authenticationService.anyGitHubSession;
		if (session) {
			lines.push(`  Username: ${session.account.label}`);
		} else {
			lines.push('  Username: (not signed in)');
		}

		// Activation blockers note
		lines.push('  Activation blockers: not individually trackable after extension activation (blockers are awaited during startup and not recorded per-blocker)');

		// Language models
		try {
			const endpoints = await this._endpointProvider.getAllChatEndpoints();
			lines.push(`  Language models loaded: ${endpoints.length > 0} (count: ${endpoints.length})`);
		} catch (e) {
			lines.push(`  Language models loaded: false (error: ${e})`);
		}

		// Tools
		const toolCount = this._toolsService.tools.length;
		lines.push(`  Tools loaded: ${toolCount > 0} (count: ${toolCount})`);

		this._logService.info(lines.join('\n'));
	}
}
