/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { PullRequestSearchItem, SessionInfo } from './githubAPI';
import { BaseOctoKitService, IOctoKitService, IOctoKitUser, JobInfo, RemoteAgentJobPayload, RemoteAgentJobResponse } from './githubService';

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

	async getTeamMembership(teamId: number): Promise<any | undefined> {
		const session = (await this._authService.getAnyGitHubSession());
		const token = session?.accessToken;
		const username = session?.account.label;
		if (!token || !username) {
			return undefined;
		}
		return await this.getTeamMembershipWithToken(teamId, token, username);
	}

	async getCopilotPullRequestsForUser(owner: string, repo: string): Promise<PullRequestSearchItem[]> {
		const auth = (await this._authService.getAnyGitHubSession());
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
		const authToken = (await this._authService.getAnyGitHubSession())?.accessToken;
		if (!authToken) {
			return [];
		}
		const response = await this.getCopilotSessionsForPRWithToken(
			prId,
			authToken,
		);
		const { sessions } = response;
		return sessions;
	}

	async getSessionLogs(sessionId: string): Promise<string> {
		const authToken = (await this._authService.getAnyGitHubSession())?.accessToken;
		if (!authToken) {
			return '';
		}
		const response = await this.getSessionLogsWithToken(
			sessionId,
			authToken,
		);
		return response;
	}

	async getSessionInfo(sessionId: string): Promise<SessionInfo> {
		const authToken = (await this._authService.getAnyGitHubSession())?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		const response = await this.getSessionInfoWithToken(
			sessionId,
			authToken,
		);
		return response;
	}

	async postCopilotAgentJob(owner: string, name: string, apiVersion: string, payload: RemoteAgentJobPayload): Promise<RemoteAgentJobResponse> {
		const authToken = (await this._authService.getAnyGitHubSession())?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		return this.postCopilotAgentJobWithToken(owner, name, apiVersion, 'vscode-copilot-chat', payload, authToken);
	}

	async getJobByJobId(owner: string, repo: string, jobId: string, userAgent: string): Promise<JobInfo> {
		const authToken = (await this._authService.getAnyGitHubSession())?.accessToken;
		if (!authToken) {
			throw new Error('No authentication token available');
		}
		return this.getJobByJobIdWithToken(owner, repo, jobId, userAgent, authToken);
	}
}