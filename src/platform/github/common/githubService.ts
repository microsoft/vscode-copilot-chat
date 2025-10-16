/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Endpoints } from "@octokit/types";
import { createServiceIdentifier } from '../../../util/common/services';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { makeGitHubAPIRequest, makeSearchGraphQLRequest, PullRequestSearchItem, SessionInfo } from './githubAPI';

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

export interface JobInfo {
	job_id: string;
	session_id: string;
	problem_statement: string;
	content_filter_mode?: string;
	status: string;
	result?: string;
	actor: {
		id: number;
		login: string;
	};
	created_at: string;
	updated_at: string;
	pull_request: {
		id: number;
		number: number;
	};
	workflow_run?: {
		id: number;
	};
	error?: {
		message: string;
	};
	event_type?: string;
	event_url?: string;
	event_identifiers?: string[];
}

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

export interface IOctoKitSessionInfo {
	name: string;
	owner_id: number;
	premium_requests: number;
	repo_id: number;
	resource_global_id: string;
	resource_id: number;
	resource_state: string;
	resource_type: string;
	state: string;
	user_id: number;
	workflow_run_id: number;
	last_updated_at: string;
	created_at: string;
}

export interface IOctoKitPullRequestInfo {
	number: number;
	title: string;
	additions: number;
	deletions: number;
	headRepository: {
		name: string;
		owner: {
			login: string;
		};
		url: string;
	};
}

export interface RemoteAgentJobResponse {
	job_id: string;
	session_id: string;
	actor: {
		id: number;
		login: string;
	};
	created_at: string;
	updated_at: string;
}

export interface RemoteAgentJobPayload {
	problem_statement: string;
	event_type: string;
	pull_request?: {
		title?: string;
		body_placeholder?: string;
		body_suffix?: string;
		base_ref?: string;
		head_ref?: string;
	};
	run_name?: string;
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

	/**
	 * Returns the list of Copilot pull requests for a given user on a specific repo.
	 */
	getCopilotPullRequestsForUser(owner: string, repo: string): Promise<PullRequestSearchItem[]>;

	/**
	 * Returns the list of Copilot sessions for a given pull request.
	 */
	getCopilotSessionsForPR(prId: string): Promise<SessionInfo[]>;

	/**
	 * Returns the logs for a specific Copilot session.
	 */
	getSessionLogs(sessionId: string): Promise<string>;

	/**
	 * Returns the information for a specific Copilot session.
	 */
	getSessionInfo(sessionId: string): Promise<SessionInfo>;

	/**
	 * Posts a new Copilot agent job.
	 */
	postCopilotAgentJob(
		owner: string,
		name: string,
		apiVersion: string,
		payload: RemoteAgentJobPayload,
	): Promise<RemoteAgentJobResponse>;

	/**
	 * Gets a job by its job ID.
	 */
	getJobByJobId(owner: string, repo: string, jobId: string, userAgent: string): Promise<JobInfo>;
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
		return makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, routeSlug, method, token, body, '2022-11-28');
	}

	protected async getCopilotPullRequestForUserWithToken(owner: string, repo: string, user: string, token: string) {
		const query = `repo:${owner}/${repo} is:open author:copilot-swe-agent[bot] involves:${user}`;
		return makeSearchGraphQLRequest(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, token, query);
	}

	protected async getCopilotSessionsForPRWithToken(prId: string, token: string) {
		return makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, 'https://api.githubcopilot.com', `agents/sessions/resource/pull/${prId}`, 'GET', token);
	}

	protected async getSessionLogsWithToken(sessionId: string, token: string) {
		return makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, 'https://api.githubcopilot.com', `agents/sessions/${sessionId}/logs`, 'GET', token, undefined, undefined, 'text');
	}

	protected async getSessionInfoWithToken(sessionId: string, token: string) {
		return makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, 'https://api.githubcopilot.com', `agents/sessions/${sessionId}`, 'GET', token, undefined, undefined, 'text');
	}

	protected async postCopilotAgentJobWithToken(owner: string, name: string, apiVersion: string, userAgent: string, payload: RemoteAgentJobPayload, token: string): Promise<RemoteAgentJobResponse> {
		return makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, 'https://api.githubcopilot.com', `agents/swe/${apiVersion}/jobs/${owner}/${name}`, 'POST', token, payload, undefined, undefined, userAgent);
	}

	protected async getJobByJobIdWithToken(owner: string, repo: string, jobId: string, userAgent: string, token: string): Promise<JobInfo> {
		return makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, 'https://api.githubcopilot.com', `agents/swe/v1/jobs/${owner}/${repo}/${jobId}`, 'GET', token, undefined, undefined, undefined, userAgent);
	}
}
