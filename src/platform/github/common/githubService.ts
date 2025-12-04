/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Endpoints } from "@octokit/types";
import { createServiceIdentifier } from '../../../util/common/services';
import { decodeBase64 } from '../../../util/vs/base/common/buffer';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { addPullRequestCommentGraphQLRequest, closePullRequest, getPullRequestFromGlobalId, makeGitHubAPIRequest, makeSearchGraphQLRequest, PullRequestComment, PullRequestSearchItem, SessionInfo } from './githubAPI';

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

export interface ErrorResponseWithStatusCode {
	status: number;
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
	custom_agent?: string;
}

export interface CustomAgentListItem {
	name: string;
	repo_owner_id: number;
	repo_owner: string;
	repo_id: number;
	repo_name: string;
	display_name: string;
	description: string;
	tools: string[];
	version: string;
	argument_hint?: string;
	metadata?: Record<string, string>;
	target?: string;
	config_error?: string;
	'mcp-servers'?: {
		[serverName: string]: {
			type: string;
			command?: string;
			args?: string[];
			tools?: string[];
			env?: { [key: string]: string };
			headers?: { [key: string]: string };
		};
	};
}

export interface CustomAgentListOptions {
	target?: 'github-copilot' | 'vscode';
	excludeInvalidConfig?: boolean;
	dedupe?: boolean;
	includeSources?: ('repo' | 'org' | 'enterprise')[];
}

export interface CustomAgentListOptions {
	target?: 'github-copilot' | 'vscode';
	excludeInvalidConfig?: boolean;
	dedupe?: boolean;
	includeSources?: ('repo' | 'org' | 'enterprise')[];
}

export interface CustomAgentDetails extends CustomAgentListItem {
	prompt: string;
}

export interface PullRequestFile {
	filename: string;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
	previous_filename?: string;
	sha?: string;
}

interface GitHubContentResponse {
	content?: string;
	encoding?: string;
	sha?: string;
}

interface GitHubBlobResponse {
	content: string;
	encoding: string;
}

export interface IOctoKitService {

	_serviceBrand: undefined;

	/**
	 * @returns The currently authenticated user or undefined if there isn't one
	 */
	getCurrentAuthedUser(): Promise<IOctoKitUser | undefined>;

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
	getSessionInfo(sessionId: string): Promise<SessionInfo | undefined>;

	/**
	 * Posts a new Copilot agent job.
	 */
	postCopilotAgentJob(
		owner: string,
		name: string,
		apiVersion: string,
		payload: RemoteAgentJobPayload,
	): Promise<RemoteAgentJobResponse | ErrorResponseWithStatusCode | undefined>;

	/**
	 * Gets a job by its job ID.
	 */
	getJobByJobId(owner: string, repo: string, jobId: string, userAgent: string): Promise<JobInfo | undefined>;

	/**
	 * Gets a job by session ID
	 */
	getJobBySessionId(owner: string, repo: string, sessionId: string, userAgent: string): Promise<JobInfo | undefined>;

	/**
	 * Adds a comment to a pull request.
	 */
	addPullRequestComment(pullRequestId: string, commentBody: string): Promise<PullRequestComment | null>;

	/**
	 * Gets all open Copilot sessions.
	 */
	getAllOpenSessions(nwo?: string): Promise<SessionInfo[]>;

	/**
	 * Gets pull request from global id.
	 */
	getPullRequestFromGlobalId(globalId: string): Promise<PullRequestSearchItem | null>;

	/**
	 * Gets the list of custom agents available for a repository.
	 * This includes both repo-level and org/enterprise-level custom agents.
	 * @param owner The repository owner
	 * @param repo The repository name
	 * @param options Optional filtering options:
	 *   - targetPlatform: Only include agents for the specified platform.
	 *   - excludeInvalidConfigs: Exclude agents with invalid configurations.
	 *   - deduplicate: Remove duplicate agents from the result.
	 *   - source: Filter agents by their source (repo, org, enterprise).
	 * @returns An array of custom agent list items with basic metadata
	 */
	getCustomAgents(owner: string, repo: string, options?: CustomAgentListOptions): Promise<CustomAgentListItem[]>;

	/**
	 * Gets the full configuration for a specific custom agent.
	 * @param owner The repository owner
	 * @param repo The repository name
	 * @param agentName The name of the custom agent
	 * @param version Optional git ref (branch, tag, or commit SHA) to fetch from
	 * @returns The complete custom agent configuration including the prompt
	 */
	getCustomAgentDetails(owner: string, repo: string, agentName: string, version?: string): Promise<CustomAgentDetails | undefined>;

	/**
	 * Gets the list of files changed in a pull request.
	 * @param owner The repository owner
	 * @param repo The repository name
	 * @param pullNumber The pull request number
	 * @returns An array of changed files with their metadata
	 */
	getPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFile[]>;

