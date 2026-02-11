/*---------------------------------------------------------------------------------------------
 *  Null GitHub Code Search Service
 *  Replaces GithubCodeSearchService which calls GitHub CAPI for remote code search.
 *  Always returns generic-error to avoid triggering GitHub sign-in prompts.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Result } from '../../../util/common/result';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { EmbeddingType } from '../../embeddings/common/embeddingsComputer';
import { GithubRepoId } from '../../git/common/gitService';
import { CodeSearchOptions, CodeSearchResult, RemoteCodeSearchError, RemoteCodeSearchIndexState } from '../../remoteCodeSearch/common/remoteCodeSearch';
import { GithubCodeSearchRepoInfo, IGithubCodeSearchService } from '../../remoteCodeSearch/common/githubCodeSearchService';

export class NullGithubCodeSearchService implements IGithubCodeSearchService {

	declare readonly _serviceBrand: undefined;

	async getRemoteIndexState(
		_authOptions: { readonly silent: boolean },
		_githubRepoId: GithubRepoId,
		_token: CancellationToken,
	): Promise<Result<RemoteCodeSearchIndexState, RemoteCodeSearchError>> {
		// Return generic-error instead of not-authorized to avoid triggering GitHub sign-in
		return Result.error({ type: 'generic-error', error: new Error('Remote code search unavailable in Azure-only mode') });
	}

	async triggerIndexing(
		_authOptions: { readonly silent: boolean },
		_triggerReason: 'auto' | 'manual' | 'tool',
		_githubRepoId: GithubRepoId,
		_telemetryInfo: TelemetryCorrelationId,
	): Promise<Result<true, RemoteCodeSearchError>> {
		return Result.error({ type: 'generic-error', error: new Error('Remote code search unavailable in Azure-only mode') });
	}

	async searchRepo(
		_authOptions: { readonly silent: boolean },
		_embeddingType: EmbeddingType,
		_repo: GithubCodeSearchRepoInfo,
		_query: string,
		_maxResults: number,
		_options: CodeSearchOptions,
		_telemetryInfo: TelemetryCorrelationId,
		_token: CancellationToken,
	): Promise<CodeSearchResult> {
		return { chunks: [], outOfSync: false };
	}
}
