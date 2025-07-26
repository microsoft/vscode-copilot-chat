/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { shouldInclude } from '../../../util/common/glob';
import { Result } from '../../../util/common/result';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { raceCancellationError, raceTimeout, timeout } from '../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Iterable } from '../../../util/vs/base/common/iterator';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { isEqual, isEqualOrParent } from '../../../util/vs/base/common/resources';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseWarningPart } from '../../../vscodeTypes';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IAuthenticationChatUpgradeService } from '../../authentication/common/authenticationUpgrade';
import { FileChunkAndScore } from '../../chunking/common/chunk';
import { ComputeBatchInfo } from '../../chunking/common/chunkingEndpointClient';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { EmbeddingType } from '../../embeddings/common/embeddingsComputer';
import { RelativePattern } from '../../filesystem/common/fileTypes';
import { GithubRepoId } from '../../git/common/gitService';
import { logExecTime, LogExecTime, measureExecTime } from '../../log/common/logExecTime';
import { ILogService } from '../../log/common/logService';
import { IAdoCodeSearchService } from '../../remoteCodeSearch/common/adoCodeSearchService';
import { IGithubCodeSearchService } from '../../remoteCodeSearch/common/githubCodeSearchService';
import { CodeSearchResult } from '../../remoteCodeSearch/common/remoteCodeSearch';
import { BuildIndexTriggerReason, CodeSearchRepoTracker, IndexedRepoEntry, RepoEntry, RepoStatus, ResolvedRepoEntry, TriggerIndexingError } from '../../remoteCodeSearch/node/codeSearchRepoTracker';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { IWorkspaceService } from '../../workspace/common/workspaceService';
import { IWorkspaceChunkSearchStrategy, StrategySearchResult, StrategySearchSizing, WorkspaceChunkQueryWithEmbeddings, WorkspaceChunkSearchOptions, WorkspaceChunkSearchStrategyId } from '../common/workspaceChunkSearch';
import { CodeSearchWorkspaceDiffTracker } from './codeSearchWorkspaceDiff';
import { EmbeddingsChunkSearch } from './embeddingsChunkSearch';
import { TfIdfWithSemanticChunkSearch } from './tfidfWithSemanticChunkSearch';
import { IWorkspaceFileIndex } from './workspaceFileIndex';

export interface CodeSearchDiffState {
	readonly totalFileCount: number;

	/**
	 * Number of files that are outdated (i.e. not indexed)
	 *
	 * This will be undefined if there are too many files that are outdated.
	 */
	readonly outdatedFileCount: number | undefined;
}

export interface CodeSearchRemoteIndexState {
	readonly status: 'disabled' | 'initializing' | 'loaded';

	readonly repos: readonly RepoEntry[];
}

type DiffSearchResult = StrategySearchResult & {
	readonly strategyId: string;
	readonly embeddingsComputeInfo?: ComputeBatchInfo;
};

interface AvailableSuccessMetadata {
	readonly indexedRepos: RepoEntry[];
	readonly notYetIndexedRepos: RepoEntry[];
	readonly repoStatuses: Record<string, number>;
}

interface AvailableFailureMetadata {
	readonly unavailableReason: string;
	readonly repoStatuses: Record<string, number>;
}

/**
 * ChunkSearch strategy that first calls the Github code search API to get a context window of files that are similar to the query.
 * Then it uses the embeddings index to find the most similar chunks in the context window.
 */
export class CodeSearchChunkSearch extends Disposable implements IWorkspaceChunkSearchStrategy {

	readonly id = WorkspaceChunkSearchStrategyId.CodeSearch;

	/**
	 * Maximum number of locally changed, un-updated files that we should still use embeddings search for
	 */
	private readonly maxEmbeddingsDiffSize = 300;

	/**
	 * Maximum number of files that have changed from what code search has indexed
	 *
	 * This is used to avoid doing code search when the diff is too large.
	 */
	private readonly maxDiffSize = 2000;

	/**
	 * Maximum percent of files that have changed from what code search has indexed.
	 *
	 * If a majority of files have been changed there's no point to doing a code search
	 */
	private readonly maxDiffPercentage = 0.70;

