/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CCAModel, RemoteAgentJobPayload, RequestType } from '@vscode/copilot-api';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { AssignableActor, getAssignableActorsWithAssignableUsers, getAssignableActorsWithSuggestedActors, PullRequestComment, PullRequestSearchItem, SessionInfo } from './githubAPI';
import { BaseOctoKitService, CCAEnabledResult, CustomAgentDetails, CustomAgentListItem, CustomAgentListOptions, ErrorResponseWithStatusCode, IOctoKitService, IOctoKitUser, JobInfo, PermissiveAuthRequiredError, PullRequestFile, RemoteAgentJobResponse } from './githubService';

export class OctoKitService extends BaseOctoKitService implements IOctoKitService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@ITelemetryService telemetryService: ITelemetryService
	) {
		super(capiClientService, fetcherService, logService, telemetryService);
	}

	async getCurrentAuthedUser(): Promise<IOctoKitUser | undefined> {
		const authToken = (await this._authService.getGitHubSession('any', { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for getCurrentAuthedUser');
			return undefined;
		}
		return await this.getCurrentAuthedUserWithToken(authToken);
	}

	async getOpenPullRequestsForUser(owner: string, repo: string, authOptions: { createIfNone?: boolean }): Promise<PullRequestSearchItem[]> {
		const auth = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }));
		if (!auth?.accessToken) {
			this._logService.trace('No authentication token available for getOpenPullRequestsForUser');
			return [];
		}
		const response = await this.getOpenPullRequestForUserWithToken(
			owner,
			repo,
			auth.account.label,
			auth.accessToken
		);
		return response;
	}

	async getCopilotSessionsForPR(prId: string, authOptions: { createIfNone?: boolean }): Promise<SessionInfo[]> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getCopilotSessionsForPR');
				throw new PermissiveAuthRequiredError();
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotSessions, prId });
			if (!response.ok) {
				throw new Error(`Failed to fetch copilot sessions for PR ${prId}: ${response.statusText}`);
			}
			const data = await response.json() as { sessions?: SessionInfo[] };
			if (data && Array.isArray(data.sessions)) {
				return data.sessions;
			}
			throw new Error('Invalid response format');
		} catch (e) {
			this._logService.error(e);
			return [];
		}
	}

	async getSessionLogs(sessionId: string, authOptions: { createIfNone?: boolean }): Promise<string> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getSessionLogs');
				throw new PermissiveAuthRequiredError();
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotSessionLogs, sessionId });
			if (!response.ok) {
				throw new Error(`Failed to fetch session logs for session ${sessionId}: ${response.statusText}`);
			}
			return response.text();
		} catch (e) {
			this._logService.error(e);
			return '';
		}
	}

	async getSessionInfo(sessionId: string, authOptions: { createIfNone?: boolean }): Promise<SessionInfo | undefined> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getSessionInfo');
				throw new PermissiveAuthRequiredError();
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotSessionDetails, sessionId });
			if (!response.ok) {
				throw new Error(`Failed to fetch session info for session ${sessionId}: ${response.statusText}`);
			}
			const responseData = await response.text();
			if (typeof responseData === 'string') {
				return JSON.parse(responseData) as SessionInfo;
			}
			throw new Error('Invalid response format');
		} catch (e) {
			this._logService.error(e);
			return undefined;
		}
	}

	async postCopilotAgentJob(owner: string, name: string, apiVersion: string, payload: RemoteAgentJobPayload, authOptions: { createIfNone?: boolean }): Promise<RemoteAgentJobResponse | ErrorResponseWithStatusCode | undefined> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for postCopilotAgentJob');
				throw new PermissiveAuthRequiredError();
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'POST',
				body: JSON.stringify(payload),
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotAgentJob, owner, repo: name, apiVersion, payload });
			if (!response.ok) {
				return {
					status: response.status,
				};
			}
			return await response.json() as RemoteAgentJobResponse;
		} catch (e) {
			this._logService.error(e);
			return undefined;
		}
	}

	async getJobByJobId(owner: string, repo: string, jobId: string, userAgent: string, authOptions: { createIfNone?: boolean }): Promise<JobInfo | undefined> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getJobByJobId');
				throw new PermissiveAuthRequiredError();
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotAgentJob, owner, repo, jobId });
			if (!response.ok) {
				throw new Error(`Failed to fetch job info for job ${jobId}: ${response.statusText}`);
			}
			return await response.json() as JobInfo;
		} catch (e) {
			this._logService.error(e);
			return undefined;
		}
	}

	async getJobBySessionId(owner: string, repo: string, sessionId: string, userAgent: string, authOptions: { createIfNone?: boolean }): Promise<JobInfo | undefined> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getJobBySessionId');
				throw new PermissiveAuthRequiredError();
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotAgentJob, owner, repo, sessionId });
			if (!response.ok) {
				throw new Error(`Failed to fetch job info for session ${sessionId}: ${response.statusText}`);
			}
			return await response.json() as JobInfo;
		} catch (e) {
			this._logService.error(e);
			return undefined;
		}
	}

	async addPullRequestComment(pullRequestId: string, commentBody: string, authOptions: { createIfNone?: boolean }): Promise<PullRequestComment | null> {
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for addPullRequestComment');
			throw new PermissiveAuthRequiredError();
		}
		return this.addPullRequestCommentWithToken(pullRequestId, commentBody, authToken);
	}

	async getAllSessions(nwo: string | undefined, open: boolean, authOptions: { createIfNone?: boolean }): Promise<SessionInfo[]> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getAllSessions');
				throw new PermissiveAuthRequiredError();
			}
			return await this._capiClientService.makeRequest<SessionInfo[]>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotSessions, nwo, resourceState: open ? 'draft,open' : undefined });
		} catch (e) {
			this._logService.error(e);
			return [];
		}
	}

	async getPullRequestFromGlobalId(globalId: string, authOptions: { createIfNone?: boolean }): Promise<PullRequestSearchItem | null> {
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for getPullRequestFromGlobalId');
			throw new PermissiveAuthRequiredError();
		}
		return this.getPullRequestFromSessionWithToken(globalId, authToken);
	}

	async getCustomAgents(owner: string, repo: string, options: CustomAgentListOptions, authOptions: { createIfNone?: boolean }): Promise<CustomAgentListItem[]> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getCustomAgents');
				throw new PermissiveAuthRequiredError();
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, {
				type: RequestType.CopilotCustomAgents,
				owner,
				repo,
				target: options?.target,
				exclude_invalid_config: options?.excludeInvalidConfig,
				dedupe: options?.dedupe,
				include_sources: options?.includeSources
			});
			if (!response.ok) {
				throw new Error(`Failed to fetch custom agents for ${owner} ${repo}: ${response.statusText}`);
			}
			const data = await response.json() as {
				agents?: CustomAgentListItem[];
			};
			if (data && Array.isArray(data.agents)) {
				return data.agents;
			}
			throw new Error('Invalid response format');
		} catch (e) {
			this._logService.error(e);
			return [];
		}
	}

	async getCustomAgentDetails(owner: string, repo: string, agentName: string, version: string, authOptions: { createIfNone?: boolean }): Promise<CustomAgentDetails | undefined> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getCustomAgentDetails');
				throw new PermissiveAuthRequiredError();
			}

			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotCustomAgentsDetail, owner, repo, version, customAgentName: agentName });

			if (!response.ok) {
				if (response.status === 404) {
					this._logService.trace(`Custom agent '${agentName}' not found for ${owner}/${repo}`);
					return undefined;
				}
				throw new Error(`Failed to fetch custom agent details for ${agentName}: ${response.statusText}`);
			}

			const data = await response.json() as CustomAgentDetails;
			return data;
		} catch (e) {
			this._logService.error(e);
			return undefined;
		}
	}

	async getPullRequestFiles(owner: string, repo: string, pullNumber: number, authOptions: { createIfNone?: boolean }): Promise<PullRequestFile[]> {
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for getPullRequestFiles');
			return [];
		}
		return this.getPullRequestFilesWithToken(owner, repo, pullNumber, authToken);
	}

	async closePullRequest(owner: string, repo: string, pullNumber: number, authOptions: { createIfNone?: boolean }): Promise<boolean> {
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for closePullRequest');
			return false;
		}
		return this.closePullRequestWithToken(owner, repo, pullNumber, authToken);
	}

	async getFileContent(owner: string, repo: string, ref: string, path: string, authOptions: { createIfNone?: boolean }): Promise<string> {
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for getFileContent');
			throw new PermissiveAuthRequiredError();
		}
		return this.getFileContentWithToken(owner, repo, ref, path, authToken);
	}

	async getUserOrganizations(authOptions: { createIfNone?: boolean }): Promise<string[]> {
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for getUserOrganizations');
			throw new PermissiveAuthRequiredError();
		}
		return this.getUserOrganizationsWithToken(authToken);
	}

	async getOrganizationRepositories(org: string, authOptions: { createIfNone?: boolean }): Promise<string[]> {
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for getOrganizationRepositories');
			throw new PermissiveAuthRequiredError();
		}
		return this.getOrganizationRepositoriesWithToken(org, authToken);
	}

	async getOrgCustomInstructions(orgLogin: string, authOptions: { createIfNone?: boolean }): Promise<string | undefined> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, {
				type: RequestType.OrgCustomInstructions,
				orgLogin
			});
			if (!response.ok) {
				throw new Error(`Failed to fetch custom instructions for org ${orgLogin}: ${response.statusText}`);
			}
			const data = await response.json() as { prompt: string };
			return data.prompt;
		} catch (e) {
			this._logService.error(e);
			return undefined;
		}
	}

	async getUserRepositories(authOptions: { createIfNone?: boolean }, query?: string): Promise<{ owner: string; name: string }[]> {
		// Use 'permissive' auth to ensure we have the 'repo' scope needed to list private repositories
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for getUserRepositories');
			throw new PermissiveAuthRequiredError();
		}
		return this.getUserRepositoriesWithToken(authToken, query);
	}

	async getRecentlyCommittedRepositories(authOptions: { createIfNone?: boolean }): Promise<{ owner: string; name: string }[]> {
		// Use 'permissive' auth to ensure we have access to private repository events
		const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
		if (!authToken) {
			this._logService.trace('No authentication token available for getRecentlyCommittedRepositories');
			throw new PermissiveAuthRequiredError();
		}
		return this.getRecentlyCommittedReposWithToken(authToken);
	}

	async getCopilotAgentModels(authOptions: { createIfNone?: boolean }): Promise<CCAModel[]> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for getCopilotAgentModels');
				throw new PermissiveAuthRequiredError();
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CCAModelsList });
			if (!response.ok) {
				this._logService.trace(`Failed to fetch Copilot agent models: ${response.statusText}`);
				return [];
			}
			const data = await response.json() as { data?: CCAModel[] };
			if (data && Array.isArray(data.data)) {
				return data.data;
			}
			return [];
		} catch (e) {
			this._logService.error(e);
			return [];
		}
	}

	async getAssignableActors(owner: string, repo: string, authOptions: { createIfNone?: boolean }): Promise<AssignableActor[]> {
		const auth = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }));
		if (!auth?.accessToken) {
			this._logService.trace('No authentication token available for getAssignableActors');
			throw new PermissiveAuthRequiredError();
		}

		try {
			// Try suggestedActors first (preferred API)
			const actors = await getAssignableActorsWithSuggestedActors(
				this._fetcherService,
				this._logService,
				this._telemetryService,
				this._capiClientService.dotcomAPIURL,
				auth.accessToken,
				owner,
				repo
			);

			if (actors.length > 0) {
				return actors;
			}

			// Fall back to assignableUsers for older GitHub Enterprise Server instances
			this._logService.trace('Falling back to assignableUsers API');
			return await getAssignableActorsWithAssignableUsers(
				this._fetcherService,
				this._logService,
				this._telemetryService,
				this._capiClientService.dotcomAPIURL,
				auth.accessToken,
				owner,
				repo
			);
		} catch (e) {
			this._logService.error(`Error fetching assignable actors: ${e}`);
			return [];
		}
	}

	async isCCAEnabled(owner: string, repo: string, authOptions: { createIfNone?: boolean }): Promise<CCAEnabledResult> {
		try {
			const authToken = (await this._authService.getGitHubSession('permissive', authOptions.createIfNone ? { createIfNone: true } : { silent: true }))?.accessToken;
			if (!authToken) {
				this._logService.trace('No authentication token available for isCCAEnabled');
				return { enabled: undefined };
			}
			const response = await this._capiClientService.makeRequest<Response>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotAgentJobEnabled, owner, repo });

			if (response.ok) {
				// 200 - OK - CCA is enabled and repository rules pass
				return { enabled: true };
			}

			switch (response.status) {
				case 401:
					// 401 - Unauthorized - Unauthenticated request
					return { enabled: false, statusCode: 401 };
				case 403:
					// 403 - Forbidden - CCA disabled
					return { enabled: false, statusCode: 403 };
				case 422:
					// 422 - Unprocessable entity - Repository rules violation
					return { enabled: false, statusCode: 422 };
				default:
					this._logService.trace(`Unexpected status code for isCCAEnabled: ${response.status}`);
					return { enabled: undefined };
			}
		} catch (e) {
			this._logService.error(`Error checking if CCA is enabled: ${e}`);
			return { enabled: undefined };
		}
	}
}
