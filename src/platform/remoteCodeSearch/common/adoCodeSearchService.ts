/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { shouldInclude } from '../../../util/common/glob';
import { Result } from '../../../util/common/result';
import { CallTracker, TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { Range } from '../../../util/vs/editor/common/core/range';
import { createDecorator } from '../../../util/vs/platform/instantiation/common/instantiation';
import { FileChunkAndScore } from '../../chunking/common/chunk';
import { getGithubMetadataHeaders } from '../../chunking/common/chunkingEndpointClientImpl';
import { stripChunkTextMetadata } from '../../chunking/common/chunkingStringUtils';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { EmbeddingType } from '../../embeddings/common/embeddingsComputer';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { AdoRepoId } from '../../git/common/gitService';
import { IIgnoreService } from '../../ignore/common/ignoreService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { getRequest, postRequest } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { CodeSearchOptions, CodeSearchResult, RemoteCodeSearchIndexState, RemoteCodeSearchIndexStatus } from './remoteCodeSearch';


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


export interface AdoCodeSearchRepoInfo {
	readonly adoRepoId: AdoRepoId;
	readonly localRepoRoot: URI | undefined;
	readonly indexedCommit: string | undefined;
}

export const IAdoCodeSearchService = createDecorator('IAdoCodeSearchService');

export interface IAdoCodeSearchService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeIndexState: Event<void>;

	/**
	 * Gets the state of the remote index for a given repo.
	 */
	getRemoteIndexState(
		authToken: string,
		repoId: AdoRepoId,
		token: CancellationToken,
	): Promise<Result<RemoteCodeSearchIndexState, Error>>;

	/**
	 * Requests that a given repo be indexed.
	 */
	triggerIndexing(
		authToken: string,
		triggerReason: 'auto' | 'manual' | 'tool',
		repoId: AdoRepoId,
		telemetryInfo: TelemetryCorrelationId,
	): Promise<boolean>;

	/**
	 * Semantic searches a given repo for relevant code snippets
	 *
	 * The repo must have been indexed first. Make sure to check {@link getRemoteIndexState} or call {@link triggerIndexing}.
	 */
	searchRepo(
		authToken: string,
		repo: AdoCodeSearchRepoInfo,
		query: string,
		maxResults: number,
		options: CodeSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken,
	): Promise<CodeSearchResult>;
}

/**
 * Ado currently uses their own scoring system for embeddings.
 */
const adoCustomEmbeddingScoreType = new EmbeddingType('adoCustomEmbeddingScore');

