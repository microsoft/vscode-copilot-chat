/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { makeGitHubAPIRequest } from '../common/githubAPI';
import { GithubRepositoryItem, IGetRepositoryInfoResponseData, IGithubRepositoryService } from '../common/githubService';
import { vRepositoryContentItem, vRepositoryItem } from '../common/githubAPIValidators';
import { vArray, vUnchecked } from '../../configuration/common/validator';

export class GithubRepositoryService implements IGithubRepositoryService {

	declare readonly _serviceBrand: undefined;

	private readonly githubRepositoryInfoCache = new Map<string, IGetRepositoryInfoResponseData>();

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService
	) {
	}

	private async _doGetRepositoryInfo(owner: string, repo: string): Promise<IGetRepositoryInfoResponseData | undefined> {
		const authToken: string | undefined = this._authenticationService.permissiveGitHubSession?.accessToken ?? this._authenticationService.anyGitHubSession?.accessToken;

		const response = await makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, 'https://api.github.com', `repos/${owner}/${repo}`, 'GET', authToken);
		if (!response) {
			return undefined;
		}

		// IGetRepositoryInfoResponseData is from @octokit/types which is a complex external type
		// We use vUnchecked here since it's a well-defined external API contract
		const validation = vUnchecked<IGetRepositoryInfoResponseData>().validate(response);
		if (validation.error) {
			this._logService.error(`[GithubRepositoryService] Failed to validate repository info response: ${validation.error.message}`);
			return undefined;
		}
		return validation.content;
	}

	async getRepositoryInfo(owner: string, repo: string) {
		const cachedInfo = this.githubRepositoryInfoCache.get(`${owner}/${repo}`);
		if (cachedInfo) {
			return cachedInfo;
		}

		const response = await this._doGetRepositoryInfo(owner, repo);
		if (response) {
			this.githubRepositoryInfoCache.set(`${owner}/${repo}`, response);
			return response;
		}
		throw new Error(`Failed to fetch repository info for ${owner}/${repo}`);
	}

	async isAvailable(org: string, repo: string): Promise<boolean> {
		try {
			const response = await this._doGetRepositoryInfo(org, repo);
			return response !== undefined;
		} catch (e) {
			return false;
		}
	}

	async getRepositoryItems(org: string, repo: string, path: string): Promise<GithubRepositoryItem[]> {
		const paths: GithubRepositoryItem[] = [];
		try {
			const authToken = this._authenticationService.permissiveGitHubSession?.accessToken;
			const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
			const response = await makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, 'https://api.github.com', `repos/${org}/${repo}/contents/${encodedPath}`, 'GET', authToken);

			if (!response) {
				this._logService.error(`Failed to fetch contents from ${org}:${repo}:${path}`);
				return [];
			}

			// Response should be an array of repository items
			const validation = vArray(vRepositoryItem()).validate(response);
			if (validation.error) {
				this._logService.error(`[GithubRepositoryService] Failed to validate repository items response: ${validation.error.message}`);
				return [];
			}

			for (const child of validation.content) {
				paths.push({ name: child.name, path: child.path, type: child.type as any, html_url: child.html_url });
				if (child.type === 'dir') {
					paths.push(...await this.getRepositoryItems(org, repo, child.path));
				}
			}
		} catch (e) {
			this._logService.error(`Failed to fetch contents from ${org}:${repo}:${path}: ${e}`);
			return [];
		}
		return paths;
	}

	async getRepositoryItemContent(org: string, repo: string, path: string): Promise<Uint8Array | undefined> {
		try {
			const authToken = this._authenticationService.permissiveGitHubSession?.accessToken;
			const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
			const response = await makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, 'https://api.github.com', `repos/${org}/${repo}/contents/${encodedPath}`, 'GET', authToken);

			if (!response) {
				this._logService.error(`Failed to fetch contents from ${org}:${repo}:${path}`);
				return undefined;
			}

			const validation = vRepositoryContentItem().validate(response);
			if (validation.error) {
				this._logService.error(`[GithubRepositoryService] Failed to validate repository content response: ${validation.error.message}`);
				return undefined;
			}

			const content = Buffer.from(validation.content.content, 'base64');
			return new Uint8Array(content);
		} catch (e) {
			this._logService.error(`Failed to fetch contents from ${org}:${repo}:${path}: ${e}`);
			return undefined;
		}
	}
}
