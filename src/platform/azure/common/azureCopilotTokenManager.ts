/*---------------------------------------------------------------------------------------------
 *  Azure Copilot Token Manager
 *  Replaces VSCodeCopilotTokenManager which fetches GitHub Copilot tokens.
 *  Returns a synthetic CopilotToken backed by Azure service principal auth.
 *  This enables inline completions, inline edits, and other systems that
 *  depend on CopilotToken for auth and endpoint resolution.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../util/vs/base/common/event';
import { IConfigurationService } from '../../configuration/common/configurationService';
// Azure-only fork: IFetcherService not needed - use globalThis.fetch for auth
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { ILogService } from '../../log/common/logService';
import { CopilotToken, createTestExtendedTokenInfo } from '../../authentication/common/copilotToken';
import { ICopilotTokenManager } from '../../authentication/common/copilotTokenManager';
import { ServicePrincipalAuthService } from './servicePrincipalAuth';

export class AzureCopilotTokenManager implements ICopilotTokenManager {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidCopilotTokenRefresh = new Emitter<void>();
	readonly onDidCopilotTokenRefresh: Event<void> = this._onDidCopilotTokenRefresh.event;

	private _authService: ServicePrincipalAuthService | undefined;
	private _cachedToken: CopilotToken | undefined;
	private _cachedTokenExpiry = 0;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
	) { }

	private getAuthService(): ServicePrincipalAuthService {
		if (!this._authService) {
			this._authService = new ServicePrincipalAuthService(
				(url: string, init: RequestInit) => globalThis.fetch(url, init)
			);
			this._authService.setExtensionContext(this._extensionContext);
		}
		const tenantId = this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.tenantId') || '';
		const clientId = this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.clientId') || '';
		this._authService.setConfig({ tenantId, clientId });
		return this._authService;
	}

	private getAzureEndpoint(): string {
		return (this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.endpoint') || '').replace(/\/$/, '');
	}

	async getCopilotToken(_force?: boolean): Promise<CopilotToken> {
		// Return cached if still valid (with 2 min buffer)
		if (this._cachedToken && this._cachedTokenExpiry > Date.now() + 120_000) {
			return this._cachedToken;
		}

		let bearerToken = 'azure-synthetic-token';
		const azureEndpoint = this.getAzureEndpoint();

		try {
			const auth = this.getAuthService();
			bearerToken = await auth.getToken(ServicePrincipalAuthService.SCOPE_COGNITIVE_SERVICES);
			this._logService.debug('AzureCopilotTokenManager: obtained service principal token');
		} catch (err) {
			// Service principal auth failed - use a synthetic placeholder token.
			// Features gated on copilotToken != undefined will still be enabled.
			// Actual API auth to Azure OpenAI is handled by the endpoint (API key).
			this._logService.info(`AzureCopilotTokenManager: service principal auth unavailable, using synthetic token. ${(err as Error).message}`);
		}

		// Build a synthetic CopilotToken that the completions system understands.
		// This always succeeds so that features gated on copilotToken (inline edits,
		// completions, etc.) are enabled regardless of service principal configuration.
		const tokenInfo = createTestExtendedTokenInfo({
			token: bearerToken,
			expires_at: Math.floor(Date.now() / 1000) + 3600,
			refresh_in: 1800,
			sku: 'business' as any,
			individual: false,
			endpoints: {
				// The proxy endpoint is used by completions-core to construct URLs.
				// We set it to our Azure endpoint base so getEndpointUrl() uses it.
				proxy: azureEndpoint,
				api: azureEndpoint,
				'origin-tracker': azureEndpoint,
				telemetry: '',
			},
			copilotignore_enabled: true,
			blackbird_clientside_indexing: true,
			codesearch: false,
			code_quote_enabled: false,
			code_review_enabled: false,
			vsc_electron_fetcher_v2: false,
			public_suggestions: 'disabled',
			telemetry: 'disabled',
			username: 'azure-service-principal',
			isVscodeTeamMember: false,
			copilot_plan: 'business',
			organization_login_list: [],
		});

		const copilotToken = new CopilotToken(tokenInfo);
		this._cachedToken = copilotToken;
		this._cachedTokenExpiry = Date.now() + 3600_000; // 1 hour
		this._onDidCopilotTokenRefresh.fire();

		return copilotToken;
	}

	resetCopilotToken(_httpError?: number): void {
		this._cachedToken = undefined;
		this._cachedTokenExpiry = 0;
	}
}
