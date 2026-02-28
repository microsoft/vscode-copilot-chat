/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ChatLocation } from '../../../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { MockEndpoint } from '../../../../../platform/endpoint/test/node/mockEndpoint';
import { ITestingServicesAccessor } from '../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { createTextDocumentData } from '../../../../../util/common/test/shims/textDocument';
import { URI } from '../../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../../vscodeTypes';
import { ChatVariablesCollection } from '../../../../prompt/common/chatVariablesCollection';
import { Conversation, ICopilotChatResultIn, Turn, TurnStatus } from '../../../../prompt/common/conversation';
import { IBuildPromptContext, IToolCall, IToolCallRound } from '../../../../prompt/common/intents';
import { ToolCallRound } from '../../../../prompt/common/toolCallRound';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ToolName } from '../../../../tools/common/toolNames';
import { SummarizedAgentHistoryProps, SummarizedConversationHistoryPropsBuilder } from '../summarizedConversationHistory';

/**
 * Unit tests for Half-Context Summarization feature.
 *
 * The half-context summarization feature improves upon the legacy approach by:
 * 1. Flattening all rounds across historical turns and current turn
 * 2. Skipping already-summarized rounds
 * 3. Splitting at the midpoint: keep the recent half, summarize the older half
 *
 * This enables finer-grained compression that can cut through Turn boundaries.
 */