	/**
	 * How long we should wait on the local diff before giving up.
	 */
	private readonly localDiffSearchTimeout = 15_000;

	/**
	 * How long we should wait for the embeddings search before falling back to tfidf.
	 */
	private readonly embeddingsSearchFallbackTimeout = 8_000;

	private readonly _repoTracker: CodeSearchRepoTracker;
	private readonly _workspaceDiffTracker: Lazy<CodeSearchWorkspaceDiffTracker>;

	private readonly _embeddingsChunkSearch: EmbeddingsChunkSearch;
	private readonly _tfIdfChunkSearch: TfIdfWithSemanticChunkSearch;

	private readonly _onDidChangeIndexState = this._register(new Emitter<void>());
	public readonly onDidChangeIndexState = this._onDidChangeIndexState.event;

	private _isDisposed = false;

	constructor(
		private readonly _embeddingType: EmbeddingType,
		embeddingsChunkSearch: EmbeddingsChunkSearch,
		tfIdfChunkSearch: TfIdfWithSemanticChunkSearch,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IAuthenticationChatUpgradeService private readonly _authUpgradeService: IAuthenticationChatUpgradeService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IWorkspaceFileIndex private readonly _workspaceChunkIndex: IWorkspaceFileIndex,
		@IGithubCodeSearchService private readonly _githubCodeSearchService: IGithubCodeSearchService,
		@IAdoCodeSearchService private readonly _adoCodeSearchService: IAdoCodeSearchService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		super();

		this._embeddingsChunkSearch = embeddingsChunkSearch;
		this._tfIdfChunkSearch = tfIdfChunkSearch;

		this._repoTracker = this._register(instantiationService.createInstance(CodeSearchRepoTracker));
		this._workspaceDiffTracker = new Lazy(() => this._register(instantiationService.createInstance(CodeSearchWorkspaceDiffTracker, this._repoTracker)));

		this._register(Event.any(
			this._repoTracker.onDidFinishInitialization,
			this._repoTracker.onDidRemoveRepo,
			this._repoTracker.onDidAddOrUpdateRepo,
		)(() => this._onDidChangeIndexState.fire()));

		this._repoTracker.initialize();
	}

	public override dispose(): void {
		super.dispose();
		this._isDisposed = true;
	}

