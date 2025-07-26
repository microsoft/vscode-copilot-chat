/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { BaseOctoKitService, VSCodeTeamId } from '../../github/common/githubService';
import { NullBaseOctoKitService } from '../../github/common/nullOctokitServiceImpl';
import { ILogService } from '../../log/common/logService';
import { IFetcherService, Response, jsonVerboseError } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { CopilotToken, CopilotUserInfo, ExtendedTokenInfo, TokenInfo, TokenInfoOrError, containsInternalOrg } from '../common/copilotToken';
import { CheckCopilotToken, ICopilotTokenManager, NotGitHubLoginFailed, nowSeconds } from '../common/copilotTokenManager';

export const tokenErrorString = `Tests: either GITHUB_PAT or GITHUB_OAUTH_TOKEN must be set. Run "npm run get_token" to get one.`;

export function getStaticGitHubToken() {
	if (process.env.GITHUB_PAT) {
		return process.env.GITHUB_PAT;
	}
	if (process.env.GITHUB_OAUTH_TOKEN) {
		return process.env.GITHUB_OAUTH_TOKEN;
	}
	throw new Error(tokenErrorString);
}

export function getOrCreateTestingCopilotTokenManager(): SyncDescriptor<ICopilotTokenManager & CheckCopilotToken> {
	let result: SyncDescriptor<ICopilotTokenManager & CheckCopilotToken> | undefined;
	if (process.env.GITHUB_PAT) {
		result = new SyncDescriptor(FixedCopilotTokenManager, [process.env.GITHUB_PAT]);
	}
	if (process.env.GITHUB_OAUTH_TOKEN) {
		result = new SyncDescriptor(CopilotTokenManagerFromGitHubToken, [process.env.GITHUB_OAUTH_TOKEN]);
	}
	if (!result) {
		throw new Error(tokenErrorString);
	}
	return result;
}

//TODO: Move this to common
export abstract class BaseCopilotTokenManager extends Disposable implements ICopilotTokenManager {
	declare readonly _serviceBrand: undefined;

	protected _isDisposed = false;

	//#region Events
	private readonly _copilotTokenRefreshEmitter = this._register(new Emitter<void>());
	readonly onDidCopilotTokenRefresh = this._copilotTokenRefreshEmitter.event;

	//#endregion
	constructor(
		protected readonly _baseOctokitservice: BaseOctoKitService,
		protected readonly _logService: ILogService,
		protected readonly _telemetryService: ITelemetryService,
		protected readonly _domainService: IDomainService,
		protected readonly _capiClientService: ICAPIClientService,
		protected readonly _fetcherService: IFetcherService,
		protected readonly _envService: IEnvService
	) {
		super();
		this._register(toDisposable(() => this._isDisposed = true));
	}

	//#region Property getters and setters
	private _copilotToken: ExtendedTokenInfo | undefined;
	get copilotToken(): ExtendedTokenInfo | undefined {
		return this._copilotToken;
	}
	set copilotToken(token: ExtendedTokenInfo | undefined) {
		if (token !== this._copilotToken) {
			this._copilotToken = token;
			this._copilotTokenRefreshEmitter.fire();
		}
	}

	//#endregion
	//#region Abstract methods
	abstract getCopilotToken(force?: boolean): Promise<CopilotToken>;

	//#endregion
	//#region Public methods
	resetCopilotToken(httpError?: number): void {
		if (httpError !== undefined) {
			this._telemetryService.sendGHTelemetryEvent('auth.reset_token_' + httpError);
		}
		this._logService.debug(`Resetting copilot token on HTTP error ${httpError || 'unknown'}`);
		this.copilotToken = undefined;
	}

	/**
	 * Fetches a Copilot token from the GitHub token.
	 * @param githubToken A GitHub token to mint a Copilot token from.
	 * @returns A Copilot token info or an error.
	 * @todo this should be not be public, but it is for now to allow testing.
	 */
	async authFromGitHubToken(
		githubToken: string
	): Promise<TokenInfoOrError & NotGitHubLoginFailed> {
		this._telemetryService.sendGHTelemetryEvent('auth.new_login');
		const response = await this.fetchCopilotToken(githubToken);
		if (!response) {
			this._logService.warn('Failed to get copilot token');
			this._telemetryService.sendGHTelemetryErrorEvent('auth.request_failed');
			return { kind: 'failure', reason: 'FailedToGetToken' };
		}

		// FIXME: Unverified type after inputting response
		const tokenInfo: undefined | TokenInfo = await jsonVerboseError(response);
		if (!tokenInfo) {
			this._logService.warn('Failed to get copilot token');
			this._telemetryService.sendGHTelemetryErrorEvent('auth.request_read_failed');
			return { kind: 'failure', reason: 'FailedToGetToken' };
		}

		if (response.status === 401) {
			this._logService.warn('Failed to get copilot token due to 401 status');
			this._telemetryService.sendGHTelemetryErrorEvent('auth.unknown_401');
			return { kind: 'failure', reason: 'HTTP401' };
		}

		if (response.status === 403 && tokenInfo.message?.startsWith('API rate limit exceeded')) {
			this._logService.warn('Failed to get copilot token due to exceeding API rate limit');
			this._telemetryService.sendGHTelemetryErrorEvent('auth.rate_limited');
			return { kind: 'failure', reason: 'RateLimited' };
		}

		if (!response.ok || !tokenInfo.token) {
			this._logService.warn(`Invalid copilot token: missing token: ${response.status} ${response.statusText}`);
			const data = TelemetryData.createAndMarkAsIssued({
				status: response.status.toString(),
				status_text: response.statusText,
			});
			this._telemetryService.sendGHTelemetryErrorEvent('auth.invalid_token', data.properties, data.measurements);
			const error_details = tokenInfo.error_details;
			return { kind: 'failure', reason: 'NotAuthorized', ...error_details };
		}

		const expires_at = tokenInfo.expires_at;
		// some users have clocks adjusted ahead, expires_at will immediately be less than current clock time;
		// adjust expires_at to the refresh time + a buffer to avoid expiring the token before the refresh can fire.
		tokenInfo.expires_at = nowSeconds() + tokenInfo.refresh_in + 60; // extra buffer to allow refresh to happen successfully



		// extend the token envelope
		const userInfo = await this.fetchCopilotUserInfo(githubToken);
		const authedUser = await this._baseOctokitservice.getCurrentAuthedUserWithToken(githubToken);
		const login = authedUser?.login ?? 'unknown';
		let isVscodeTeamMember = false;
		// VS Code team members are guaranteed to be a part of an internal org so we can check that first to minimize API calls
		if (containsInternalOrg(tokenInfo.organization_list ?? [])) {
			isVscodeTeamMember = !!(await this._baseOctokitservice.getTeamMembershipWithToken(VSCodeTeamId, githubToken, login));
		}
		const extendedInfo: ExtendedTokenInfo = {
			...tokenInfo,
			copilot_plan: userInfo.copilot_plan,
			quota_snapshots: userInfo.quota_snapshots,
			quota_reset_date: userInfo.quota_reset_date,
			username: login,
			isVscodeTeamMember,
		};
		const telemetryData = TelemetryData.createAndMarkAsIssued(
			{},
			{
				adjusted_expires_at: tokenInfo.expires_at,
				expires_at: expires_at, // track original expires_at
				current_time: nowSeconds(),
			}
		);

		this._telemetryService.sendGHTelemetryEvent('auth.new_token', telemetryData.properties, telemetryData.measurements);

		return { kind: 'success', ...extendedInfo };
	}

