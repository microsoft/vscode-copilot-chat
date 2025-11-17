/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IValidator, vArray, vNumber, vObj, vString } from '../../configuration/common/validator';
import { CustomAgentListItem, JobInfo } from './githubService';

// Validator for Actor (used in JobInfo)
const vActor = () => vObj({
	id: vNumber(),
	login: vString(),
});

// Validator for JobInfo
export const vJobInfo = (): IValidator<JobInfo> => vObj({
	job_id: vString(),
	session_id: vString(),
	problem_statement: vString(),
	content_filter_mode: vString(),
	status: vString(),
	result: vString(),
	actor: vActor(),
	created_at: vString(),
	updated_at: vString(),
	pull_request: vObj({
		id: vNumber(),
		number: vNumber(),
	}),
	workflow_run: vObj({
		id: vNumber(),
	}),
	error: vObj({
		message: vString(),
	}),
	event_type: vString(),
	event_url: vString(),
	event_identifiers: vArray(vString()),
});

// Validator for CustomAgentListItem
export const vCustomAgentListItem = (): IValidator<CustomAgentListItem> => vObj({
	name: vString(),
	repo_owner_id: vNumber(),
	repo_owner: vString(),
	repo_id: vNumber(),
	repo_name: vString(),
	display_name: vString(),
	description: vString(),
	tools: vArray(vString()),
	version: vString(),
});

// Validator for GetCustomAgentsResponse
export interface GetCustomAgentsResponse {
	agents: CustomAgentListItem[];
}

export const vGetCustomAgentsResponse = (): IValidator<GetCustomAgentsResponse> => vObj({
	agents: vArray(vCustomAgentListItem()),
});
