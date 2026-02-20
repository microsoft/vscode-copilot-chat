/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { RequestType } from '@vscode/copilot-api';
import { createRequestHMAC } from '../../../util/common/crypto';
import { shouldInclude } from '../../../util/common/glob';
import { Result } from '../../../util/common/result';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { env } from '../../../util/vs/base/common/process';
import { URI } from '../../../util/vs/base/common/uri';
import { Range } from '../../../util/vs/editor/common/core/range';
import { createDecorator } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { FileChunkAndScore } from '../../chunking/common/chunk';
import { getGithubMetadataHeaders } from '../../chunking/common/chunkingEndpointClientImpl';
import { stripChunkTextMetadata, truncateToMaxUtf8Length } from '../../chunking/common/chunkingStringUtils';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { EmbeddingType } from '../../embeddings/common/embeddingsComputer';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IEnvService } from '../../env/common/envService';
import { GithubRepoId, toGithubNwo } from '../../git/common/gitService';
import { IIgnoreService } from '../../ignore/common/ignoreService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService, Response } from '../../networking/common/fetcherService';
import { postRequest } from '../../networking/common/networking';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { CodeSearchOptions, CodeSearchResult, RemoteCodeSearchError, RemoteCodeSearchIndexState, RemoteCodeSearchIndexStatus } from './remoteCodeSearch';

/**
 * Normalizes an endpoint URL by stripping trailing slashes.
 */
export function normalizeEndpointUrl(endpoint: string): string {
	return endpoint.replace(/\/+$/, '');
}

interface ResponseShape {
	readonly results: readonly SemanticSearchResult[];
	readonly embedding_model: string;
}

type SemanticSearchResult = {
	chunk: {
		hash: string;
		text: string;
		// Byte offset range of the chunk
		range: { start: number; end: number };
		line_range: { start: number; end: number };
		embedding?: { embedding: number[] };
	};
	distance: number;
	location: {
		path: string; // file path
		commit_sha: string;
		repo: {
			nwo: string;
			url: string;
		};
	};
};

export interface GithubCodeSearchRepoInfo {
	readonly githubRepoId: GithubRepoId;
	readonly localRepoRoot: URI | undefined;
	readonly indexedCommit: string | undefined;
}

export const IGithubCodeSearchService = createDecorator('IGithubCodeSearchService');

export interface IGithubCodeSearchService {
	readonly _serviceBrand: undefined;

	/**
	 * Gets the state of the remote index for a given repo.
	 */
	getRemoteIndexState(
		authOptions: { readonly silent: boolean },
		githubRepoId: GithubRepoId,
		token: CancellationToken,
	): Promise<Result<RemoteCodeSearchIndexState, RemoteCodeSearchError>>;

	/**
	 * Requests that a given repo be indexed.
	 */
	triggerIndexing(
		authOptions: { readonly silent: boolean },
		triggerReason: 'auto' | 'manual' | 'tool',
		githubRepoId: GithubRepoId,
		telemetryInfo: TelemetryCorrelationId,
	): Promise<Result<true, RemoteCodeSearchError>>;

	/**
	 * Semantic searches a given github repo for relevant code snippets
	 *
	 * The repo must have been indexed first. Make sure to check {@link getRemoteIndexState} or call {@link triggerIndexing}.
	 */
	searchRepo(
		authOptions: { readonly silent: boolean },
		embeddingType: EmbeddingType,
		repo: GithubCodeSearchRepoInfo,
		query: string,
		maxResults: number,
		options: CodeSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken,
	): Promise<CodeSearchResult>;
}

