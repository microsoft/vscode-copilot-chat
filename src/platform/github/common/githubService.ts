/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { makeGitHubAPIRequest } from './githubAPI';
import type { Endpoints } from "@octokit/types";

export type IGetRepositoryInfoResponseData = Endpoints["GET /repos/{owner}/{repo}"]["response"]["data"];

export const IGithubRepositoryService = createServiceIdentifier<IGithubRepositoryService>('IGithubRepositoryService');
export const IOctoKitService = createServiceIdentifier<IOctoKitService>('IOctoKitService');

export const VSCodeTeamId = 1682102;

export type GithubRepositoryItem = {
	name: string;
	path: string;
	html_url: string;
	type: 'file' | 'dir';
};

export interface IGithubRepositoryService {

	_serviceBrand: undefined;

	/**
	 * Returns whether the given repository is available via GitHub APIs.
	 * @param org The GitHub organization
	 * @param repo The GitHub repository
	 */
	isAvailable(org: string, repo: string): Promise<boolean>;
	getRepositoryInfo(owner: string, repo: string): Promise<IGetRepositoryInfoResponseData>;
	getRepositoryItems(org: string, repo: string, path: string): Promise<GithubRepositoryItem[]>;
	getRepositoryItemContent(org: string, repo: string, path: string): Promise<Uint8Array | undefined>;
}

export interface IOctoKitUser {
	login: string;
	name: string | null;
	avatar_url: string;
}

export interface IOctoKitService {

	_serviceBrand: undefined;

	/**
	 * @returns The currently authenticated user or undefined if there isn't one
	 */
	getCurrentAuthedUser(): Promise<IOctoKitUser | undefined>;

	/**
	 * Queries for team membership of the currently authenticated user against the team id.
	 * @returns The team membership or undefined if the user is not a member of the team
	 */
	getTeamMembership(teamId: number): Promise<any | undefined>;
}

/**
 * The same as {@link OctoKitService} but doesn't require the AuthService.
 * This is because we want to call certain Octokit method inside the Authservice and must
 * avoid a circular dependency.
 * Note: Only OctoKitService is exposed on the accessor to avoid confusion.
 */
export class BaseOctoKitService {
	constructor(
		private readonly _capiClientService: ICAPIClientService,
		private readonly _fetcherService: IFetcherService,
		private readonly _logService: ILogService,
		private readonly _telemetryService: ITelemetryService
	) { }

	async getCurrentAuthedUserWithToken(token: string): Promise<IOctoKitUser | undefined> {
		return this._makeGHAPIRequest('user', 'GET', token);
	}

	async getTeamMembershipWithToken(teamId: number, token: string, username: string): Promise<any | undefined> {
		return this._makeGHAPIRequest(`teams/${teamId}/memberships/${username}`, 'GET', token);
	}

	protected async _makeGHAPIRequest(routeSlug: string, method: 'GET' | 'POST', token: string, body?: { [key: string]: any }) {
		return makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, routeSlug, method, token, body);
	}
}
