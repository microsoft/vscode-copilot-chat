/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { Result } from '../../../util/common/result';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { URI } from '../../../util/vs/base/common/uri';
import { Range } from '../../../util/vs/editor/common/core/range';
import { FileChunkAndScore } from '../../chunking/common/chunk';
import { stripChunkTextMetadata, truncateToMaxUtf8Length } from '../../chunking/common/chunkingStringUtils';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { EmbeddingType } from '../../embeddings/common/embeddingsComputer';
import { getGitHubRepoInfoFromContext, IGitService, toGithubNwo } from '../../git/common/gitService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { WorkspaceChunkQuery, WorkspaceChunkSearchOptions } from '../common/workspaceChunkSearch';
import { BuildIndexTriggerReason, TriggerIndexingError } from './codeSearch/codeSearchRepo';
import {
	IWorkspaceChunkSearchService,
	WorkspaceChunkSearchResult,
	WorkspaceChunkSearchSizing,
	WorkspaceIndexState,
} from './workspaceChunkSearchService';

/**
 * Scenario automation implementation of {@link IWorkspaceChunkSearchService}.
 *
 * This is a minimal implementation that directly calls the Blackbird local
 * embeddings endpoint (configured via {@link ConfigKey.Advanced.DebugOverrideEmbeddingsUrl})
 * without depending on the production {@link WorkspaceChunkSearchService} or
 * any of its strategies.  All methods except {@link searchFileChunks} and
 * {@link getIndexState} are no-ops.
 */
export class ScenarioAutomationWorkspaceChunkSearchService implements IWorkspaceChunkSearchService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChangeIndexState: Event<void> = Event.None;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IGitService private readonly _gitService: IGitService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async getIndexState(): Promise<WorkspaceIndexState> {
		return {
			remoteIndexState: { status: 'loaded', repos: [] },
		};
	}

	async isAvailable(): Promise<boolean> {
		return !!this._configService.getConfig(ConfigKey.Advanced.DebugOverrideEmbeddingsUrl);
	}

	async searchFileChunks(
		sizing: WorkspaceChunkSearchSizing,
		query: WorkspaceChunkQuery,
		_options: WorkspaceChunkSearchOptions,
		_telemetryInfo: TelemetryCorrelationId,
		_progress: vscode.Progress<vscode.ChatResponsePart> | undefined,
		_token: CancellationToken,
	): Promise<WorkspaceChunkSearchResult> {
		const overrideUrl = this._configService.getConfig(ConfigKey.Advanced.DebugOverrideEmbeddingsUrl);
		if (!overrideUrl) {
			this._logService.trace('ScenarioAutomationWorkspaceChunkSearchService: no override URL configured');
			return { chunks: [] };
		}

		const repo = this._gitService.repositories[0];
		const repoInfo = repo ? getGitHubRepoInfoFromContext(repo) : undefined;
		const nwo = repoInfo ? toGithubNwo(repoInfo.id) : (process.env.SWEBENCH_REPO ?? '');

		const queryText = query.queryText;
		const maxResults = sizing.maxResults ?? 20;

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		const authToken = process.env.COPILOT_EMBEDDINGS_AUTH_TOKEN;
		if (authToken) {
			headers['Authorization'] = `Bearer ${authToken}`;
		}

		this._logService.trace(`ScenarioAutomationWorkspaceChunkSearchService: searching ${overrideUrl} for "${queryText}" in repo ${nwo}`);

		if (!nwo) {
			this._logService.error('ScenarioAutomationWorkspaceChunkSearchService: no repo NWO available (git has no remotes and SWEBENCH_REPO is unset)');
			return { chunks: [] };
		}

		const requestBody = {
			scoping_query: `repo:${nwo}`,
			prompt: truncateToMaxUtf8Length(queryText, 7800),
			include_embeddings: false,
			limit: maxResults,
			embedding_model: EmbeddingType.metis_1024_I16_Binary.id,
		};
		this._logService.trace(`ScenarioAutomationWorkspaceChunkSearchService: request body: ${JSON.stringify(requestBody)}`);

		let response;
		try {
			response = await this._fetcherService.fetch(overrideUrl, {
				callSite: 'ScenarioAutomationWorkspaceChunkSearchService.searchFileChunks',
				method: 'POST',
				headers,
				body: JSON.stringify(requestBody),
			});
		} catch (e) {
			this._logService.error(`ScenarioAutomationWorkspaceChunkSearchService: fetch failed: ${e instanceof Error ? e.message : e}`);
			return { chunks: [] };
		}

		if (!response.ok) {
			const errorBody = await response.text().catch(() => '<unable to read body>');
			this._logService.error(`ScenarioAutomationWorkspaceChunkSearchService: search failed with status ${response.status}, body: ${errorBody}`);
			return { chunks: [] };
		}

		const body = await response.json();
		if (!Array.isArray(body.results)) {
			this._logService.error('ScenarioAutomationWorkspaceChunkSearchService: unexpected response shape');
			return { chunks: [] };
		}

		const embeddingType = new EmbeddingType(body.embedding_model ?? EmbeddingType.metis_1024_I16_Binary.id);
		const chunks: FileChunkAndScore[] = [];
		for (const result of body.results) {
			const fileUri = repo?.rootUri
				? URI.joinPath(repo.rootUri, result.location.path)
				: URI.from({ scheme: 'githubRepoResult', path: '/' + result.location.path });
			chunks.push({
				chunk: {
					file: fileUri,
					text: stripChunkTextMetadata(result.chunk.text),
					rawText: undefined,
					range: new Range(result.chunk.line_range.start, 0, result.chunk.line_range.end, 0),
					isFullFile: false,
				},
				distance: {
					embeddingType,
					value: result.distance,
				},
			});
		}

		this._logService.trace(`ScenarioAutomationWorkspaceChunkSearchService: got ${chunks.length} chunks`);
		return { chunks };
	}

	async triggerRemoteIndexing(_trigger: BuildIndexTriggerReason, _onProgress: (message: string) => void, _telemetryInfo: TelemetryCorrelationId, _token: CancellationToken): Promise<Result<true, TriggerIndexingError>> {
		return Result.ok(true);
	}

	async deleteExternalIngestWorkspaceIndex(): Promise<void> {
		// noop
	}

	dispose(): void {
		// noop
	}
}
