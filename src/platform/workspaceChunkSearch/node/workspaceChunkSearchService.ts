/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { createFencedCodeBlock, getLanguageId } from '../../../util/common/markdown';
import { Result } from '../../../util/common/result';
import { createServiceIdentifier } from '../../../util/common/services';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { TokenizerType } from '../../../util/common/tokenizer';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { CancelablePromise, createCancelablePromise, raceCancellationError, raceTimeout } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError, isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart2 } from '../../../vscodeTypes';
import { IAuthenticationChatUpgradeService } from '../../authentication/common/authenticationUpgrade';
import { FileChunk, FileChunkAndScore } from '../../chunking/common/chunk';
import { MAX_CHUNK_SIZE_TOKENS } from '../../chunking/node/naiveChunker';
import { distance, Embedding, EmbeddingDistance, Embeddings, EmbeddingType, IEmbeddingsComputer } from '../../embeddings/common/embeddingsComputer';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { IIgnoreService } from '../../ignore/common/ignoreService.js';
import { logExecTime, LogExecTime } from '../../log/common/logExecTime';
import { ILogService } from '../../log/common/logService';
import { IChatEndpoint } from '../../networking/common/networking';
import { BuildIndexTriggerReason, RepoStatus, TriggerIndexingError } from '../../remoteCodeSearch/node/codeSearchRepoTracker';
import { ISimulationTestContext } from '../../simulationTestContext/common/simulationTestContext';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { getWorkspaceFileDisplayPath, IWorkspaceService } from '../../workspace/common/workspaceService';
import { GithubAvailableEmbeddingTypesManager } from '../common/githubAvailableEmbeddingTypes';
import { GithubEmbeddingsComputer } from '../common/githubEmbeddingsComputer';
import { IWorkspaceChunkSearchStrategy, StrategySearchResult, StrategySearchSizing, WorkspaceChunkQuery, WorkspaceChunkQueryWithEmbeddings, WorkspaceChunkSearchOptions, WorkspaceChunkSearchStrategyId, WorkspaceSearchAlert } from '../common/workspaceChunkSearch';
import { CodeSearchChunkSearch, CodeSearchRemoteIndexState } from './codeSearchChunkSearch';
import { EmbeddingsChunkSearch, LocalEmbeddingsIndexState, LocalEmbeddingsIndexStatus } from './embeddingsChunkSearch';
import { FullWorkspaceChunkSearch } from './fullWorkspaceChunkSearch';
import { TfidfChunkSearch } from './tfidfChunkSearch';
import { TfIdfWithSemanticChunkSearch } from './tfidfWithSemanticChunkSearch';
import { WorkspaceChunkEmbeddingsIndex } from './workspaceChunkEmbeddingsIndex';
import { IWorkspaceFileIndex } from './workspaceFileIndex';

const maxEmbeddingSpread = 0.65;

interface ScoredFileChunk<T extends FileChunk = FileChunk> {
	readonly chunk: T;
	readonly distance: EmbeddingDistance;
}

export interface WorkspaceChunkSearchResult {
	readonly chunks: readonly FileChunkAndScore[];
	readonly isFullWorkspace: boolean;
	readonly alerts?: readonly WorkspaceSearchAlert[];
	readonly strategy?: string;
}

export interface WorkspaceChunkSearchSizing {
	readonly endpoint: IChatEndpoint;
	readonly tokenBudget: number | undefined;
	readonly maxResults: number | undefined;
}

export interface WorkspaceIndexState {
	readonly remoteIndexState: CodeSearchRemoteIndexState;
	readonly localIndexState: LocalEmbeddingsIndexState;
}

export const IWorkspaceChunkSearchService = createServiceIdentifier<IWorkspaceChunkSearchService>('IWorkspaceChunkSearchService');

export interface IWorkspaceChunkSearchService extends IDisposable {
	readonly _serviceBrand: undefined;

	readonly onDidChangeIndexState: Event<void>;

	getIndexState(): Promise<WorkspaceIndexState>;

	hasFastSearch(sizing: StrategySearchSizing): Promise<boolean>;

