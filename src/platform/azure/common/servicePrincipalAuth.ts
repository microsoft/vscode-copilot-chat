/*---------------------------------------------------------------------------------------------
 *  Azure OpenAI Service Principal Authentication
 *  Uses client credentials (client_id + client_secret) to acquire Azure AD tokens
 *  for Azure OpenAI / Cognitive Services.
 *--------------------------------------------------------------------------------------------*/

import type { ExtensionContext } from 'vscode';

interface AccessToken {
	token: string;
	expiresOnTimestamp: number;
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
	token_type: string;
}

export interface IServicePrincipalAuthConfig {
	tenantId: string;
	clientId: string;
	clientSecret: string;
}

/**
 * Service principal authentication service that acquires Azure AD tokens
 * using client credentials grant (OAuth 2.0 client_credentials flow).
 * No interactive login required - fully automated token management.
 */
export class ServicePrincipalAuthService {
	private cachedToken: AccessToken | undefined;
	private _config: IServicePrincipalAuthConfig | undefined;
	private _extensionContext: ExtensionContext | undefined;

	constructor(
		private readonly _fetchFn: (url: string, init: RequestInit) => Promise<Response>,
	) { }

	setExtensionContext(context: ExtensionContext): void {
		this._extensionContext = context;
	}

	setConfig(config: Partial<IServicePrincipalAuthConfig>): void {
		if (config.tenantId && config.clientId) {
			this._config = {
				tenantId: config.tenantId,
				clientId: config.clientId,
				clientSecret: config.clientSecret || '',
			};
		}
	}

	private async getConfig(): Promise<IServicePrincipalAuthConfig> {
		if (this._config && this._config.clientSecret) {
			return this._config;
		}

		// Try to get client secret from environment variable first
		const envSecret = process.env.YOURCOMPANY_AI_CLIENT_SECRET;
		if (envSecret && this._config) {
			this._config.clientSecret = envSecret;
			return this._config;
		}

		// Try to get client secret from VS Code SecretStorage
		if (this._extensionContext && this._config) {
			const storedSecret = await this._extensionContext.secrets.get('yourcompany.ai.clientSecret');
			if (storedSecret) {
				this._config.clientSecret = storedSecret;
				return this._config;
			}
		}

		throw new Error(
			'Azure AD not fully configured. Set yourcompany.ai.tenantId, yourcompany.ai.clientId, and provide the client secret.'
		);
	}

	async getToken(): Promise<string> {
		// Return cached token if still valid (with 5 min buffer)
		if (this.cachedToken && this.cachedToken.expiresOnTimestamp > Date.now() + 300_000) {
			return this.cachedToken.token;
		}

		const config = await this.getConfig();

		const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;

		const body = new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: config.clientId,
			client_secret: config.clientSecret,
			scope: 'https://cognitiveservices.azure.com/.default',
		});

		const response = await this._fetchFn(tokenUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: body.toString(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Failed to acquire token from Azure AD: ${response.status} ${errorText}`);
		}

		const tokenResponse = await response.json() as TokenResponse;

		this.cachedToken = {
			token: tokenResponse.access_token,
			expiresOnTimestamp: Date.now() + (tokenResponse.expires_in * 1000),
		};

		return this.cachedToken.token;
	}

	/**
	 * Call this if credentials change (e.g. user updates settings or rotates secret)
	 */
	reset(): void {
		this._config = undefined;
		this.cachedToken = undefined;
	}

	/**
	 * Check whether minimum configuration is available
	 */
	isConfigured(): boolean {
		return !!(this._config?.tenantId && this._config?.clientId);
	}
}