export class AdoCodeSearchService extends Disposable implements IAdoCodeSearchService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeIndexState = this._register(new Emitter<void>());
	public readonly onDidChangeIndexState = this._onDidChangeIndexState.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDomainService private readonly _domainService: IDomainService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IEnvService private readonly _envService: IEnvService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.Internal.WorkspaceEnableAdoCodeSearch.fullyQualifiedId)) {
				this._onDidChangeIndexState.fire();
			}
		}));
	}

	private getAdoAlmStatusUrl(repoId: AdoRepoId): string {
		return `https://almsearch.dev.azure.com/${repoId.org}/${repoId.project}/_apis/search/semanticsearchstatus/${repoId.repo}?api-version=7.1-preview`;
	}

	private getAdoAlmSearchUrl(repo: AdoRepoId): string {
		return `https://almsearch.dev.azure.com/${repo.org}/${repo.project}/_apis/search/embeddings?api-version=7.1-preview`;
	}

	async getRemoteIndexState(authToken: string, repoId: AdoRepoId, token: CancellationToken): Promise<Result<RemoteCodeSearchIndexState, Error>> {
		if (!this.isEnabled()) {
			return Result.ok<RemoteCodeSearchIndexState>({
				status: RemoteCodeSearchIndexStatus.NotIndexable,
			});
		}

		const endpoint = this.getAdoAlmStatusUrl(repoId);

		const additionalHeaders = {
			Accept: 'application/json',
			Authorization: `Basic ${authToken}`,
			'Content-Type': 'application/json',
			...getGithubMetadataHeaders(new CallTracker('AdoCodeSearchService::getRemoteIndexState'), this._envService)
		};

		const result = await raceCancellationError(
			getRequest(
				this._fetcherService,
				this._envService,
				this._telemetryService,
				this._domainService,
				this._capiClientService,
				endpoint,
				authToken,
				undefined,
				'copilot-panel',
				'',
				undefined,
				additionalHeaders,
				token),
			token);

		if (!result.ok) {
			// TODO: how can we tell the difference between no access to repo and semantic search not being enabled?
			return Result.error(new Error(`Ado code search index status request failed with status: ${result.status}`));
		}

		type AdoIndexStatusResponse = {
			semanticSearchEnabled: boolean;
			id: string;
			name: string;
			indexedBranches: {
				name: string;
				lastIndexedChangeId: string;
				lastProcessedTime: string;
			}[];
		};

		const body: AdoIndexStatusResponse = await result.json();
		if (!body.semanticSearchEnabled) {
			return Result.ok<RemoteCodeSearchIndexState>({
				status: RemoteCodeSearchIndexStatus.NotIndexable,
			});
		}

		const indexedCommit = body.indexedBranches.at(0)?.lastIndexedChangeId;

		return Result.ok<RemoteCodeSearchIndexState>({
			indexedCommit,
			status: RemoteCodeSearchIndexStatus.Ready,
		});
	}

	public async triggerIndexing(
		authToken: string,
		triggerReason: 'auto' | 'manual' | 'tool',
		repoId: AdoRepoId,
		telemetryInfo: TelemetryCorrelationId,
	): Promise<boolean> {
		// ADO doesn't support explicit indexing. Just use the status and assume it's always ready
		const status = await this.getRemoteIndexState(authToken, repoId, CancellationToken.None);
		return status.isOk();
	}

	async searchRepo(
		authToken: string,
		repo: AdoCodeSearchRepoInfo,
		searchQuery: string,
		maxResults: number,
		options: CodeSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken
	): Promise<CodeSearchResult> {
		if (!this.isEnabled()) {
			return { chunks: [], outOfSync: false };
		}

		let endpoint = this._configurationService.getConfig(ConfigKey.Internal.WorkspacePrototypeAdoCodeSearchEndpointOverride);
		if (!endpoint) {
			endpoint = this.getAdoAlmSearchUrl(repo.adoRepoId);
		}
		const additionalHeaders = {
			Accept: 'application/json',
			Authorization: `Basic ${authToken}`,
			'Content-Type': 'application/json',
			...getGithubMetadataHeaders(new CallTracker('AdoCodeSearchService::searchRepo'), this._envService)
		};

		const response = await raceCancellationError(
			postRequest(
				this._fetcherService,
				this._envService,
				this._telemetryService,
				this._domainService,
				this._capiClientService,
				endpoint,
				authToken,
				undefined,
				'copilot-panel',
				'',
				{
					// TODO: Unclear what's ADO's actual limit is
					prompt: searchQuery.slice(0, 10000),
					scoping_query: `repo:${repo.adoRepoId.project}/${repo.adoRepoId.repo}`,
					limit: maxResults,
				} satisfies {
					prompt: string;
					scoping_query: string;
					limit: number;
				},
				additionalHeaders,
				token),
			token);

		if (!response.ok) {
			/* __GDPR__
				"adoCodeSearch.searchRepo.error" : {
					"owner": "mjbvz",
					"comment": "Information about failed code ado searches",
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The response status code" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('adoCodeSearch.searchRepo.error', {
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, {
				statusCode: response.status,
			});

			throw new Error(`Ado code search semantic search failed with status: ${response.status}`);
		}

		const body: ResponseShape = await raceCancellationError(response.json(), token);
		if (!Array.isArray(body.results)) {
			throw new Error(`Code search semantic search unexpected response json shape`);
		}

		const returnedEmbeddingsType = body.embedding_model ? new EmbeddingType(body.embedding_model) : adoCustomEmbeddingScoreType;

		const outChunks: FileChunkAndScore[] = [];
		let outOfSync = false;
		await Promise.all(body.results.map(async (result: SemanticSearchResult): Promise<FileChunkAndScore | undefined> => {
			let fileUri: URI;
			if (repo.localRepoRoot) {
				fileUri = URI.joinPath(repo.localRepoRoot, result.location.path.replace('%repo%/', ''));
				if (await this._ignoreService.isCopilotIgnored(fileUri)) {
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
					isFullFile: false, // TODO: not provided
				},
				distance: {
					embeddingType: returnedEmbeddingsType,
					value: result.distance,
				}
			});
		}));

		/* __GDPR__
			"adoCodeSearch.searchRepo.success" : {
				"owner": "mjbvz",
				"comment": "Information about successful ado code search searches",
				"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
				"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
				"resultCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of returned chunks from the search" },
				"resultOutOfSync": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Tracks if the commit we think code search has indexed matches the commit code search returns results from" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('adoCodeSearch.searchRepo.success', {
			workspaceSearchSource: telemetryInfo.callTracker.toString(),
			workspaceSearchCorrelationId: telemetryInfo.correlationId,
		}, {
			resultCount: body.results.length,
			resultOutOfSync: outOfSync ? 1 : 0,
		});

		return { chunks: outChunks, outOfSync };
	}

	private isEnabled(): boolean {
		return this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.WorkspaceEnableAdoCodeSearch, this._expService);
	}
}