describe('Half-Context Summarization', () => {
	let accessor: ITestingServicesAccessor;
	let configService: IConfigurationService;
	let instaService: IInstantiationService;
	const fileTsUri = URI.file('/workspace/file.ts');
	let conversation: Conversation;

	const tools: IBuildPromptContext['tools'] = {
		availableTools: [],
		toolInvocationToken: null as never,
		toolReferences: [],
	};

	beforeAll(() => {
		const testDoc = createTextDocumentData(fileTsUri, 'line 1\nline 2\nline 3', 'ts').document;

		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService,
			[
				[URI.file('/workspace')],
				[testDoc]
			]
		));
		accessor = services.createTestingAccessor();
		configService = accessor.get(IConfigurationService);
		instaService = accessor.get(IInstantiationService);
	});

	beforeEach(() => {
		const turn = new Turn('turnId', { type: 'user', message: 'hello' });
		conversation = new Conversation('sessionId', [turn]);
		// Enable half-context summarization by default for these tests
		configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, true);
	});

	afterAll(() => {
		accessor.dispose();
	});

	// Helper functions
	function createToolCall(idx: number): IToolCall {
		return {
			id: `tooluse_${idx}`,
			name: ToolName.EditFile,
			arguments: JSON.stringify({
				filePath: fileTsUri.fsPath,
				code: `// edit ${idx}`
			})
		};
	}

	function createToolResult(...idxs: number[]): Record<string, LanguageModelToolResult> {
		const result: Record<string, LanguageModelToolResult> = {};
		for (const idx of idxs) {
			result[`tooluse_${idx}`] = new LanguageModelToolResult([new LanguageModelTextPart(`success ${idx}`)]);
		}
		return result;
	}

	function createRound(message: string, toolIdx: number, id?: string): ToolCallRound {
		return new ToolCallRound(message, [createToolCall(toolIdx)], undefined, id ?? `round_${toolIdx}`);
	}

	function createTurnWithRounds(turnId: string, userMessage: string, rounds: IToolCallRound[]): Turn {
		const turn = new Turn(turnId, { type: 'user', message: userMessage });
		const result: ICopilotChatResultIn = {
			metadata: {
				toolCallRounds: rounds,
				toolCallResults: createToolResult(...rounds.map((_, i) => i + 1)),
			}
		};
		turn.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', result);
		return turn;
	}

	function createBaseProps(promptContext: IBuildPromptContext): SummarizedAgentHistoryProps {
		const endpoint = instaService.createInstance(MockEndpoint, undefined);
		return {
			priority: 1,
			endpoint,
			location: ChatLocation.Panel,
			promptContext: { ...promptContext, conversation },
			maxToolResultLength: Infinity,
		};
	}

	function getPropsBuilder(): SummarizedConversationHistoryPropsBuilder {
		return instaService.createInstance(SummarizedConversationHistoryPropsBuilder);
	}

	describe('Split Point Calculation', () => {
		test('2 rounds: summarize 1, keep 1', () => {
			const rounds = [createRound('round 1', 1), createRound('round 2', 2)];
			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			expect(result.summarizedToolCallRoundId).toBe('round_1');
			expect(result.props.promptContext.toolCallRounds).toHaveLength(1);
			expect(result.props.promptContext.toolCallRounds![0].id).toBe('round_1');
		});

		test('3 rounds: summarize 1, keep 2', () => {
			const rounds = [
				createRound('round 1', 1),
				createRound('round 2', 2),
				createRound('round 3', 3),
			];
			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 3 rounds -> ceil(3/2) = 2 to keep, 1 to summarize
			expect(result.summarizedToolCallRoundId).toBe('round_1');
			expect(result.props.promptContext.toolCallRounds).toHaveLength(1);
		});

		test('4 rounds: summarize 2, keep 2', () => {
			const rounds = [
				createRound('round 1', 1),
				createRound('round 2', 2),
				createRound('round 3', 3),
				createRound('round 4', 4),
			];
			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3, 4),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 4 rounds -> ceil(4/2) = 2 to keep, 2 to summarize
			expect(result.summarizedToolCallRoundId).toBe('round_2');
			expect(result.props.promptContext.toolCallRounds).toHaveLength(2);
			expect(result.props.promptContext.toolCallRounds![0].id).toBe('round_1');
			expect(result.props.promptContext.toolCallRounds![1].id).toBe('round_2');
		});

		test('5 rounds: summarize 2, keep 3', () => {
			const rounds = [
				createRound('round 1', 1),
				createRound('round 2', 2),
				createRound('round 3', 3),
				createRound('round 4', 4),
				createRound('round 5', 5),
			];
			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3, 4, 5),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 5 rounds -> ceil(5/2) = 3 to keep, 2 to summarize
			expect(result.summarizedToolCallRoundId).toBe('round_2');
			expect(result.props.promptContext.toolCallRounds).toHaveLength(2);
		});

		test('6 rounds: summarize 3, keep 3', () => {
			const rounds = [
				createRound('round 1', 1),
				createRound('round 2', 2),
				createRound('round 3', 3),
				createRound('round 4', 4),
				createRound('round 5', 5),
				createRound('round 6', 6),
			];
			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3, 4, 5, 6),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 6 rounds -> ceil(6/2) = 3 to keep, 3 to summarize
			expect(result.summarizedToolCallRoundId).toBe('round_3');
			expect(result.props.promptContext.toolCallRounds).toHaveLength(3);
		});
	});

	describe('Cross-Turn Boundary Splitting', () => {
		test('split point in historical turn - rounds are truncated', () => {
			// Turn 1: 2 rounds
			// Turn 2: 2 rounds
			// Current: 2 rounds
			// Total: 6 rounds -> keep 3, summarize 3
			// Split point should be at Turn 2, round index 0 (the 3rd round overall)
			const turn1 = createTurnWithRounds('turn1', 'message 1', [
				createRound('t1r1', 1, 'turn1_round1'),
				createRound('t1r2', 2, 'turn1_round2'),
			]);
			const turn2 = createTurnWithRounds('turn2', 'message 2', [
				createRound('t2r1', 3, 'turn2_round1'),
				createRound('t2r2', 4, 'turn2_round2'),
			]);
			const currentRounds = [
				createRound('current r1', 5, 'current_round1'),
				createRound('current r2', 6, 'current_round2'),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [turn1, turn2],
				query: 'test',
				toolCallRounds: currentRounds,
				toolCallResults: createToolResult(5, 6),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 6 total rounds, keep 3, summarize 3
			// Rounds to summarize: turn1_round1, turn1_round2, turn2_round1
			// Split point: turn2_round1
			expect(result.summarizedToolCallRoundId).toBe('turn2_round1');

			// History should contain turn1 complete + turn2 truncated to 1 round
			expect(result.props.promptContext.history).toHaveLength(2);
			expect(result.props.promptContext.history[0].rounds).toHaveLength(2); // turn1 complete
			expect(result.props.promptContext.history[1].rounds).toHaveLength(1); // turn2 truncated

			// Current toolCallRounds should be empty (split point is in history)
			expect(result.props.promptContext.toolCallRounds).toHaveLength(0);

			// Should be marked as continuation to skip current user message
			expect(result.props.promptContext.isContinuation).toBe(true);
		});

		test('split point in current turn - history remains intact', () => {
			// Turn 1: 1 round
			// Current: 3 rounds
			// Total: 4 rounds -> keep 2, summarize 2
			// Split point is current_round2 (index 1), so virtualToolCallRounds includes [0..1]
			const turn1 = createTurnWithRounds('turn1', 'message 1', [
				createRound('t1r1', 1, 'turn1_round1'),
			]);
			const currentRounds = [
				createRound('current r1', 2, 'current_round1'),
				createRound('current r2', 3, 'current_round2'),
				createRound('current r3', 4, 'current_round3'),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [turn1],
				query: 'test',
				toolCallRounds: currentRounds,
				toolCallResults: createToolResult(2, 3, 4),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 4 total rounds, keep ceil(4/2)=2, summarize 2
			// Candidates: turn1_round1, current_round1, current_round2, current_round3
			// To summarize (first 2): turn1_round1, current_round1
			// Split point: current_round1 (turnIndex = -1, roundIndexInTurn = 0)
			expect(result.summarizedToolCallRoundId).toBe('current_round1');

			// History should remain intact
			expect(result.props.promptContext.history).toHaveLength(1);
			expect(result.props.promptContext.history[0].rounds).toHaveLength(1);

			// virtualToolCallRounds = currentRounds.slice(0, splitPoint.roundIndexInTurn + 1)
			// = currentRounds.slice(0, 1) = [current_round1]
			// This is the summarization scope, not what's "kept" - the kept rounds aren't in props
			expect(result.props.promptContext.toolCallRounds).toHaveLength(1);
			expect(result.props.promptContext.toolCallRounds![0].id).toBe('current_round1');
		});

		test('all rounds in history - current turn is empty', () => {
			// Turn 1: 2 rounds
			// Turn 2: 2 rounds
			// Current: 0 rounds
			// Total: 4 rounds -> keep 2, summarize 2
			const turn1 = createTurnWithRounds('turn1', 'message 1', [
				createRound('t1r1', 1, 'turn1_round1'),
				createRound('t1r2', 2, 'turn1_round2'),
			]);
			const turn2 = createTurnWithRounds('turn2', 'message 2', [
				createRound('t2r1', 3, 'turn2_round1'),
				createRound('t2r2', 4, 'turn2_round2'),
			]);

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [turn1, turn2],
				query: 'test',
				toolCallRounds: [],
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 4 total rounds, keep 2, summarize 2
			expect(result.summarizedToolCallRoundId).toBe('turn1_round2');
			expect(result.props.promptContext.history).toHaveLength(1);
			expect(result.props.promptContext.history[0].rounds).toHaveLength(2);
			expect(result.props.promptContext.toolCallRounds).toHaveLength(0);
			expect(result.props.promptContext.isContinuation).toBe(true);
		});
	});

	describe('Already-Summarized Rounds Handling', () => {
		test('skips rounds that already have summaries', () => {
			// Round 1: has summary (should be skipped)
			// Round 2-5: no summary (4 candidates)
			// 4 candidates -> keep 2, summarize 2
			const round1 = createRound('round 1', 1);
			round1.summary = 'already summarized';

			const rounds = [
				round1,
				createRound('round 2', 2),
				createRound('round 3', 3),
				createRound('round 4', 4),
				createRound('round 5', 5),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3, 4, 5),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 4 candidates (rounds 2-5), keep 2, summarize 2
			// Summarize rounds 2-3, keep rounds 4-5
			expect(result.summarizedToolCallRoundId).toBe('round_3');
			expect(result.props.promptContext.toolCallRounds).toHaveLength(3);
			// Note: The already-summarized round 1 is still included in output
			// but rounds after the new summary point are excluded
		});

		test('handles multiple consecutive summarized rounds', () => {
			// Rounds 1-2: have summaries
			// Rounds 3-5: no summary (3 candidates)
			// 3 candidates -> keep 2, summarize 1
			const round1 = createRound('round 1', 1);
			round1.summary = 'summary 1';
			const round2 = createRound('round 2', 2);
			round2.summary = 'summary 2';

			const rounds = [
				round1,
				round2,
				createRound('round 3', 3),
				createRound('round 4', 4),
				createRound('round 5', 5),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3, 4, 5),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 3 candidates (rounds 3-5), keep 2, summarize 1
			expect(result.summarizedToolCallRoundId).toBe('round_3');
		});

		test('falls back to legacy when all rounds are already summarized', () => {
			const round1 = createRound('round 1', 1);
			round1.summary = 'summary 1';
			const round2 = createRound('round 2', 2);
			round2.summary = 'summary 2';

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: [round1, round2],
				toolCallResults: createToolResult(1, 2),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));
			expect(result.summarizedToolCallRoundId).toBe('round_1');
		});

		test('falls back to legacy when only one candidate round remains', () => {
			const round1 = createRound('round 1', 1);
			round1.summary = 'summary';

			const rounds = [
				round1,
				createRound('round 2', 2), // Only 1 candidate
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));
			expect(result.summarizedToolCallRoundId).toBe('round_1');
		});
	});

	describe('Overflow Handling', () => {
		test('does not summarize interrupted round when maxToolCallsExceeded turn is at split point', () => {
			const turn1Rounds = [
				createRound('t1r1', 1, 'turn1_round1'),
				createRound('t1r2', 2, 'turn1_round2'),
			];
			const turn1 = new Turn('turn1', { type: 'user', message: 'message 1' });
			turn1.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', {
				metadata: {
					toolCallRounds: turn1Rounds,
					toolCallResults: createToolResult(1, 2),
					maxToolCallsExceeded: true
				}
			} satisfies ICopilotChatResultIn);

			const turn2Rounds = [
				createRound('t2r1', 3, 'turn2_round1'),
				createRound('t2r2', 4, 'turn2_round2'),
			];
			const turn2 = new Turn('turn2', { type: 'user', message: 'message 2' });
			turn2.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', {
				metadata: {
					toolCallRounds: turn2Rounds,
					toolCallResults: createToolResult(3, 4)
				}
			} satisfies ICopilotChatResultIn);

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [turn1, turn2],
				query: 'test',
				toolCallRounds: [],
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// 4 total rounds -> keep 2, summarize 2 normally (t1r1, t1r2)
			// Since t1r2 is the interrupted round (maxToolCallsExceeded + last of turn1), it is skipped
			// Summary stops at t1r1 instead.
			expect(result.summarizedToolCallRoundId).toBe('turn1_round1');
		});
	});

	describe('Edge Cases', () => {
		test('throws with no rounds at all', () => {
			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: [],
				tools,
			};

			expect(() => getPropsBuilder().getProps(createBaseProps(promptContext)))
				.toThrow('Nothing to summarize');
		});

		test('throws with only one round', () => {
			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: [createRound('only round', 1)],
				toolCallResults: createToolResult(1),
				tools,
			};

			expect(() => getPropsBuilder().getProps(createBaseProps(promptContext)))
				.toThrow('Nothing to summarize');
		});

		test('handles history with turn that has no explicit rounds', () => {
			// Turn with no explicit rounds - Turn.rounds getter returns a default round with turn.id
			// Turn 1 (no explicit toolCallRounds): gets default round with id='turn1'
			// Current: 2 rounds
			// Total: 3 rounds -> keep 2, summarize 1
			const turn1 = new Turn('turn1', { type: 'user', message: 'message 1' });
			turn1.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', {
				metadata: { toolCallRounds: [] } // Empty, so Turn.rounds returns default round
			});

			const currentRounds = [
				createRound('current r1', 1, 'current_round1'),
				createRound('current r2', 2, 'current_round2'),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [turn1],
				query: 'test',
				toolCallRounds: currentRounds,
				toolCallResults: createToolResult(1, 2),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// Turn.rounds getter returns a default round with id = turn.id ('turn1')
			// Total rounds: [turn1(default), current_round1, current_round2] = 3
			// keep ceil(3/2)=2, summarize 1
			// Summarize first 1: the default round from turn1
			expect(result.summarizedToolCallRoundId).toBe('turn1');
		});

		test('preserves Turn prototype chain (getters remain functional)', () => {
			// This tests that Object.create preserves getters like resultMetadata
			const turn1 = createTurnWithRounds('turn1', 'message 1', [
				createRound('t1r1', 1, 'turn1_round1'),
				createRound('t1r2', 2, 'turn1_round2'),
				createRound('t1r3', 3, 'turn1_round3'),
			]);
			const currentRounds = [
				createRound('current r1', 4, 'current_round1'),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [turn1],
				query: 'test',
				toolCallRounds: currentRounds,
				toolCallResults: createToolResult(4),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// Split occurs in turn1, truncating it
			// The truncated turn should still have working getters
			const truncatedTurn = result.props.promptContext.history[0];
			expect(truncatedTurn.rounds).toHaveLength(2);

			// These should not throw - prototype chain should be preserved
			expect(() => truncatedTurn.resultMetadata).not.toThrow();
			expect(() => truncatedTurn.responseChatResult).not.toThrow();
		});
	});

	describe('Configuration Toggle', () => {
		test('uses legacy logic when half-context is disabled', () => {
			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, false);

			// With legacy: 3 rounds -> exclude last one, summarize up to 2nd
			const rounds = [
				createRound('round 1', 1),
				createRound('round 2', 2),
				createRound('round 3', 3),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// Legacy behavior: exclude last round, summarize from 2nd-to-last
			expect(result.summarizedToolCallRoundId).toBe('round_2');
			expect(result.props.promptContext.toolCallRounds).toHaveLength(2);
		});

		test('uses half-context logic when enabled', () => {
			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, true);

			// With half-context: 3 rounds -> keep 2, summarize 1
			const rounds = [
				createRound('round 1', 1),
				createRound('round 2', 2),
				createRound('round 3', 3),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3),
				tools,
			};

			const result = getPropsBuilder().getProps(createBaseProps(promptContext));

			// Half-context behavior: keep 2, summarize 1
			expect(result.summarizedToolCallRoundId).toBe('round_1');
			expect(result.props.promptContext.toolCallRounds).toHaveLength(1);
		});
	});

	describe('Comparison: Legacy vs Half-Context', () => {
		test('half-context preserves more recent context', () => {
			// Scenario: 6 rounds
			// Legacy: excludes last round, summarizes up to round 5
			// Half-context: keeps 3 recent rounds, summarizes 3 older rounds
			const rounds = [
				createRound('round 1', 1),
				createRound('round 2', 2),
				createRound('round 3', 3),
				createRound('round 4', 4),
				createRound('round 5', 5),
				createRound('round 6', 6),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3, 4, 5, 6),
				tools,
			};

			// Test legacy
			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, false);
			const legacyResult = getPropsBuilder().getProps(createBaseProps(promptContext));

			// Legacy: summarize up to round 5 (all but last)
			expect(legacyResult.summarizedToolCallRoundId).toBe('round_5');
			expect(legacyResult.props.promptContext.toolCallRounds).toHaveLength(5);

			// Test half-context
			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, true);
			const halfContextResult = getPropsBuilder().getProps(createBaseProps(promptContext));

			// Half-context: summarize only first 3
			expect(halfContextResult.summarizedToolCallRoundId).toBe('round_3');
			expect(halfContextResult.props.promptContext.toolCallRounds).toHaveLength(3);

			// Half-context preserves more rounds in detailed form (3 vs 1)
			// Legacy keeps only 1 round after the summary point
			// Half-context keeps 3 rounds after the summary point
		});
	});

	describe('Anthropic Thinking Support', () => {
		function createRoundWithThinking(message: string, toolIdx: number, thinking?: { thinking: string; signature?: string }): ToolCallRound {
			return new ToolCallRound(
				message,
				[createToolCall(toolIdx)],
				undefined,
				`round_${toolIdx}`,
				undefined,
				thinking
			);
		}

		function createAnthropicBaseProps(promptContext: IBuildPromptContext): SummarizedAgentHistoryProps {
			// Create endpoint with claude family to trigger Anthropic-specific behavior
			const endpoint = instaService.createInstance(MockEndpoint, 'claude-sonnet-4');
			return {
				priority: 1,
				endpoint,
				location: ChatLocation.Panel,
				promptContext: { ...promptContext, conversation },
				maxToolResultLength: Infinity,
			};
		}

		function createNonAnthropicBaseProps(promptContext: IBuildPromptContext): SummarizedAgentHistoryProps {
			// Create endpoint with non-claude family
			const endpoint = instaService.createInstance(MockEndpoint, 'gpt-4');
			return {
				priority: 1,
				endpoint,
				location: ChatLocation.Panel,
				promptContext: { ...promptContext, conversation },
				maxToolResultLength: Infinity,
			};
		}

		test('half-context returns summarizedThinking for Anthropic endpoints', () => {
			const thinkingData = { thinking: 'I am thinking about this problem...', signature: 'sig123' };
			const rounds = [
				createRoundWithThinking('round 1', 1, thinkingData),
				createRoundWithThinking('round 2', 2),
				createRoundWithThinking('round 3', 3),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3),
				tools,
			};

			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, true);
			const result = getPropsBuilder().getProps(createAnthropicBaseProps(promptContext));

			expect(result.summarizedThinking).toBeDefined();
			expect(result.summarizedThinking?.thinking).toBe('I am thinking about this problem...');
		});

		test('half-context returns undefined summarizedThinking for non-Anthropic endpoints', () => {
			const thinkingData = { thinking: 'I am thinking...', signature: 'sig123' };
			const rounds = [
				createRoundWithThinking('round 1', 1, thinkingData),
				createRoundWithThinking('round 2', 2),
				createRoundWithThinking('round 3', 3),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3),
				tools,
			};

			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, true);
			const result = getPropsBuilder().getProps(createNonAnthropicBaseProps(promptContext));

			expect(result.summarizedThinking).toBeUndefined();
		});

		test('half-context finds last thinking from summarized rounds only', () => {
			// 4 rounds: round1(thinking1), round2(thinking2), round3, round4
			// Split: summarize first 2, keep last 2
			// toSummarize = [round1, round2] -> should find thinking2 (last in summarized span)
			const thinking1 = { thinking: 'First thinking', signature: 'sig1' };
			const thinking2 = { thinking: 'Second thinking in summarized span', signature: 'sig2' };
			const rounds = [
				createRoundWithThinking('round 1', 1, thinking1),
				createRoundWithThinking('round 2', 2, thinking2),
				createRoundWithThinking('round 3', 3), // no thinking, in kept span
				createRoundWithThinking('round 4', 4), // no thinking, in kept span
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3, 4),
				tools,
			};

			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, true);
			const result = getPropsBuilder().getProps(createAnthropicBaseProps(promptContext));

			// Should find thinking2 (last thinking in summarized rounds), not thinking1
			expect(result.summarizedThinking?.thinking).toBe('Second thinking in summarized span');
		});

		test('legacy finds thinking from current toolCallRounds, half-context from summarized span', () => {
			// This test verifies the semantic difference:
			// - Legacy: findLastThinking scans current toolCallRounds
			// - Half-context: finds thinking only within the summarized rounds
			const thinking1 = { thinking: 'Thinking in summarized span', signature: 'sig1' };
			const thinking3 = { thinking: 'Thinking in kept span', signature: 'sig3' };
			const rounds = [
				createRoundWithThinking('round 1', 1, thinking1),
				createRoundWithThinking('round 2', 2),
				createRoundWithThinking('round 3', 3, thinking3),
				createRoundWithThinking('round 4', 4),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [],
				query: 'test',
				toolCallRounds: rounds,
				toolCallResults: createToolResult(1, 2, 3, 4),
				tools,
			};

			// Test legacy - finds last thinking from ALL toolCallRounds
			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, false);
			const legacyResult = getPropsBuilder().getProps(createAnthropicBaseProps(promptContext));
			expect(legacyResult.summarizedThinking?.thinking).toBe('Thinking in kept span');

			// Test half-context - finds last thinking from summarized rounds only
			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, true);
			const halfContextResult = getPropsBuilder().getProps(createAnthropicBaseProps(promptContext));
			expect(halfContextResult.summarizedThinking?.thinking).toBe('Thinking in summarized span');
		});

		test('half-context finds thinking from historical rounds when split is in history', () => {
			// Scenario: split point is in history, not current toolCallRounds
			// The thinking on the historical round should be found
			const historyThinking = { thinking: 'Thinking from historical round', signature: 'hist_sig' };

			// Create a turn with 2 rounds, one with thinking
			const historyRoundWithThinking = createRoundWithThinking('history round 1', 1, historyThinking);
			const historyRound2 = createRoundWithThinking('history round 2', 2);
			const historyTurn = createTurnWithRounds('turn1', 'first question', [historyRoundWithThinking, historyRound2]);

			// Current turn has 2 more rounds
			const currentRounds = [
				createRoundWithThinking('current round 1', 3),
				createRoundWithThinking('current round 2', 4),
			];

			const promptContext: IBuildPromptContext = {
				chatVariables: new ChatVariablesCollection([]),
				history: [historyTurn],
				query: 'follow-up question',
				toolCallRounds: currentRounds,
				toolCallResults: createToolResult(1, 2, 3, 4),
				tools,
			};

			configService.setConfig(ConfigKey.Advanced.HalfContextSummarization, true);
			const result = getPropsBuilder().getProps(createAnthropicBaseProps(promptContext));

			// Total 4 rounds: 2 history + 2 current
			// Split: summarize 2, keep 2
			// toSummarize = [historyRound1, historyRound2]
			// Should find historyThinking (on historyRound1)
			expect(result.summarizedThinking).toBeDefined();
			expect(result.summarizedThinking?.thinking).toBe('Thinking from historical round');
		});
	});
});
