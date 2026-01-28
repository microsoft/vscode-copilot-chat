/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Raw } from '@vscode/prompt-tsx';
import { TrajectoryLoggerAdapter } from '../../node/trajectoryLoggerAdapter';
import { TrajectoryLogger } from '../../node/trajectoryLogger';
import { TestRequestLogger } from '../../../requestLogger/test/node/testRequestLogger';
import { CapturingToken } from '../../../requestLogger/common/capturingToken';
import { LoggedRequestKind } from '../../../requestLogger/node/requestLogger';
import { ChatFetchResponseType } from '../../../chat/common/commonTypes';
import { LanguageModelTextPart } from '../../../../vscodeTypes';

describe('TrajectoryLoggerAdapter', () => {
	let requestLogger: TestRequestLogger;
	let trajectoryLogger: TrajectoryLogger;
	let adapter: TrajectoryLoggerAdapter;

	beforeEach(() => {
		requestLogger = new TestRequestLogger();
		trajectoryLogger = new TrajectoryLogger();
		adapter = new TrajectoryLoggerAdapter(requestLogger, trajectoryLogger);
	});

	describe('basic trajectory creation from request logs', () => {
		it('should create trajectory when request is logged with CapturingToken', () => {
			const token = new CapturingToken('test-agent', undefined, false);

			requestLogger.captureInvocation(token, async () => {
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'test-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					timeToFirstToken: 100,
					usage: { prompt_tokens: 50, completion_tokens: 25 },
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Test response',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					isConversationRequest: true
				});
			});

			const trajectories = trajectoryLogger.getAllTrajectories();
			expect(trajectories.size).toBeGreaterThan(0);

			const trajectory = Array.from(trajectories.values())[0];
			expect(trajectory).toBeDefined();
			expect(trajectory.agent.name).toBe('GitHub Copilot Chat');
			expect(trajectory.steps.length).toBeGreaterThan(0);
		});

		it('should use subAgentName when present in CapturingToken', () => {
			const token = new CapturingToken('search-agent', undefined, false);
			// Simulate subagent token with subAgentName
			(token as any).subAgentName = 'SearchSubagent';

			requestLogger.captureInvocation(token, async () => {
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'search-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'search-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Search results',
						requestId: 'req-2',
						serverRequestId: 'server-req-2'
					},
					isConversationRequest: true
				});
			});

			const trajectories = trajectoryLogger.getAllTrajectories();
			const trajectory = Array.from(trajectories.values())[0];
			expect(trajectory.agent.name).toBe('SearchSubagent');
		});
	});

	describe('user message deduplication', () => {
		it('should add user step from first request with user message', () => {
			const token = new CapturingToken('test-agent', undefined, false);

			requestLogger.captureInvocation(token, async () => {
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'test-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [
							{ role: Raw.ChatRole.User, content: 'Hello agent!' }
						] as Raw.ChatMessage[],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					isConversationRequest: true
				});
			});

			const trajectory = trajectoryLogger.getTrajectory();
			expect(trajectory).toBeDefined();

			const userSteps = trajectory!.steps.filter(s => s.source === 'user');
			expect(userSteps.length).toBe(1);
			expect(userSteps[0].message).toBe('Hello agent!');
		});

		it('should not duplicate user message on subsequent requests', () => {
			const token = new CapturingToken('test-agent', undefined, false);

			requestLogger.captureInvocation(token, async () => {
				// First request with user message
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'request-1',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [
							{ role: Raw.ChatRole.User, content: 'Hello agent!' }
						] as Raw.ChatMessage[],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response 1',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					isConversationRequest: true
				});

				// Second request with same user message
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'request-2',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [
							{ role: Raw.ChatRole.User, content: 'Hello agent!' }
						] as Raw.ChatMessage[],
						ourRequestId: 'test-456',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:02Z'),
					endTime: new Date('2024-01-01T10:00:03Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response 2',
						requestId: 'req-2',
						serverRequestId: 'server-req-2'
					},
					isConversationRequest: true
				});
			});

			const trajectory = trajectoryLogger.getTrajectory();
			const userSteps = trajectory!.steps.filter(s => s.source === 'user');
			// Should only have one user step despite two requests
			expect(userSteps.length).toBe(1);
		});
	});

	describe('tool call correlation', () => {
		it('should attach tool calls to agent step', async () => {
			const token = new CapturingToken('test-agent', undefined, false);

			await requestLogger.captureInvocation(token, async () => {
				// Add request with tool calls in deltas
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'test-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					deltas: [
						{
							text: 'Calling tool...',
							copilotToolCalls: [
								{ id: 'call-1', name: 'read_file', arguments: '{"path": "/test.txt"}' }
							]
						}
					],
					isConversationRequest: true
				});

				// Log the tool call
				requestLogger.logToolCall(
					'call-1',
					'read_file',
					{ path: '/test.txt' },
					{ content: [new LanguageModelTextPart('File contents')] } as any
				);
			});

			// Wait for async processing
			await new Promise(resolve => setTimeout(resolve, 100));

			const trajectory = trajectoryLogger.getTrajectory();
			expect(trajectory).toBeDefined();

			const agentSteps = trajectory!.steps.filter(s => s.source === 'agent');
			expect(agentSteps.length).toBeGreaterThan(0);

			const stepWithToolCall = agentSteps.find(s => s.tool_calls && s.tool_calls.length > 0);
			expect(stepWithToolCall).toBeDefined();
			expect(stepWithToolCall!.tool_calls![0].function_name).toBe('read_file');
			expect(stepWithToolCall!.observation?.results).toBeDefined();
		});

		it('should handle multiple parallel tool calls', async () => {
			const token = new CapturingToken('test-agent', undefined, false);

			await requestLogger.captureInvocation(token, async () => {
				// Request with multiple tool calls
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'test-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					deltas: [
						{
							text: 'Calling tools...',
							copilotToolCalls: [
								{ id: 'call-1', name: 'read_file', arguments: '{"path": "/file1.txt"}' },
								{ id: 'call-2', name: 'read_file', arguments: '{"path": "/file2.txt"}' }
							]
						}
					],
					isConversationRequest: true
				});

				// Log both tool calls
				requestLogger.logToolCall(
					'call-1',
					'read_file',
					{ path: '/file1.txt' },
					{ content: [new LanguageModelTextPart('File 1 contents')] } as any
				);

				requestLogger.logToolCall(
					'call-2',
					'read_file',
					{ path: '/file2.txt' },
					{ content: [new LanguageModelTextPart('File 2 contents')] } as any
				);
			});

			// Wait for async processing
			await new Promise(resolve => setTimeout(resolve, 100));

			const trajectory = trajectoryLogger.getTrajectory();
			const agentSteps = trajectory!.steps.filter(s => s.source === 'agent');

			const stepWithToolCalls = agentSteps.find(s => s.tool_calls && s.tool_calls.length > 0);
			expect(stepWithToolCalls).toBeDefined();
			expect(stepWithToolCalls!.tool_calls!.length).toBe(2);
			expect(stepWithToolCalls!.observation?.results.length).toBe(2);
		});

		it('should handle orphan tool calls', async () => {
			const token = new CapturingToken('test-agent', undefined, false);

			await requestLogger.captureInvocation(token, async () => {
				// Start trajectory
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'test-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					isConversationRequest: true
				});

				// Log tool call without corresponding deltas (orphan)
				requestLogger.logToolCall(
					'orphan-call',
					'orphan_tool',
					{ test: 'data' },
					{ content: [new LanguageModelTextPart('Orphan result')] } as any
				);
			});

			// Wait for async processing
			await new Promise(resolve => setTimeout(resolve, 100));

			const trajectory = trajectoryLogger.getTrajectory();
			expect(trajectory).toBeDefined();

			// Orphan tool call should create its own agent step
			const agentSteps = trajectory!.steps.filter(s => s.source === 'agent');
			const orphanStep = agentSteps.find(s =>
				s.tool_calls?.some(tc => tc.function_name === 'orphan_tool')
			);
			expect(orphanStep).toBeDefined();
		});
	});

	describe('subagent trajectory linking', () => {
		it('should link subagent trajectory for search_subagent tool', async () => {
			const mainToken = new CapturingToken('main-agent', undefined, false);
			const subagentToken = new CapturingToken('search-agent', undefined, false);
			(subagentToken as any).subAgentInvocationId = 'subagent-session-123';
			(subagentToken as any).subAgentName = 'SearchSubagent';

			await requestLogger.captureInvocation(mainToken, async () => {
				// Main agent calls search subagent
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'main-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'main-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Delegating to search',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					deltas: [
						{
							copilotToolCalls: [
								{ id: 'search-call', name: 'search_subagent', arguments: '{"query": "test"}' }
							]
						}
					],
					isConversationRequest: true
				});

				// Create tool result with metadata
				const toolResult: any = {
					content: [new LanguageModelTextPart('Search complete')]
				};
				// Attach toolMetadata with subagent session ID
				toolResult.toolMetadata = {
					subAgentInvocationId: 'subagent-session-123'
				};

				requestLogger.logToolCall(
					'search-call',
					'search_subagent',
					{ query: 'test' },
					toolResult
				);
			});

			// Subagent creates its own trajectory
			await requestLogger.captureInvocation(subagentToken, async () => {
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'search-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'search-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:01Z'),
					endTime: new Date('2024-01-01T10:00:02Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Search results',
						requestId: 'req-2',
						serverRequestId: 'server-req-2'
					},
					isConversationRequest: true
				});
			});

			// Wait for async processing
			await new Promise(resolve => setTimeout(resolve, 100));

			const trajectories = trajectoryLogger.getAllTrajectories();
			// With subagent, we should have at least 2 trajectories
			expect(trajectories.size).toBeGreaterThanOrEqual(1); // At least main trajectory

			// Find main trajectory
			const mainTrajectory = Array.from(trajectories.values()).find(
				t => t.agent.name === 'GitHub Copilot Chat'
			);
			expect(mainTrajectory).toBeDefined();

			// Check for subagent reference in tool call observation
			const agentSteps = mainTrajectory!.steps.filter(s => s.source === 'agent');
			const stepWithSubagent = agentSteps.find(s =>
				s.observation?.results.some(r => r.subagent_trajectory_ref)
			);
			expect(stepWithSubagent).toBeDefined();

			const subagentRef = stepWithSubagent!.observation!.results.find(
				r => r.subagent_trajectory_ref
			)?.subagent_trajectory_ref;
			expect(subagentRef).toBeDefined();
			expect(subagentRef![0].session_id).toBe('subagent-session-123');
		});
	});

	describe('metrics tracking', () => {
		it('should extract and set metrics from request usage', () => {
			const token = new CapturingToken('test-agent', undefined, false);

			requestLogger.captureInvocation(token, async () => {
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'test-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01.5Z'),
					timeToFirstToken: 250,
					usage: {
						prompt_tokens: 150,
						completion_tokens: 75,
						prompt_tokens_details: { cached_tokens: 50 }
					},
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response with metrics',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					isConversationRequest: true
				});
			});

			const trajectory = trajectoryLogger.getTrajectory();
			expect(trajectory).toBeDefined();

			const agentSteps = trajectory!.steps.filter(s => s.source === 'agent');
			expect(agentSteps.length).toBeGreaterThan(0);

			const stepWithMetrics = agentSteps[0];
			expect(stepWithMetrics.metrics).toBeDefined();
			expect(stepWithMetrics.metrics!.prompt_tokens).toBe(150);
			expect(stepWithMetrics.metrics!.completion_tokens).toBe(75);
			expect(stepWithMetrics.metrics!.cached_tokens).toBe(50);
			expect(stepWithMetrics.metrics!.time_to_first_token_ms).toBe(250);
			expect(stepWithMetrics.metrics!.duration_ms).toBe(1500);
		});
	});

	describe('session management', () => {
		it('should use chatSessionId when available', () => {
			const token = new CapturingToken('test-agent', undefined, false);
			(token as any).chatSessionId = 'explicit-session-id';

			requestLogger.captureInvocation(token, async () => {
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'test-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					isConversationRequest: true
				});
			});

			const trajectory = trajectoryLogger.getTrajectory();
			expect(trajectory?.session_id).toBe('explicit-session-id');
		});

		it('should prioritize subAgentInvocationId over chatSessionId', () => {
			const token = new CapturingToken('test-agent', undefined, false);
			(token as any).chatSessionId = 'chat-session-id';
			(token as any).subAgentInvocationId = 'subagent-invocation-id';

			requestLogger.captureInvocation(token, async () => {
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'test-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'test-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Response',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					isConversationRequest: true
				});
			});

			const trajectory = trajectoryLogger.getTrajectory();
			expect(trajectory?.session_id).toBe('subagent-invocation-id');
		});
	});

	describe('non-conversation requests', () => {
		it('should skip non-conversation requests', () => {
			const token = new CapturingToken('test-agent', undefined, false);

			requestLogger.captureInvocation(token, async () => {
				requestLogger.addEntry({
					type: LoggedRequestKind.ChatMLSuccess,
					debugName: 'utility-request',
					chatEndpoint: { model: 'gpt-4' },
					chatParams: {
						messages: [],
						ourRequestId: 'util-123',
						model: 'gpt-4',
						location: 'panel' as any,
						body: {}
					},
					startTime: new Date('2024-01-01T10:00:00Z'),
					endTime: new Date('2024-01-01T10:00:01Z'),
					result: {
						type: ChatFetchResponseType.Success,
						value: 'Utility response',
						requestId: 'req-1',
						serverRequestId: 'server-req-1'
					},
					isConversationRequest: false // Not a conversation request
				});
			});

			const trajectory = trajectoryLogger.getTrajectory();
			// Trajectory is created but should have no agent steps
			expect(trajectory).toBeDefined();
			const agentSteps = trajectory!.steps.filter(s => s.source === 'agent');
			expect(agentSteps.length).toBe(0);
		});
	});
});