	@LogExecTime(self => self._logService, 'CodeSearchChunkSearch.isAvailable')
	async isAvailable(searchTelemetryInfo?: TelemetryCorrelationId, canPrompt = false, token = CancellationToken.None): Promise<boolean> {
		const sw = new StopWatch();
		const checkResult = await this.doIsAvailableCheck(canPrompt, token);

		// Track where indexed repos are located related to the workspace
		const indexedRepoLocation = {
			workspaceFolder: 0,
			parentFolder: 0,
			subFolder: 0,
			unknownFolder: 0,
		};

		if (checkResult.isOk()) {
			const workspaceFolder = this._workspaceService.getWorkspaceFolders();
			for (const repo of checkResult.val.indexedRepos) {
				if (workspaceFolder.some(folder => isEqual(repo.repo.rootUri, folder))) {
					indexedRepoLocation.workspaceFolder++;
				} else if (workspaceFolder.some(folder => isEqualOrParent(folder, repo.repo.rootUri))) {
					indexedRepoLocation.parentFolder++;
				} else if (workspaceFolder.some(folder => isEqualOrParent(repo.repo.rootUri, folder))) {
					indexedRepoLocation.subFolder++;
				} else {
					indexedRepoLocation.unknownFolder++;
				}
			}
		}

		/* __GDPR__
			"codeSearchChunkSearch.isAvailable" : {
				"owner": "mjbvz",
				"comment": "Metadata about the code search availability check",
				"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
				"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
				"unavailableReason": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
				"repoStatues": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Detailed info about the statues of the repos in the workspace" },
				"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How long the check too to complete" },
				"indexedRepoCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of indexed repositories" },
				"notYetIndexedRepoCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of repositories that have not yet been indexed" },

				"indexedRepoLocation.workspace": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of repositories that map exactly to a workspace folder" },
				"indexedRepoLocation.parent": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of repositories that map to a parent folder" },
				"indexedRepoLocation.sub": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of repositories that map to a sub-folder" },
				"indexedRepoLocation.unknown": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of repositories that map to an unknown folder" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('codeSearchChunkSearch.isAvailable', {
			workspaceSearchSource: searchTelemetryInfo?.callTracker,
			workspaceSearchCorrelationId: searchTelemetryInfo?.correlationId,
			unavailableReason: checkResult.isError() ? checkResult.err.unavailableReason : undefined,
			repoStatues: JSON.stringify(checkResult.isOk() ? checkResult.val.repoStatuses : checkResult.err.repoStatuses),
		}, {
			execTime: sw.elapsed(),
			indexedRepoCount: checkResult.isOk() ? checkResult.val.indexedRepos.length : 0,
			notYetIndexedRepoCount: checkResult.isOk() ? checkResult.val.notYetIndexedRepos.length : 0,
			'indexedRepoLocation.workspace': indexedRepoLocation.workspaceFolder,
			'indexedRepoLocation.parent': indexedRepoLocation.parentFolder,
			'indexedRepoLocation.sub': indexedRepoLocation.subFolder,
			'indexedRepoLocation.unknown': indexedRepoLocation.unknownFolder,
		});

		if (checkResult.isError()) {
			this._logService.debug(`CodeSearchChunkSearch.isAvailable: false. ${checkResult.err.unavailableReason}`);
		} else {
			this._logService.debug(`CodeSearchChunkSearch.isAvailable: true`);
		}

		return checkResult.isOk();
	}

	private async doIsAvailableCheck(canPrompt = false, token: CancellationToken): Promise<Result<AvailableSuccessMetadata, AvailableFailureMetadata>> {
		if (!this.isCodeSearchEnabled()) {
			return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Disabled by experiment', repoStatuses: {} });
		}

		await this._repoTracker.initialize();
		if (this._isDisposed) {
			return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Disposed', repoStatuses: {} });
		}


		let allRepos = Array.from(this._repoTracker.getAllRepos());
		if (canPrompt) {
			if (allRepos.some(repo => repo.status === RepoStatus.CouldNotCheckIndexStatus || repo.status === RepoStatus.NotAuthorized)) {
				if (await raceCancellationError(this._authUpgradeService.shouldRequestPermissiveSessionUpgrade(), token)) { // Needs more thought
					if (await raceCancellationError(this._authUpgradeService.shouldRequestPermissiveSessionUpgrade(), token)) {
						await raceCancellationError(this._repoTracker.updateAllRepoStatuses(), token);
						allRepos = Array.from(this._repoTracker.getAllRepos());
					}
				}
			}
		}

		const repoStatuses = allRepos.reduce((sum, repo) => { sum[repo.status] = (sum[repo.status] ?? 0) + 1; return sum; }, {} as Record<string, number>);
		const indexedRepos = allRepos.filter(repo => repo.status === RepoStatus.Ready);
		const notYetIndexedRepos = this.canUseInstantIndexing() ? allRepos.filter(repo => repo.status === RepoStatus.NotYetIndexed) : [];

		if (!indexedRepos.length && !notYetIndexedRepos.length) {
			// Get detailed info about why we failed
			if (!allRepos.length) {
				return Result.error<AvailableFailureMetadata>({ unavailableReason: 'No repos', repoStatuses });
			}

			if (allRepos.some(repo => repo.status === RepoStatus.CheckingStatus || repo.status === RepoStatus.Initializing)) {
				return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Checking status', repoStatuses });
			}

			if (allRepos.every(repo => repo.status === RepoStatus.NotResolvable)) {
				return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Repos not resolvable', repoStatuses });
			}

			if (allRepos.every(repo => repo.status === RepoStatus.NotIndexable)) {
				return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Repos not indexable', repoStatuses });
			}

			if (allRepos.every(repo => repo.status === RepoStatus.NotYetIndexed)) {
				return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Not yet indexed', repoStatuses });
			}

			if (allRepos.every(repo => repo.status === RepoStatus.CouldNotCheckIndexStatus || repo.status === RepoStatus.NotAuthorized)) {
				return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Could not check index status', repoStatuses });
			}

			// Generic error
			return Result.error<AvailableFailureMetadata>({ unavailableReason: `No indexed repos`, repoStatuses });
		}

		const diffArray = await this.getLocalDiff();
		if (!Array.isArray(diffArray)) {
			switch (diffArray) {
				case 'unknown': {
					return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Diff not available', repoStatuses });
				}
				case 'tooLarge': {
					return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Diff too large', repoStatuses });
				}
			}
			return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Unknown diff error', repoStatuses });
		}

		return Result.ok({ indexedRepos, notYetIndexedRepos, repoStatuses });
	}

	private isCodeSearchEnabled() {
		return this._configService.getExperimentBasedConfig<boolean>(ConfigKey.Internal.WorkspaceEnableCodeSearch, this._experimentationService);
	}

	getRemoteIndexState(): CodeSearchRemoteIndexState {
		if (!this.isCodeSearchEnabled()) {
			return {
				status: 'disabled',
				repos: [],
			};
		}

		// Kick of request but do not wait for it to finish
		this._repoTracker.initialize();

		if (this._repoTracker.isInitializing()) {
			return {
				status: 'initializing',
				repos: [],
			};
		}

		const allResolvedRepos = Array.from(this._repoTracker.getAllRepos())
			.filter(repo => repo.status !== RepoStatus.NotResolvable);

		return {
			status: 'loaded',
			repos: allResolvedRepos,
		};
	}


	private didRunPrepare = false;
	async prepareSearchWorkspace(telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<undefined> {
		if (this.didRunPrepare) {
			return;
		}

		this.didRunPrepare = true;
		return this._repoTracker.tryAuthIfNeeded(telemetryInfo, token);
	}

	async searchWorkspace(sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<StrategySearchResult | undefined> {
		if (!(await raceCancellationError(this.isAvailable(telemetryInfo, true, token), token))) {
			return;
		}

		const allRepos = Array.from(this._repoTracker.getAllRepos());
		const indexedRepos = allRepos.filter(repo => repo.status === RepoStatus.Ready);
		const notYetIndexedRepos = allRepos.filter((repo): repo is ResolvedRepoEntry => repo.status === RepoStatus.NotYetIndexed);

		if (!indexedRepos.length && !notYetIndexedRepos.length) {
			return;
		}

		return logExecTime(this._logService, 'CodeSearchChunkSearch.searchWorkspace', async () => {
			const diffArray = await raceCancellationError(this.getLocalDiff(), token);
			if (!Array.isArray(diffArray)) {
				return;
			}

			if (notYetIndexedRepos.length) {
				const instantIndexResults = await Promise.all(notYetIndexedRepos.map(repo => this.tryToInstantIndexRepo(repo, telemetryInfo, token)));
				if (!instantIndexResults.every(x => x)) {
					this._logService.error(`Instant indexing failed for some repos. Will not try code search.`);
					return;
				}
			}

			const diffFilePatten = diffArray.map(uri => new RelativePattern(uri, '*'));

			const localSearchCts = new CancellationTokenSource(token);

			// Kick off remote and local searches in parallel
			const innerTelemetryInfo = telemetryInfo.addCaller('CodeSearchChunkSearch::searchWorkspace');

			// Trigger code search for all files without any excludes for diffed files.
			// This is needed incase local diff times out
			const codeSearchOperation = this.doCodeSearch(query, [...indexedRepos, ...notYetIndexedRepos], sizing, options, innerTelemetryInfo, token).catch(e => {
				if (!isCancellationError(e)) {
					this._logService.error(`Code search failed`, e);
				}

				// If code search fails, cancel local search too because we won't be able to merge
				localSearchCts.cancel();
				throw e;
			});

			const localSearchOperation = raceTimeout(this.searchLocalDiff(diffArray, sizing, query, options, innerTelemetryInfo, localSearchCts.token), this.localDiffSearchTimeout, () => {
				localSearchCts.cancel();
			});

			let codeSearchResults: CodeSearchResult | undefined;
			let localResults: DiffSearchResult | undefined;
			try {
				// However await them in sequence since if code search fails we don't care about local result
				codeSearchResults = await raceCancellationError(codeSearchOperation, token);
				if (codeSearchResults) {
					localResults = await raceCancellationError(localSearchOperation, token);
				} else {
					// No need to do local search if code search failed
					localSearchCts.cancel();
				}
			} finally {
				localSearchCts.dispose(true);
			}

			/* __GDPR__
				"codeSearchChunkSearch.search.success" : {
					"owner": "mjbvz",
					"comment": "Information about successful code searches",
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"diffSearchStrategy": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Search strategy for the diff" },
					"chunkCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of returned chunks just from code search" },
					"locallyChangedFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of files that are different than the code search index" },
					"codeSearchOutOfSync": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Tracks if the local commit we think code search has indexed matches what code search actually has indexed" },
					"embeddingsRecomputedFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of files that needed to have their embeddings recomputed. Only logged when embeddings search is used" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('codeSearchChunkSearch.search.success', {
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
				diffSearchStrategy: localResults?.strategyId ?? 'none',
			}, {
				chunkCount: codeSearchResults?.chunks.length ?? 0,
				locallyChangedFileCount: diffArray.length,
				codeSearchOutOfSync: codeSearchResults?.outOfSync ? 1 : 0,
				embeddingsRecomputedFileCount: localResults?.embeddingsComputeInfo?.recomputedFileCount ?? 0,
			});

			this._logService.trace(`CodeSearchChunkSearch.searchWorkspace: codeSearchResults: ${codeSearchResults?.chunks.length}, localResults: ${localResults?.chunks.length}`);

			if (!codeSearchResults) {
				return;
			}

			const mergedChunks: readonly FileChunkAndScore[] = localResults ?
				[
					...codeSearchResults.chunks
						.filter(x => shouldInclude(x.chunk.file, { exclude: diffFilePatten })),
					...(localResults?.chunks ?? [])
						.filter(x => shouldInclude(x.chunk.file, { include: diffFilePatten })),
				]
				// If there are no local results, use the full code search results without filtering
				: codeSearchResults.chunks;

			const outChunks = mergedChunks
				.filter(x => shouldInclude(x.chunk.file, options.globPatterns));

			return {
				chunks: outChunks,
				alerts: !localResults
					? [new ChatResponseWarningPart(l10n.t('Still updating workspace index. Falling back to using the latest remote code index only. Response may be less accurate.'))]
					: undefined
			};
		}, (execTime, status) => {
			/* __GDPR__
				"codeSearchChunkSearch.perf.searchFileChunks" : {
					"owner": "mjbvz",
					"comment": "Total time for searchFileChunks to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('codeSearchChunkSearch.perf.searchFileChunks', {
				status,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, { execTime });
		});
	}

	@LogExecTime(self => self._logService, 'CodeSearchChunkSearch.getLocalDiff')
	private async getLocalDiff(): Promise<readonly URI[] | 'unknown' | 'tooLarge'> {
		await this._workspaceDiffTracker.value.initialized;

		const diff = this._workspaceDiffTracker.value.getDiffFiles();
		if (!diff) { // undefined means we don't know the state of the workspace
			return 'unknown';
		}

		const diffArray = Array.from(diff);
		if (
			diffArray.length > this.maxDiffSize
			|| (diffArray.length / Iterable.reduce(this._workspaceChunkIndex.values(), sum => sum + 1, 0)) > this.maxDiffPercentage
		) {
			return 'tooLarge';
		}

		return diffArray;
	}

	private async searchLocalDiff(diffArray: readonly URI[], sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<DiffSearchResult | undefined> {
		if (!diffArray.length) {
			return { chunks: [], strategyId: 'skipped' };
		}

		const subSearchOptions: WorkspaceChunkSearchOptions = {
			...options,
			globPatterns: {
				exclude: options.globPatterns?.exclude,
				include: diffArray.map(uri => new RelativePattern(uri, '*')),
			}
		};

		const innerTelemetryInfo = telemetryInfo.addCaller('CodeSearchChunkSearch::searchLocalDiff');

		const outdatedFiles = await raceCancellationError(this.getLocalDiff(), token);
		if (outdatedFiles.length > this.maxEmbeddingsDiffSize) {
			// Too many files, only do tfidf search
			const result = await this._tfIdfChunkSearch.searchSubsetOfFiles(sizing, query, diffArray, subSearchOptions, innerTelemetryInfo, token);
			return { ...result, strategyId: this._tfIdfChunkSearch.id };
		}

		// Kick off embeddings search of diff
		const batchInfo = new ComputeBatchInfo();
		const embeddingsSearch = this._embeddingsChunkSearch.searchSubsetOfFiles(sizing, query, diffArray, subSearchOptions, { info: innerTelemetryInfo, batchInfo }, token)
			.then((result): DiffSearchResult => ({ ...result, strategyId: this._embeddingsChunkSearch.id, embeddingsComputeInfo: batchInfo }));

		const embeddingsSearchResult = await raceCancellationError(raceTimeout(embeddingsSearch, this.embeddingsSearchFallbackTimeout), token);
		if (embeddingsSearchResult) {
			return embeddingsSearchResult;
		}

		// Start tfidf too but keep embeddings search running in parallel
		const tfIdfSearch = this._tfIdfChunkSearch.searchSubsetOfFiles(sizing, query, diffArray, subSearchOptions, innerTelemetryInfo, token)
			.then((result): DiffSearchResult => ({ ...result, strategyId: this._tfIdfChunkSearch.id }));

		return Promise.race([embeddingsSearch, tfIdfSearch]);
	}

	private canUseInstantIndexing(): unknown {
		return this._configService.getExperimentBasedConfig<boolean>(ConfigKey.Internal.WorkspaceUseCodeSearchInstantIndexing, this._experimentationService);
	}

	@LogExecTime(self => self._logService, 'CodeSearchChunkSearch.doCodeSearch', function (execTime, status) {
		// Old name used for backwards compatibility with old telemetry
		/* __GDPR__
			"codeSearchChunkSearch.perf.doCodeSearchWithRetry" : {
				"owner": "mjbvz",
				"comment": "Total time for doCodeSearch to complete",
				"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
				"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('codeSearchChunkSearch.perf.doCodeSearchWithRetry', { status }, { execTime });
	})
	private async doCodeSearch(query: WorkspaceChunkQueryWithEmbeddings, repos: ReadonlyArray<ResolvedRepoEntry | IndexedRepoEntry>, sizing: StrategySearchSizing, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<CodeSearchResult | undefined> {
		const resolvedQuery = await raceCancellationError(query.resolveQuery(token), token);

		const githubAuthToken = new Lazy(() => this.tryGetGitHubAuthToken());
		const adoAuthToken = new Lazy(() => this.tryGetAdoAuthToken());

		const results = await Promise.all(repos.map(async repo => {
			if (repo.remoteInfo.repoId instanceof GithubRepoId) {
				const authToken = await githubAuthToken.value;
				if (!authToken) {
					this._logService.warn(`CodeSearchChunkSearch: doCodeSearch failed to get github auth token for repo ${repo.remoteInfo.repoId}`);
					return;
				}

				return this._githubCodeSearchService.searchRepo(authToken, this._embeddingType, {
					githubRepoId: repo.remoteInfo.repoId,
					localRepoRoot: repo.repo.rootUri,
					indexedCommit: repo.status === RepoStatus.Ready ? repo.indexedCommit : undefined,
				}, resolvedQuery, sizing.maxResultCountHint, options, telemetryInfo, token);
			} else {
				const authToken = await adoAuthToken.value;
				if (!authToken) {
					this._logService.warn(`CodeSearchChunkSearch: doCodeSearch failed to get ado auth token for repo ${repo.remoteInfo.repoId}`);
					return;
				}

				return this._adoCodeSearchService.searchRepo(authToken, {
					adoRepoId: repo.remoteInfo.repoId,
					localRepoRoot: repo.repo.rootUri,
					indexedCommit: repo.status === RepoStatus.Ready ? repo.indexedCommit : undefined,
				}, resolvedQuery, sizing.maxResultCountHint, options, telemetryInfo, token);
			}
		}));

		return {
			chunks: coalesce(results).flatMap(x => x.chunks),
			outOfSync: coalesce(results).some(x => x.outOfSync),
		};
	}

	private async tryToInstantIndexRepo(repo: ResolvedRepoEntry, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<boolean> {
		// Amount of time we'll wait for instant indexing to finish before giving up
		const unindexRepoInitTimeout = 8_000;

		const startRepoStatus = this._repoTracker.getRepoStatus(repo);

		await measureExecTime(() => raceTimeout((async () => {
			// Trigger indexing if we have not already
			if (startRepoStatus === RepoStatus.NotYetIndexed) {
				const triggerResult = await raceCancellationError(this._repoTracker.triggerRemoteIndexingOfRepo(repo, 'auto', telemetryInfo), token);
				if (triggerResult.isError()) {
					throw new Error(`CodeSearchChunkSearch: Triggering indexing of '${repo.remoteInfo.repoId}' failed: ${triggerResult.err.id}`);
				}
			}

			if (this._repoTracker.getRepoStatus(repo) === RepoStatus.BuildingIndex) {
				// Poll rapidly using endpoint to check if instant indexing has completed
				let attemptsRemaining = 5;
				const delayBetweenAttempts = 1000;

				while (attemptsRemaining--) {
					const currentStatus = (await raceCancellationError(this._repoTracker.updateRepoStateFromEndpoint(repo.repo, repo.remoteInfo, false, token), token)).status;
					if (currentStatus === RepoStatus.Ready) {
						// We're good to start searching
						break;
					} else if (currentStatus !== RepoStatus.BuildingIndex) {
						throw new Error(`CodeSearchChunkSearch: Checking instant indexing status of '${repo.remoteInfo.repoId}' failed. Found unexpected status: '${currentStatus}'`);
					}

					await raceCancellationError(timeout(delayBetweenAttempts), token);
				}
			}
		})(), unindexRepoInitTimeout), (execTime, status) => {
			const endRepoStatus = this._repoTracker.getRepoStatus(repo);

			/* __GDPR__
				"codeSearchChunkSearch.perf.tryToInstantIndexRepo" : {
					"owner": "mjbvz",
					"comment": "Total time for instant indexing to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"startRepoStatus": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Initial status of the repo" },
					"endRepoStatus": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Final status of the repo" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('codeSearchChunkSearch.perf.tryToInstantIndexRepo', {
				status,
				startRepoStatus,
				endRepoStatus,
			}, { execTime });
		});

		const currentStatus = this._repoTracker.getRepoStatus(repo);
		return currentStatus === RepoStatus.Ready || currentStatus === RepoStatus.BuildingIndex;
	}

	private async tryGetGitHubAuthToken() {
		return (await this._authenticationService.getPermissiveGitHubSession({ silent: true }))?.accessToken
			?? (await this._authenticationService.getAnyGitHubSession({ silent: true }))?.accessToken;
	}

	private async tryGetAdoAuthToken() {
		return this._authenticationService.getAdoAccessTokenBase64({ createIfNone: true });
	}

	public async triggerRemoteIndexing(triggerReason: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		const triggerResult = await this._repoTracker.triggerRemoteIndexing(triggerReason, telemetryInfo);

		if (triggerResult.isOk()) {
			this._logService.trace(`CodeSearch.triggerRemoteIndexing(${triggerReason}) succeeded`);
		} else {
			this._logService.trace(`CodeSearch.triggerRemoteIndexing(${triggerReason}) failed. ${triggerResult.err.id}`);
		}

		/* __GDPR__
			"codeSearchChunkSearch.triggerRemoteIndexing" : {
				"owner": "mjbvz",
				"comment": "Triggers of remote indexing",
				"triggerReason": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "How the call was triggered" },
				"error": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "How the trigger call failed" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('codeSearchChunkSearch.triggerRemoteIndexing', {
			triggerReason: triggerReason,
			error: triggerResult.isError() ? triggerResult.err.id : undefined,
		});

		return triggerResult;
	}

	public async triggerDiffIndexing(): Promise<undefined> {
		const diffArray = await this.getLocalDiff();
		if (Array.isArray(diffArray)) {
			this._embeddingsChunkSearch.tryTriggerReindexing(diffArray, new TelemetryCorrelationId('CodeSearchChunkSearch::triggerDiffIndexing'));
		}
	}
}

