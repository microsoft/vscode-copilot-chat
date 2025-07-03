/*----------------------------------------------------------------	override resetCopilotToken(httpError?: number): void {
		// Instead of clearing the token, refresh it to maintain authentication
		this.copilotToken = this.createFullAccessToken();
		this._logService.logger.debug(`Copilot token refreshed after HTTP error: ${httpError || 'unknown'}`);
	}------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { BaseOctoKitService } from '../../github/common/githubService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { CopilotToken, ExtendedTokenInfo } from '../common/copilotToken';
import { BaseCopilotTokenManager } from '../node/copilotTokenManager';

/**
 * Custom Copilot Token Manager that behaves as if the user has a valid,
 * never-expiring Copilot subscription with full access to all features.
 */
export class CustomCopilotTokenManager extends BaseCopilotTokenManager {
	private readonly customApiKey: string;
	private readonly customEndpoint: string;
	private readonly fullAccessToken: ExtendedTokenInfo;

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

		// Create a long-lived token that represents full Copilot access
		this.fullAccessToken = this.createFullAccessToken();

		// Initialize with the full access token
		this.copilotToken = this.fullAccessToken;

		this._logService.logger.info('Custom Copilot Token Manager initialized with full access');
	}

	async getCopilotToken(force?: boolean): Promise<CopilotToken> {
		// Always return a valid token - simulate perfect authentication
		if (!this.copilotToken || force) {
			this.copilotToken = this.createFullAccessToken();
			this._logService.logger.debug('Generated fresh Copilot token with full access');
		}

		return new CopilotToken(this.copilotToken);
	}

	override resetCopilotToken(httpError?: number): void {
		// Instead of clearing the token, refresh it to maintain authentication
		this.copilotToken = this.createFullAccessToken();
		this._logService.logger.debug(`Copilot token refreshed after HTTP error: ${httpError || 'unknown'}`);
	}

	private createFullAccessToken(): ExtendedTokenInfo {
		const now = Date.now() / 1000;
		const oneYear = 365 * 24 * 60 * 60; // One year in seconds

		return {
			token: this.generateCopilotToken(),
			expires_at: now + oneYear, // Token valid for 1 year
			refresh_in: oneYear - 3600, // Refresh 1 hour before expiry
			username: 'custom-copilot-user',
			isVscodeTeamMember: true, // Grant VS Code team member benefits
			copilot_plan: 'business' // Business plan for full feature access
		};
	}

	private generateCopilotToken(): string {
		// Generate a realistic Copilot token format
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2);
		const customId = this.customApiKey.substring(0, 8);

		// Include endpoint info in token generation for uniqueness
		const endpointHash = this.customEndpoint.split('').reduce((a, b) => {
			a = ((a << 5) - a) + b.charCodeAt(0);
			return a & a;
		}, 0);

		// Format: cop_[environment]_[timestamp]_[random]_[custom_id]_[endpoint_hash]
		return `cop_custom_${timestamp}_${random}_${customId}_${Math.abs(endpointHash)}`;
	}
}
