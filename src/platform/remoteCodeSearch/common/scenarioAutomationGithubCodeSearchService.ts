/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { Result } from '../../../util/common/result';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { getGithubMetadataHeaders } from '../../github/common/githubApiFetcherService';
import { truncateToMaxUtf8Length } from '../../chunking/common/chunkingStringUtils';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { EmbeddingType } from '../../embeddings/common/embeddingsComputer';
import { IEnvService } from '../../env/common/envService';
import { GithubRepoId, toGithubNwo } from '../../git/common/gitService';
import { IIgnoreService } from '../../ignore/common/ignoreService';
import { ILogService } from '../../log/common/logService';
import { postRequest } from '../../networking/common/networking';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { GithubCodeSearchService, GithubCodeSearchRepoInfo, parseGithubCodeSearchResponse } from './githubCodeSearchService';
import { CodeSearchOptions, CodeSearchResult, RemoteCodeSearchError, RemoteCodeSearchIndexState, RemoteCodeSearchIndexStatus } from './remoteCodeSearch';

/**
 * Scenario automation variant of GithubCodeSearchService that bypasses
 * remote index state checks and auth token requirements so that searches
 * proceed directly against a local embeddings endpoint.
 */
export class ScenarioAutomationGithubCodeSearchService extends GithubCodeSearchService {

	constructor(
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IEnvService private readonly _envService2: IEnvService,
		@IIgnoreService private readonly _ignoreService2: IIgnoreService,
		@ILogService private readonly _log: ILogService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService private readonly _instantiation2: IInstantiationService,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super(_authService, capiClientService, _envService2, _ignoreService2, _log, telemetryService, _instantiation2);
	}

	override async getRemoteIndexState(_auth: { readonly silent: boolean }, githubRepoId: GithubRepoId, _telemetryInfo: TelemetryCorrelationId, _token: CancellationToken): Promise<Result<RemoteCodeSearchIndexState, RemoteCodeSearchError>> {
		this._log.trace(`ScenarioAutomationGithubCodeSearchService::getRemoteIndexState(${toGithubNwo(githubRepoId)}). Returning Ready for local endpoint.`);
		return Result.ok({ status: RemoteCodeSearchIndexStatus.Ready, indexedCommit: undefined });
	}

	/**
	 * Override searchRepo to bypass the auth token requirement when an
	 * embeddings override URL is configured.  The request is intercepted by
	 * {@link ScenarioAutomationCAPIClientImpl} which strips auth headers
	 * anyway, so a placeholder token is used when no real one is available.
	 */
	override async searchRepo(
		auth: { readonly silent: boolean },
		embeddingType: EmbeddingType,
		repo: GithubCodeSearchRepoInfo,
		searchQuery: string,
		maxResults: number,
		options: CodeSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken,
	): Promise<CodeSearchResult> {
		if (!this._configService.getConfig(ConfigKey.Advanced.DebugOverrideEmbeddingsUrl)) {
			return super.searchRepo(auth, embeddingType, repo, searchQuery, maxResults, options, telemetryInfo, token);
		}

		// Use a real token if available, otherwise a placeholder — the CAPI
		// client override strips auth headers before sending to the local server.
		const authToken =
			(await this._authService.getGitHubSession('permissive', { silent: true }))?.accessToken
			?? (await this._authService.getGitHubSession('any', { silent: true }))?.accessToken
			?? 'scenario-automation-placeholder';

		const response = await raceCancellationError(
			this._instantiation2.invokeFunction(postRequest, {
				endpointOrUrl: { type: RequestType.EmbeddingsCodeSearch },
				secretKey: authToken,
				intent: 'copilot-panel',
				requestId: '',
				body: {
					scoping_query: `repo:${toGithubNwo(repo.githubRepoId)}`,
					prompt: truncateToMaxUtf8Length(searchQuery, 7800),
					include_embeddings: false,
					limit: maxResults,
					embedding_model: embeddingType.id,
				} satisfies {
					scoping_query: string;
					prompt: string;
					include_embeddings: boolean;
					limit: number;
					embedding_model: string;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any,
				additionalHeaders: getGithubMetadataHeaders(telemetryInfo.callTracker, this._envService2),
				cancelToken: token,
			}),
			token);

		if (!response.ok) {
			throw new Error(`Embeddings search failed with status: ${response.status}`);
		}

		const body = await raceCancellationError(response.json(), token);
		if (!Array.isArray(body.results)) {
			throw new Error(`Embeddings search unexpected response shape`);
		}

		return raceCancellationError(parseGithubCodeSearchResponse(body, repo, options, this._ignoreService2), token);
	}
}