	searchFileChunks(
		sizing: WorkspaceChunkSearchSizing,
		query: WorkspaceChunkQuery,
		options: WorkspaceChunkSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		progress: vscode.Progress<vscode.ChatResponsePart> | undefined,
		token: CancellationToken,
	): Promise<WorkspaceChunkSearchResult>;

	triggerLocalIndexing(trigger: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>>;

	triggerRemoteIndexing(trigger: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>>;
}


interface StrategySearchOk {
	readonly strategy: WorkspaceChunkSearchStrategyId;
	readonly result: StrategySearchResult;
}

interface StrategySearchErr {
	readonly errorDiagMessage: string;
	alerts?: readonly WorkspaceSearchAlert[];
}

type StrategySearchOutcome = Result<StrategySearchOk, StrategySearchErr>;

export class WorkspaceChunkSearchService extends Disposable implements IWorkspaceChunkSearchService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeIndexState = this._register(new Emitter<void>());
	readonly onDidChangeIndexState = this._onDidChangeIndexState.event;

	private _impl: WorkspaceChunkSearchServiceImpl | undefined;
	private readonly _availableEmbeddingTypes: GithubAvailableEmbeddingTypesManager;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._availableEmbeddingTypes = _instantiationService.createInstance(GithubAvailableEmbeddingTypesManager);

		this.tryInit(true);
	}

	public override dispose(): void {
		super.dispose();
		this._impl?.dispose();
	}

	private async tryInit(silent: boolean): Promise<WorkspaceChunkSearchServiceImpl | undefined> {
		if (this._impl) {
			return this._impl;
		}

		try {
			const best = await this._availableEmbeddingTypes.getPreferredType(silent);
			if (this._impl) {
				return this._impl;
			}

			if (best) {
				this._impl = this._instantiationService.createInstance(WorkspaceChunkSearchServiceImpl, best);
				this._impl.onDidChangeIndexState(() => this._onDidChangeIndexState.fire());

				return this._impl;
			}
		} catch {
			return undefined;
		}
	}

	async getIndexState(): Promise<WorkspaceIndexState> {
		const impl = await this.tryInit(true);
		if (!impl) {
			return {
				remoteIndexState: {
					status: 'disabled',
					repos: [],
				},
				localIndexState: {
					status: LocalEmbeddingsIndexStatus.Unknown,
					getState: async () => undefined,
				}
			};
		}

		return impl.getIndexState();
	}

	async hasFastSearch(sizing: StrategySearchSizing): Promise<boolean> {
		if (!this._impl) {
			return false;
		}

		return this._impl.hasFastSearch(sizing);
	}

	async searchFileChunks(sizing: WorkspaceChunkSearchSizing, query: WorkspaceChunkQuery, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, progress: vscode.Progress<vscode.ChatResponsePart> | undefined, token: CancellationToken): Promise<WorkspaceChunkSearchResult> {
		const impl = await this.tryInit(false);
		if (!impl) {
			throw new Error('Workspace chunk search service not available');
		}
		return impl.searchFileChunks(sizing, query, options, telemetryInfo, progress, token);
	}

	async triggerLocalIndexing(trigger: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		const impl = await this.tryInit(false);
		if (!impl) {
			throw new Error('Workspace chunk search service not available');
		}
		return impl.triggerLocalIndexing(trigger, telemetryInfo);
	}

	async triggerRemoteIndexing(trigger: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		const impl = await this.tryInit(false);
		if (!impl) {
			throw new Error('Workspace chunk search service not available');
		}
		return impl.triggerRemoteIndexing(trigger, telemetryInfo);
	}
}

class WorkspaceChunkSearchServiceImpl extends Disposable implements IWorkspaceChunkSearchService {

	declare readonly _serviceBrand: undefined;

	private readonly shouldEagerlyIndexKey = 'workspaceChunkSearch.shouldEagerlyIndex';

	private readonly _embeddingsComputer: IEmbeddingsComputer;
	private readonly _embeddingsIndex: WorkspaceChunkEmbeddingsIndex;

