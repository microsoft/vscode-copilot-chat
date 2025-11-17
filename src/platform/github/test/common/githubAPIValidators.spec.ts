/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	vCustomAgentListItem,
	vGetCustomAgentsResponse,
	vJobInfo
} from '../../common/githubAPIValidators';

describe('GitHub API Validators', () => {
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
});
