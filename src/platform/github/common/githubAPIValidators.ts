/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IValidator, vArray, vNumber, vObj, vRequired, vString, vUnion, vUnchecked } from '../../configuration/common/validator';
import type { SessionInfo, PullRequestFile } from './githubAPI';

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
