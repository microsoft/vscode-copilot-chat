/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { RequestType } from '@vscode/copilot-api';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { PullRequestComment, PullRequestSearchItem, SessionInfo } from './githubAPI';
import { BaseOctoKitService, CustomAgentDetails, CustomAgentListItem, CustomAgentListOptions, ErrorResponseWithStatusCode, IOctoKitService, IOctoKitUser, JobInfo, PullRequestFile, RemoteAgentJobPayload, RemoteAgentJobResponse } from './githubService';

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
		const authToken = (await this._authService.getAnyGitHubSession())?.accessToken;
		if (!authToken) {
			return undefined;
		}
		return await this.getCurrentAuthedUserWithToken(authToken);
	}

	async getCopilotPullRequestsForUser(owner: string, repo: string): Promise<PullRequestSearchItem[]> {
		const auth = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }));
		if (!auth?.accessToken) {
			return [];
		}
		const response = await this.getCopilotPullRequestForUserWithToken(
			owner,
			repo,
			auth.account.label,
			auth.accessToken,
		);
		return response;
	}

	async getCopilotSessionsForPR(prId: string): Promise<SessionInfo[]> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
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

	async getSessionLogs(sessionId: string): Promise<string> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
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

	async getSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
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

	async postCopilotAgentJob(owner: string, name: string, apiVersion: string, payload: RemoteAgentJobPayload): Promise<RemoteAgentJobResponse | ErrorResponseWithStatusCode | undefined> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
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

	async getJobByJobId(owner: string, repo: string, jobId: string, userAgent: string): Promise<JobInfo | undefined> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
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

	async getJobBySessionId(owner: string, repo: string, sessionId: string, userAgent: string): Promise<JobInfo | undefined> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
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

	async addPullRequestComment(pullRequestId: string, commentBody: string): Promise<PullRequestComment | null> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		return this.addPullRequestCommentWithToken(pullRequestId, commentBody, authToken);
	}

	async getAllOpenSessions(nwo?: string): Promise<SessionInfo[]> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
			}
			return await this._capiClientService.makeRequest<SessionInfo[]>({
				method: 'GET',
				headers: {
					Authorization: `Bearer ${authToken}`,
				}
			}, { type: RequestType.CopilotSessions, nwo, resourceState: 'draft,open' });
		} catch (e) {
			this._logService.error(e);
			return [];
		}
	}

	async getPullRequestFromGlobalId(globalId: string): Promise<PullRequestSearchItem | null> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		return this.getPullRequestFromSessionWithToken(globalId, authToken);
	}

	async getCustomAgents(owner: string, repo: string, options?: CustomAgentListOptions): Promise<CustomAgentListItem[]> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
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

	async getCustomAgentDetails(owner: string, repo: string, agentName: string, version?: string): Promise<CustomAgentDetails | undefined> {
		try {
			const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
			if (!authToken) {
				throw new Error('No authentication token available');
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

	async getPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFile[]> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			return [];
		}
		return this.getPullRequestFilesWithToken(owner, repo, pullNumber, authToken);
	}

	async closePullRequest(owner: string, repo: string, pullNumber: number): Promise<boolean> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			return false;
		}
		return this.closePullRequestWithToken(owner, repo, pullNumber, authToken);
	}

	async getFileContent(owner: string, repo: string, ref: string, path: string): Promise<string> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No GitHub authentication available');
		}
		return this.getFileContentWithToken(owner, repo, ref, path, authToken);
	}

	async getUserOrganizations(): Promise<string[]> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			return [];
		}
		return this.getUserOrganizationsWithToken(authToken);
	}

	async getOrganizationRepositories(org: string): Promise<string[]> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			return [];
		}
		return this.getOrganizationRepositoriesWithToken(org, authToken);
	}
}