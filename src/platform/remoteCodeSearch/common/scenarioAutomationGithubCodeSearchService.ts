/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Result } from '../../../util/common/result';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IEnvService } from '../../env/common/envService';
import { GithubRepoId, toGithubNwo } from '../../git/common/gitService';
import { IIgnoreService } from '../../ignore/common/ignoreService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { GithubCodeSearchService } from './githubCodeSearchService';
import { RemoteCodeSearchError, RemoteCodeSearchIndexState, RemoteCodeSearchIndexStatus } from './remoteCodeSearch';

/**
 * Scenario automation variant of GithubCodeSearchService that bypasses
 * remote index state checks, always returning Ready status so that
 * searches proceed directly against the local endpoint.
 */
export class ScenarioAutomationGithubCodeSearchService extends GithubCodeSearchService {

	constructor(
		@IAuthenticationService authenticationService: IAuthenticationService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IEnvService envService: IEnvService,
		@IFetcherService fetcherService: IFetcherService,
		@IIgnoreService ignoreService: IIgnoreService,
		@ILogService private readonly _log: ILogService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(authenticationService, capiClientService, envService, fetcherService, ignoreService, _log, telemetryService);
	}

	override async getRemoteIndexState(_auth: { readonly silent: boolean }, githubRepoId: GithubRepoId, _telemetryInfo: TelemetryCorrelationId, _token: CancellationToken): Promise<Result<RemoteCodeSearchIndexState, RemoteCodeSearchError>> {
		this._log.trace(`ScenarioAutomationGithubCodeSearchService::getRemoteIndexState(${toGithubNwo(githubRepoId)}). Returning Ready for local endpoint.`);
		return Result.ok({ status: RemoteCodeSearchIndexStatus.Ready, indexedCommit: undefined });
	}
}