	/**
	 * Closes a pull request.
	 * @param owner The repository owner
	 * @param repo The repository name
	 * @param pullNumber The pull request number
	 * @returns A promise that resolves to true if the PR was successfully closed
	 */
	closePullRequest(owner: string, repo: string, pullNumber: number): Promise<boolean>;

	/**
	 * Get file content from a specific commit.
	 * @param owner The repository owner
	 * @param repo The repository name
	 * @param ref The commit SHA, branch name, or tag
	 * @param path The file path within the repository
	 * @returns The file content as a string
	 */
	getFileContent(owner: string, repo: string, ref: string, path: string): Promise<string>;

	/**
	 * Gets the list of organizations that the authenticated user belongs to.
	 * @returns An array of organization logins
	 */
	getUserOrganizations(): Promise<string[]>;

	/**
	 * Gets the list of repositories for an organization.
	 * @param org The organization name
	 * @returns An array of repository names
	 */
	getOrganizationRepositories(org: string): Promise<string[]>;
}

/**
 * The same as {@link OctoKitService} but doesn't require the AuthService.
 * This is because we want to call certain Octokit method inside the Authservice and must
 * avoid a circular dependency.
 * Note: Only OctoKitService is exposed on the accessor to avoid confusion.
 */
export class BaseOctoKitService {
	constructor(
		protected readonly _capiClientService: ICAPIClientService,
		private readonly _fetcherService: IFetcherService,
		protected readonly _logService: ILogService,
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

	protected async addPullRequestCommentWithToken(pullRequestId: string, commentBody: string, token: string): Promise<PullRequestComment | null> {
		return addPullRequestCommentGraphQLRequest(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, token, pullRequestId, commentBody);
	}

	protected async getPullRequestFromSessionWithToken(globalId: string, token: string): Promise<PullRequestSearchItem | null> {
		return getPullRequestFromGlobalId(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, token, globalId);
	}

	protected async getPullRequestFilesWithToken(owner: string, repo: string, pullNumber: number, token: string): Promise<PullRequestFile[]> {
		const result = await makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, `repos/${owner}/${repo}/pulls/${pullNumber}/files`, 'GET', token, undefined, '2022-11-28');
		return result || [];
	}

	protected async closePullRequestWithToken(owner: string, repo: string, pullNumber: number, token: string): Promise<boolean> {
		return closePullRequest(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, token, owner, repo, pullNumber);
	}

	protected async getFileContentWithToken(owner: string, repo: string, ref: string, path: string, token: string): Promise<string> {
		const route = `repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
		const response = await makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, route, 'GET', token, undefined);

		if (!response || Array.isArray(response)) {
			throw new Error('Unable to fetch file content');
		}

		const typedResponse = response as GitHubContentResponse;

		if (typedResponse.content && typedResponse.encoding === 'base64') {
			return decodeBase64(typedResponse.content.replace(/\n/g, '')).toString();
		}

		if (typedResponse.sha) {
			const blob = await this.getBlobContentWithToken(owner, repo, typedResponse.sha, token);
			if (blob) {
				return blob;
			}
		}

		this._logService.error(`Failed to get file content for ${owner}/${repo}/${path} at ref ${ref}`);
		return '';
	}

	protected async getUserOrganizationsWithToken(token: string): Promise<string[]> {
		const result = await this._makeGHAPIRequest('user/orgs', 'GET', token);
		if (!result || !Array.isArray(result)) {
			return [];
		}
		return result.map((org: { login: string }) => org.login);
	}

	protected async getOrganizationRepositoriesWithToken(org: string, token: string): Promise<string[]> {
		const result = await this._makeGHAPIRequest(`orgs/${org}/repos?per_page=5&sort=updated`, 'GET', token);
		if (!result || !Array.isArray(result) || result.length === 0) {
			return [];
		}
		return result.map((repo: { name: string }) => repo.name);
	}

	private async getBlobContentWithToken(owner: string, repo: string, sha: string, token: string): Promise<string | undefined> {
		const blobRoute = `repos/${owner}/${repo}/git/blobs/${sha}`;
		const blobResponse = await makeGitHubAPIRequest(this._fetcherService, this._logService, this._telemetryService, this._capiClientService.dotcomAPIURL, blobRoute, 'GET', token, undefined, '2022-11-28');

		if (!blobResponse || Array.isArray(blobResponse)) {
			return undefined;
		}

		const typedBlob = blobResponse as GitHubBlobResponse;
		if (typedBlob.content && typedBlob.encoding === 'base64') {
			return decodeBase64(typedBlob.content.replace(/\n/g, '')).toString();
		}

		return undefined;
	}
}
