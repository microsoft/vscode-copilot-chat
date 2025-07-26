/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GlobIncludeOptions } from '../../../util/common/glob';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { Range } from '../../../util/vs/editor/common/core/range';
import { FileChunkAndScore } from '../../chunking/common/chunk';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { logExecTime } from '../../log/common/logExecTime';
import { ILogService } from '../../log/common/logService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { IWorkspaceChunkSearchStrategy, StrategySearchResult, StrategySearchSizing, WorkspaceChunkQuery, WorkspaceChunkSearchOptions, WorkspaceChunkSearchStrategyId } from '../common/workspaceChunkSearch';
import { IWorkspaceFileIndex } from './workspaceFileIndex';

/**
 * Tries including the entire workspace if there's enough budget for it.
 *
 * This always either succeeds with the full workspace or returns no results.
 */
export class FullWorkspaceChunkSearch extends Disposable implements IWorkspaceChunkSearchStrategy {

	readonly id = WorkspaceChunkSearchStrategyId.FullWorkspace;

	/**
	 * Upper bound on number of files we can use full workspace search for.
	 *
	 * This is is an optimization so we don't even try to compute the workspace token count if it has a ton of files.
	 */
	private static maxFileCount = 100;

	private _previousHitWholeWorkspaceTokenCount = 0;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ITokenizerProvider private readonly _tokenizationProvider: ITokenizerProvider,
		@IWorkspaceFileIndex private readonly _workspaceIndex: IWorkspaceFileIndex,
	) {
		super();
	}

	/**
	 * Does a fast check to see if full workspace search may be available.
	 */
	async mayBeAvailable(sizing: StrategySearchSizing, globPatterns?: GlobIncludeOptions): Promise<boolean> {
		if (!this.isEnabled()) {
			return false;
		}

		if (!sizing.tokenBudget || (!globPatterns && !this.mayBeUnderGlobalTokenBudget(sizing))) {
			return false;
		}

		await this._workspaceIndex.initialize();

		let count = 0;
		for (const _ of this._workspaceIndex.values(globPatterns)) {
			count++;
			if (count >= FullWorkspaceChunkSearch.maxFileCount) {
				return false;
			}
		}

		return true;
	}

	async searchWorkspace(sizing: StrategySearchSizing, _query: WorkspaceChunkQuery, options: WorkspaceChunkSearchOptions, telemetryInfo: TelemetryCorrelationId, token: CancellationToken): Promise<StrategySearchResult | undefined> {
		if (!(await this.mayBeAvailable(sizing, options.globPatterns))) {
			return;
		}

		let errorReason: string | undefined;
		return logExecTime(this._logService, 'FullWorkspaceChunkSearch.searchWorkspace', async () => {
			if (!sizing.tokenBudget) {
				return undefined;
			}

			try {
				const tokenizer = this._tokenizationProvider.acquireTokenizer(sizing.endpoint);

				const chunks: FileChunkAndScore[] = [];
				let usedTokenBudget = 0;

				const cts = new CancellationTokenSource(token);
				try {
					await raceCancellationError(Promise.all(Array.from(this._workspaceIndex.values(options.globPatterns), async (file) => {
						let text: string;
						try {
							text = await raceCancellationError(file.getText(), cts.token);
						} catch (e) {
							if (!isCancellationError(e)) {
								errorReason = 'error-reading-file';
								this._logService.error(`FullWorkspaceChunkSearch: Error getting text for file ${file.uri}: ${e}`);
							}
							throw e;
						}

						let fileTokens: number;
						try {
							fileTokens = await raceCancellationError(tokenizer.tokenLength(text), cts.token);
						} catch (e) {
							if (!isCancellationError(e)) {
								errorReason = 'error-tokenizing-file';
								this._logService.error(`FullWorkspaceChunkSearch: Error tokenizing file ${file.uri}: ${e}`);
							}
							throw e;
						}

						usedTokenBudget += fileTokens;
						if (usedTokenBudget >= sizing.tokenBudget!) {
							cts.cancel();
							return;
						}

						chunks.push({
							// TODO: get proper range
							chunk: { file: file.uri, range: new Range(0, 0, Number.MAX_SAFE_INTEGER, 0), isFullFile: true, text, rawText: text },
							distance: undefined
						});
					})), token);
				} catch (e) {
					// If only the inner cts was cancelled, we want to ignore it
					// All other errors should be propagated
					if (!isCancellationError(e) || (isCancellationError(e) && token.isCancellationRequested)) {
						throw e;
					}
				} finally {
					cts.dispose();
				}

				if (usedTokenBudget >= sizing.tokenBudget) {
					if (!options.globPatterns) {
						this._previousHitWholeWorkspaceTokenCount = Math.max(usedTokenBudget, this._previousHitWholeWorkspaceTokenCount);
					}

					this._logService.debug(`FullWorkspaceChunkSearch: Workspace too large. Found at least ${usedTokenBudget} of ${sizing.tokenBudget} token limit`);
					errorReason = 'too-large';
					return undefined;
				} else {
					this._logService.debug(`FullWorkspaceChunkSearch: Found ${usedTokenBudget} of ${sizing.tokenBudget} token limit`);
					return { chunks };
				}
			} catch (e) {
				if (!isCancellationError(e)) {
					this._logService.error(e, `Error collecting info for full workspace search`);
					if (e instanceof Error) {
						errorReason ??= e.message;
					}
				}

				throw e;
			}
		}, (execTime, status) => {
			/* __GDPR__
				"fullWorkspaceChunkSearch.perf.searchFileChunks" : {
					"owner": "mjbvz",
					"comment": "Total time for searchFileChunks to complete",
					"status": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the call succeeded or failed" },
					"workspaceSearchSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller of the search" },
					"workspaceSearchCorrelationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id for the search" },
					"failureReason": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "why did we fail" },
					"execTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Time in milliseconds that the call took" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('fullWorkspaceChunkSearch.perf.searchFileChunks', {
				status,
				workspaceSearchSource: telemetryInfo.callTracker.toString(),
				workspaceSearchCorrelationId: telemetryInfo.correlationId,
				failureReason: errorReason,
			}, { execTime });
		});
	}

	private mayBeUnderGlobalTokenBudget(sizing: StrategySearchSizing): boolean {
		return !!sizing.tokenBudget && this._previousHitWholeWorkspaceTokenCount < sizing.tokenBudget;
	}

	private isEnabled(): boolean {
		return this._configService.getExperimentBasedConfig<boolean>(ConfigKey.Internal.WorkspaceEnableFullWorkspace, this._experimentationService);
	}
}