	private readonly _embeddingsChunkSearch: EmbeddingsChunkSearch;
	private readonly _fullWorkspaceChunkSearch: FullWorkspaceChunkSearch;
	private readonly _codeSearchChunkSearch: CodeSearchChunkSearch;
	private readonly _tfidfChunkSearch: TfidfChunkSearch;
	private readonly _tfIdfWithSemanticChunkSearch: TfIdfWithSemanticChunkSearch;

	private readonly _onDidChangeIndexState = this._register(new Emitter<void>());
	readonly onDidChangeIndexState = this._onDidChangeIndexState.event;

	private _isDisposed = false;

	constructor(
		private readonly _embeddingType: EmbeddingType,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAuthenticationChatUpgradeService private readonly _authUpgradeService: IAuthenticationChatUpgradeService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@ILogService private readonly _logService: ILogService,
		@ISimulationTestContext private readonly _simulationTestContext: ISimulationTestContext,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IWorkspaceFileIndex private readonly _workspaceFileIndex: IWorkspaceFileIndex,
	) {
		super();

		this._embeddingsComputer = instantiationService.createInstance(GithubEmbeddingsComputer);
		this._embeddingsIndex = instantiationService.createInstance(WorkspaceChunkEmbeddingsIndex, this._embeddingType);

		this._embeddingsChunkSearch = this._register(instantiationService.createInstance(EmbeddingsChunkSearch, this._embeddingsIndex));
		this._fullWorkspaceChunkSearch = this._register(instantiationService.createInstance(FullWorkspaceChunkSearch));
		this._tfidfChunkSearch = this._register(instantiationService.createInstance(TfidfChunkSearch, { tokenizer: TokenizerType.O200K })); // TODO mjbvz: remove hardcoding
		this._tfIdfWithSemanticChunkSearch = this._register(instantiationService.createInstance(TfIdfWithSemanticChunkSearch, this._tfidfChunkSearch, this._embeddingsIndex));
		this._codeSearchChunkSearch = this._register(instantiationService.createInstance(CodeSearchChunkSearch, this._embeddingType, this._embeddingsChunkSearch, this._tfIdfWithSemanticChunkSearch));

		this._register(
			Event.debounce(
				Event.any(
					this._embeddingsChunkSearch.onDidChangeIndexState,
					this._codeSearchChunkSearch.onDidChangeIndexState
				),
				() => { },
				250
			)(() => this._onDidChangeIndexState.fire()));

		if (
			this._extensionContext.workspaceState.get(this.shouldEagerlyIndexKey, false)
			&& (this._experimentationService.getTreatmentVariable<boolean>('vscode', 'copilotchat.workspaceChunkSearch.shouldEagerlyInitLocalIndex') ?? true)
		) {
			this._codeSearchChunkSearch.isAvailable().then(async hasCodeSearch => {
				if (!hasCodeSearch && !this._isDisposed) {
					try {
						await this._embeddingsChunkSearch.triggerLocalIndexing('auto');
					} catch {
						// noop
					}
				}
			});
		}

		this._register(this._authUpgradeService.onDidGrantAuthUpgrade(() => {
			if (this._experimentationService.getTreatmentVariable<boolean>('vscode', 'copilotchat.workspaceChunkSearch.shouldRemoteIndexOnAuthUpgrade') ?? true) {
				void this.triggerRemoteIndexing('auto', new TelemetryCorrelationId('onDidGrantAuthUpgrade')).catch(e => {
					// noop
				});
			}
		}));
	}

	public override dispose(): void {
		this._isDisposed = true;
		super.dispose();
	}

	async getIndexState(): Promise<WorkspaceIndexState> {
		const localState = await this._embeddingsChunkSearch.getState();
		return {
			remoteIndexState: this._codeSearchChunkSearch.getRemoteIndexState(),
			localIndexState: localState,
		};
	}

	async hasFastSearch(sizing: StrategySearchSizing): Promise<boolean> {
		if (this._experimentationService.getTreatmentVariable<boolean>('vscode', 'copilotchat.workspaceChunkSearch.markAllSearchesSlow')) {
			return false;
		}

		const indexState = await this.getIndexState();
		return (indexState.remoteIndexState.status === 'loaded' && indexState.remoteIndexState.repos.length > 0 && indexState.remoteIndexState.repos.every(repo => repo.status === RepoStatus.Ready))
			|| indexState.localIndexState.status === LocalEmbeddingsIndexStatus.Ready
			|| await this._fullWorkspaceChunkSearch.mayBeAvailable(sizing);
	}

