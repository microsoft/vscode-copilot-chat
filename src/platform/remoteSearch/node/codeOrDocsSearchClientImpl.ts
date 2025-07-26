/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { RequestMetadata, RequestType } from '@vscode/copilot-api';
import { createRequestHMAC } from '../../../util/common/crypto';
import { TokenizerType } from '../../../util/common/tokenizer';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError, isCancellationError } from '../../../util/vs/base/common/errors';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { LogExecTime } from '../../log/common/logExecTime';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { IEndpoint, postRequest } from '../../networking/common/networking';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ICodeOrDocsSearchBaseScopingQuery, ICodeOrDocsSearchItem, ICodeOrDocsSearchMultiRepoScopingQuery, ICodeOrDocsSearchOptions, ICodeOrDocsSearchResult, ICodeOrDocsSearchSingleRepoScopingQuery, IDocsSearchClient } from '../common/codeOrDocsSearchClient';
import { SearchErrorType, constructSearchError, constructSearchRepoError } from '../common/codeOrDocsSearchErrors';
import { formatScopingQuery } from '../common/utils';

/**
 * What an error looks like that is returned by docssearch.
 */
interface IDocsSearchError {
	message: string;
	error: string;
	repo: string;
}

/**
 * What the response looks like that is returned by docssearch.
 */
interface IDocsSearchResponse {
	results: ICodeOrDocsSearchItem[];
	errors?: IDocsSearchError[];
}

class UnknownHttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 100;
const DEFAULT_SIMILARITY = 0.766;

export class DocsSearchClient implements IDocsSearchClient {
	declare readonly _serviceBrand: undefined;

	private readonly slug = 'docs';

	constructor(
		@IDomainService private readonly _domainService: IDomainService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IEnvService private readonly _envService: IEnvService,
		@ILogService private readonly _logService: ILogService,
	) { }

	search(query: string, scopingQuery: ICodeOrDocsSearchSingleRepoScopingQuery, options?: ICodeOrDocsSearchOptions, token?: CancellationToken): Promise<ICodeOrDocsSearchItem[]>;
	search(query: string, scopingQuery: ICodeOrDocsSearchMultiRepoScopingQuery, options?: ICodeOrDocsSearchOptions, token?: CancellationToken): Promise<ICodeOrDocsSearchResult>;
	@LogExecTime(self => self._logService, 'CodeOrDocsSearchClientImpl.search')
	async search(
		query: string,
		scopingQuery: ICodeOrDocsSearchSingleRepoScopingQuery | ICodeOrDocsSearchMultiRepoScopingQuery,
		options: ICodeOrDocsSearchOptions = {},
		token?: CancellationToken,
	): Promise<ICodeOrDocsSearchItem[] | ICodeOrDocsSearchResult> {
		// Code search requires at least one repo specified
		if (Array.isArray(scopingQuery.repo) && !scopingQuery.repo.length) {
			throw new Error('No repos specified');
		}

		let result: IDocsSearchResponse;
		try {
			result = await this.postRequestWithRetry(query, scopingQuery, options, token ?? CancellationToken.None);
		} catch (error) {
			if (!isCancellationError(error)) {
				this._telemetryService.sendGHTelemetryException(error, `${this.slug} search failed`);
			}
			throw error;
		}
		const errors = result.errors?.map(constructSearchRepoError) ?? [];
		// If we're in single repo mode, we will throw errors. If not, we're return a similar shape
		if (!Array.isArray(scopingQuery.repo)) {
			if (errors.length) {
				// TODO: Can this happen?
				if (errors.length > 1) {
					throw new AggregateError(errors);
				} else {
					throw errors[0];
				}
			}
			return result.results;
		}

		// Multi-repo
		return {
			results: result.results,
			errors
		};
	}

