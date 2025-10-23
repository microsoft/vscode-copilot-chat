/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationGetSessionOptions, AuthenticationSession } from 'vscode';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { BaseAuthenticationService, GITHUB_SCOPE_ALIGNED, GITHUB_SCOPE_USER_EMAIL, IAuthenticationService, MinimalModeError } from './authentication';
import { CopilotToken } from './copilotToken';
import { ICopilotTokenManager } from './copilotTokenManager';
import { ICopilotTokenStore } from './copilotTokenStore';

export class StaticGitHubAuthenticationService extends BaseAuthenticationService {
	constructor(
		private readonly tokenProvider: { (): string } | undefined,
		@ILogService logService: ILogService,
		@ICopilotTokenStore tokenStore: ICopilotTokenStore,
		@ICopilotTokenManager tokenManager: ICopilotTokenManager,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super(logService, tokenStore, tokenManager, configurationService);

		const that = this;
		this._anyGitHubSession = tokenProvider ? {
			get id() { return that.tokenProvider!(); },
			get accessToken() { return that.tokenProvider!(); },
			scopes: GITHUB_SCOPE_USER_EMAIL,
			account: {
				id: 'user',
				label: 'User'
			}
		} : undefined;

		this._permissiveGitHubSession = tokenProvider ? {
			get id() { return that.tokenProvider!(); },
			get accessToken() { return that.tokenProvider!(); },
			scopes: GITHUB_SCOPE_ALIGNED,
			account: {
				id: 'user',
				label: 'User'
			}
		} : undefined;
	}

	getAnyGitHubSession(_options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		return Promise.resolve(this._anyGitHubSession);
	}

	getPermissiveGitHubSession(options: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		if (this.isMinimalMode) {
			if (options.createIfNone || options.forceNewSession) {
				throw new MinimalModeError();
			}
			return Promise.resolve(undefined);
		}
		return Promise.resolve(this._permissiveGitHubSession);
	}

	override async getCopilotToken(force?: boolean): Promise<CopilotToken> {
		return await super.getCopilotToken(force);
	}

	setCopilotToken(token: CopilotToken): void {
		this._tokenStore.copilotToken = token;
		this._onDidAuthenticationChange.fire();
	}


	override getAnyAdoSession(_options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		return Promise.resolve(undefined);
	}

	override getAdoAccessTokenBase64(options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}
}

export function setCopilotToken(authenticationService: IAuthenticationService, token: CopilotToken): void {
	if (!(authenticationService instanceof StaticGitHubAuthenticationService)) {
		throw new Error('This function should only be used with StaticGitHubAuthenticationService');
	}
	(authenticationService as StaticGitHubAuthenticationService).setCopilotToken(token);
}
