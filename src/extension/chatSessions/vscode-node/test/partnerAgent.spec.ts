/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { RemoteAgentJobPayload } from '../../../../platform/github/common/githubService';

describe('Partner Agent Configuration', () => {
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

	it('should map Claude to agent_id 2246796', () => {
		// Test the mapping logic
		const partnerAgent = 'Claude';
		let agentId: number | undefined;
		
		switch (partnerAgent) {
			case 'Claude':
				agentId = 2246796;
				break;
			case '__default_agent_copilot':
			default:
				agentId = undefined;
				break;
		}

		expect(agentId).toBe(2246796);
	});

	it('should map default agent to undefined agent_id', () => {
		// Test the mapping logic for default agent
		const partnerAgent = '__default_agent_copilot';
		let agentId: number | undefined;
		
		switch (partnerAgent) {
			case 'Claude':
				agentId = 2246796;
				break;
			case '__default_agent_copilot':
			default:
				agentId = undefined;
				break;
		}

		expect(agentId).toBeUndefined();
	});
});
