/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { vSessionInfo, vPullRequestFile, vSessionsResponse, vFileContentResponse, vPullRequestStateResponse } from '../../common/githubAPIValidators';

describe('vSessionInfo', () => {
	it('should validate a valid SessionInfo object', () => {
		const validSession = {
			id: 'session-123',
			name: 'Test Session',
			user_id: 12345,
			agent_id: 67890,
			logs: 'Log content',
			logs_blob_id: 'blob-123',
			state: 'completed',
			owner_id: 11111,
			repo_id: 22222,
			resource_type: 'pull_request',
			resource_id: 33333,
			last_updated_at: '2024-01-01T00:00:00Z',
			created_at: '2024-01-01T00:00:00Z',
			completed_at: '2024-01-01T00:00:00Z',
			event_type: 'push',
			workflow_run_id: 44444,
			premium_requests: 5,
			error: null,
			resource_global_id: 'global-123',
		};

		const result = vSessionInfo.validate(validSession);
		expect(result.error).toBeUndefined();
		expect(result.content).toEqual(validSession);
	});

	it('should reject a SessionInfo object with missing required fields', () => {
		const invalidSession = {
			id: 'session-123',
			name: 'Test Session',
			// Missing required fields
		};

		const result = vSessionInfo.validate(invalidSession);
		expect(result.error).toBeDefined();
		expect(result.error?.message).toContain("Required field");
	});

	it('should reject a SessionInfo object with wrong types', () => {
		const invalidSession = {
			id: 'session-123',
			name: 'Test Session',
			user_id: '12345', // should be number
			agent_id: 67890,
			logs: 'Log content',
			logs_blob_id: 'blob-123',
			state: 'completed',
			owner_id: 11111,
			repo_id: 22222,
			resource_type: 'pull_request',
			resource_id: 33333,
			last_updated_at: '2024-01-01T00:00:00Z',
			created_at: '2024-01-01T00:00:00Z',
			completed_at: '2024-01-01T00:00:00Z',
			event_type: 'push',
			workflow_run_id: 44444,
			premium_requests: 5,
			error: null,
			resource_global_id: 'global-123',
		};

		const result = vSessionInfo.validate(invalidSession);
		expect(result.error).toBeDefined();
	});
});

describe('vPullRequestFile', () => {
	it('should validate a valid PullRequestFile object', () => {
		const validFile = {
			filename: 'test.ts',
			status: 'modified',
			additions: 10,
			deletions: 5,
			changes: 15,
			patch: '@@ -1,5 +1,5 @@',
		};

		const result = vPullRequestFile.validate(validFile);
		expect(result.error).toBeUndefined();
		expect(result.content).toEqual(validFile);
	});

	it('should validate a PullRequestFile without optional fields', () => {
		const validFile = {
			filename: 'test.ts',
			status: 'added',
			additions: 10,
			deletions: 0,
			changes: 10,
		};

		const result = vPullRequestFile.validate(validFile);
		expect(result.error).toBeUndefined();
		expect(result.content?.filename).toBe('test.ts');
	});

	it('should reject a PullRequestFile with missing required fields', () => {
		const invalidFile = {
			filename: 'test.ts',
			// Missing required fields
		};

		const result = vPullRequestFile.validate(invalidFile);
		expect(result.error).toBeDefined();
	});
});

describe('vSessionsResponse', () => {
	it('should validate a valid sessions response', () => {
		const validResponse = {
			sessions: [
				{
					id: 'session-123',
					name: 'Test Session',
					user_id: 12345,
					agent_id: 67890,
					logs: 'Log content',
					logs_blob_id: 'blob-123',
					state: 'completed',
					owner_id: 11111,
					repo_id: 22222,
					resource_type: 'pull_request',
					resource_id: 33333,
					last_updated_at: '2024-01-01T00:00:00Z',
					created_at: '2024-01-01T00:00:00Z',
					completed_at: '2024-01-01T00:00:00Z',
					event_type: 'push',
					workflow_run_id: 44444,
					premium_requests: 5,
					error: null,
					resource_global_id: 'global-123',
				},
			],
		};

		const result = vSessionsResponse.validate(validResponse);
		expect(result.error).toBeUndefined();
		expect(result.content?.sessions).toHaveLength(1);
	});

	it('should reject invalid sessions response', () => {
		const invalidResponse = {
			// Missing sessions array
		};

		const result = vSessionsResponse.validate(invalidResponse);
		expect(result.error).toBeDefined();
	});
});

describe('vFileContentResponse', () => {
	it('should validate a valid file content response', () => {
		const validResponse = {
			content: 'SGVsbG8gV29ybGQ=',
			encoding: 'base64',
		};

		const result = vFileContentResponse.validate(validResponse);
		expect(result.error).toBeUndefined();
		expect(result.content).toEqual(validResponse);
	});

	it('should reject file content response with missing fields', () => {
		const invalidResponse = {
			content: 'SGVsbG8gV29ybGQ=',
			// Missing encoding
		};

		const result = vFileContentResponse.validate(invalidResponse);
		expect(result.error).toBeDefined();
	});
});

describe('vPullRequestStateResponse', () => {
	it('should validate a valid pull request state response', () => {
		const validResponse = {
			state: 'closed',
		};

		const result = vPullRequestStateResponse.validate(validResponse);
		expect(result.error).toBeUndefined();
		expect(result.content?.state).toBe('closed');
	});

	it('should reject pull request state response without state field', () => {
		const invalidResponse = {};

		const result = vPullRequestStateResponse.validate(invalidResponse);
		expect(result.error).toBeDefined();
	});
});
