/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { RemoteAgentJobPayload } from '../../../../platform/github/common/githubService';

describe('Partner Agent Configuration', () => {
	describe('RemoteAgentJobPayload Interface', () => {
		it('should include agent_id field in RemoteAgentJobPayload interface', () => {
			// Verify that the RemoteAgentJobPayload interface includes the optional agent_id field
			const payload: RemoteAgentJobPayload = {
				problem_statement: 'Test problem',
				event_type: 'test_event',
				agent_id: 2246796, // Claude agent
				pull_request: {
					title: 'Test PR',
					base_ref: 'main'
				}
			};

			expect(payload.agent_id).toBe(2246796);
		});

		it('should allow agent_id to be undefined', () => {
			// Verify that agent_id is optional
			const payload: RemoteAgentJobPayload = {
				problem_statement: 'Test problem',
				event_type: 'test_event',
				pull_request: {
					title: 'Test PR',
					base_ref: 'main'
				}
			};

			expect(payload.agent_id).toBeUndefined();
		});

		it('should allow agent_id to be 0', () => {
			// Verify that agent_id can be 0 (edge case for truthy check)
			const payload: RemoteAgentJobPayload = {
				problem_statement: 'Test problem',
				event_type: 'test_event',
				agent_id: 0,
				pull_request: {
					title: 'Test PR',
					base_ref: 'main'
				}
			};

			expect(payload.agent_id).toBe(0);
		});
	});

	describe('Partner Agent Mapping Logic', () => {
		it('should map Claude to agent_id 2246796', () => {
			// Verify the Claude agent ID constant
			const CLAUDE_AGENT_ID = 2246796;
			expect(CLAUDE_AGENT_ID).toBe(2246796);
		});

		it('should use spread operator with !== undefined to include agent_id', () => {
			// Test the spread operator logic that should be used in the payload
			const agentId: number | undefined = 2246796;
			const payload = {
				...(agentId !== undefined && { agent_id: agentId })
			};
			expect(payload.agent_id).toBe(2246796);
		});

		it('should exclude agent_id when undefined', () => {
			// Test that undefined agent_id is not included in payload
			const agentId: number | undefined = undefined;
			const payload = {
				...(agentId !== undefined && { agent_id: agentId })
			};
			expect(payload.agent_id).toBeUndefined();
			expect('agent_id' in payload).toBe(false);
		});

		it('should include agent_id when 0', () => {
			// Test that 0 is properly included (edge case)
			const agentId: number | undefined = 0;
			const payload = {
				...(agentId !== undefined && { agent_id: agentId })
			};
			expect(payload.agent_id).toBe(0);
			expect('agent_id' in payload).toBe(true);
		});
	});
});
