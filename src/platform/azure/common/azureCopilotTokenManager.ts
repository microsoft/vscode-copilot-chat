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
	) { }

	private getAuthService(): ServicePrincipalAuthService {
		if (!this._authService) {
			this._authService = new ServicePrincipalAuthService(
				(url: string, init: RequestInit) => globalThis.fetch(url, init)
			);
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

		const auth = this.getAuthService();
		const azureEndpoint = this.getAzureEndpoint();

		try {
			const bearerToken = await auth.getToken(ServicePrincipalAuthService.SCOPE_COGNITIVE_SERVICES);

			// Build a synthetic CopilotToken that the completions system understands
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

			this._logService.debug('AzureCopilotTokenManager: obtained service principal token');
			return copilotToken;
		} catch (err) {
			this._logService.error(`AzureCopilotTokenManager: failed to get token: ${(err as Error).message}`);
			throw err;
		}
	}

	resetCopilotToken(_httpError?: number): void {
		this._cachedToken = undefined;
		this._cachedTokenExpiry = 0;
	}
}