	async triggerLocalIndexing(trigger: BuildIndexTriggerReason, _telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		if (await this._codeSearchChunkSearch.isAvailable()) {
			await this._codeSearchChunkSearch.triggerDiffIndexing();
			return Result.ok(true);
		} else {
			return this._embeddingsChunkSearch.triggerLocalIndexing(trigger);
		}
	}

	triggerRemoteIndexing(trigger: BuildIndexTriggerReason, telemetryInfo: TelemetryCorrelationId): Promise<Result<true, TriggerIndexingError>> {
		return this._codeSearchChunkSearch.triggerRemoteIndexing(trigger, telemetryInfo);
	}

	async searchFileChunks(
		sizing: WorkspaceChunkSearchSizing,
		query: WorkspaceChunkQuery,
		options: WorkspaceChunkSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		progress: vscode.Progress<vscode.ChatResponsePart> | undefined,
		token: CancellationToken
	): Promise<WorkspaceChunkSearchResult> {
		const wasFirstSearchInWorkspace = !this._extensionContext.workspaceState.get(this.shouldEagerlyIndexKey, false);
		this._extensionContext.workspaceState.update(this.shouldEagerlyIndexKey, true);

		return logExecTime(this._logService, 'WorkspaceChunkSearch.searchFileChunks', async (): Promise<WorkspaceChunkSearchResult> => {
			// Kick off (but do not wait on) query embedding resolve as soon as possible because almost all strategies will ultimately need it
			const queryWithEmbeddings = this.toQueryWithEmbeddings(query, token);

			const stratSizing: StrategySearchSizing = {
				endpoint: sizing.endpoint,
				tokenBudget: sizing.tokenBudget,
				maxResultCountHint: this.getMaxChunks(sizing),
			};

			const searchTask = this.doSearchFileChunks(stratSizing, queryWithEmbeddings, options, telemetryInfo, token);
			progress?.report(new ChatResponseProgressPart2(l10n.t('Collecting workspace information'), async () => { await searchTask; }));
			const searchSw = new StopWatch();
			const searchResult = await raceCancellationError(searchTask, token);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			/* __GDPR__
				"workspaceChunkSearchStrategy" : {
					"owner": "mjbvz",
					"comment": "Understanding which workspace chunk search strategy is used",
					"strategy": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The chosen strategy" },
					"errorDiagMessage": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The reason why the search failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total time in ms for workspace chunk search" },
					"workspaceIndexFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of files in our workspace index" },
					"wasFirstSearchInWorkspace": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Tracks if this was the first time we triggered a workspace search" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('workspaceChunkSearchStrategy', {
				strategy: searchResult.isOk() ? searchResult.val.strategy : 'none',
				errorDiagMessage: searchResult.isError() ? searchResult.err.errorDiagMessage : undefined,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, {
				execTime: searchSw.elapsed(),
				workspaceIndexFileCount: this._workspaceFileIndex.fileCount,
				wasFirstSearchInWorkspace: wasFirstSearchInWorkspace ? 1 : 0,
			});

			if (searchResult.isError()) {
				this._logService.error(`WorkspaceChunkSearch.searchFileChunks: no strategies succeeded`);
				if (this._simulationTestContext.isInSimulationTests) {
					throw new Error('All workspace search strategies failed');
				}

				return {
					chunks: [],
					isFullWorkspace: false,
					alerts: searchResult.err.alerts,
				};
			}

			this._logService.trace(`WorkspaceChunkSearch.searchFileChunks: found ${searchResult.val.result.chunks.length} chunks using '${searchResult.val.strategy}'`);

			const filteredChunks = await raceCancellationError(this.filterIgnoredChunks(searchResult.val.result.chunks), token);
			if (this._simulationTestContext.isInSimulationTests) {
				if (!filteredChunks.length) {
					throw new Error('No chunks returned');
				}
			}

			const filteredResult = {
				...searchResult.val,
				result: {
					alerts: searchResult.val.result.alerts,
					chunks: filteredChunks
				}
			};
			return this.rerankResultIfNeeded(queryWithEmbeddings, filteredResult, this.getMaxChunks(sizing), telemetryInfo, progress, token);
		}, (execTime, status) => {
			/* __GDPR__
				"workspaceChunkSearch.perf.searchFileChunks" : {
					"owner": "mjbvz",
					"comment": "Total time for searchFileChunks to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('workspaceChunkSearch.perf.searchFileChunks', {
				status,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, {
				execTime
			});
		});
	}

	private toQueryWithEmbeddings(query: WorkspaceChunkQuery, token: CancellationToken): WorkspaceChunkQueryWithEmbeddings {
		const queryEmbeddings: Promise<Embedding> = logExecTime(this._logService, 'WorkspaceChunkSearch.resolveQueryEmbeddings', () =>
			query.resolveQuery(token).then(async (queryStr) => {
				const result = await this.computeEmbeddings('query', [queryStr], token);
				const first = result.values.at(0);
				if (!first) {
					throw new Error('Could not resolve query embeddings');
				}
				return first;
			}));

		return {
			...query,
			resolveQueryEmbeddings: (_token) => queryEmbeddings
		};
	}

	private async doSearchFileChunks(
		sizing: StrategySearchSizing,
		query: WorkspaceChunkQueryWithEmbeddings,
		options: WorkspaceChunkSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken,
	): Promise<StrategySearchOutcome> {
		this._logService.debug(`Searching for ${sizing.maxResultCountHint} chunks in workspace`);

		// First try full workspace
		try {
			const fullWorkspaceResults = await this.runSearchStrategy(this._fullWorkspaceChunkSearch, sizing, query, options, telemetryInfo, token);
			if (fullWorkspaceResults.isOk()) {
				return fullWorkspaceResults;
			}
		} catch (e) {
			if (isCancellationError(e)) {
				throw e;
			}
			this._logService.error(e, `Error during full workspace search`);
		}

		// Then try code search but fallback to local search on error or timeout
		const codeSearchTimeout = this._simulationTestContext.isInSimulationTests ? 1_000_000 : 12_500;
		return this.runSearchStrategyWithFallback(
			this._codeSearchChunkSearch,
			() => createCancelablePromise(token => this.doSearchFileChunksLocally(sizing, query, options, telemetryInfo, token)),
			codeSearchTimeout,
			sizing,
			query,
			options,
			telemetryInfo,
			token);
	}

	/**
	 * Tries to run {@link mainStrategy} but falls back to {@link fallback} if it fails or times out.
	 *
	 * On timeout, the main strategy will continue to run in the background and will be cancelled if the fallback finishes first.
	 */
	private async runSearchStrategyWithFallback(
		mainStrategy: IWorkspaceChunkSearchStrategy,
		fallback: () => CancelablePromise<StrategySearchOutcome>,
		mainTimeout: number,
		sizing: StrategySearchSizing,
		query: WorkspaceChunkQueryWithEmbeddings,
		options: WorkspaceChunkSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken
	): Promise<StrategySearchOutcome> {
		// Run prepare before starting the actual timeout
		if (mainStrategy.prepareSearchWorkspace) {
			await raceCancellationError(mainStrategy.prepareSearchWorkspace?.(telemetryInfo, token), token);
		}

		const mainOp = createCancelablePromise(token => this.runSearchStrategy(mainStrategy, sizing, query, options, telemetryInfo, token));
		token.onCancellationRequested(() => mainOp.cancel());

		const mainResult = await raceCancellationError(raceTimeout(mainOp, mainTimeout), token);
		if (mainResult?.isOk()) {
			return mainResult;
		}

		// If main op failed or timed out, fallback but continue with the main too in case it finishes before the fallback
		const fallBackOp = fallback();
		token.onCancellationRequested(() => fallBackOp.cancel());

		return this.raceSearchOperations([mainOp, fallBackOp]);
	}

	private async raceSearchOperations(ops: readonly CancelablePromise<StrategySearchOutcome>[]): Promise<StrategySearchOutcome> {
		for (const op of ops) {
			// if any op finishes, cancel the others
			op.then(result => {
				if (result.isOk()) {
					ops.forEach(op => op.cancel());
				}
			}, () => { });
		}

		const result = await Promise.allSettled(ops);
		for (const r of result) {
			if (r.status === 'fulfilled' && r.value.isOk()) {
				return r.value;
			}
		}

		// Check known failures
		{
			const errors: string[] = [];
			for (const r of result) {
				if (r.status === 'fulfilled' && r.value.isError()) {
					errors.push(r.value.err.errorDiagMessage);
				}
			}
			if (errors.length) {
				return Result.error<StrategySearchErr>({
					errorDiagMessage: errors.join(', ')
				});
			}
		}

		// Check exceptions
		if (result.every(r => r.status === 'rejected' && isCancellationError(r.reason))) {
			return Result.error<StrategySearchErr>({
				errorDiagMessage: 'cancelled',
			});
		}

		for (const r of result) {
			if (r.status === 'rejected' && !isCancellationError(r.reason)) {
				return Result.error<StrategySearchErr>({
					errorDiagMessage: r.reason + ''
				});
			}
		}

		return Result.error<StrategySearchErr>({
			errorDiagMessage: 'unknown error',
		});
	}

	private async doSearchFileChunksLocally(
		sizing: StrategySearchSizing,
		query: WorkspaceChunkQueryWithEmbeddings,
		options: WorkspaceChunkSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken,
	): Promise<StrategySearchOutcome> {
		const embeddingStatus = (await this._embeddingsChunkSearch.getState()).status;
		if (embeddingStatus === LocalEmbeddingsIndexStatus.Ready || embeddingStatus === LocalEmbeddingsIndexStatus.UpdatingIndex) {
			const embeddingsTimeout = 8000;

			return this.runSearchStrategyWithFallback(
				this._embeddingsChunkSearch,
				() => createCancelablePromise(token => this.runSearchStrategy(this._tfIdfWithSemanticChunkSearch, sizing, query, options, telemetryInfo, token)),
				embeddingsTimeout,
				sizing,
				query,
				options,
				telemetryInfo,
				token);
		} else if (this._simulationTestContext.isInSimulationTests && embeddingStatus === LocalEmbeddingsIndexStatus.Unknown) {
			return this.runSearchStrategy(this._embeddingsChunkSearch, sizing, query, options, telemetryInfo, token);
		} else {
			return this.runSearchStrategy(this._tfIdfWithSemanticChunkSearch, sizing, query, options, telemetryInfo, token);
		}
	}

	private async runSearchStrategy(strategy: IWorkspaceChunkSearchStrategy, sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<StrategySearchOutcome> {
		try {
			if (strategy.prepareSearchWorkspace) {
				await raceCancellationError(strategy.prepareSearchWorkspace(telemetryInfo, token), token);
			}

			const result = await raceCancellationError(strategy.searchWorkspace(sizing, query, options, telemetryInfo, token), token);
			if (result) {
				return Result.ok<StrategySearchOk>({
					strategy: strategy.id,
					result: result,
				});
			} else {
				return Result.error<StrategySearchErr>({
					errorDiagMessage: `${strategy.id}: no result`,
				});
			}
		} catch (e) {
			if (isCancellationError(e)) {
				throw e;
			}

			this._logService.error(e, `Error during ${strategy.id} search`);
			return Result.error<StrategySearchErr>({
				errorDiagMessage: `${strategy.id} error: ` + e,
			});
		}
	}

	private getMaxChunks(sizing: WorkspaceChunkSearchSizing): number {
		let maxResults: number | undefined;
		if (typeof sizing.tokenBudget === 'number') {
			maxResults = Math.floor(sizing.tokenBudget / MAX_CHUNK_SIZE_TOKENS);
		}

		if (typeof sizing.maxResults === 'number') {
			maxResults = typeof maxResults === 'number' ? Math.min(sizing.maxResults, maxResults) : sizing.maxResults;
		}

		if (typeof maxResults !== 'number') {
			throw new Error('Either maxResults or tokenBudget must be provided');
		}

		return maxResults;
	}

	private async filterIgnoredChunks(chunks: readonly FileChunkAndScore[]): Promise<FileChunkAndScore[]> {
		return coalesce(await Promise.all(chunks.map(async (entry) => {
			const isIgnored = await this._ignoreService.isCopilotIgnored(entry.chunk.file);
			return isIgnored ? null : entry;
		})));
	}

	@LogExecTime(self => self._logService, 'WorkspaceChunkSearch.rerankResultIfNeeded')
	private async rerankResultIfNeeded(query: WorkspaceChunkQueryWithEmbeddings, result: StrategySearchOk, maxResults: number, telemetryInfo: TelemetryCorrelationId, progress: vscode.Progress<vscode.ChatResponsePart> | undefined, token: CancellationToken): Promise<WorkspaceChunkSearchResult> {
		// If we have full workspace results, use those directly without re-ranking
		if (result.strategy === WorkspaceChunkSearchStrategyId.FullWorkspace) {
			return {
				// No slice. We care more about token budget here
				chunks: result.result.chunks,
				isFullWorkspace: true,
				alerts: result.result.alerts,
				strategy: result.strategy,
			};
		}

		const chunks = result.result.chunks;
		const orderedChunks = await this.rerankChunks(query, chunks, maxResults, telemetryInfo, progress, token);
		return {
			chunks: orderedChunks,
			isFullWorkspace: false,
			alerts: result.result.alerts,
			strategy: result.strategy,
		};
	}

	@LogExecTime(self => self._logService, 'WorkspaceChunkSearch.rerankChunks')
	private async rerankChunks(query: WorkspaceChunkQueryWithEmbeddings, inChunks: readonly FileChunkAndScore[], maxResults: number, telemetryInfo: TelemetryCorrelationId, progress: vscode.Progress<vscode.ChatResponsePart> | undefined, token: CancellationToken): Promise<FileChunkAndScore[]> {
		if (!inChunks.length) {
			return [];
		}

		try {
			let sortedChunks: ScoredFileChunk<FileChunk>[];

			// Handle special case where all chunks have the same embedding type even if this doesn't match the current embedding type.
			// Since we don't care about raw scores, we'll sort them by the distance value instead of recomputing the embeddings.
			const firstChunkEmbeddingType = inChunks.at(0)?.distance?.embeddingType;
			if (firstChunkEmbeddingType && inChunks.every(x => typeof x.distance !== 'undefined' && x.distance.embeddingType.equals(firstChunkEmbeddingType))) {
				sortedChunks = [...inChunks as Array<ScoredFileChunk<FileChunk>>]
					.sort((a, b) => b.distance!.value - a.distance!.value);
			} else {
				// In this case, we are either missing a distance value or have a mix of embedding types
				const chunksPlusIndexes = inChunks.map((x, i) => ({ ...x.chunk, distance: x.distance, index: i }));

				const unscoredChunks = chunksPlusIndexes.filter(entry => typeof entry.distance === 'undefined' || !entry.distance.embeddingType.equals(this._embeddingType));
				let newlyScoredChunks: Array<ScoredFileChunk<FileChunk & { index: number }>> | undefined;

				if (unscoredChunks.length) {
					this._logService.debug(`WorkspaceChunkSearch.rerankChunks. Scoring ${unscoredChunks.length} new chunks`);

					// Only show progress when we're doing a potentially long running operation
					const scoreTask = this.scoreChunks(query, unscoredChunks, telemetryInfo, token);
					progress?.report(new ChatResponseProgressPart2(l10n.t('Filtering to most relevant information'), async () => { await scoreTask; }));
					newlyScoredChunks = await raceCancellationError(scoreTask, token);
				}

				const out: ScoredFileChunk[] = [];
				for (let i = 0; i < inChunks.length; i++) {
					const entry = inChunks[i];
					if (typeof entry.distance !== 'undefined') {
						out[i] = { chunk: entry.chunk, distance: entry.distance };
					}
				}

				for (const entry of newlyScoredChunks ?? []) {
					out[entry.chunk.index] = entry;
				}

				for (let i = 0; i < inChunks.length; i++) {
					if (!out[i]) {
						this._logService.error(`Missing out chunk ${i}`);
					}
				}

				sortedChunks = out
					.filter(chunk => chunk?.distance?.embeddingType.equals(this._embeddingType))
					.sort((a, b) => b.distance.value - a.distance.value);
			}

			if (!sortedChunks.length) {
				return sortedChunks;
			}

			sortedChunks = sortedChunks.slice(0, maxResults);

			// Filter out low quality results based on the top result
			const topScore = sortedChunks[0].distance.value;
			const lowestAllowedScore = topScore * maxEmbeddingSpread;
			const filteredChunks = sortedChunks.filter(x => x.distance.value >= lowestAllowedScore);
			this._logService.debug(`Eagerly filtered out ${sortedChunks.length - filteredChunks.length} chunks due to low quality`);
			return filteredChunks;
		} catch (e) {
			if (!isCancellationError(e)) {
				this._logService.error(e, 'Failed to search chunk embeddings index');
			}
			return inChunks.slice(0, maxResults);
		}
	}

	private async scoreChunks<T extends FileChunk>(
		query: WorkspaceChunkQueryWithEmbeddings,
		chunks: readonly T[],
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken,
	): Promise<ScoredFileChunk<T>[]> {
		return logExecTime(this._logService, 'WorkspaceChunkSearch.scoreChunks', async () => {
			if (!chunks.length) {
				return [];
			}

			const chunkStrings = chunks.map(chunk => this.chunkToIndexString(chunk));

			const [queryEmbeddings, chunkEmbeddings] = await raceCancellationError(Promise.all([
				query.resolveQueryEmbeddings(token),
				this.computeEmbeddings('document', chunkStrings, token)
			]), token);

			return chunkEmbeddings.values.map((embedding, index): ScoredFileChunk<T> => ({
				chunk: chunks[index],
				distance: distance(queryEmbeddings, embedding),
			}));
		}, (execTime, status) => {
			/* __GDPR__
				"workspaceChunkSearch.perf.adaRerank" : {
					"owner": "mjbvz",
					"comment": "Understanding how effective ADA re-ranking is",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('workspaceChunkSearch.perf.adaRerank', {
				status,
				workspaceSearchSource: telemetryInfo.callTracker,
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, { execTime });
		});
	}

	private async computeEmbeddings(inputType: 'query' | 'document', strings: readonly string[], token: CancellationToken): Promise<Embeddings> {
		const embeddings = await this._embeddingsComputer.computeEmbeddings(this._embeddingType, strings, { inputType }, token);
		if (!embeddings) {
			throw new Error('Timeout computing embeddings');
		}

		return embeddings;
	}

	/**
	 * Get the string used to used to calculate embeddings for a chunk.
	 */
	private chunkToIndexString(chunk: FileChunk): string {
		// TODO: could performance be improved here if we process chunks per file first?
		const displayPath = getWorkspaceFileDisplayPath(this._workspaceService, chunk.file);
		return this.toStringForEmbeddingsComputer(chunk, displayPath);
	}

	private toStringForEmbeddingsComputer(chunk: FileChunk, displayPath: string) {
		return `File: \`${displayPath}\`\n${createFencedCodeBlock(getLanguageId(chunk.file), chunk.text)}`;
	}
}

export class NullWorkspaceChunkSearchService implements IWorkspaceChunkSearchService {
	_serviceBrand: undefined;
	onDidChangeIndexState: Event<void> = Event.None;
	hasFastSearch(sizing: StrategySearchSizing): Promise<boolean> {
		return Promise.resolve(false);
	}
	getIndexState(): Promise<WorkspaceIndexState> {
		throw new Error('Method not implemented.');
	}
	searchFileChunks(sizing: WorkspaceChunkSearchSizing, query: WorkspaceChunkQuery, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, progress: vscode.Progress<vscode.ChatResponsePart> | undefined, token: CancellationToken): Promise<WorkspaceChunkSearchResult> {
		throw new Error('Method not implemented.');
	}
	async triggerLocalIndexing(): Promise<Result<true, TriggerIndexingError>> {
		return Result.ok(true);
	}
	triggerRemoteIndexing(): Promise<Result<true, TriggerIndexingError>> {
		return Promise.resolve(Result.ok(true));
	}
	dispose(): void {
		// noop
	}
}

