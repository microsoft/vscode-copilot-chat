/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { BaseOctoKitService, IOctoKitService, IOctoKitUser } from './githubService';

export class OctoKitService extends BaseOctoKitService implements IOctoKitService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@ITelemetryService telemetryService: ITelemetryService
	) {
		super(capiClientService, fetcherService, logService, telemetryService);
	}

	async getCurrentAuthedUser(): Promise<IOctoKitUser | undefined> {
		const authToken = (await this._authService.getAnyGitHubSession())?.accessToken;
		if (!authToken) {
			return undefined;
		}
		return await this.getCurrentAuthedUserWithToken(authToken);
	}

	async getTeamMembership(teamId: number): Promise<any | undefined> {
		const session = (await this._authService.getAnyGitHubSession());
		const token = session?.accessToken;
		const username = session?.account.label;
		if (!token || !username) {
			return undefined;
		}
		return await this.getTeamMembershipWithToken(teamId, token, username);
	}
}