	//#endregion

	//#region Private methods
	private async fetchCopilotToken(githubToken: string) {
		return await this._capiClientService.makeRequest<Response>({
			headers: {
				Authorization: `token ${githubToken}`,
				'X-GitHub-Api-Version': '2025-04-01'
			},
		}, { type: RequestType.CopilotToken });
	}

	private async fetchCopilotUserInfo(githubToken: string): Promise<CopilotUserInfo> {
		const response = await this._capiClientService.makeRequest<Response>({
			headers: {
				Authorization: `token ${githubToken}`,
				'X-GitHub-Api-Version': '2025-04-01',
			}
		}, { type: RequestType.CopilotUserInfo });
		const data = await response.json();
		return data;
	}
}

//#region FixedCopilotTokenManager

/**
 * A `CopilotTokenManager` that always returns the same token.
 * Mostly only useful for short periods, e.g. tests or single completion requests,
 * as these tokens typically expire after a few hours.
 * @todo Move this to a test layer
 */

export class FixedCopilotTokenManager extends BaseCopilotTokenManager implements CheckCopilotToken {
	constructor(
		private _completionsToken: string,
		@ILogService logService: ILogService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IDomainService domainService: IDomainService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService
	) {
		super(new NullBaseOctoKitService(capiClientService, fetcherService), logService, telemetryService, domainService, capiClientService, fetcherService, envService);
		this.copilotToken = { token: _completionsToken, expires_at: 0, refresh_in: 0, username: 'fixedTokenManager', isVscodeTeamMember: false, copilot_plan: 'unknown' };
	}

	set completionsToken(token: string) {
		this._completionsToken = token;
		this.copilotToken = { token, expires_at: 0, refresh_in: 0, username: 'fixedTokenManager', isVscodeTeamMember: false, copilot_plan: 'unknown' };
	}
	get completionsToken(): string {
		return this._completionsToken;
	}

	async getCopilotToken(): Promise<CopilotToken> {
		return new CopilotToken(this.copilotToken!);
	}

	async checkCopilotToken(): Promise<{ status: 'OK' }> {
		// assume it's valid
		return { status: 'OK' };
	}
}

//#endregion

//#region CopilotTokenManagerFromGitHubToken

/**
 * Given a GitHub token, return a Copilot token, refreshing it as needed.
 * The caller that initializes the object is responsible for checking telemetry consent before
 * using the object.
 */
export class CopilotTokenManagerFromGitHubToken extends BaseCopilotTokenManager implements CheckCopilotToken {

	constructor(
		private readonly githubToken: string,
		@ILogService logService: ILogService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@IConfigurationService protected readonly configurationService: IConfigurationService
	) {
		super(new NullBaseOctoKitService(capiClientService, fetcherService), logService, telemetryService, domainService, capiClientService, fetcherService, envService);
	}

	async getCopilotToken(force?: boolean): Promise<CopilotToken> {
		if (!this.copilotToken || this.copilotToken.expires_at < nowSeconds() - (60 * 5 /* 5min */) || force) {
			const tokenResult = await this.authFromGitHubToken(this.githubToken);
			if (tokenResult.kind === 'failure') {
				throw Error(
					`Failed to get copilot token: ${tokenResult.reason.toString()} ${tokenResult.message ?? ''}`
				);
			}
			this.copilotToken = { ...tokenResult };
		}
		return new CopilotToken(this.copilotToken);
	}

	async checkCopilotToken() {
		if (!this.copilotToken || this.copilotToken.expires_at < nowSeconds()) {
			const tokenResult = await this.authFromGitHubToken(this.githubToken);
			if (tokenResult.kind === 'failure') {
				return tokenResult;
			}
			this.copilotToken = { ...tokenResult };
		}
		const result: { status: 'OK' } = {
			status: 'OK',
		};
		return result;
	}
}
