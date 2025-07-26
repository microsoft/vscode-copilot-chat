/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { WorkerWithRpcProxy } from '../../../util/node/worker';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { Schemas } from '../../../util/vs/base/common/network';
import * as path from '../../../util/vs/base/common/path';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { URI } from '../../../util/vs/base/common/uri';
import { IRange, Range } from '../../../util/vs/editor/common/core/range';
import { FileChunk, FileChunkAndScore } from '../../chunking/common/chunk';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { RelativePattern } from '../../filesystem/common/fileTypes';
import { LogExecTime, logExecTime } from '../../log/common/logExecTime';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { rewriteObject } from '../../tfidf/node/tfidfMessaging';
import type { TfidfHostApi, TfIdfInitializeTelemetry, TfidfSearchResults, TfidfWorkerApi, TfIdfWorkerData } from '../../tfidf/node/tfidfWorker';
import { TokenizationEndpoint } from '../../tokenizer/node/tokenizer';
import { IWorkspaceChunkSearchStrategy, ResolvedWorkspaceChunkQuery, StrategySearchResult, StrategySearchSizing, WorkspaceChunkQueryWithEmbeddings, WorkspaceChunkSearchOptions, WorkspaceChunkSearchStrategyId } from '../common/workspaceChunkSearch';
import { FileRepresentation, IWorkspaceFileIndex } from './workspaceFileIndex';

const workerPath = path.join(__dirname, 'tfidfWorker.js');

export class TfidfChunkSearch extends Disposable implements IWorkspaceChunkSearchStrategy {

	private readonly _maxInitialFileCount = 25_000;

	readonly id = WorkspaceChunkSearchStrategyId.Tfidf;

	private _isDisposed = false;

	private _initializePromise?: Promise<void>;
	private readonly _tfIdfWorker: Lazy<WorkerWithRpcProxy<TfidfWorkerApi>>;

	constructor(
		endpoint: TokenizationEndpoint,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IWorkspaceFileIndex private readonly _workspaceIndex: IWorkspaceFileIndex,
		@IVSCodeExtensionContext vsExtensionContext: IVSCodeExtensionContext,
	) {
		super();

		this._tfIdfWorker = new Lazy(() => {
			const dbPath = vsExtensionContext.storageUri && vsExtensionContext.storageUri.scheme === Schemas.file
				? URI.joinPath(vsExtensionContext.storageUri, 'local-index.1.db')
				: ':memory:';

			return new WorkerWithRpcProxy<TfidfWorkerApi, TfidfHostApi>(workerPath, {
				name: 'TfIdf Worker',
				workerData: {
					endpoint,
					dbPath,
				} satisfies TfIdfWorkerData
			}, {
				readFile: async (uri): Promise<string> => {
					const entry = this._workspaceIndex.get(revive(uri));
					if (!entry) {
						throw new Error('Could not find file in index');
					}

					return entry.getText();
				},
				getContentVersionId: async (uri): Promise<string> => {
					const entry = this._workspaceIndex.get(revive(uri));
					if (!entry) {
						throw new Error('Could not find file in index');
					}

					return entry.getFastContentVersionId();
				},
			});
		});
	}

	override dispose(): void {
		this._isDisposed = true;
		super.dispose();

		this._tfIdfWorker.rawValue?.terminate();
	}

