/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IValidator, vArray, vEnum, vNull, vNumber, vObj, vRequired, vString, vUnion } from '../../configuration/common/validator';
import { CustomAgentListItem, JobInfo, PullRequestFile } from './githubService';
import { SessionInfo } from './githubAPI';

// Validator for IOctoKitUser
export interface IOctoKitUser {
	login: string;
	name: string | null;
	avatar_url: string;
}

export const vOctoKitUser = (): IValidator<IOctoKitUser> => vObj({
	login: vRequired(vString()),
	name: vRequired(vUnion(vString(), vNull())), // Allow string or null
	avatar_url: vRequired(vString()),
});

// Validator for Actor (used in JobInfo and RemoteAgentJobResponse)
const vActor = () => vObj({
	id: vRequired(vNumber()),
	login: vRequired(vString()),
});

// Validator for JobInfo
export const vJobInfo = (): IValidator<JobInfo> => vObj({
	job_id: vRequired(vString()),
	session_id: vRequired(vString()),
	problem_statement: vRequired(vString()),
	content_filter_mode: vString(),
	status: vRequired(vString()),
	result: vString(),
	actor: vRequired(vActor()),
	created_at: vRequired(vString()),
	updated_at: vRequired(vString()),
	pull_request: vRequired(vObj({
		id: vRequired(vNumber()),
		number: vRequired(vNumber()),
	})),
	workflow_run: vObj({
		id: vRequired(vNumber()),
	}),
	error: vObj({
		message: vRequired(vString()),
	}),
	event_type: vString(),
	event_url: vString(),
	event_identifiers: vArray(vString()),
});

// Validator for RemoteAgentJobResponse
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

export const vRemoteAgentJobResponse = (): IValidator<RemoteAgentJobResponse> => vObj({
	job_id: vRequired(vString()),
	session_id: vRequired(vString()),
	actor: vRequired(vActor()),
	created_at: vRequired(vString()),
	updated_at: vRequired(vString()),
});

// Validator for ErrorResponseWithStatusCode
export interface ErrorResponseWithStatusCode {
	status: number;
}

export const vErrorResponseWithStatusCode = (): IValidator<ErrorResponseWithStatusCode> => vObj({
	status: vRequired(vNumber()),
});

// Validator for CustomAgentListItem
export const vCustomAgentListItem = (): IValidator<CustomAgentListItem> => vObj({
	name: vRequired(vString()),
	repo_owner_id: vRequired(vNumber()),
	repo_owner: vRequired(vString()),
	repo_id: vRequired(vNumber()),
	repo_name: vRequired(vString()),
	display_name: vRequired(vString()),
	description: vRequired(vString()),
	tools: vRequired(vArray(vString())),
	version: vRequired(vString()),
});

// Validator for GetCustomAgentsResponse
export interface GetCustomAgentsResponse {
	agents: CustomAgentListItem[];
}

export const vGetCustomAgentsResponse = (): IValidator<GetCustomAgentsResponse> => vObj({
	agents: vRequired(vArray(vCustomAgentListItem())),
});

// Validator for PullRequestFile
export const vPullRequestFile = (): IValidator<PullRequestFile> => vObj({
	filename: vRequired(vString()),
	status: vRequired(vEnum('added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged')),
	additions: vRequired(vNumber()),
	deletions: vRequired(vNumber()),
	changes: vRequired(vNumber()),
	patch: vString(),
	previous_filename: vString(),
});

// Validator for SessionInfo
export const vSessionInfo = (): IValidator<SessionInfo> => vObj({
	id: vRequired(vString()),
	name: vRequired(vString()),
	user_id: vRequired(vNumber()),
	agent_id: vRequired(vNumber()),
	logs: vRequired(vString()),
	logs_blob_id: vRequired(vString()),
	state: vRequired(vEnum('completed', 'in_progress', 'failed', 'queued')),
	owner_id: vRequired(vNumber()),
	repo_id: vRequired(vNumber()),
	resource_type: vRequired(vString()),
	resource_id: vRequired(vNumber()),
	last_updated_at: vRequired(vString()),
	created_at: vRequired(vString()),
	completed_at: vRequired(vString()),
	event_type: vRequired(vString()),
	workflow_run_id: vRequired(vNumber()),
	premium_requests: vRequired(vNumber()),
	error: vRequired(vUnion(vString(), vNull())), // Allow string or null
	resource_global_id: vRequired(vString()),
});

// Validator for sessions response wrapper
export interface SessionsResponse {
	sessions: SessionInfo[];
}

export const vSessionsResponse = (): IValidator<SessionsResponse> => vObj({
	sessions: vRequired(vArray(vSessionInfo())),
});

// Validator for file content response from GitHub API
export interface FileContentResponse {
	content: string;
	encoding: string;
}

export const vFileContentResponse = (): IValidator<FileContentResponse> => vObj({
	content: vRequired(vString()),
	encoding: vRequired(vString()),
});

// Validator for close pull request response
export interface ClosePullRequestResponse {
	state: string;
}

export const vClosePullRequestResponse = (): IValidator<ClosePullRequestResponse> => vObj({
	state: vRequired(vString()),
});

// Validator for repository item
export interface RepositoryItem {
	name: string;
	path: string;
	type: string;
	html_url: string;
}

export const vRepositoryItem = (): IValidator<RepositoryItem> => vObj({
	name: vRequired(vString()),
	path: vRequired(vString()),
	type: vRequired(vString()),
	html_url: vRequired(vString()),
});

// Validator for repository content response (file)
export interface RepositoryContentItem {
	content: string;
}

export const vRepositoryContentItem = (): IValidator<RepositoryContentItem> => vObj({
	content: vRequired(vString()),
});
