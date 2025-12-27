/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { generateCodeChallenge, generateCodeVerifier, generateNonce, generateState } from '../../../util/common/pkce';
import {
	getClaimsFromJWT,
	IAuthorizationJWTClaims,
	IAuthorizationServerMetadata,
	IAuthorizationTokenResponse
} from '../../../util/vs/base/common/oauth';

/**
 * Configuration for OAuth2 authentication
 */
export interface IOAuth2Config {
	/** OAuth2 client ID */
	clientId: string;
	/** OAuth2 client secret (optional for public clients using PKCE) */
	clientSecret?: string;
	/** OAuth2 server metadata */
	serverMetadata: IAuthorizationServerMetadata;
	/** Redirect URI registered with the provider */
	redirectUri: string;
	/** OAuth2 scopes */
	scopes: string[];
	/** Additional authorization parameters */
	additionalAuthParams?: Record<string, string>;
}

/**
 * OAuth2 flow state for validation
 */
interface IOAuth2FlowState {
	codeVerifier: string;
	state: string;
	nonce?: string;
	startedAt: number;
}

/**
 * OAuth2 service implementing authorization code flow with PKCE
 * Follows RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), and OpenID Connect
 */
export class OAuth2Service {
	private _currentFlow: IOAuth2FlowState | undefined;

	constructor(
		private readonly _config: IOAuth2Config,
		private readonly _fetcher: IFetcherService
	) { }

	/**
	 * Build authorization URL for OAuth2 flow
	 */
	async buildAuthorizationUrl(): Promise<string> {
		// Generate PKCE parameters
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = await generateCodeChallenge(codeVerifier);

		// Generate state and nonce
		const state = generateState();
		const nonce = this._config.scopes.includes('openid') ? generateNonce() : undefined;

		// Store flow state
		this._currentFlow = {
			codeVerifier,
			state,
			nonce,
			startedAt: Date.now()
		};

		// Build authorization URL
		console.log('[OAuth2Service] Building authorization URL from endpoint:', this._config.serverMetadata.authorization_endpoint);
		const authUrl = new URL(this._config.serverMetadata.authorization_endpoint!);
		authUrl.searchParams.set('client_id', this._config.clientId);
		authUrl.searchParams.set('response_type', 'code');
		authUrl.searchParams.set('redirect_uri', this._config.redirectUri);
		authUrl.searchParams.set('state', state);
		authUrl.searchParams.set('code_challenge', codeChallenge);
		authUrl.searchParams.set('code_challenge_method', 'S256');
		authUrl.searchParams.set('scope', this._config.scopes.join(' '));
		console.log('[OAuth2Service] Authorization URL constructed:', authUrl.toString());

		if (nonce) {
			authUrl.searchParams.set('nonce', nonce);
		}

		// Add additional parameters
		if (this._config.additionalAuthParams) {
			for (const [key, value] of Object.entries(this._config.additionalAuthParams)) {
				authUrl.searchParams.set(key, value);
			}
		}

		return authUrl.toString();
	}

	/**
	 * Validate callback and extract authorization code
	 * @param query The query string from the callback URI (already parsed by VS Code)
	 */
	validateCallback(query: string): { code: string } | { error: string } {
		// Parse query string - VS Code has already decoded it
		const params = new URLSearchParams(query);

		// Check for error
		const error = params.get('error');
		if (error) {
			return { error: params.get('error_description') || error };
		}

		// Extract code and state
		const code = params.get('code');
		const state = params.get('state');

		if (!code || !state) {
			console.error('[OAuth2Service] Missing code or state. Query:', query);
			console.error('[OAuth2Service] Parsed params:', { code, state });
			return { error: 'Missing code or state in callback' };
		}

		// Validate state
		if (!this._currentFlow || this._currentFlow.state !== state) {
			return { error: 'Invalid state - possible CSRF attack' };
		}

		// Check flow expiration (10 minutes)
		if (Date.now() - this._currentFlow.startedAt > 10 * 60 * 1000) {
			return { error: 'Authorization flow expired' };
		}

		return { code };
	}

	/**
	 * Exchange authorization code for tokens
	 */
	async exchangeCodeForToken(code: string): Promise<IAuthorizationTokenResponse> {
		if (!this._currentFlow) {
			throw new Error('No active OAuth2 flow');
		}

		const body = new URLSearchParams();
		body.append('grant_type', 'authorization_code');
		body.append('client_id', this._config.clientId);
		body.append('code', code);
		body.append('redirect_uri', this._config.redirectUri);
		body.append('code_verifier', this._currentFlow.codeVerifier);

		if (this._config.clientSecret) {
			body.append('client_secret', this._config.clientSecret);
		}

		const response = await this._fetcher.fetch(this._config.serverMetadata.token_endpoint!, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Accept': 'application/json'
			},
			body: body.toString()
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
		}

		const tokenResponse: IAuthorizationTokenResponse = await response.json();
		this._currentFlow = undefined;

		return tokenResponse;
	}

	/**
	 * Refresh access token
	 */
	async refreshAccessToken(refreshToken: string): Promise<IAuthorizationTokenResponse> {
		const body = new URLSearchParams();
		body.append('grant_type', 'refresh_token');
		body.append('client_id', this._config.clientId);
		body.append('refresh_token', refreshToken);

		if (this._config.clientSecret) {
			body.append('client_secret', this._config.clientSecret);
		}

		const response = await this._fetcher.fetch(this._config.serverMetadata.token_endpoint!, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Accept': 'application/json'
			},
			body: body.toString()
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
		}

		return await response.json();
	}

	/**
	 * Check if token needs refresh based on expiration
	 */
	shouldRefreshToken(tokenResponse: IAuthorizationTokenResponse, bufferSeconds: number = 300): boolean {
		if (!tokenResponse.expires_in) {
			return false;
		}

		// Calculate expiration (assuming token was just received)
		const expiresAt = Date.now() + (tokenResponse.expires_in * 1000);
		const now = Date.now();
		return expiresAt < (now + bufferSeconds * 1000);
	}

	/**
	 * Extract user info from token response
	 */
	getUserInfo(tokenResponse: IAuthorizationTokenResponse): IAuthorizationJWTClaims | undefined {
		try {
			const token = tokenResponse.id_token || tokenResponse.access_token;
			return token ? getClaimsFromJWT(token) : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Revoke token (if revocation endpoint is supported)
	 */
	async revokeToken(token: string, tokenTypeHint?: 'access_token' | 'refresh_token'): Promise<void> {
		if (!this._config.serverMetadata.revocation_endpoint) {
			console.warn('[OAuth2Service] Revocation endpoint not available');
			return;
		}

		const body = new URLSearchParams();
		body.append('token', token);
		body.append('client_id', this._config.clientId);

		if (tokenTypeHint) {
			body.append('token_type_hint', tokenTypeHint);
		}

		if (this._config.clientSecret) {
			body.append('client_secret', this._config.clientSecret);
		}

		try {
			const response = await this._fetcher.fetch(this._config.serverMetadata.revocation_endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: body.toString()
			});

			// RFC 7009: revocation endpoint returns 200 even if token doesn't exist
			if (!response.ok) {
				console.warn(`[OAuth2Service] Token revocation returned ${response.status}`);
			}
		} catch (error) {
			console.warn('[OAuth2Service] Token revocation failed:', error);
		}
	}
}
