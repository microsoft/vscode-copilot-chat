/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commands } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

/**
 * The main entry point for the authentication contribution.
 */
export class AuthenticationContrib extends Disposable {
	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		this.askToUpgradeAuthPermissions();
	}
	private async askToUpgradeAuthPermissions() {
		const authUpgradeAsk = this._register(this.instantiationService.createInstance(AuthUpgradeAsk));
		await authUpgradeAsk.run();
	}
}

/**
 * This contribution ensures we have a token that is good enough for making API calls for current workspace.
 */
class AuthUpgradeAsk extends Disposable {

	constructor(
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@IAuthenticationChatUpgradeService private readonly _authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
	) {
		super();
		this._register(commands.registerCommand('github.copilot.chat.triggerPermissiveSignIn', async () => {
			await this._authenticationChatUpgradeService.showPermissiveSessionModal(true);
		}));
	}

	async run() {
		// Azure-only fork: don't block on GitHub auth or prompt for GitHub permissions.
		// Authentication is handled by Azure service principal via AzureCopilotTokenManager.
		try {
			await this._authenticationService.getCopilotToken();
		} catch (error) {
			// Azure token manager may fail if not configured yet - that's OK
			this._logService.debug('AuthUpgradeAsk: getCopilotToken failed (may be expected in Azure-only mode)', error);
		}
		// No GitHub auth listeners or permission prompts needed
	}
}
