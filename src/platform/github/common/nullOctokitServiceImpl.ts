/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { BaseOctoKitService, CCAEnabledResult, CustomAgentDetails, CustomAgentListItem, CustomAgentListOptions, ErrorResponseWithStatusCode, IOctoKitService, IOctoKitUser, JobInfo, PullRequestFile, RemoteAgentJobResponse } from './githubService';
import { AssignableActor, PullRequestComment, PullRequestSearchItem, SessionInfo } from './githubAPI';
import { CCAModel, RemoteAgentJobPayload } from '@vscode/copilot-api';

type AuthOptions = { createIfNone?: boolean };

export class NullBaseOctoKitService extends BaseOctoKitService implements IOctoKitService {

	declare readonly _serviceBrand: undefined;

	override async getCurrentAuthedUserWithToken(token: string): Promise<IOctoKitUser | undefined> {
		return { avatar_url: '', login: 'NullUser', name: 'Null User' };
	}

	override async getTeamMembershipWithToken(teamId: number, token: string, username: string): Promise<any | undefined> {
		return undefined;
	}

	override async _makeGHAPIRequest(routeSlug: string, method: 'GET' | 'POST', token: string, body?: { [key: string]: any }) {
		return undefined;
	}

	async getCurrentAuthedUser(): Promise<IOctoKitUser | undefined> {
		return undefined;
	}

	async getOpenPullRequestsForUser(owner: string, repo: string, authOptions: AuthOptions): Promise<PullRequestSearchItem[]> {
		return [];
	}

	async getCopilotSessionsForPR(prId: string, authOptions: AuthOptions): Promise<SessionInfo[]> {
		return [];
	}

	async getSessionLogs(sessionId: string, authOptions: AuthOptions): Promise<string> {
		return '';
	}

	async getSessionInfo(sessionId: string, authOptions: AuthOptions): Promise<SessionInfo | undefined> {
		return undefined;
	}

	async postCopilotAgentJob(owner: string, name: string, apiVersion: string, payload: RemoteAgentJobPayload, authOptions: AuthOptions): Promise<RemoteAgentJobResponse | ErrorResponseWithStatusCode | undefined> {
		return undefined;
	}

	async getJobByJobId(owner: string, repo: string, jobId: string, userAgent: string, authOptions: AuthOptions): Promise<JobInfo | undefined> {
		return undefined;
	}

	async getJobBySessionId(owner: string, repo: string, sessionId: string, userAgent: string, authOptions: AuthOptions): Promise<JobInfo | undefined> {
		return undefined;
	}

	async addPullRequestComment(pullRequestId: string, commentBody: string, authOptions: AuthOptions): Promise<PullRequestComment | null> {
		return null;
	}

	async getAllSessions(nwo: string | undefined, open: boolean, authOptions: AuthOptions): Promise<SessionInfo[]> {
		return [];
	}

	async getPullRequestFromGlobalId(globalId: string, authOptions: AuthOptions): Promise<PullRequestSearchItem | null> {
		return null;
	}

	async getCustomAgents(owner: string, repo: string, options: CustomAgentListOptions, authOptions: AuthOptions): Promise<CustomAgentListItem[]> {
		return [];
	}

	async getCustomAgentDetails(owner: string, repo: string, agentName: string, version: string, authOptions: AuthOptions): Promise<CustomAgentDetails | undefined> {
		return undefined;
	}

	async getPullRequestFiles(owner: string, repo: string, pullNumber: number, authOptions: AuthOptions): Promise<PullRequestFile[]> {
		return [];
	}

	async closePullRequest(owner: string, repo: string, pullNumber: number, authOptions: AuthOptions): Promise<boolean> {
		return false;
	}

	async getFileContent(owner: string, repo: string, ref: string, path: string, authOptions: AuthOptions): Promise<string> {
		return '';
	}

	async getUserOrganizations(authOptions: AuthOptions, pageSize?: number): Promise<string[]> {
		return [];
	}

	async isUserMemberOfOrg(org: string, authOptions: AuthOptions): Promise<boolean> {
		return false;
	}

	async getOrganizationRepositories(org: string, authOptions: AuthOptions, pageSize?: number): Promise<string[]> {
		return [];
	}

	async getOrgCustomInstructions(orgLogin: string, authOptions: AuthOptions): Promise<string | undefined> {
		return undefined;
	}

	async getUserRepositories(authOptions: AuthOptions, query?: string): Promise<{ owner: string; name: string }[]> {
		return [];
	}

	async getRecentlyCommittedRepositories(authOptions: AuthOptions): Promise<{ owner: string; name: string }[]> {
		return [];
	}

	async getCopilotAgentModels(authOptions: AuthOptions): Promise<CCAModel[]> {
		return [];
	}

	async getAssignableActors(owner: string, repo: string, authOptions: AuthOptions): Promise<AssignableActor[]> {
		return [];
	}

	async isCCAEnabled(owner: string, repo: string, authOptions: AuthOptions): Promise<CCAEnabledResult> {
		return { enabled: undefined };
	}

}
