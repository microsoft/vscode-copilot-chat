/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	vClosePullRequestResponse,
	vCustomAgentListItem,
	vErrorResponseWithStatusCode,
	vFileContentResponse,
	vGetCustomAgentsResponse,
	vJobInfo,
	vOctoKitUser,
	vPullRequestFile,
	vRemoteAgentJobResponse,
	vRepositoryContentItem,
	vRepositoryItem,
	vSessionInfo,
	vSessionsResponse
} from '../../common/githubAPIValidators';

describe('GitHub API Validators', () => {
	describe('vOctoKitUser', () => {
		it('should validate a valid user', () => {
			const validUser = {
				login: 'testuser',
				name: 'Test User',
				avatar_url: 'https://example.com/avatar.png'
			};

			const result = vOctoKitUser().validate(validUser);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validUser);
		});

		it('should validate a user with null name', () => {
			const validUser = {
				login: 'testuser',
				name: null,
				avatar_url: 'https://example.com/avatar.png'
			};

			const result = vOctoKitUser().validate(validUser);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validUser);
		});

		it('should reject a user with missing login', () => {
			const invalidUser = {
				name: 'Test User',
				avatar_url: 'https://example.com/avatar.png'
			};

			const result = vOctoKitUser().validate(invalidUser);
			expect(result.error).toBeDefined();
			expect(result.error?.message).toContain("login");
		});
	});

	describe('vJobInfo', () => {
		it('should validate a valid job info', () => {
			const validJobInfo = {
				job_id: 'job-123',
				session_id: 'session-456',
				problem_statement: 'Fix the bug',
				status: 'completed',
				actor: {
					id: 123,
					login: 'testuser'
				},
				created_at: '2023-01-01T00:00:00Z',
				updated_at: '2023-01-02T00:00:00Z',
				pull_request: {
					id: 789,
					number: 42
				}
			};

			const result = vJobInfo().validate(validJobInfo);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validJobInfo);
		});

		it('should validate job info with optional fields', () => {
			const validJobInfo = {
				job_id: 'job-123',
				session_id: 'session-456',
				problem_statement: 'Fix the bug',
				content_filter_mode: 'strict',
				status: 'in_progress',
				result: 'pending',
				actor: {
					id: 123,
					login: 'testuser'
				},
				created_at: '2023-01-01T00:00:00Z',
				updated_at: '2023-01-02T00:00:00Z',
				pull_request: {
					id: 789,
					number: 42
				},
				workflow_run: {
					id: 999
				},
				error: {
					message: 'Something went wrong'
				},
				event_type: 'pull_request',
				event_url: 'https://example.com/event',
				event_identifiers: ['id1', 'id2']
			};

			const result = vJobInfo().validate(validJobInfo);
			expect(result.error).toBeUndefined();
		});

		it('should reject job info with missing required fields', () => {
			const invalidJobInfo = {
				job_id: 'job-123',
				// Missing session_id
				problem_statement: 'Fix the bug',
				status: 'completed'
			};

			const result = vJobInfo().validate(invalidJobInfo);
			expect(result.error).toBeDefined();
		});
	});

	describe('vRemoteAgentJobResponse', () => {
		it('should validate a valid remote agent job response', () => {
			const validResponse = {
				job_id: 'job-123',
				session_id: 'session-456',
				actor: {
					id: 123,
					login: 'testuser'
				},
				created_at: '2023-01-01T00:00:00Z',
				updated_at: '2023-01-02T00:00:00Z'
			};

			const result = vRemoteAgentJobResponse().validate(validResponse);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validResponse);
		});
	});

	describe('vErrorResponseWithStatusCode', () => {
		it('should validate an error response with status code', () => {
			const validError = {
				status: 404
			};

			const result = vErrorResponseWithStatusCode().validate(validError);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validError);
		});
	});

	describe('vCustomAgentListItem', () => {
		it('should validate a valid custom agent list item', () => {
			const validAgent = {
				name: 'my-agent',
				repo_owner_id: 123,
				repo_owner: 'testowner',
				repo_id: 456,
				repo_name: 'testrepo',
				display_name: 'My Agent',
				description: 'A test agent',
				tools: ['tool1', 'tool2'],
				version: '1.0.0'
			};

			const result = vCustomAgentListItem().validate(validAgent);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validAgent);
		});
	});

	describe('vGetCustomAgentsResponse', () => {
		it('should validate a valid custom agents response', () => {
			const validResponse = {
				agents: [
					{
						name: 'my-agent',
						repo_owner_id: 123,
						repo_owner: 'testowner',
						repo_id: 456,
						repo_name: 'testrepo',
						display_name: 'My Agent',
						description: 'A test agent',
						tools: ['tool1', 'tool2'],
						version: '1.0.0'
					}
				]
			};

			const result = vGetCustomAgentsResponse().validate(validResponse);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validResponse);
		});

		it('should validate an empty agents list', () => {
			const validResponse = {
				agents: []
			};

			const result = vGetCustomAgentsResponse().validate(validResponse);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validResponse);
		});
	});

	describe('vPullRequestFile', () => {
		it('should validate a valid pull request file', () => {
			const validFile = {
				filename: 'test.ts',
				status: 'modified',
				additions: 10,
				deletions: 5,
				changes: 15
			};

			const result = vPullRequestFile().validate(validFile);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validFile);
		});

		it('should validate a file with optional fields', () => {
			const validFile = {
				filename: 'test.ts',
				status: 'renamed',
				additions: 10,
				deletions: 5,
				changes: 15,
				patch: '@@ -1,3 +1,3 @@',
				previous_filename: 'old-test.ts'
			};

			const result = vPullRequestFile().validate(validFile);
			expect(result.error).toBeUndefined();
		});

		it('should reject invalid status', () => {
			const invalidFile = {
				filename: 'test.ts',
				status: 'invalid-status',
				additions: 10,
				deletions: 5,
				changes: 15
			};

			const result = vPullRequestFile().validate(invalidFile);
			expect(result.error).toBeDefined();
		});
	});

	describe('vSessionInfo', () => {
		it('should validate a valid session info', () => {
			const validSession = {
				id: 'session-123',
				name: 'Test Session',
				user_id: 123,
				agent_id: 456,
				logs: 'log data',
				logs_blob_id: 'blob-123',
				state: 'completed',
				owner_id: 789,
				repo_id: 101112,
				resource_type: 'pull_request',
				resource_id: 131415,
				last_updated_at: '2023-01-02T00:00:00Z',
				created_at: '2023-01-01T00:00:00Z',
				completed_at: '2023-01-03T00:00:00Z',
				event_type: 'pull_request',
				workflow_run_id: 161718,
				premium_requests: 5,
				error: null,
				resource_global_id: 'global-123'
			};

			const result = vSessionInfo().validate(validSession);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validSession);
		});

		it('should validate session with error string', () => {
			const validSession = {
				id: 'session-123',
				name: 'Test Session',
				user_id: 123,
				agent_id: 456,
				logs: 'log data',
				logs_blob_id: 'blob-123',
				state: 'failed',
				owner_id: 789,
				repo_id: 101112,
				resource_type: 'pull_request',
				resource_id: 131415,
				last_updated_at: '2023-01-02T00:00:00Z',
				created_at: '2023-01-01T00:00:00Z',
				completed_at: '2023-01-03T00:00:00Z',
				event_type: 'pull_request',
				workflow_run_id: 161718,
				premium_requests: 5,
				error: 'Something went wrong',
				resource_global_id: 'global-123'
			};

			const result = vSessionInfo().validate(validSession);
			expect(result.error).toBeUndefined();
		});
	});

	describe('vSessionsResponse', () => {
		it('should validate a valid sessions response', () => {
			const validResponse = {
				sessions: [
					{
						id: 'session-123',
						name: 'Test Session',
						user_id: 123,
						agent_id: 456,
						logs: 'log data',
						logs_blob_id: 'blob-123',
						state: 'completed',
						owner_id: 789,
						repo_id: 101112,
						resource_type: 'pull_request',
						resource_id: 131415,
						last_updated_at: '2023-01-02T00:00:00Z',
						created_at: '2023-01-01T00:00:00Z',
						completed_at: '2023-01-03T00:00:00Z',
						event_type: 'pull_request',
						workflow_run_id: 161718,
						premium_requests: 5,
						error: null,
						resource_global_id: 'global-123'
					}
				]
			};

			const result = vSessionsResponse().validate(validResponse);
			expect(result.error).toBeUndefined();
		});
	});

	describe('vFileContentResponse', () => {
		it('should validate a valid file content response', () => {
			const validResponse = {
				content: 'base64encodedcontent',
				encoding: 'base64'
			};

			const result = vFileContentResponse().validate(validResponse);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validResponse);
		});
	});

	describe('vClosePullRequestResponse', () => {
		it('should validate a valid close PR response', () => {
			const validResponse = {
				state: 'closed'
			};

			const result = vClosePullRequestResponse().validate(validResponse);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validResponse);
		});
	});

	describe('vRepositoryItem', () => {
		it('should validate a valid repository item', () => {
			const validItem = {
				name: 'test.ts',
				path: 'src/test.ts',
				type: 'file',
				html_url: 'https://github.com/owner/repo/blob/main/src/test.ts'
			};

			const result = vRepositoryItem().validate(validItem);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validItem);
		});
	});

	describe('vRepositoryContentItem', () => {
		it('should validate a valid repository content item', () => {
			const validContent = {
				content: 'base64encodedcontent'
			};

			const result = vRepositoryContentItem().validate(validContent);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(validContent);
		});
	});
});
