/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { PullRequestComment, PullRequestSearchItem, SessionInfo } from './githubAPI';
import { BaseOctoKitService, CustomAgentListItem, ErrorResponseWithStatusCode, IOctoKitService, IOctoKitUser, JobInfo, PullRequestFile, RemoteAgentJobPayload, RemoteAgentJobResponse } from './githubService';

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
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			return [];
		}
		const response = await this.getCopilotSessionsForPRWithToken(
			prId,
			authToken,
		);
		if (!response) {
			return [];
		}
		const sessionsResponse = response as { sessions: SessionInfo[] };
		return sessionsResponse.sessions;
	}

	async getSessionLogs(sessionId: string): Promise<string> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			return '';
		}
		const response = await this.getSessionLogsWithToken(
			sessionId,
			authToken,
		);
		if (!response) {
			return '';
		}
		return response as string;
	}

	async getSessionInfo(sessionId: string): Promise<SessionInfo> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		const response = await this.getSessionInfoWithToken(
			sessionId,
			authToken,
		);
		if (!response) {
			throw new Error('No session info response received');
		}

		// The response might be a string (JSON) or already parsed
		let parsedResponse: SessionInfo = response as SessionInfo;
		if (typeof response === 'string') {
			try {
				parsedResponse = JSON.parse(response) as SessionInfo;
			} catch (e) {
				throw new Error('Failed to parse session info response');
			}
		}

		return parsedResponse;
	}

	async postCopilotAgentJob(owner: string, name: string, apiVersion: string, payload: RemoteAgentJobPayload): Promise<RemoteAgentJobResponse | ErrorResponseWithStatusCode> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		const response = await this.postCopilotAgentJobWithToken(owner, name, apiVersion, 'vscode-copilot-chat', payload, authToken);
		if (!response) {
			throw new Error('No response received from post copilot agent job');
		}

		return response as RemoteAgentJobResponse | ErrorResponseWithStatusCode;
	}

	async getJobByJobId(owner: string, repo: string, jobId: string, userAgent: string): Promise<JobInfo> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		return this.getJobByJobIdWithToken(owner, repo, jobId, userAgent, authToken);
	}

	async getJobBySessionId(owner: string, repo: string, sessionId: string, userAgent: string): Promise<JobInfo> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		return this.getJobBySessionIdWithToken(owner, repo, sessionId, userAgent, authToken);
	}

	async addPullRequestComment(pullRequestId: string, commentBody: string): Promise<PullRequestComment | null> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		return this.addPullRequestCommentWithToken(pullRequestId, commentBody, authToken);
	}

	async getAllOpenSessions(nwo: string): Promise<SessionInfo[]> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			return [];
		}
		return this.getAllOpenSessionsWithToken(nwo, authToken);
	}

	async getPullRequestFromGlobalId(globalId: string): Promise<PullRequestSearchItem | null> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		return this.getPullRequestFromSessionWithToken(globalId, authToken);
	}

	async getCustomAgents(owner: string, repo: string): Promise<CustomAgentListItem[]> {
		const authToken = (await this._authService.getPermissiveGitHubSession({ createIfNone: true }))?.accessToken;
		if (!authToken) {
			return [];
		}
		const { agents } = await this.getCustomAgentsWithToken(owner, repo, authToken);
		if (!Array.isArray(agents)) {
			return [];
		}
		return agents;
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
}