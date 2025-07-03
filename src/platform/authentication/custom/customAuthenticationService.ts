/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationGetSessionOptions, AuthenticationSession } from 'vscode';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { BaseAuthenticationService, GITHUB_SCOPE_ALIGNED, GITHUB_SCOPE_USER_EMAIL } from '../common/authentication';
import { ICopilotTokenManager } from '../common/copilotTokenManager';
import { ICopilotTokenStore } from '../common/copilotTokenStore';

/**
 * Custom Authentication Service that behaves as if the user is fully authenticated
 * with access to all GitHub Copilot features including permissive scopes.
 */
export class CustomAuthenticationService extends BaseAuthenticationService {
	private readonly customOrgProvider: string;
	private readonly _fullAccessSession: AuthenticationSession;
	private readonly _permissiveSession: AuthenticationSession;

	constructor(
		customOrgProvider: string,
		logService: ILogService,
		tokenStore: ICopilotTokenStore,
		tokenManager: ICopilotTokenManager,
		configurationService: IConfigurationService
	) {
		super(logService, tokenStore, tokenManager, configurationService);
		this.customOrgProvider = customOrgProvider;

		// Create pre-authenticated sessions for immediate access
		this._fullAccessSession = this.createFullAccessSession();
		this._permissiveSession = this.createPermissiveSession();

		// Set initial sessions
		this._anyGitHubSession = this._fullAccessSession;
		this._permissiveGitHubSession = this._permissiveSession;

		this._logService.logger.info(`Custom authentication initialized for ${customOrgProvider} with full access`);
	}

	/**
	 * Always returns true to indicate user is not in minimal mode and has full access
	 */
	override get isMinimalMode(): boolean {
		return false;
	}

	async getAnyGitHubSession(options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		this._logService.logger.debug('Providing full access GitHub session');
		this._anyGitHubSession = this._fullAccessSession;
		return this._fullAccessSession;
	}

	async getPermissiveGitHubSession(options: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		this._logService.logger.debug('Providing permissive GitHub session with full repo access');
		this._permissiveGitHubSession = this._permissiveSession;
		return this._permissiveSession;
	}

	async getAdoAccessTokenBase64(options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
		// Provide Azure DevOps access token
		const adoToken = this.generateAdoToken();
		const base64Token = Buffer.from(`PAT:${adoToken}`, 'utf8').toString('base64');
		this._logService.logger.debug('Providing Azure DevOps access token');
		return base64Token;
	}

	private createFullAccessSession(): AuthenticationSession {
		const timestamp = Date.now();
		return {
			id: `custom-full-access-${timestamp}`,
			accessToken: this.generateGitHubToken('full'),
			scopes: GITHUB_SCOPE_USER_EMAIL,
			account: {
				id: 'custom-user-full',
				label: `${this.customOrgProvider} User (Full Access)`
			}
		};
	}

	private createPermissiveSession(): AuthenticationSession {
		const timestamp = Date.now();
		return {
			id: `custom-permissive-${timestamp}`,
			accessToken: this.generateGitHubToken('permissive'),
			scopes: GITHUB_SCOPE_ALIGNED, // Full repo access including read:user, user:email, repo, workflow
			account: {
				id: 'custom-user-permissive',
				label: `${this.customOrgProvider} User (Permissive)`
			}
		};
	}

	private generateGitHubToken(scope: 'full' | 'permissive'): string {
		// Generate a realistic-looking GitHub token
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2);
		return `ghp_${scope}_${timestamp}_${random}`;
	}

	private generateAdoToken(): string {
		// Generate Azure DevOps Personal Access Token
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2);
		return `ado_${timestamp}_${random}`;
	}
}
