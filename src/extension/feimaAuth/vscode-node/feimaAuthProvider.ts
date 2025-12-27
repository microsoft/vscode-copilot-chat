/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IAuthorizationTokenResponse } from '../../../util/vs/base/common/oauth';
import { IOAuth2Config, OAuth2Service } from '../common/oauth2Service';

/**
 * Stored token data in VS Code secrets
 */
interface IStoredTokenData {
	tokenResponse: IAuthorizationTokenResponse;
	issuedAt: number;
	sessionId: string;
	accountId: string;
	accountLabel: string;
}

/**
 * Authentication provider using OAuth2 + PKCE flow
 */
export class FeimaAuthProvider implements vscode.AuthenticationProvider, vscode.UriHandler {
	private _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _oauth2Service: OAuth2Service;
	private readonly _secretsKey = 'feimaAuth.tokens';
	private _pendingCallback: ((result: { code: string } | { error: string }) => void) | undefined;

	constructor(
		private readonly _context: IVSCodeExtensionContext,
		config: IOAuth2Config,
		oauth2Service: OAuth2Service
	) {
		this._oauth2Service = oauth2Service;
	}

	/**
	 * Handle OAuth callback URI
	 */
	async handleUri(uri: vscode.Uri): Promise<void> {

		if (!this._pendingCallback) {
			console.warn('[FeimaAuthProvider] Received callback without pending request');
			vscode.window.showErrorMessage('OAuth callback received but no authentication was in progress. Please try signing in again.');
			return;
		}

		// Validate callback using the parsed query string from VS Code
		const result = this._oauth2Service.validateCallback(uri.query);
		this._pendingCallback(result);
		this._pendingCallback = undefined;
	}

	/**
	 * Get existing sessions
	 */
	async getSessions(
		_scopes: readonly string[] | undefined,
		_options: vscode.AuthenticationProviderSessionOptions
	): Promise<vscode.AuthenticationSession[]> {
		const stored = await this._loadStoredToken();
		if (!stored) {
			return [];
		}

		// Check if token needs refresh
		const needsRefresh = this._oauth2Service.shouldRefreshToken(stored.tokenResponse);
		if (needsRefresh && stored.tokenResponse.refresh_token) {
			try {
				const refreshed = await this._oauth2Service.refreshAccessToken(stored.tokenResponse.refresh_token);
				await this._saveToken(refreshed, stored.accountId, stored.accountLabel);
				stored.tokenResponse = refreshed;
				stored.issuedAt = Date.now();
			} catch (error) {
				console.error('[FeimaAuthProvider] Token refresh failed:', error);
				await this._clearStoredToken();
				return [];
			}
		}

		return [{
			id: stored.sessionId,
			accessToken: stored.tokenResponse.access_token,
			account: {
				id: stored.accountId,
				label: stored.accountLabel
			},
			scopes: []
		}];
	}

	/**
	 * Create a new session with OAuth2 flow
	 */
	async createSession(
		_scopes: readonly string[],
		_options: vscode.AuthenticationProviderSessionOptions
	): Promise<vscode.AuthenticationSession> {

		// Build authorization URL
		const authUrl = await this._oauth2Service.buildAuthorizationUrl();

		// Open in browser
		const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
		if (!opened) {
			throw new Error('Failed to open authentication URL');
		}

		// Wait for callback
		const result = await new Promise<{ code: string } | { error: string }>((resolve) => {
			this._pendingCallback = resolve;
			// Timeout after 5 minutes
			setTimeout(() => {
				if (this._pendingCallback) {
					this._pendingCallback({ error: 'Authentication timed out' });
					this._pendingCallback = undefined;
				}
			}, 5 * 60 * 1000);
		});

		if ('error' in result) {
			throw new Error(`Authentication failed: ${result.error}`);
		}

		// Exchange code for token
		const tokenResponse = await this._oauth2Service.exchangeCodeForToken(result.code);

		// Extract user info
		const userInfo = this._oauth2Service.getUserInfo(tokenResponse);
		const accountId = userInfo?.sub || `user-${Date.now()}`;
		const accountLabel = userInfo?.email || userInfo?.preferred_username || userInfo?.name || 'Dummy User';

		// Save token
		await this._saveToken(tokenResponse, accountId, accountLabel);

		const session: vscode.AuthenticationSession = {
			id: `feima-session-${Date.now()}`,
			accessToken: tokenResponse.access_token,
			account: {
				id: accountId,
				label: accountLabel
			},
			scopes: []
		};

		// Fire the change event
		this._onDidChangeSessions.fire({
			added: [session],
			removed: [],
			changed: []
		});

		return session;
	}

	/**
	 * Remove a session
	 */
	async removeSession(sessionId: string): Promise<void> {
		console.log('[FeimaAuthProvider] removeSession called for:', sessionId);
		const stored = await this._loadStoredToken();
		console.log('[FeimaAuthProvider] Stored session:', stored ? stored.sessionId : 'NONE');
		if (!stored || stored.sessionId !== sessionId) {
			console.log('[FeimaAuthProvider] No matching session found, skipping removal');
			return;
		}

		// Revoke tokens if supported
		try {
			if (stored.tokenResponse.refresh_token) {
				await this._oauth2Service.revokeToken(stored.tokenResponse.refresh_token, 'refresh_token');
			}
			await this._oauth2Service.revokeToken(stored.tokenResponse.access_token, 'access_token');
		} catch (error) {
			console.warn('[FeimaAuthProvider] Token revocation failed:', error);
		}

		// Clear stored token
		await this._clearStoredToken();
		console.log('[FeimaAuthProvider] Token cleared from secrets');

		// Verify it's cleared
		const verify = await this._loadStoredToken();
		console.log('[FeimaAuthProvider] Verification after clear:', verify ? 'STILL EXISTS!' : 'Correctly cleared');

		// Fire the change event
		console.log('[FeimaAuthProvider] Firing session removed event');
		this._onDidChangeSessions.fire({
			added: [],
			removed: [{
				id: sessionId,
				accessToken: stored.tokenResponse.access_token,
				account: {
					id: stored.accountId,
					label: stored.accountLabel
				},
				scopes: []
			}],
			changed: []
		});
	}

	/**
	 * Load stored token from secrets
	 */
	private async _loadStoredToken(): Promise<IStoredTokenData | undefined> {
		try {
			if (!this._context) {
				console.error('[FeimaAuthProvider] Context is undefined in _loadStoredToken');
				return undefined;
			}
			const json = await this._context.secrets.get(this._secretsKey);
			return json ? JSON.parse(json) : undefined;
		} catch (error) {
			console.error('[FeimaAuthProvider] Failed to load token:', error);
			return undefined;
		}
	}

	/**
	 * Save token to secrets
	 */
	private async _saveToken(tokenResponse: IAuthorizationTokenResponse, accountId: string, accountLabel: string): Promise<void> {
		const data: IStoredTokenData = {
			tokenResponse,
			issuedAt: Date.now(),
			sessionId: `feima-session-${Date.now()}`,
			accountId,
			accountLabel
		};
		await this._context.secrets.store(this._secretsKey, JSON.stringify(data));
	}

	/**
	 * Clear stored token
	 */
	private async _clearStoredToken(): Promise<void> {
		await this._context.secrets.delete(this._secretsKey);
	}
}
