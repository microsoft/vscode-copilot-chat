/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IValidator, vArray, vNumber, vObj, vRequired, vString, vUnion, vUnchecked } from '../../configuration/common/validator';
import type { SessionInfo, PullRequestFile } from './githubAPI';
import type { IOctoKitUser, RemoteAgentJobResponse, CustomAgentListItem, ErrorResponseWithStatusCode, JobInfo } from './githubService';

// Validator for SessionInfo
export const vSessionInfo: IValidator<SessionInfo> = vObj({
	id: vRequired(vString()),
	name: vRequired(vString()),
	user_id: vRequired(vNumber()),
	agent_id: vRequired(vNumber()),
	logs: vRequired(vString()),
	logs_blob_id: vRequired(vString()),
	state: vRequired(vString()),
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
	error: vUnion(vString(), vUnchecked<null>()),
	resource_global_id: vRequired(vString()),
});

// Validator for PullRequestFile
export const vPullRequestFile: IValidator<PullRequestFile> = vObj({
	filename: vRequired(vString()),
	status: vRequired(vString()),
	additions: vRequired(vNumber()),
	deletions: vRequired(vNumber()),
	changes: vRequired(vNumber()),
	patch: vString(),
	previous_filename: vString(),
});

// Validator for sessions response with pagination
export const vSessionsResponse = vObj({
	sessions: vRequired(vArray(vSessionInfo)),
});

// Validator for file content response
export const vFileContentResponse = vObj({
	content: vRequired(vString()),
	encoding: vRequired(vString()),
});

// Validator for pull request state response
export const vPullRequestStateResponse = vObj({
	state: vRequired(vString()),
});

// Validator for IOctoKitUser
export const vIOctoKitUser: IValidator<IOctoKitUser> = vObj({
	login: vRequired(vString()),
	name: vUnion(vString(), vUnchecked<null>()),
	avatar_url: vRequired(vString()),
});

// Validator for RemoteAgentJobResponse
export const vRemoteAgentJobResponse: IValidator<RemoteAgentJobResponse> = vObj({
	job_id: vRequired(vString()),
	session_id: vRequired(vString()),
	actor: vRequired(vObj({
		id: vRequired(vNumber()),
		login: vRequired(vString()),
	})),
	created_at: vRequired(vString()),
	updated_at: vRequired(vString()),
});

// Validator for CustomAgentListItem
export const vCustomAgentListItem: IValidator<CustomAgentListItem> = vObj({
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
export const vGetCustomAgentsResponse = vObj({
	agents: vRequired(vArray(vCustomAgentListItem)),
});

// Validator for ErrorResponseWithStatusCode
export const vErrorResponseWithStatusCode: IValidator<ErrorResponseWithStatusCode> = vObj({
	status: vRequired(vNumber()),
});

// Validator for job responses that could be either RemoteAgentJobResponse or ErrorResponseWithStatusCode
export const vRemoteAgentJobOrError = vUnion(vRemoteAgentJobResponse, vErrorResponseWithStatusCode);

// Validator for JobInfo
export const vJobInfo: IValidator<JobInfo> = vObj({
	job_id: vRequired(vString()),
	session_id: vRequired(vString()),
	problem_statement: vRequired(vString()),
	content_filter_mode: vString(),
	status: vRequired(vString()),
	result: vString(),
	actor: vRequired(vObj({
		id: vRequired(vNumber()),
		login: vRequired(vString()),
	})),
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