	private async postRequestWithRetry(
		query: string,
		scopingQuery: ICodeOrDocsSearchBaseScopingQuery,
		options: ICodeOrDocsSearchOptions,
		token: CancellationToken
	): Promise<IDocsSearchResponse> {
		const authToken = (await this._authenticationService.getPermissiveGitHubSession({ silent: true }))?.accessToken ?? (await this._authenticationService.getAnyGitHubSession({ silent: true }))?.accessToken;
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		const MAX_RETRIES = 3;
		let retryCount = 0;

		const errorMessages = new Set<string>;
		let error: Error | undefined;
		while (retryCount < MAX_RETRIES) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			try {
				try {
					const result = await this.postCodeOrDocsSearchRequest({ type: RequestType.SearchSkill, slug: this.slug }, authToken!, query, scopingQuery, options, token);
					return result;
				} catch (e) {
					if (e instanceof UnknownHttpError) {
						throw e;
					}
					error = e;
					break;
				}
			} catch (error: any) {
				retryCount++;
				const waitTime = 100;
				errorMessages.add(`Error fetching ${this.slug} search. ${error.message ?? error}`);
				this._logService.warn(`[repo:${scopingQuery.repo}] Error fetching ${this.slug} search. Error: ${error.message ?? error}. Retrying in ${retryCount}ms. Query: ${query}`);
				await new Promise(resolve => setTimeout(resolve, waitTime));
			}
		}

		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		if (retryCount >= MAX_RETRIES) {
			this._logService.warn(`[repo:${scopingQuery.repo}] Max Retry Error thrown while querying '${query}'`);
			error = constructSearchError({
				error: SearchErrorType.maxRetriesExceeded,
				message: `${this.slug} search timed out after ${MAX_RETRIES} retries. ${Array.from(errorMessages).join('\n')}`
			});
		}

		throw error;
	}

	private async postCodeOrDocsSearchRequest(
		requestMetadata: RequestMetadata,
		authToken: string,
		query: string,
		scopingQuery: ICodeOrDocsSearchBaseScopingQuery,
		options: ICodeOrDocsSearchOptions,
		cancellationToken?: CancellationToken
	) {
		const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
		const similarity = options.similarity ?? DEFAULT_SIMILARITY;
		const endpointInfo: IEndpoint = {
			urlOrRequestMetadata: requestMetadata,
			tokenizer: TokenizerType.O200K,
			acquireTokenizer() {
				throw new Error('Method not implemented.');
			},
			family: 'Code Or Doc Search',
			name: 'Code Or Doc Search',
			version: '2023-12-12-preview',
			modelMaxPromptTokens: 0,
			getExtraHeaders() {
				const headers: Record<string, string> = {
					// needed for errors to be in the right format
					// TODO: should this be the default of postRequest?
					Accept: 'application/json',
					'X-GitHub-Api-Version': '2023-12-12-preview',
				};
				return headers;
			},
		};
		const response = await postRequest(
			this._fetcherService,
			this._envService,
			this._telemetryService,
			this._domainService,
			this._capiClientService,
			endpointInfo,
			authToken ?? '',
			await createRequestHMAC(process.env.HMAC_SECRET),
			'codesearch',
			generateUuid(),
			{
				query,
				scopingQuery: formatScopingQuery(scopingQuery),
				similarity,
				limit
			},
			undefined,
			cancellationToken
		);

		const text = await response.text();
		if (response.status === 404 || (response.status === 400 && text.includes('unknown integration'))) {
			// If the endpoint is not available for this user it will return 404.
			this._logService.debug(`${this.slug} search endpoint not available for this user.`);
			const error = constructSearchError({
				error: SearchErrorType.noAccessToEndpoint,
				message: `${this.slug}: ${text}`
			});
			throw error;
		}

		let result: IDocsSearchResponse;
		try {
			// handle 500s specifically (like blackbird queries)
			result = JSON.parse(text);
		} catch (e) {
			// try again in the 500 case
			throw new UnknownHttpError(response.status, text);
		}

		return result;
	}
}
