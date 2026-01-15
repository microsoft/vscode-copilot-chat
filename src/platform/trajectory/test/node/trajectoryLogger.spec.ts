/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, beforeEach } from 'vitest';
import { TrajectoryLogger } from '../../node/trajectoryLogger';
import { IAgentInfo } from '../../common/trajectoryLogger';
import { TRAJECTORY_SCHEMA_VERSION } from '../../common/trajectoryTypes';

describe('TrajectoryLogger', () => {
	let logger: TrajectoryLogger;
	const mockAgentInfo: IAgentInfo = {
		name: 'test-agent',
		version: '1.0.0',
		model_name: 'gpt-4'
	};

	beforeEach(() => {
		logger = new TrajectoryLogger();
	});

	describe('basic trajectory creation', () => {
		it('should create a trajectory with correct schema version', () => {
			logger.startTrajectory('test-session-1', mockAgentInfo);
			const trajectory = logger.getTrajectory();

			expect(trajectory).toBeDefined();
			expect(trajectory?.schema_version).toBe(TRAJECTORY_SCHEMA_VERSION);
			expect(trajectory?.session_id).toBe('test-session-1');
		});

		it('should store agent information', () => {
			logger.startTrajectory('test-session-2', mockAgentInfo);
			const trajectory = logger.getTrajectory();

			expect(trajectory?.agent).toEqual(mockAgentInfo);
		});

		it('should return undefined when no trajectory is started', () => {
			const trajectory = logger.getTrajectory();
			expect(trajectory).toBeUndefined();
		});

		it('should clear trajectory', () => {
			logger.startTrajectory('test-session-3', mockAgentInfo);
			logger.clearTrajectory();
			const trajectory = logger.getTrajectory();

			expect(trajectory).toBeUndefined();
			expect(logger.hasActiveTrajectory()).toBe(false);
		});
	});

	describe('step management', () => {
		beforeEach(() => {
			logger.startTrajectory('test-session', mockAgentInfo);
		});

		it('should add system step', () => {
			logger.addSystemStep('System initialization message');
			const trajectory = logger.getTrajectory();

			expect(trajectory?.steps).toHaveLength(1);
			expect(trajectory?.steps[0]).toMatchObject({
				step_id: 1,
				source: 'system',
				message: 'System initialization message'
			});
		});

		it('should add user step', () => {
			logger.addUserStep('Hello, agent!');
			const trajectory = logger.getTrajectory();

			expect(trajectory?.steps).toHaveLength(1);
			expect(trajectory?.steps[0]).toMatchObject({
				step_id: 1,
				source: 'user',
				message: 'Hello, agent!'
			});
		});

		it('should add agent step with reasoning', () => {
			const stepContext = logger.beginAgentStep(
				'Hello, user!',
				'gpt-4',
				'This is my internal reasoning'
			);
			stepContext.complete();

			const trajectory = logger.getTrajectory();
			expect(trajectory?.steps).toHaveLength(1);
			expect(trajectory?.steps[0]).toMatchObject({
				step_id: 1,
				source: 'agent',
				message: 'Hello, user!',
				model_name: 'gpt-4',
				reasoning_content: 'This is my internal reasoning'
			});
		});

		it('should increment step IDs correctly', () => {
			logger.addSystemStep('System message');
			logger.addUserStep('User message');
			const stepContext = logger.beginAgentStep('Agent response');
			stepContext.complete();

			const trajectory = logger.getTrajectory();
			expect(trajectory?.steps).toHaveLength(3);
			expect(trajectory?.steps[0].step_id).toBe(1);
			expect(trajectory?.steps[1].step_id).toBe(2);
			expect(trajectory?.steps[2].step_id).toBe(3);
		});
	});

	describe('tool calls and observations', () => {
		beforeEach(() => {
			logger.startTrajectory('test-session', mockAgentInfo);
		});

		it('should add tool calls to agent step', () => {
			const stepContext = logger.beginAgentStep('Calling tools');
			
			stepContext.addToolCalls([
				{
					tool_call_id: 'call-1',
					function_name: 'read_file',
					arguments: { path: '/test/file.txt' }
				},
				{
					tool_call_id: 'call-2',
					function_name: 'search_code',
					arguments: { query: 'test function' }
				}
			]);

			stepContext.complete();

			const trajectory = logger.getTrajectory();
			expect(trajectory?.steps[0].tool_calls).toHaveLength(2);
			expect(trajectory?.steps[0].tool_calls?.[0]).toMatchObject({
				tool_call_id: 'call-1',
				function_name: 'read_file'
			});
		});

		it('should add observations with results', () => {
			const stepContext = logger.beginAgentStep('Processing results');

			stepContext.addObservation([
				{
					source_call_id: 'call-1',
					content: 'File contents: Hello World'
				},
				{
					source_call_id: 'call-2',
					content: 'Found 3 matches'
				}
			]);

			stepContext.complete();

			const trajectory = logger.getTrajectory();
			expect(trajectory?.steps[0].observation?.results).toHaveLength(2);
			expect(trajectory?.steps[0].observation?.results[0].content).toBe('File contents: Hello World');
		});

		it('should add subagent reference', () => {
			const stepContext = logger.beginAgentStep('Delegating to subagent');

			stepContext.addToolCalls([{
				tool_call_id: 'call-subagent',
				function_name: 'search_subagent',
				arguments: { query: 'find related files' }
			}]);

			stepContext.addSubagentReference('call-subagent', {
				session_id: 'subagent-123',
				trajectory_path: '/path/to/subagent-trajectory.json'
			});

			stepContext.complete();

			const trajectory = logger.getTrajectory();
			const observation = trajectory?.steps[0].observation?.results[0];
			expect(observation?.subagent_trajectory_ref).toBeDefined();
			expect(observation?.subagent_trajectory_ref?.[0].session_id).toBe('subagent-123');
		});
	});

	describe('metrics tracking', () => {
		beforeEach(() => {
			logger.startTrajectory('test-session', mockAgentInfo);
		});

		it('should add step metrics', () => {
			const stepContext = logger.beginAgentStep('Response with metrics');

			stepContext.setMetrics({
				prompt_tokens: 100,
				completion_tokens: 50,
				cached_tokens: 20,
				cost_usd: 0.001,
				time_to_first_token_ms: 150,
				duration_ms: 500
			});

			stepContext.complete();

			const trajectory = logger.getTrajectory();
			expect(trajectory?.steps[0].metrics).toMatchObject({
				prompt_tokens: 100,
				completion_tokens: 50,
				cached_tokens: 20,
				cost_usd: 0.001
			});
		});

		it('should calculate final metrics correctly', () => {
			// Step 1
			const step1 = logger.beginAgentStep('Step 1');
			step1.addToolCalls([{
				tool_call_id: 'call-1',
				function_name: 'tool1',
				arguments: {}
			}]);
			step1.setMetrics({
				prompt_tokens: 100,
				completion_tokens: 50,
				cached_tokens: 20,
				cost_usd: 0.001
			});
			step1.complete();

			// Step 2
			const step2 = logger.beginAgentStep('Step 2');
			step2.addToolCalls([
				{
					tool_call_id: 'call-2',
					function_name: 'tool2',
					arguments: {}
				},
				{
					tool_call_id: 'call-3',
					function_name: 'tool3',
					arguments: {}
				}
			]);
			step2.setMetrics({
				prompt_tokens: 150,
				completion_tokens: 75,
				cached_tokens: 30,
				cost_usd: 0.002
			});
			step2.complete();

			const trajectory = logger.getTrajectory();
			expect(trajectory?.final_metrics).toMatchObject({
				total_prompt_tokens: 250,
				total_completion_tokens: 125,
				total_cached_tokens: 50,
				total_cost_usd: 0.003,
				total_steps: 2,
				total_tool_calls: 3
			});
		});
	});

	describe('multiple trajectories', () => {
		it('should track multiple trajectories', () => {
			// Main trajectory
			logger.startTrajectory('main-session', mockAgentInfo);
			logger.addUserStep('Main user message');

			// Register a subagent trajectory
			const subagentTrajectory = {
				schema_version: TRAJECTORY_SCHEMA_VERSION,
				session_id: 'subagent-session',
				agent: { ...mockAgentInfo, name: 'search-subagent' },
				steps: [
					{
						step_id: 1,
						source: 'user' as const,
						message: 'Search for files'
					}
				]
			};

			logger.registerSubagentTrajectory(subagentTrajectory);

			const allTrajectories = logger.getAllTrajectories();
			expect(allTrajectories.size).toBe(2);
			expect(allTrajectories.has('main-session')).toBe(true);
			expect(allTrajectories.has('subagent-session')).toBe(true);
		});
	});

	describe('event firing', () => {
		it('should fire update event when trajectory is modified', () => {
			return new Promise<void>((resolve) => {
				let eventCount = 0;
				
				logger.onDidUpdateTrajectory(() => {
					eventCount++;
					if (eventCount === 2) {
						// First event from startTrajectory, second from addUserStep
						resolve();
					}
				});

				logger.startTrajectory('test-session', mockAgentInfo);
				logger.addUserStep('Test message');
			});
		});
	});
});
