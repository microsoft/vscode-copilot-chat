/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { shouldInclude } from '../../../../util/common/glob';
import { Result } from '../../../../util/common/result';
import { TelemetryCorrelationId } from '../../../../util/common/telemetryCorrelationId';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { CancelablePromise, createCancelablePromise, DeferredPromise, IntervalTimer, raceCancellationError, raceTimeout, timeout } from '../../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { isEqual, isEqualOrParent } from '../../../../util/vs/base/common/resources';
import { StopWatch } from '../../../../util/vs/base/common/stopwatch';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseWarningPart } from '../../../../vscodeTypes';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { IAuthenticationChatUpgradeService } from '../../../authentication/common/authenticationUpgrade';
import { FileChunkAndScore } from '../../../chunking/common/chunk';
import { ComputeBatchInfo } from '../../../chunking/common/chunkingEndpointClient';
import { ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { EmbeddingType } from '../../../embeddings/common/embeddingsComputer';
import { RelativePattern } from '../../../filesystem/common/fileTypes';
import { AdoRepoId, GithubRepoId, IGitService, ResolvedRepoRemoteInfo } from '../../../git/common/gitService';
import { Change } from '../../../git/vscode/git';
import { logExecTime, LogExecTime, measureExecTime } from '../../../log/common/logExecTime';
import { ILogService } from '../../../log/common/logService';
import { IAdoCodeSearchService } from '../../../remoteCodeSearch/common/adoCodeSearchService';
import { IGithubCodeSearchService } from '../../../remoteCodeSearch/common/githubCodeSearchService';
import { CodeSearchResult, RemoteCodeSearchIndexStatus } from '../../../remoteCodeSearch/common/remoteCodeSearch';
import { ICodeSearchAuthenticationService } from '../../../remoteCodeSearch/node/codeSearchRepoAuth';
import { isGitHubRemoteRepository } from '../../../remoteRepositories/common/utils';
import { IExperimentationService } from '../../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { IWorkspaceService } from '../../../workspace/common/workspaceService';
import { IWorkspaceChunkSearchStrategy, StrategySearchResult, StrategySearchSizing, WorkspaceChunkQueryWithEmbeddings, WorkspaceChunkSearchOptions, WorkspaceChunkSearchStrategyId } from '../../common/workspaceChunkSearch';
import { EmbeddingsChunkSearch } from '../embeddingsChunkSearch';
import { TfIdfWithSemanticChunkSearch } from '../tfidfWithSemanticChunkSearch';
import { IWorkspaceFileIndex } from '../workspaceFileIndex';
import { CodeSearchRepoTracker, RepoInfo, TrackedRepoState, TrackedRepoStatus } from './repoTracker';
import { CodeSearchDiff, CodeSearchWorkspaceDiffTracker } from './workspaceDiff';

export enum RepoStatus {
	/** We could not resolve this repo */
	NotResolvable = 'NotResolvable',

	Resolving = 'Resolving',

	/** We are checking the status of the remote index. */
	CheckingStatus = 'CheckingStatus',

	/** The remote index is indexable but not built yet */
	NotYetIndexed = 'NotYetIndexed',

	/** The remote index is not indexed and we cannot trigger indexing for it */
	NotIndexable = 'NotIndexable',

	/**
	 * We failed to check the remote index status.
	 *
	 * This has a number of possible causes:
	 *
	 * - The repo doesn't exist
	 * - The user cannot access the repo (most services won't differentiate with it not existing). If we know
	 * 		for sure that the user cannot access the repo, we will instead use {@linkcode NotAuthorized}.
	 * - The status endpoint returned an error.
	 */
	CouldNotCheckIndexStatus = 'CouldNotCheckIndexStatus',

	/**
	 * The user is not authorized to access the remote index.
	 *
	 * This is a special case of {@linkcode CouldNotCheckIndexStatus} that is shown when we know the user is not authorized.
	 */
	NotAuthorized = 'NotAuthorized',

	/** The remote index is being build but is not ready for use  */
	BuildingIndex = 'BuildingIndex',

	/** The remote index is ready and usable */
	Ready = 'Ready'
}


export type BuildIndexTriggerReason = 'auto' | 'manual';

export interface TriggerIndexingError {
	readonly id: string;
	readonly userMessage: string;
}

export namespace TriggerRemoteIndexingError {
	export const noGitRepos: TriggerIndexingError = {
		id: 'no-git-repos',
		userMessage: l10n.t("No git repos found")
	};

	export const stillResolving: TriggerIndexingError = {
		id: 'still-resolving',
		userMessage: l10n.t("Still resolving repos. Please try again shortly.")
	};

	export const noRemoteIndexableRepos: TriggerIndexingError = {
		id: 'no-remote-indexable-repos',
		userMessage: l10n.t("No remotely indexable repos found")
	};

	export const noValidAuthToken: TriggerIndexingError = {
		id: 'no-valid-auth-token',
		userMessage: l10n.t("No valid auth token")
	};

	export const alreadyIndexed: TriggerIndexingError = {
		id: 'already-indexed',
		userMessage: l10n.t("Already indexed")
	};

	export const alreadyIndexing: TriggerIndexingError = {
		id: 'already-indexing',
		userMessage: l10n.t("Already indexing")
	};

	export const couldNotCheckIndexStatus: TriggerIndexingError = {
		id: 'could-not-check-index-status',
		userMessage: l10n.t("Could not check the remote index status for this repo")
	};

	export function errorTriggeringIndexing(repoId: GithubRepoId | AdoRepoId): TriggerIndexingError {
		return {
			id: 'request-to-index-failed',
			userMessage: l10n.t`Request to index '${repoId.toString()}' failed`
		};
	}
}

export interface CodeSearchRemoteIndexState {
	readonly status: 'disabled' | 'initializing' | 'loaded';

	readonly repos: readonly RepoInfo[];
}

type DiffSearchResult = StrategySearchResult & {
	readonly strategyId: string;
	readonly embeddingsComputeInfo?: ComputeBatchInfo;
};

interface AvailableSuccessMetadata {
	readonly indexedRepos: readonly RepoInfo[];
	readonly notYetIndexedRepos: readonly RepoInfo[];
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

	private readonly _workspaceDiffTracker: Lazy<CodeSearchWorkspaceDiffTracker>;

	private readonly _embeddingsChunkSearch: EmbeddingsChunkSearch;
	private readonly _tfIdfChunkSearch: TfIdfWithSemanticChunkSearch;

	private readonly _onDidChangeIndexState = this._register(new Emitter<void>());
	public readonly onDidChangeIndexState = this._onDidChangeIndexState.event;

	private _isDisposed = false;

	private readonly _codeSearchRepos = new ResourceMap<GithubCodeSearchRepo>();

	private readonly _onDidFinishInitialization = this._register(new Emitter<void>());
	public readonly onDidFinishInitialization = this._onDidFinishInitialization.event;

	private readonly _onDidAddOrUpdateCodeSearchRepo = this._register(new Emitter<RepoInfo>());
	public readonly onDidAddOrUpdateCodeSearchRepo = this._onDidAddOrUpdateCodeSearchRepo.event;

	private readonly _onDidRemoveCodeSearchRepo = this._register(new Emitter<RepoInfo>());
	public readonly onDidRemoveCodeSearchRepo = this._onDidRemoveCodeSearchRepo.event;

	private readonly _tracker: CodeSearchRepoTracker;

	constructor(
		private readonly _embeddingType: EmbeddingType,
		embeddingsChunkSearch: EmbeddingsChunkSearch,
		tfIdfChunkSearch: TfIdfWithSemanticChunkSearch,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAdoCodeSearchService private readonly _adoCodeSearchService: IAdoCodeSearchService,
		@IAuthenticationChatUpgradeService private readonly _authUpgradeService: IAuthenticationChatUpgradeService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ICodeSearchAuthenticationService private readonly _codeSearchAuthService: ICodeSearchAuthenticationService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
		@IGitService private readonly _gitService: IGitService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IWorkspaceFileIndex private readonly _workspaceChunkIndex: IWorkspaceFileIndex,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		super();

		this._embeddingsChunkSearch = embeddingsChunkSearch;
		this._tfIdfChunkSearch = tfIdfChunkSearch;

		this._tracker = this._register(instantiationService.createInstance(CodeSearchRepoTracker));

		this._register(this._tracker.onDidAddOrUpdateRepo(info => {
			this.addOrUpdateTrackedRepo(info);
		}));

		this._register(this._tracker.onDidRemoveRepo(info => {
			this.closeRepo(info.repo);
		}));

		const refreshInterval = this._register(new IntervalTimer());
		refreshInterval.cancelAndSet(() => this.updateIndexedCommitForAllRepos(), 5 * 60 * 1000); // 5 minutes

		// When the authentication state changes, update repos
		this._register(Event.any(
			this._authenticationService.onDidAuthenticationChange,
			this._adoCodeSearchService.onDidChangeIndexState
		)(() => {
			this.updateRepoStatuses();
		}));

		this._register(Event.any(
			this._authenticationService.onDidAdoAuthenticationChange
		)(() => {
			this.updateRepoStatuses('ado');
		}));

		this._register(Event.any(
			this.onDidFinishInitialization,
			this.onDidRemoveCodeSearchRepo,
			this.onDidAddOrUpdateCodeSearchRepo,
		)(() => this._onDidChangeIndexState.fire()));

		this._workspaceDiffTracker = new Lazy(() => {
			return this._register(instantiationService.createInstance(CodeSearchWorkspaceDiffTracker, {
				onDidAddOrUpdateRepo: this.onDidAddOrUpdateCodeSearchRepo,
				onDidRemoveRepo: this.onDidRemoveCodeSearchRepo,
				diffWithIndexedCommit: (repoInfo) => this.diffWithIndexedCommit(repoInfo),
				initialize: () => this.initialize(),
				getAllRepos: () => this.getAllRepos(),
			}));
		});

		if (this.isCodeSearchEnabled()) {
			this.initialize();
		}
	}

	public override dispose(): void {
		super.dispose();
		this._isDisposed = true;

		for (const repo of this._codeSearchRepos.values()) {
			repo.dispose();
		}
		this._codeSearchRepos.clear();
	}

	private _hasFinishedInitialization = false;
	private _initializePromise: Promise<void> | undefined;

	@LogExecTime(self => self._logService, 'CodeSearchChunkSearch::initialize')
	private async initialize() {
		this._initializePromise ??= (async () => {
			return logExecTime(this._logService, 'CodeSearchChunkSearch::initialize_impl', async () => {
				try {
					// Wait for the initial repos to be found
					await this._tracker.initialize();
					if (this._isDisposed) {
						return;
					}

					// And make sure they have done their initial checks.
					// After this the repos may still be left polling github but we've done at least one check
					await Promise.all(Array.from(this._codeSearchRepos.values(), repo => repo.initialize()));
				} finally {
					this._hasFinishedInitialization = true;
					this._onDidFinishInitialization.fire();
				}
			});
		})();
		await this._initializePromise;
	}

	private isInitializing(): boolean {
		return !this._hasFinishedInitialization;
	}

	@LogExecTime(self => self._logService, 'CodeSearchChunkSearch::isAvailable')
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
				if (workspaceFolder.some(folder => isEqual(repo.rootUri, folder))) {
					indexedRepoLocation.workspaceFolder++;
				} else if (workspaceFolder.some(folder => isEqualOrParent(folder, repo.rootUri))) {
					indexedRepoLocation.parentFolder++;
				} else if (workspaceFolder.some(folder => isEqualOrParent(repo.rootUri, folder))) {
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

		await this.initialize();
		if (this._isDisposed) {
			return Result.error<AvailableFailureMetadata>({ unavailableReason: 'Disposed', repoStatuses: {} });
		}


		let allRepos = Array.from(this.getAllRepos());
		if (canPrompt) {
			if (allRepos.some(repo => repo.status === RepoStatus.CouldNotCheckIndexStatus || repo.status === RepoStatus.NotAuthorized)) {
				if (await raceCancellationError(this._authUpgradeService.shouldRequestPermissiveSessionUpgrade(), token)) { // Needs more thought
					if (await raceCancellationError(this._authUpgradeService.shouldRequestPermissiveSessionUpgrade(), token)) {
						await raceCancellationError(this.updateRepoStatuses(), token);
						allRepos = Array.from(this.getAllRepos());
					}
				}
			}
		}

		const repoStatuses = allRepos.reduce((sum, repo) => { sum[repo.status] = (sum[repo.status] ?? 0) + 1; return sum; }, {} as Record<string, number>);
		const indexedRepos = allRepos.filter(repo => repo.status === RepoStatus.Ready);
		const notYetIndexedRepos = allRepos.filter(repo => repo.status === RepoStatus.NotYetIndexed);

		if (!indexedRepos.length && !notYetIndexedRepos.length) {
			// Get detailed info about why we failed
			if (!allRepos.length) {
				return Result.error<AvailableFailureMetadata>({ unavailableReason: 'No repos', repoStatuses });
			}

			if (allRepos.some(repo => repo.status === RepoStatus.CheckingStatus || repo.status === RepoStatus.Resolving)) {
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
		return this._configService.getExperimentBasedConfig<boolean>(ConfigKey.Advanced.WorkspaceEnableCodeSearch, this._experimentationService);
	}

	public getRemoteIndexState(): CodeSearchRemoteIndexState {
		if (!this.isCodeSearchEnabled()) {
			return {
				status: 'disabled',
				repos: [],
			};
		}

		// Kick of request but do not wait for it to finish
		this.initialize();

		if (this.isInitializing()) {
			return {
				status: 'initializing',
				repos: [],
			};
		}

		const allResolvedRepos = Array.from(this.getAllRepos())
			.filter(repo => repo.status !== RepoStatus.NotResolvable);

		return {
			status: 'loaded',
			repos: allResolvedRepos,
		};
	}


	private didRunPrepare = false;
	public async prepareSearchWorkspace(telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<undefined> {
		if (this.didRunPrepare) {
			return;
		}

		this.didRunPrepare = true;
		return this.tryAuthIfNeeded(telemetryInfo, token);
	}

	public async searchWorkspace(sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<StrategySearchResult | undefined> {
		if (!(await raceCancellationError(this.isAvailable(telemetryInfo, true, token), token))) {
			return;
		}

		const allRepos = Array.from(this._codeSearchRepos.values());
		const indexedRepos = allRepos.filter(repo => repo.status === RepoStatus.Ready);
		const notYetIndexedRepos = allRepos.filter((repo) => repo.status === RepoStatus.NotYetIndexed);

		if (!indexedRepos.length && !notYetIndexedRepos.length) {
			return;
		}

		return logExecTime(this._logService, 'CodeSearchChunkSearch.searchWorkspace', async () => {
			const diffArray = await raceCancellationError(this.getLocalDiff(), token);
			if (!Array.isArray(diffArray)) {
				return;
			}

			if (notYetIndexedRepos.length) {
				const instantIndexResults = await Promise.all(notYetIndexedRepos.map(repo => repo.tryToInstantIndexRepo(telemetryInfo, token)));
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

	@LogExecTime(self => self._logService, 'CodeSearchChunkSearch::getLocalDiff')
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

	@LogExecTime(self => self._logService, 'CodeSearchChunkSearch::doCodeSearch', function (execTime, status) {
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
	private async doCodeSearch(query: WorkspaceChunkQueryWithEmbeddings, repos: readonly GithubCodeSearchRepo[], sizing: StrategySearchSizing, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<CodeSearchResult | undefined> {
		const resolvedQuery = await raceCancellationError(query.resolveQuery(token), token);

		const results = await Promise.all(repos.map(repo => {
			return repo.searchRepo({ silent: true }, this._embeddingType, resolvedQuery, sizing.maxResultCountHint, options, telemetryInfo, token);
		}));

		return {
			chunks: coalesce(results).flatMap(x => x.chunks),
			outOfSync: coalesce(results).some(x => x.outOfSync),
		};
	}

	public async triggerRemoteIndexing(triggerReason: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		const triggerResult = await this.doTriggerRemoteIndexing(triggerReason, telemetryInfo);
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

	private getAllRepos(): Iterable<RepoEntry> {
		return this._codeSearchRepos.values();
	}

	private addOrUpdateTrackedRepo(info: TrackedRepoState) {
		switch (info.status) {
			case TrackedRepoStatus.Resolving: {
				this.updateRepoEntry(info.repo, { status: RepoStatus.Resolving, repo: info.repo });
				return;
			}
			case TrackedRepoStatus.Resolved: {
				if (info.resolvedRemoteInfo) {
					return this.openGitRepo(info.repo, info.resolvedRemoteInfo);
				} else {
					// We found a git repo but not one a type we know about
					this.updateRepoEntry(info.repo, { status: RepoStatus.NotResolvable, repo: info.repo });
				}
			}
		}
	}

	@LogExecTime(self => self._logService, 'CodeSearchChunkSearch::openGitRepo')
	private async openGitRepo(repo: RepoInfo, remoteInfo: ResolvedRepoRemoteInfo): Promise<void> {
		this._logService.trace(`CodeSearchChunkSearch.openGitRepo(${repo.rootUri})`);

		const existing = this._codeSearchRepos.get(repo.rootUri);
		if (existing) {
			return;
		}

		if (remoteInfo.repoId.type === 'github') {
			this._codeSearchRepos.set(repo.rootUri, this._instantiationService.createInstance(GithubCodeSearchRepo, repo, remoteInfo.repoId));
		} else if (remoteInfo.repoId.type === 'ado') {
			this._codeSearchRepos.set(repo.rootUri, this._instantiationService.createInstance(AdoCodeSearchRepo, repo, remoteInfo.repoId));
		} else {
			this._logService.warn(`CodeSearchChunkSearch.openGitRepo: Unsupported repo type ${remoteInfo.repoId} for repo at ${repo.rootUri}`);
		}
	}

	private closeRepo(repo: RepoInfo) {
		this._logService.trace(`CodeSearchChunkSearch.closeRepo(${repo.rootUri})`);

		const repoEntry = this._codeSearchRepos.get(repo.rootUri);
		if (!repoEntry) {
			return;
		}

		repoEntry.dispose();

		this._onDidRemoveCodeSearchRepo.fire(repoEntry.repoInfo);
		this._codeSearchRepos.delete(repo.rootUri);
	}

	private async doTriggerRemoteIndexing(triggerReason: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		this._logService.trace(`RepoTracker.TriggerRemoteIndexing(${triggerReason}).started`);

		await this.initialize();

		this._logService.trace(`RepoTracker.TriggerRemoteIndexing(${triggerReason}).Repos: ${JSON.stringify(Array.from(this._codeSearchRepos.values(), r => ({
			rootUri: r.repoInfo.rootUri.toString(),
			status: r.status,
		})), null, 4)} `);

		const allRepos = Array.from(this._codeSearchRepos.values());
		if (!allRepos.length) {
			return Result.error(TriggerRemoteIndexingError.noGitRepos);
		}

		if (allRepos.every(repo => repo.status === RepoStatus.Resolving)) {
			return Result.error(TriggerRemoteIndexingError.stillResolving);
		}

		if (allRepos.every(repo => repo.status === RepoStatus.NotResolvable)) {
			return Result.error(TriggerRemoteIndexingError.noRemoteIndexableRepos);
		}

		const candidateRepos = allRepos.filter(repo => repo.status !== RepoStatus.NotResolvable && repo.status !== RepoStatus.Resolving);

		const authToken = await this.getGithubAuthToken();
		if (this._isDisposed) {
			return Result.ok(true);
		}

		if (!authToken) {
			return Result.error(TriggerRemoteIndexingError.noValidAuthToken);
		}

		if (candidateRepos.every(repo => repo.status === RepoStatus.Ready)) {
			return Result.error(TriggerRemoteIndexingError.alreadyIndexed);
		}

		if (candidateRepos.every(repo => repo.status === RepoStatus.BuildingIndex || repo.status === RepoStatus.Ready)) {
			return Result.error(TriggerRemoteIndexingError.alreadyIndexing);
		}

		if (candidateRepos.every(repo => repo.status === RepoStatus.CouldNotCheckIndexStatus || repo.status === RepoStatus.NotAuthorized)) {
			return Result.error(TriggerRemoteIndexingError.couldNotCheckIndexStatus);
		}

		const responses = await Promise.all(candidateRepos.map(repoEntry => {
			if (repoEntry.status === RepoStatus.NotYetIndexed) {
				return repoEntry.triggerRemoteIndexingOfRepo(triggerReason, telemetryInfo.addCaller('CodeSearchChunkSearch::triggerRemoteIndexing'));
			}
		}));

		const error = responses.find(r => r?.isError());
		return error ?? Result.ok(true);
	}

	private async updateRepoStatuses(onlyReposOfType?: 'github' | 'ado'): Promise<void> {
		await Promise.all(Array.from(this._codeSearchRepos.values(), repo => {
			if (!onlyReposOfType || repo.repoId.type === onlyReposOfType) {
				return repo.refreshStatusFromEndpoint(true, CancellationToken.None).catch(() => { });
			}
		}));
	}

	private async getGithubAuthToken() {
		return (await this._authenticationService.getPermissiveGitHubSession({ silent: true }))?.accessToken
			?? (await this._authenticationService.getAnyGitHubSession({ silent: true }))?.accessToken;
	}

	private async tryAuthIfNeeded(_telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<PromiseLike<undefined> | undefined> {
		await raceCancellationError(this.initialize(), token);
		if (this._isDisposed) {
			return;
		}

		// See if there are any repos that we know for sure we are not authorized for
		const allRepos = Array.from(this.getAllRepos());
		const notAuthorizedRepos = allRepos.filter(repo => repo.status === RepoStatus.NotAuthorized);
		if (!notAuthorizedRepos.length) {
			return;
		}

		// TODO: only handles first repos of each type, but our other services also don't track tokens for multiple
		// repos in a workspace right now
		const firstGithubRepo = notAuthorizedRepos.find(repo => repo.remoteInfo.repoId.type === 'github');
		if (firstGithubRepo) {
			await this._codeSearchAuthService.tryAuthenticating(firstGithubRepo);
		}

		const firstAdoRepo = notAuthorizedRepos.find(repo => repo.remoteInfo.repoId.type === 'ado');
		if (firstAdoRepo) {
			await this._codeSearchAuthService.tryAuthenticating(firstAdoRepo);
		}
	}

	private updateRepoEntry(repo: RepoInfo, entry: RepoEntry): void {
		this._codeSearchRepos.set(repo.rootUri, entry);
		this._onDidAddOrUpdateCodeSearchRepo.fire(entry);
	}

	private async diffWithIndexedCommit(repoInfo: RepoEntry): Promise<CodeSearchDiff | undefined> {
		if (isGitHubRemoteRepository(repoInfo.repo.rootUri)) {
			// TODO: always assumes no diff. Can we get a real diff somehow?
			return { changes: [] };
		}

		const doDiffWith = async (ref: string): Promise<Change[] | undefined> => {
			try {
				return await this._gitService.diffWith(repoInfo.repo.rootUri, ref);
			} catch (e) {
				this._logService.trace(`CodeSearchChunkSearch.diffWithIndexedCommit(${repoInfo.repo.rootUri}).Could not compute diff against: ${ref}.Error: ${e} `);
			}
		};

		if (repoInfo.status === RepoStatus.NotYetIndexed) {
			const changes = await doDiffWith('@{upstream}');
			return changes ? { changes } : undefined;
		}

		if (repoInfo.status === RepoStatus.Ready) {
			const changesAgainstIndexedCommit = repoInfo.indexedCommit ? await doDiffWith(repoInfo.indexedCommit) : undefined;
			if (changesAgainstIndexedCommit) {
				return { changes: changesAgainstIndexedCommit, mayBeOutdated: false };
			}

			this._logService.trace(`CodeSearchChunkSearch.diffWithIndexedCommit(${repoInfo.repo.rootUri}).Falling back to diff against upstream.`);

			const changesAgainstUpstream = await doDiffWith('@{upstream}');
			if (changesAgainstUpstream) {
				return { changes: changesAgainstUpstream, mayBeOutdated: true };
			}

			this._logService.trace(`CodeSearchChunkSearch.diffWithIndexedCommit(${repoInfo.repo.rootUri}).Could not compute any diff.`);
		}

		return undefined;
	}

	private updateIndexedCommitForAllRepos(): void {
		this._logService.trace(`CodeSearchChunkSearch.updateIndexedCommitForAllRepos`);

		for (const repo of this._codeSearchRepos.values()) {
			if (repo.status !== RepoStatus.Ready) {
				continue;
			}

			this.getRepoIndexStatusFromEndpoint(repo.repo, repo.remoteInfo, CancellationToken.None)
				.then(
					(newStatus) => {
						if (this._isDisposed) {
							return;
						}

						if (newStatus.status === RepoStatus.Ready && newStatus.indexedCommit !== repo.indexedCommit) {
							this.updateRepoEntry(repo.repo, newStatus);
						}
					},
					() => {
						// Noop
					});
		}
	}
}


type RepoState =
	{
		readonly status: RepoStatus.BuildingIndex | RepoStatus.CheckingStatus | RepoStatus.CouldNotCheckIndexStatus | RepoStatus.NotAuthorized | RepoStatus.NotIndexable | RepoStatus.NotResolvable | RepoStatus.Resolving;
	} | {
		readonly status: RepoStatus.Ready;
		readonly indexedCommit: string | undefined;
	};

class GithubCodeSearchRepo extends Disposable {

	// TODO: Switch to use backoff instead of polling at fixed intervals
	private readonly _repoIndexPollingInterval = 3000; // ms
	private readonly maxPollingAttempts = 120;

	private _state: RepoState;
	public get status(): RepoStatus {
		return this._state.status;
	}

	private initTask: CancelablePromise<void>;

	private _isDisposed = false;

	private _onDidChangeStatus = this._register(new Emitter<RepoStatus>());
	public readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private _repoIndexPolling?: {
		readonly poll: IntervalTimer;
		readonly deferredP: DeferredPromise<void>;
		attemptNumber: number;
	};

	constructor(
		public readonly repoInfo: RepoInfo,
		public readonly repoId: GithubRepoId,
		@ILogService private readonly _logService: ILogService,
		@IGithubCodeSearchService private readonly _githubCodeSearchService: IGithubCodeSearchService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		this._state = {
			status: RepoStatus.CheckingStatus,
		};

		this.initTask = createCancelablePromise<void>(initToken =>
			this.refreshStatusFromEndpoint(false, initToken)
				.then(() => void 0)
				.catch(e => {
					if (!isCancellationError(e)) {
						this._logService.error(`CodeSearchChunkSearch.openGitRepo(${repoInfo.rootUri}). Failed to initialize repo state from endpoint. ${e}`);
					}
				}));
	}

	public override dispose(): void {
		super.dispose();
		this._isDisposed = true;
	}

	public async initialize(): Promise<void> {
		try {
			await this.initTask;
		} catch (error) {
			this._logService.error(`Error during repo initialization: ${error}`);
		}
	}

	private updateState(updatedEntry: ResolvedRepoEntry) {
		// TODO
	}

	public searchRepo(authOptions: { silent: boolean }, embeddingType: EmbeddingType, resolvedQuery: string, maxResultCountHint: number, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): any {
		return this._githubCodeSearchService.searchRepo(authOptions, embeddingType, {
			githubRepoId: this.repoId,
			localRepoRoot: this.repoInfo.rootUri,
			indexedCommit: undefined, // TODO
		}, resolvedQuery, maxResultCountHint, options, telemetryInfo, token);
	}

	public async triggerRemoteIndexingOfRepo(triggerReason: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		this._logService.trace(`Triggering indexing for repo: ${this.repoId} `);

		// Update UI state as soon as possible if triggered by the user
		if (triggerReason === 'manual') {
			this.updateState({ status: RepoStatus.BuildingIndex });
		}

		const triggerSuccess = await this._githubCodeSearchService.triggerIndexing({ silent: true }, triggerReason, this.repoId, telemetryInfo);
		if (!triggerSuccess) {
			this._logService.error(`RepoTracker::TriggerRemoteIndexing(${triggerReason}). Failed to request indexing for '${this.repoId}'.`);

			this.updateState({ status: RepoStatus.NotYetIndexed });

			return Result.error(TriggerRemoteIndexingError.errorTriggeringIndexing(this.repoId));
		}

		this.updateState({ status: RepoStatus.BuildingIndex });

		return Result.ok(true);
	}

	public async tryToInstantIndexRepo(telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<boolean> {
		// Amount of time we'll wait for instant indexing to finish before giving up
		const unindexRepoInitTimeout = 8_000;

		const startRepoStatus = this.status;

		await measureExecTime(() => raceTimeout((async () => {
			// Trigger indexing if we have not already
			if (startRepoStatus === RepoStatus.NotYetIndexed) {
				const triggerResult = await raceCancellationError(this.triggerRemoteIndexingOfRepo('auto', telemetryInfo), token);
				if (triggerResult.isError()) {
					throw new Error(`CodeSearchChunkSearch: Triggering indexing of '${this.repoId}' failed: ${triggerResult.err.id}`);
				}
			}

			if (this.status === RepoStatus.BuildingIndex) {
				// Poll rapidly using endpoint to check if instant indexing has completed
				let attemptsRemaining = 5;
				const delayBetweenAttempts = 1000;

				while (attemptsRemaining-- > 0) {
					const currentStatus = (await raceCancellationError(this.refreshStatusFromEndpoint(false, token), token)).status;
					if (currentStatus === RepoStatus.Ready) {
						// We're good to start searching
						break;
					} else if (currentStatus !== RepoStatus.BuildingIndex) {
						throw new Error(`CodeSearchChunkSearch: Checking instant indexing status of '${this.repoId}' failed. Found unexpected status: '${currentStatus}'`);
					}

					await raceCancellationError(timeout(delayBetweenAttempts), token);
				}
			}
		})(), unindexRepoInitTimeout), (execTime, status) => {
			const endRepoStatus = this.status;

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

		const currentStatus = this.status;
		return currentStatus === RepoStatus.Ready || currentStatus === RepoStatus.BuildingIndex;
	}

	public async refreshStatusFromEndpoint(force = false, token: CancellationToken) {
		if (!force && this.status === RepoStatus.Ready) {
			return;
		}

		this._logService.trace(`CodeSearchChunkSearch.updateRepoStateFromEndpoint(${this.repoInfo.rootUri}). Checking status from endpoint.`);

		const newState = await raceCancellationError(this.getRepoIndexStatusFromEndpoint(token), token);
		this._logService.trace(`CodeSearchChunkSearch.updateRepoStateFromEndpoint(${this.repoInfo.rootUri}). Updating state to ${newState.status}.`);

		this.updateState(newState);

		if (newState.status === RepoStatus.BuildingIndex) {
			// Trigger polling but don't block
			this.pollForRepoIndexingToComplete(repo).catch(() => { });
		}

		return newState;
	}

	private async getRepoIndexStatusFromEndpoint(token: CancellationToken): Promise<RepoState> {
		this._logService.trace(`CodeSearchChunkSearch.getRepoIndexStatusFromEndpoint(${this.repoInfo.rootUri}`);

		const statusResult = await this._githubCodeSearchService.getRemoteIndexState({ silent: true }, this.repoId, token);
		if (!statusResult.isOk()) {
			if (statusResult.err.type === 'not-authorized') {
				this._logService.error(`CodeSearchChunkSearch::getIndexedStatus(${this.repoId}). Failed to fetch indexing status. Unauthorized.`);
				return { status: RepoStatus.NotAuthorized };
			} else {
				this._logService.error(`CodeSearchChunkSearch::getIndexedStatus(${this.repoId}). Failed to fetch indexing status. Encountered error: ${statusResult.err.error}`);
				return { status: RepoStatus.CouldNotCheckIndexStatus };
			}
		}

		switch (statusResult.val.status) {
			case RemoteCodeSearchIndexStatus.Ready: return { status: RepoStatus.Ready, indexedCommit: statusResult.val.indexedCommit };
			case RemoteCodeSearchIndexStatus.BuildingIndex: return { status: RepoStatus.BuildingIndex };
			case RemoteCodeSearchIndexStatus.NotYetIndexed: return { status: RepoStatus.NotYetIndexed };
			case RemoteCodeSearchIndexStatus.NotIndexable: return { status: RepoStatus.NotResolvable };
		}
	}

	private pollForRepoIndexingToComplete(repo: RepoInfo): Promise<void> {
		this._logService.trace(`CodeSearchChunkSearch.startPollingForRepoIndexingComplete(${repo.rootUri})`);

		const existing = this._repoIndexPolling;
		if (existing) {
			existing.attemptNumber = 0; // reset
			return existing.deferredP.p;
		}

		const deferredP = new DeferredPromise<void>();
		const poll = new IntervalTimer();

		const pollEntry = { poll, deferredP, attemptNumber: 0 };
		this._repoIndexPolling = pollEntry;

		const onComplete = () => {
			poll.cancel();
			deferredP.complete();
			this._repoIndexPolling = undefined;
		};

		poll.cancelAndSet(async () => {
			if (this._isDisposed) {
				// It's possible the repo has been closed since
				this._logService.trace(`CodeSearchChunkSearch.startPollingForRepoIndexingComplete(${repo.rootUri}). Repo no longer tracked.`);
				return onComplete();
			}

			if (this.status === RepoStatus.BuildingIndex) {
				const attemptNumber = pollEntry.attemptNumber++;
				if (attemptNumber > this.maxPollingAttempts) {
					this._logService.trace(`CodeSearchChunkSearch.startPollingForRepoIndexingComplete(${repo.rootUri}). Max attempts reached.Stopping polling.`);
					if (!this._isDisposed) {
						this.updateState(RepoStatus.CouldNotCheckIndexStatus);
					}
					return onComplete();
				}

				this._logService.trace(`CodeSearchChunkSearch.startPollingForRepoIndexingComplete(${repo.rootUri}). Checking endpoint for status.`);
				let polledState: RepoState | undefined;
				try {
					polledState = await this.getRepoIndexStatusFromEndpoint(CancellationToken.None);
				} catch {
					// noop
				}
				this._logService.trace(`CodeSearchChunkSearch.startPollingForRepoIndexingComplete(${repo.rootUri}). Got back new status from endpoint: ${polledState?.status}.`);

				switch (polledState?.status) {
					case RepoStatus.Ready: {
						this._logService.trace(`CodeSearchChunkSearch.startPollingForRepoIndexingComplete(${repo.rootUri}). Repo indexed successfully.`);
						if (!this._isDisposed) {
							this.updateState(polledState);
						}
						return onComplete();
					}
					case RepoStatus.BuildingIndex: {
						// Poll again
						return;
					}
					default: {
						// We got some other state, so stop polling
						if (!this._isDisposed) {
							this.updateRepoEntry(repo, polledState ?? { status: RepoStatus.CouldNotCheckIndexStatus, repo: currentRepoEntry.repo, remoteInfo: currentRepoEntry.remoteInfo });
						}
						return onComplete();
					}
				}
			} else {
				this._logService.trace(`CodeSearchChunkSearch.startPollingForRepoIndexingComplete(${repo.rootUri}). Found unknown repo state: ${currentRepoEntry.status}. Stopping polling`);
				return onComplete();
			}
		}, this._repoIndexPollingInterval);

		return deferredP.p;
	}
}