	async searchWorkspace(
		sizing: StrategySearchSizing,
		query: WorkspaceChunkQueryWithEmbeddings,
		options: WorkspaceChunkSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken,
	): Promise<StrategySearchResult> {
		return logExecTime(this._logService, 'tfIdfChunkSearch.searchWorkspace', async () => {
			const [_, resolved] = await raceCancellationError(Promise.all([
				this.initializeWholeWorkspace(),
				query.resolveQueryAndKeywords(token),
			]), token);

			if (this._isDisposed) {
				throw new Error('TfidfChunkSearch is disposed');
			}

			const resolvedQuery = this.toQuery(resolved);
			this._logService.trace(`TfidfChunkSearch.searchWorkspace: Starting tfidf search for: ${resolvedQuery}`);
			const result = await raceCancellationError(this.doTfidfSearch(resolvedQuery, sizing.maxResultCountHint, options, telemetryInfo.addCaller('TfidfChunkSearch::searchWorkspace'), token), token);
			this._logService.trace(`TfidfChunkSearch.searchWorkspace: Found ${result.length} results`);

			return { chunks: result.map((chunk): FileChunkAndScore => ({ chunk, distance: undefined })) };
		}, (execTime, status) => {
			/* __GDPR__
				"tfIdfChunkSearch.perf.searchFileChunks" : {
					"owner": "mjbvz",
					"comment": "Total time for searchFileChunks to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('tfIdfChunkSearch.perf.searchFileChunks', {
				status,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, { execTime });
		});
	}

	async searchSubsetOfFiles(sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, files: readonly URI[], options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<StrategySearchResult> {
		return logExecTime(this._logService, 'tfIdfChunkSearch.searchSubsetOfFiles', async () => {
			if (!files.length) {
				return { chunks: [] };
			}

			const [_, resolved] = await raceCancellationError(Promise.all([
				this.initializeForSubsetFiles(files),
				query.resolveQueryAndKeywords(token),
			]), token);
			if (this._isDisposed) {
				throw new Error('TfidfChunkSearch is disposed');
			}

			const maxResults = sizing.maxResultCountHint;
			const result = await raceCancellationError(
				this.doTfidfSearch(this.toQuery(resolved), maxResults, {
					...options,
					globPatterns: {
						include: files.map(uri => new RelativePattern(uri, '*')),
						exclude: options.globPatterns?.exclude,
					}
				}, telemetryInfo.addCaller('TfidfChunkSearch::searchSubsetOfFiles'), token),
				token);

			return { chunks: result.map((chunk): FileChunkAndScore => ({ chunk, distance: undefined })) };
		}, (execTime, status) => {
			/* __GDPR__
				"tfIdfChunkSearch.perf.searchSubsetOfFiles" : {
					"owner": "mjbvz",
					"comment": "Total time for searchSubsetOfFiles to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" },
					"files": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of files being searched" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('tfIdfChunkSearch.perf.searchSubsetOfFiles', {
				status,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, {
				execTime,
				fileCount: files.length
			});
		});
	}

	private doTfidfSearch(query: string, maxResults: number, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<readonly FileChunk[]> {
		let results: TfidfSearchResults | undefined;
		return logExecTime(this._logService, 'tfIdfChunkSearch.doTfidfSearch', async () => {
			results = await raceCancellationError(
				this._tfIdfWorker.value.proxy.search(
					query,
					{ maxResults, globPatterns: serialize(options.globPatterns), maxSpread: 0.75 }),
				token);

			return revive(results.results);
		}, (execTime, status) => {
			/* __GDPR__
				"tfIdfChunkSearch.perf.tfidfSearch" : {
					"owner": "mjbvz",
					"comment": "Total time for searchFileChunks to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" },
					"fileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of files in the index" },
					"updatedFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of files updated for this search" },
					"updateTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that updating of the index took" },
					"searchTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that searching the index took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('tfIdfChunkSearch.perf.tfidfSearch', {
				status: token.isCancellationRequested ? 'cancelled' : status,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, {
				execTime,
				fileCount: results?.telemetry.fileCount,
				updatedFileCount: results?.telemetry.updatedFileCount,
				updateTime: results?.telemetry.updateTime,
				searchTime: results?.telemetry.searchTime,
			});
		});
	}

	@LogExecTime(self => self._logService)
	private initializeWholeWorkspace(): Promise<void> {
		this._initializePromise ??= this.initializeWorkspaceFiles();
		return this._initializePromise;
	}

	private async initializeWorkspaceFiles(): Promise<void> {
		const sw = new StopWatch();
		await logExecTime(this._logService, 'initialize workspaceIndex', () => this._workspaceIndex.initialize());
		const initWorkspaceIndexTime = sw.elapsed();
		if (this._isDisposed) {
			return;
		}

		let filesToIndex: FileRepresentation[] = [];
		let telemetryData: TfIdfInitializeTelemetry | undefined;
		let readInitDocsTime: number | undefined = undefined;
		await logExecTime(this._logService, 'initialize tfidf', async () => {
			sw.reset();
			filesToIndex = Array.from(this._workspaceIndex.values()).slice(0, this._maxInitialFileCount);

			const initDocs = await Promise.all(filesToIndex.map(async entry => ({ uri: entry.uri, contentId: await entry.getFastContentVersionId() })));
			readInitDocsTime = sw.elapsed();
			if (this._isDisposed) {
				return;
			}

			telemetryData = await this._tfIdfWorker.value.proxy.initialize(initDocs);
		}, (execTime, status) => {
			/* __GDPR__
				"tfidfChunkSearch.perf.initializeTfidf" : {
					"owner": "mjbvz",
					"comment": "Understanding how long it took to initialize the tfidf index",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" },
					"initWorkspaceIndexTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that initializing the workspace index took" },
					"readInitDocsTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that reading the initial documents took" },
					"fileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of files that we can index" },
					"newFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of new files" },
					"outOfSyncFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of files that are out of sync" },
					"deletedFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of files that have been deleted" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('tfidfChunkSearch.perf.initializeTfidf', { status }, {
				execTime,
				initWorkspaceIndexTime,
				readInitDocsTime: readInitDocsTime,
				fileCount: filesToIndex.length,
				newFileCount: telemetryData?.newFileCount,
				outOfSyncFileCount: telemetryData?.outOfSyncFileCount,
				deletedFileCount: telemetryData?.deletedFileCount
			});
		});

		if (this._isDisposed) {
			return;
		}

		this._register(Event.any(
			this._workspaceIndex.onDidCreateFiles,
			this._workspaceIndex.onDidChangeFiles
		)((uris: readonly URI[]) => {
			if (!this._isDisposed) {
				this.addOrUpdateTfidfEntries(uris);
			}
		}));

		this._register(this._workspaceIndex.onDidDeleteFiles(resources => {
			if (!this._isDisposed) {
				this._tfIdfWorker.value.proxy.delete(resources);
			}
		}));
	}

	/**
	 * Initialize the index for a subset of files in the workspace.
	 */
	@LogExecTime(self => self._logService)
	private async initializeForSubsetFiles(files: readonly URI[]): Promise<void> {
		await logExecTime(this._logService, 'initialize workspaceIndex', () => this._workspaceIndex.initialize());
		if (this._isDisposed) {
			return;
		}

		return this.addOrUpdateTfidfEntries(Array.from(this._workspaceIndex.values(), x => x.uri).filter(uri => files.includes(uri)));
	}

	private async addOrUpdateTfidfEntries(files: readonly URI[]) {
		if (!files.length) {
			return;
		}
		this._tfIdfWorker.value.proxy.addOrUpdate(files);
	}

	private toQuery(resolved: ResolvedWorkspaceChunkQuery): string {
		const flattenedKeywords = resolved.keywords.flatMap(entry => [entry.keyword, ...entry.variations]);

		return flattenedKeywords.length ? flattenedKeywords.join(', ') : resolved.rephrasedQuery;
	}
}


function serialize<T>(value: T): T {
	return rewriteObject(value, obj => {
		if (URI.isUri(obj)) {
			return {
				'$mid': 'uri',
				...obj
			};
		}
		if (obj instanceof Range) {
			return {
				startLineNumber: obj.startLineNumber,
				startColumn: obj.startColumn,
				endLineNumber: obj.endLineNumber,
				endColumn: obj.endColumn,
			} as IRange;
		}
	});
}

function revive<T>(value: T): T {
	return rewriteObject(value, (obj: any) => {
		if (obj['$mid'] === 'range') {
			return new Range(obj.startLineNumber, obj.startColumn, obj.endLineNumber, obj.endColumn);
		}
		if (obj['$mid'] === 'uri') {
			return URI.revive(obj);
		}
	});
}
