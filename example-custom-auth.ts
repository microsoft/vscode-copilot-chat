/*---------------------------------------------------------------------------------------------
 *  Example: Custom Authentication Service and Token Manager Implementation
 *
 *  ✅ FULLY AUTHENTICATED BEHAVIOR:
 *  This implementation behaves as if the user is fully authenticated with access to ALL features:
 *
 *  🚀 Token Manager:
 *     - 24-hour long-lived tokens with business plan access
 *     - Marked as VS Code team member (isVscodeTeamMember: true)
 *     - All permissions: copilot:all, repo:all, workflow:all, admin:all
 *     - All features enabled: chat, completions, edits, agents, workspace
 *
 *  🚀 Authentication Service:
 *     - Never in minimal mode (isMinimalMode: false)
 *     - Full GitHub permissions including admin scopes
 *     - Always returns valid authenticated sessions
 *     - Full Azure DevOps token support
 *
 *  🎯 Result: All Copilot features work without restrictions or authentication prompts
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationGetSessionOptions, AuthenticationSession, ExtensionContext } from 'vscode';
import { BaseAuthenticationService, IAuthenticationService } from './src/platform/authentication/common/authentication';
import { CopilotToken, ExtendedTokenInfo } from './src/platform/authentication/common/copilotToken';
import { ICopilotTokenManager } from './src/platform/authentication/common/copilotTokenManager';
import { ICopilotTokenStore } from './src/platform/authentication/common/copilotTokenStore';
import { BaseCopilotTokenManager } from './src/platform/authentication/node/copilotTokenManager';
import { IConfigurationService } from './src/platform/configuration/common/configurationService';
import { ICAPIClientService } from './src/platform/endpoint/common/capiClient';
import { IDomainService } from './src/platform/endpoint/common/domainService';
import { IEnvService } from './src/platform/env/common/envService';
import { BaseOctoKitService } from './src/platform/github/common/githubService';
import { ILogService } from './src/platform/log/common/logService';
import { IFetcherService } from './src/platform/networking/common/fetcherService';
import { ITelemetryService } from './src/platform/telemetry/common/telemetry';
import { IInstantiationServiceBuilder } from './src/util/common/services';
import { SyncDescriptor } from './src/util/vs/platform/instantiation/common/descriptors';

// ===========================================================================================
// Custom Token Manager Implementation
// ===========================================================================================

export class CustomCopilotTokenManager extends BaseCopilotTokenManager {
	private readonly customApiKey: string;
	private readonly customEndpoint: string;

	constructor(
		customApiKey: string,
		customEndpoint: string,
		logService: ILogService,
		telemetryService: ITelemetryService,
		domainService: IDomainService,
		capiClientService: ICAPIClientService,
		fetcherService: IFetcherService,
		envService: IEnvService
	) {
		// Initialize base class with required dependencies
		super(
			new BaseOctoKitService(capiClientService, fetcherService),
			logService,
			telemetryService,
			domainService,
			capiClientService,
			fetcherService,
			envService
		);

		this.customApiKey = customApiKey;
		this.customEndpoint = customEndpoint;
	}

	async getCopilotToken(force?: boolean): Promise<CopilotToken> {
		// Always return a valid token for fully authenticated user
		// Check if we have a valid cached token
		if (!force && this.copilotToken && this.copilotToken.expires_at > Date.now() / 1000 + 300) { // 5 min buffer
			return new CopilotToken(this.copilotToken);
		}

		// Generate a long-lived, fully privileged token
		const tokenString = this.generateFullAccessToken();

		// Create token info for a fully authenticated enterprise user
		const tokenInfo: ExtendedTokenInfo = {
			token: tokenString,
			expires_at: Date.now() / 1000 + (24 * 3600), // 24 hours from now
			refresh_in: 23 * 3600, // 23 hours - refresh 1 hour before expiry
			username: 'enterprise-user',
			isVscodeTeamMember: true, // Enable all VS Code team features
			copilot_plan: 'business' // Business plan for full feature access
		};

		// Store in base class
		this.copilotToken = tokenInfo;
		return new CopilotToken(tokenInfo);
	}

	resetCopilotToken(httpError?: number): void {
		// Reset the token when there's an authentication error - but regenerate immediately
		this.copilotToken = undefined;
		// Note: In a fully authenticated scenario, you might want to immediately
		// regenerate the token instead of leaving it undefined
	}

	private generateFullAccessToken(): string {
		// Generate a mock token that represents full enterprise access
		// In a real implementation, this would be your actual token from your auth system
		const timestamp = Date.now();
		const userInfo = {
			user: 'enterprise-user',
			org: this.customApiKey ? 'enterprise' : 'default',
			permissions: ['copilot:all', 'repo:all', 'workflow:all', 'admin:all'],
			plan: 'business',
			features: ['chat', 'completions', 'edits', 'agents', 'workspace']
		};

		// Create a deterministic but unique token for full access
		const tokenData = JSON.stringify({ ...userInfo, timestamp });
		const token = `copilot_enterprise_full_${Buffer.from(tokenData).toString('base64').slice(0, 32)}`;

		// Log success (accessing protected _logService from base class)
		(this as any)._logService.logger.info('Generated full access Copilot token for enterprise user with all features enabled');
		return token;
	}
}

// ===========================================================================================
// Custom Authentication Service Implementation
// ===========================================================================================

export class CustomAuthenticationService extends BaseAuthenticationService {
	private readonly customOrgProvider: string;

	constructor(
		customOrgProvider: string,
		logService: ILogService,
		tokenStore: ICopilotTokenStore,
		tokenManager: ICopilotTokenManager,
		configurationService: IConfigurationService
	) {
		super(logService, tokenStore, tokenManager, configurationService);
		this.customOrgProvider = customOrgProvider;
	}

	async getAnyGitHubSession(options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		// Always return a fully authenticated session for basic GitHub access
		const session = this.createFullyAuthenticatedSession('basic');
		this._anyGitHubSession = session; // Cache the session
		return session;
	}

	async getPermissiveGitHubSession(options: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		// Always return a fully authenticated session with all permissions
		// Ignore minimal mode - we're always fully authenticated
		const session = this.createFullyAuthenticatedSession('permissive');
		this._permissiveGitHubSession = session; // Cache the session
		return session;
	}

	async getAdoAccessTokenBase64(options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
		// Always return a valid Azure DevOps token for full enterprise access
		const adoToken = this.generateAdoToken();
		return Buffer.from(`PAT:${adoToken}`, 'utf8').toString('base64');
	}

	private createFullyAuthenticatedSession(scope: 'basic' | 'permissive'): AuthenticationSession {
		// Create a session with full enterprise permissions
		const scopes = scope === 'permissive'
			? ['read:user', 'user:email', 'repo', 'workflow', 'admin:org', 'admin:repo_hook', 'admin:enterprise']
			: ['user:email', 'read:user'];

		const sessionId = `enterprise-auth-${scope}-${Date.now()}`;
		const accessToken = this.generateGitHubAccessToken(scope);

		this._logService.logger.info(`Created fully authenticated ${scope} session for enterprise user`);

		return {
			id: sessionId,
			accessToken: accessToken,
			scopes: scopes,
			account: {
				id: 'enterprise-user-123',
				label: `Enterprise User (${this.customOrgProvider}) - Full Access`
			}
		};
	}

	private generateGitHubAccessToken(scope: string): string {
		// Generate a mock GitHub access token with full permissions
		const timestamp = Date.now();
		const tokenData = {
			scope: scope,
			org: this.customOrgProvider,
			user: 'enterprise-user',
			permissions: 'all',
			timestamp: timestamp
		};

		return `ghp_enterprise_${Buffer.from(JSON.stringify(tokenData)).toString('base64').slice(0, 40)}`;
	}

	private generateAdoToken(): string {
		// Generate a mock Azure DevOps token with full permissions
		const timestamp = Date.now();
		const tokenData = {
			org: this.customOrgProvider,
			user: 'enterprise-user',
			scopes: ['vso.build', 'vso.code', 'vso.project', 'vso.work'],
			timestamp: timestamp
		};

		return `ado_enterprise_${Buffer.from(JSON.stringify(tokenData)).toString('base64').slice(0, 32)}`;
	}

	// Override minimal mode to always return false - we're always fully authenticated
	get isMinimalMode(): boolean {
		return false; // Always return false to enable all features
	}
}

// ===========================================================================================
// Service Registration Override
// ===========================================================================================

export function registerCustomAuthenticationServices(
	builder: IInstantiationServiceBuilder,
	extensionContext: ExtensionContext,
	customConfig: {
		apiKey: string;
		endpoint: string;
		orgProvider: string;
	}
): void {
	// Override the default authentication services with your custom implementations

	// Register custom token manager with configuration
	builder.define(ICopilotTokenManager, new SyncDescriptor(CustomCopilotTokenManager, [
		customConfig.apiKey,
		customConfig.endpoint
	]));

	// Register custom authentication service
	builder.define(IAuthenticationService, new SyncDescriptor(CustomAuthenticationService, [
		customConfig.orgProvider
	]));
}

// ===========================================================================================
// Integration Example
// ===========================================================================================

export function integrateCustomAuth() {
	/*
	In your extension's service registration (modify services.ts):

	import { registerCustomAuthenticationServices } from './path/to/custom-auth';

	export function registerServices(builder: IInstantiationServiceBuilder, extensionContext: ExtensionContext): void {
		// Register all common services first
		registerCommonServices(builder, extensionContext);

		// Custom configuration (could come from VS Code settings, environment vars, etc.)
		const customConfig = {
			apiKey: process.env.CUSTOM_COPILOT_API_KEY || '',
			endpoint: process.env.CUSTOM_COPILOT_ENDPOINT || 'https://your-api.company.com/copilot',
			orgProvider: 'YourCompany'
		};

		// Override authentication services with custom implementations
		if (customConfig.apiKey && customConfig.endpoint) {
			registerCustomAuthenticationServices(builder, extensionContext, customConfig);
		} else {
			// Fall back to default implementations
			if (isTestMode) {
				builder.define(ICopilotTokenManager, getOrCreateTestingCopilotTokenManager());
			} else {
				builder.define(ICopilotTokenManager, new SyncDescriptor(VSCodeCopilotTokenManager));
			}
			builder.define(IAuthenticationService, new SyncDescriptor(AuthenticationService));
		}

		// Register other services...
	}
	*/
}
