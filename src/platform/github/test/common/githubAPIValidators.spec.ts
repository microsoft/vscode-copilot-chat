/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { vSessionInfo, vPullRequestFile, vSessionsResponse, vFileContentResponse, vPullRequestStateResponse, vIOctoKitUser, vRemoteAgentJobResponse, vCustomAgentListItem, vGetCustomAgentsResponse, vJobInfo } from '../../common/githubAPIValidators';

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

describe('vIOctoKitUser', () => {
	it('should validate a valid IOctoKitUser object', () => {
		const validUser = {
			login: 'testuser',
			name: 'Test User',
			avatar_url: 'https://example.com/avatar.png',
		};

		const result = vIOctoKitUser.validate(validUser);
		expect(result.error).toBeUndefined();
		expect(result.content).toEqual(validUser);
	});

	it('should validate IOctoKitUser with null name', () => {
		const validUser = {
			login: 'testuser',
			name: null,
			avatar_url: 'https://example.com/avatar.png',
		};

		const result = vIOctoKitUser.validate(validUser);
		expect(result.error).toBeUndefined();
		expect(result.content?.name).toBeNull();
	});
});

describe('vRemoteAgentJobResponse', () => {
	it('should validate a valid RemoteAgentJobResponse object', () => {
		const validResponse = {
			job_id: 'job-123',
			session_id: 'session-456',
			actor: {
				id: 789,
				login: 'testactor',
			},
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
		};

		const result = vRemoteAgentJobResponse.validate(validResponse);
		expect(result.error).toBeUndefined();
		expect(result.content).toEqual(validResponse);
	});
});

describe('vCustomAgentListItem', () => {
	it('should validate a valid CustomAgentListItem object', () => {
		const validAgent = {
			name: 'test-agent',
			repo_owner_id: 123,
			repo_owner: 'testowner',
			repo_id: 456,
			repo_name: 'testrepo',
			display_name: 'Test Agent',
			description: 'A test agent',
			tools: ['tool1', 'tool2'],
			version: '1.0.0',
		};

		const result = vCustomAgentListItem.validate(validAgent);
		expect(result.error).toBeUndefined();
		expect(result.content).toEqual(validAgent);
	});
});

describe('vGetCustomAgentsResponse', () => {
	it('should validate a valid GetCustomAgentsResponse object', () => {
		const validResponse = {
			agents: [
				{
					name: 'test-agent',
					repo_owner_id: 123,
					repo_owner: 'testowner',
					repo_id: 456,
					repo_name: 'testrepo',
					display_name: 'Test Agent',
					description: 'A test agent',
					tools: ['tool1', 'tool2'],
					version: '1.0.0',
				},
			],
		};

		const result = vGetCustomAgentsResponse.validate(validResponse);
		expect(result.error).toBeUndefined();
		expect(result.content?.agents).toHaveLength(1);
	});
});

describe('vJobInfo', () => {
	it('should validate a valid JobInfo object', () => {
		const validJob = {
			job_id: 'job-123',
			session_id: 'session-456',
			problem_statement: 'Fix the bug',
			status: 'completed',
			actor: {
				id: 789,
				login: 'testactor',
			},
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			pull_request: {
				id: 111,
				number: 222,
			},
		};

		const result = vJobInfo.validate(validJob);
		expect(result.error).toBeUndefined();
		expect(result.content).toEqual(validJob);
	});

	it('should validate JobInfo with optional fields', () => {
		const validJob = {
			job_id: 'job-123',
			session_id: 'session-456',
			problem_statement: 'Fix the bug',
			content_filter_mode: 'strict',
			status: 'completed',
			result: 'Success',
			actor: {
				id: 789,
				login: 'testactor',
			},
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			pull_request: {
				id: 111,
				number: 222,
			},
			workflow_run: {
				id: 333,
			},
			error: {
				message: 'Some error',
			},
			event_type: 'push',
			event_url: 'https://example.com/event',
			event_identifiers: ['id1', 'id2'],
		};

		const result = vJobInfo.validate(validJob);
		expect(result.error).toBeUndefined();
		expect(result.content?.content_filter_mode).toBe('strict');
	});
});
