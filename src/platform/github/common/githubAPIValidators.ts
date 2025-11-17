/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IValidator, vArray, vNumber, vObj, vRequired, vString } from '../../configuration/common/validator';
import { CustomAgentListItem, JobInfo } from './githubService';

// Validator for Actor (used in JobInfo)
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