export class GithubCodeSearchService implements IGithubCodeSearchService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvService private readonly _envService: IEnvService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) { }

	async getRemoteIndexState(auth: { readonly silent: boolean }, githubRepoId: GithubRepoId, token: CancellationToken): Promise<Result<RemoteCodeSearchIndexState, RemoteCodeSearchError>> {
		const repoNwo = toGithubNwo(githubRepoId);

		// Check for custom semantic search endpoint (for local blackbird testing)
		const customEndpoint = this._configurationService.getConfig(ConfigKey.Advanced.SemanticSearchEndpoint);
		if (customEndpoint) {
			this._logService.trace(`GithubCodeSearchService::getRemoteIndexState(${repoNwo}). Using custom endpoint, returning Ready status.`);
			return Result.ok({ status: RemoteCodeSearchIndexStatus.Ready, indexedCommit: 'custom-endpoint' });
		}

		if (repoNwo.startsWith('microsoft/simuluation-test-')) {
			return Result.ok({ status: RemoteCodeSearchIndexStatus.NotYetIndexed });
		}

		const authToken = await this.getGithubAccessToken(auth.silent);
		if (!authToken) {
			this._logService.error(`GithubCodeSearchService::getRemoteIndexState(${repoNwo}). Failed to fetch indexing status. No valid github auth token.`);
			return Result.error<RemoteCodeSearchError>({ type: 'not-authorized' });
		}

		try {
			const statusRequest = await raceCancellationError(this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.EmbeddingsIndex, repoWithOwner: repoNwo }), token);
			if (!statusRequest.ok) {
				/* __GDPR__
					"githubCodeSearch.getRemoteIndexState.error" : {
						"owner": "mjbvz",
						"comment": "Information about failed remote index state requests",
						"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The response status code" }
					}
				*/
				this._telemetryService.sendMSFTTelemetryEvent('githubCodeSearch.getRemoteIndexState.error', {}, {
					statusCode: statusRequest.status,
				});

				this._logService.error(`GithubCodeSearchService::getRemoteIndexState(${repoNwo}). Failed to fetch indexing status. Response: ${statusRequest.status}. ${await statusRequest.text()}`);
				return Result.error<RemoteCodeSearchError>({ type: 'generic-error', error: new Error(`Failed to fetch indexing status. Response: ${statusRequest.status}.`) });
			}

			const preCheckResult = await raceCancellationError(statusRequest.json(), token);
			if (preCheckResult.semantic_code_search_ok && preCheckResult.semantic_commit_sha) {
				const indexedCommit = preCheckResult.semantic_commit_sha;
				this._logService.trace(`GithubCodeSearchService::getRemoteIndexState(${repoNwo}). Found indexed commit: ${indexedCommit}.`);
				return Result.ok({
					status: RemoteCodeSearchIndexStatus.Ready,
					indexedCommit,
				});
			}

			if (preCheckResult.semantic_indexing_enabled) {
				if (await raceCancellationError(this.isEmptyRepo(authToken, githubRepoId, token), token)) {
					this._logService.trace(`GithubCodeSearchService::getRemoteIndexState(${repoNwo}). Semantic indexing enabled but repo is empty.`);
					return Result.ok({
						status: RemoteCodeSearchIndexStatus.Ready,
						indexedCommit: undefined
					});
				}

				this._logService.trace(`GithubCodeSearchService::getRemoteIndexState(${repoNwo}). Semantic indexing enabled but not yet indexed.`);

				return Result.ok({ status: RemoteCodeSearchIndexStatus.BuildingIndex });
			} else {
				this._logService.trace(`GithubCodeSearchService::getRemoteIndexState(${repoNwo}). semantic_indexing_enabled was false. Repo not yet indexed but possibly can be.`);
				return Result.ok({ status: RemoteCodeSearchIndexStatus.NotYetIndexed });
			}
		} catch (e: unknown) {
			if (isCancellationError(e)) {
				throw e;
			}

			this._logService.error(`GithubCodeSearchService::getRemoteIndexState(${repoNwo}). Error: ${e}`);
			return Result.error<RemoteCodeSearchError>({ type: 'generic-error', error: e instanceof Error ? e : new Error(String(e)) });
		}
	}

	public async triggerIndexing(
		auth: { readonly silent: boolean },
		triggerReason: 'auto' | 'manual' | 'tool',
		githubRepoId: GithubRepoId,
		telemetryInfo: TelemetryCorrelationId,
	): Promise<Result<true, RemoteCodeSearchError>> {
		const authToken = await this.getGithubAccessToken(auth.silent);
		if (!authToken) {
			return Result.error({ type: 'not-authorized' });
		}

		const response = await this._capiClientService.makeRequest<Response>({
			method: 'POST',
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
			body: JSON.stringify({
				auto: triggerReason === 'auto',
			})
		}, { type: RequestType.EmbeddingsIndex, repoWithOwner: toGithubNwo(githubRepoId) });

		if (!response.ok) {
			this._logService.error(`GithubCodeSearchService.triggerIndexing(${triggerReason}). Failed to request indexing for '${githubRepoId}'. Response: ${response.status}. ${await response.text()}`);

			/* __GDPR__
				"githubCodeSearch.triggerIndexing.error" : {
					"owner": "mjbvz",
					"comment": "Information about failed trigger indexing requests",
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"triggerReason": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Reason why the indexing was triggered" },
					"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The response status code" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('githubCodeSearch.triggerIndexing.error', {
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
				triggerReason
			}, {
				statusCode: response.status,
			});

			return Result.error({ type: 'generic-error', error: new Error(`Failed to request indexing for '${githubRepoId}'. Response: ${response.status}.`) });
		}

		/* __GDPR__
			"githubCodeSearch.getRemoteIndexState.success" : {
				"owner": "mjbvz",
				"comment": "Information about failed remote index state requests",
				"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
				"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
				"triggerReason": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Reason why the indexing was triggered" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('githubCodeSearch.getRemoteIndexState.success', {
			workspaceSearchSource: telemetryInfo.callTracker.toString(),
			workspaceSearchCorrelationId: telemetryInfo.correlationId,
			triggerReason,
		}, {});

		return Result.ok(true);
	}

	async searchRepo(
		auth: { readonly silent: boolean },
		embeddingType: EmbeddingType,
		repo: GithubCodeSearchRepoInfo,
		searchQuery: string,
		maxResults: number,
		options: CodeSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken
	): Promise<CodeSearchResult> {
		// Check for custom semantic search endpoint (for local blackbird testing)
		const customEndpoint = this._configurationService.getConfig(ConfigKey.Advanced.SemanticSearchEndpoint);
		if (customEndpoint) {
			return this.searchCustomEndpoint(customEndpoint, embeddingType, repo, searchQuery, maxResults, options, telemetryInfo, token);
		}

		const authToken = await this.getGithubAccessToken(auth.silent);
		if (!authToken) {
			throw new Error('No valid auth token');
		}

		const response = await raceCancellationError(
			postRequest(
				this._fetcherService,
				this._telemetryService,
				this._capiClientService,
				{ type: RequestType.EmbeddingsCodeSearch },
				authToken,
				await createRequestHMAC(env.HMAC_SECRET),
				'copilot-panel',
				'',
				{
					scoping_query: `repo:${toGithubNwo(repo.githubRepoId)}`,
					// The semantic search endpoint only supports prompts of up to 8k bytes (in utf8)
					// For now just truncate but we should consider a better way to handle this, such as having a model
					// generate a short prompt
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
				} as any,
				getGithubMetadataHeaders(telemetryInfo.callTracker, this._envService),
				token),
			token);

		if (!response.ok) {
			/* __GDPR__
				"githubCodeSearch.searchRepo.error" : {
					"owner": "mjbvz",
					"comment": "Information about failed code searches",
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The response status code" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('githubCodeSearch.searchRepo.error', {
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, {
				statusCode: response.status,
			});

			throw new Error(`Code search semantic search failed with status: ${response.status}`);
		}

		const body = await raceCancellationError(response.json(), token);
		if (!Array.isArray(body.results)) {
			throw new Error(`Code search semantic search unexpected response json shape`);
		}

		const result = await raceCancellationError(parseGithubCodeSearchResponse(body, repo, options, this._ignoreService), token);

		/* __GDPR__
			"githubCodeSearch.searchRepo.success" : {
				"owner": "mjbvz",
				"comment": "Information about successful code searches",
				"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
				"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
				"resultCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of returned chunks from the search" },
				"resultOutOfSync": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Tracks if the commit we think code search has indexed matches the commit code search returns results from" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('githubCodeSearch.searchRepo.success', {
			workspaceSearchSource: telemetryInfo.callTracker.toString(),
			workspaceSearchCorrelationId: telemetryInfo.correlationId,
		}, {
			resultCount: body.results.length,
			resultOutOfSync: result.outOfSync ? 1 : 0,
		});

		return result;
	}

	private async getGithubAccessToken(silent: boolean) {
		return (await this._authenticationService.getGitHubSession('permissive', { silent }))?.accessToken
			?? (await this._authenticationService.getGitHubSession('any', { silent }))?.accessToken;
	}


	private async isEmptyRepo(authToken: string, githubRepoId: GithubRepoId, token: CancellationToken): Promise<boolean> {
		const response = await raceCancellationError(fetch(this._capiClientService.dotcomAPIURL + `/repos/${toGithubNwo(githubRepoId)}`, {
			headers: {
				'Authorization': `Bearer ${authToken}`,
				'Accept': 'application/vnd.github.v3+json'
			}
		}), token);

		if (!response.ok) {
			this._logService.error(`GithubCodeSearchService.isEmptyRepo(${toGithubNwo(githubRepoId)}). Failed to fetch repo info. Response: ${response.status}. ${await response.text()}`);
			return false;
		}

		const data: any = await response.json();

		// Check multiple indicators of an empty repo:
		// - size of 0 indicates no content
		// - missing default_branch often means no commits
		return data.size === 0 || !data.default_branch;
	}

	/**
	 * Search using a custom endpoint (for local blackbird testing)
	 */
	private async searchCustomEndpoint(
		endpoint: string,
		embeddingType: EmbeddingType,
		repo: GithubCodeSearchRepoInfo,
		searchQuery: string,
		maxResults: number,
		options: CodeSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken
	): Promise<CodeSearchResult> {
		this._logService.trace(`GithubCodeSearchService::searchCustomEndpoint. Using custom endpoint: ${endpoint}`);

		const normalizedEndpoint = normalizeEndpointUrl(endpoint);
		// Use the same API path as blackbird tool: /embeddings/code/search
		const searchUrl = `${normalizedEndpoint}/embeddings/code/search`;
		const requestBody = {
			prompt: truncateToMaxUtf8Length(searchQuery, 7800),
			scoping_query: `repo:${toGithubNwo(repo.githubRepoId)}`,
			include_embeddings: false,
			limit: maxResults,
		};

		const response = await raceCancellationError(
			this._fetcherService.fetch(
				searchUrl,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(requestBody),
				}
			),
			token
		);

		if (!response.ok) {
			/* __GDPR__
				"githubCodeSearch.searchCustomEndpoint.error" : {
					"owner": "mjbvz",
					"comment": "Information about failed custom endpoint searches",
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The response status code" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('githubCodeSearch.searchCustomEndpoint.error', {
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, {
				statusCode: response.status,
			});

			this._logService.error(`GithubCodeSearchService::searchCustomEndpoint. Custom endpoint search failed: ${response.status}`);
			throw new Error(`Custom endpoint search failed with status: ${response.status}`);
		}

		const body = await raceCancellationError(response.json(), token) as ResponseShape;
		if (!Array.isArray(body.results)) {
			this._logService.error('GithubCodeSearchService::searchCustomEndpoint. Custom endpoint returned invalid response');
			throw new Error('Custom endpoint returned invalid response');
		}

		const result = await parseGithubCodeSearchResponse(body, repo, options, this._ignoreService);

		/* __GDPR__
			"githubCodeSearch.searchCustomEndpoint.success" : {
				"owner": "mjbvz",
				"comment": "Information about successful custom endpoint searches",
				"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
				"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
				"resultCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of returned chunks from the search" },
				"resultOutOfSync": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Tracks if the commit we think code search has indexed matches the commit code search returns results from" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('githubCodeSearch.searchCustomEndpoint.success', {
			workspaceSearchSource: telemetryInfo.callTracker.toString(),
			workspaceSearchCorrelationId: telemetryInfo.correlationId,
		}, {
			resultCount: body.results.length,
			resultOutOfSync: result.outOfSync ? 1 : 0,
		});

		return result;
	}
}

export async function parseGithubCodeSearchResponse(body: ResponseShape, repo: GithubCodeSearchRepoInfo, options: CodeSearchOptions & { skipVerifyRepo?: boolean }, ignoreService: IIgnoreService): Promise<CodeSearchResult> {
	let outOfSync = false;
	const outChunks: FileChunkAndScore[] = [];

	const embeddingsType = new EmbeddingType(body.embedding_model);

	await Promise.all(body.results.map(async (result): Promise<FileChunkAndScore | undefined> => {
		if (!options.skipVerifyRepo && result.location.repo.nwo.toLowerCase() !== toGithubNwo(repo.githubRepoId)) {
			return;
		}

		let fileUri: URI;
		if (repo.localRepoRoot) {
			fileUri = URI.joinPath(repo.localRepoRoot, result.location.path);
			if (await ignoreService.isCopilotIgnored(fileUri)) {
				return;
			}
		} else {
			// Non-local repo, make up a URI
			fileUri = URI.from({
				scheme: 'githubRepoResult',
				path: '/' + result.location.path
			});
		}

		if (!shouldInclude(fileUri, options.globPatterns)) {
			return;
		}

		outOfSync ||= !!repo.indexedCommit && result.location.commit_sha !== repo.indexedCommit;
		outChunks.push({
			chunk: {
				file: fileUri,
				text: stripChunkTextMetadata(result.chunk.text),
				rawText: undefined,
				range: new Range(result.chunk.line_range.start, 0, result.chunk.line_range.end, 0),
				isFullFile: false, // TODO: get this from github
			},
			distance: {
				embeddingType: embeddingsType,
				value: result.distance,
			}
		});
	}));

	return { chunks: outChunks, outOfSync };
}
