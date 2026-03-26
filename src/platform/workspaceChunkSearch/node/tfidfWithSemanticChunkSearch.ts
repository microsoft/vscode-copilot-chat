/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { FileChunk, FileChunkAndScore } from '../../chunking/common/chunk';
import { logExecTime, LogExecTime } from '../../log/common/logExecTime';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { IWorkspaceChunkSearchStrategy, StrategySearchResult, StrategySearchSizing, WorkspaceChunkQueryWithEmbeddings, WorkspaceChunkSearchOptions, WorkspaceChunkSearchStrategyId } from '../common/workspaceChunkSearch';
import { TfidfChunkSearch } from './tfidfChunkSearch';
import { WorkspaceChunkEmbeddingsIndex } from './workspaceChunkEmbeddingsIndex';

/**
 * Uses tf-idf to find a set of basic chunks then converts them to semantic chunks.
 */
export class TfIdfWithSemanticChunkSearch extends Disposable implements IWorkspaceChunkSearchStrategy {

	readonly id = WorkspaceChunkSearchStrategyId.Tfidf;

	constructor(
		private readonly _tfidf: TfidfChunkSearch,
		private readonly _workspaceChunkEmbeddingsIndex: WorkspaceChunkEmbeddingsIndex,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();
	}

	async searchWorkspace(sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<StrategySearchResult> {
		return logExecTime(this._logService, 'TfIdfWithSemanticChunkSearch.perf.searchFileChunks', async () => {
			const tfidfResult = await raceCancellationError(this._tfidf.searchWorkspace(sizing, query, options, telemetryInfo.addCaller('TfIdfWithSemanticChunkSearch::searchWorkspace'), token), token);

			const semanticChunks = await this.toSemanticChunks(query, tfidfResult.chunks.map(x => x.chunk), telemetryInfo, token);
			return { chunks: semanticChunks };
		}, (execTime, status) => {
			/* __GDPR__
				"tfIdfWithSemanticChunkSearch.perf.searchFileChunks" : {
					"owner": "mjbvz",
					"comment": "Total time for searchFileChunks to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('tfIdfWithSemanticChunkSearch.perf.searchFileChunks', {
				status,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, { execTime });
		});
	}

	@LogExecTime(self => self._logService, 'TfIdfWithSemanticChunkSearch::searchSubsetOfFiles')
	async searchSubsetOfFiles(sizing: StrategySearchSizing, query: WorkspaceChunkQueryWithEmbeddings, files: readonly URI[], options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<StrategySearchResult> {
		if (!files.length) {
			return { chunks: [] };
		}

		const tfidfResult = await raceCancellationError(this._tfidf.searchSubsetOfFiles(sizing, query, files, options, telemetryInfo.addCaller('TfidfChunkSearch::searchSubsetOfFiles'), token), token);

		const semanticChunks = await this.toSemanticChunks(query, tfidfResult.chunks.map(x => x.chunk), telemetryInfo, token);
		return { chunks: semanticChunks };
	}

	private async toSemanticChunks(query: WorkspaceChunkQueryWithEmbeddings, tfidfResults: readonly FileChunk[], telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<PromiseLike<FileChunkAndScore[]>> {
		return logExecTime(this._logService, 'TfIdfWithSemanticChunkSearch.perf.toSemanticChunks', async () => {
			return this._workspaceChunkEmbeddingsIndex.toSemanticChunks(query.resolveQueryEmbeddings(token), tfidfResults, { semanticTimeout: 5000, telemetryInfo }, token);
		}, (execTime, status) => {
			/* __GDPR__
				"tfIdfWithSemanticChunkSearch.perf.toSemanticChunks" : {
					"owner": "mjbvz",
					"comment": "Time for the toSemantic part of searchFileChunks to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('tfIdfWithSemanticChunkSearch.perf.toSemanticChunks', {
				status,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
			}, { execTime });
		});
	}
}
