/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { afterAll, beforeAll, beforeEach, expect, suite, test } from 'vitest';
import { IChatMLFetcher } from '../../../../../platform/chat/common/chatMLFetcher';
import { ChatLocation } from '../../../../../platform/chat/common/commonTypes';
import { StaticChatMLFetcher } from '../../../../../platform/chat/test/common/staticChatMLFetcher';
import { CodeGenerationTextInstruction, ConfigKey, IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { MockEndpoint } from '../../../../../platform/endpoint/test/node/mockEndpoint';
import { messageToMarkdown } from '../../../../../platform/log/common/messageStringify';
import { IResponseDelta } from '../../../../../platform/networking/common/fetch';
import { ITestingServicesAccessor } from '../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { createTextDocumentData } from '../../../../../util/common/test/shims/textDocument';
import { URI } from '../../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../../vscodeTypes';
import { addCacheBreakpoints } from '../../../../intents/node/cacheBreakpoints';
import { ChatVariablesCollection } from '../../../../prompt/common/chatVariablesCollection';
import { Conversation, ICopilotChatResultIn, normalizeSummariesOnRounds, Turn, TurnStatus } from '../../../../prompt/common/conversation';
import { IBuildPromptContext, IToolCall } from '../../../../prompt/common/intents';
import { ToolCallRound } from '../../../../prompt/common/toolCallRound';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ToolName } from '../../../../tools/common/toolNames';
import { PromptRenderer } from '../../base/promptRenderer';
import { AgentPrompt, AgentPromptProps } from '../agentPrompt';
import { PromptRegistry } from '../promptRegistry';
import { ConversationHistorySummarizationPrompt, SummarizedConversationHistoryMetadata, SummarizedConversationHistoryPropsBuilder } from '../summarizedConversationHistory';

suite('Agent Summarization', () => {
	let accessor: ITestingServicesAccessor;
	let chatResponse: (string | IResponseDelta[])[] = [];
	const fileTsUri = URI.file('/workspace/file.ts');

	let conversation: Conversation;

	beforeAll(() => {
		const testDoc = createTextDocumentData(fileTsUri, 'line 1\nline 2\n\nline 4\nline 5', 'ts').document;

		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService,
			[
				[URI.file('/workspace')],
				[testDoc]
			]
		));
		chatResponse = [];
		services.define(IChatMLFetcher, new StaticChatMLFetcher(chatResponse));
		accessor = services.createTestingAccessor();
		accessor.get(IConfigurationService).setConfig(ConfigKey.CodeGenerationInstructions, [{
			text: 'This is a test custom instruction file',
		} satisfies CodeGenerationTextInstruction]);
	});

	beforeEach(() => {
		const turn = new Turn('turnId', { type: 'user', message: 'hello' });
		conversation = new Conversation('sessionId', [turn]);
	});

	afterAll(() => {
		accessor.dispose();
	});

	enum TestPromptType {
		Agent = 'Agent',
		FullSummarization = 'FullSumm',
		SimpleSummarization = 'SimpleSummarizedHistory'
	}

	async function agentPromptToString(accessor: ITestingServicesAccessor, promptContext: IBuildPromptContext, otherProps?: Partial<AgentPromptProps>, promptType: TestPromptType = TestPromptType.Agent): Promise<string> {
		const instaService = accessor.get(IInstantiationService);
		const endpoint = instaService.createInstance(MockEndpoint, undefined);
		normalizeSummariesOnRounds(promptContext.history);
		if (!promptContext.conversation) {
			promptContext = { ...promptContext, conversation };
		}

		const baseProps = {
			priority: 1,
			endpoint,
			location: ChatLocation.Panel,
			promptContext,
			maxToolResultLength: Infinity,
			...otherProps
		};

		let renderer;
		if (promptType === 'Agent') {
			const customizations = await PromptRegistry.resolveAllCustomizations(instaService, endpoint);
			const props: AgentPromptProps = { ...baseProps, customizations };
			renderer = PromptRenderer.create(instaService, endpoint, AgentPrompt, props);
		} else {
			const propsInfo = instaService.createInstance(SummarizedConversationHistoryPropsBuilder).getProps(baseProps);
			const simpleMode = promptType === TestPromptType.SimpleSummarization;
			renderer = PromptRenderer.create(instaService, endpoint, ConversationHistorySummarizationPrompt, { ...propsInfo.props, simpleMode });
		}

		const r = await renderer.render();
		const summarizedConversationMetadata = r.metadata.get(SummarizedConversationHistoryMetadata);
		if (summarizedConversationMetadata && promptContext.toolCallRounds) {
			for (const toolCallRound of promptContext.toolCallRounds) {
				if (toolCallRound.id === summarizedConversationMetadata.toolCallRoundId) {
					toolCallRound.summary = summarizedConversationMetadata.text;
				}
			}
		}
		addCacheBreakpoints(r.messages);
		return r.messages
			.filter(message => message.role !== Raw.ChatRole.System)
			.map(m => messageToMarkdown(m))
			.join('\n\n')
			.replace(/\\+/g, '/')
			.replace(/The current date is.*/g, '(Date removed from snapshot)');
	}

	function createEditFileToolCall(idx: number): IToolCall {
		return {
			id: `tooluse_${idx}`,
			name: ToolName.EditFile,
			arguments: JSON.stringify({
				filePath: fileTsUri.fsPath, code: `// existing code...\nconsole.log('hi')`
			})
		};
	}

	function createEditFileToolResult(...idxs: number[]): Record<string, LanguageModelToolResult> {
		const result: Record<string, LanguageModelToolResult> = {};
		for (const idx of idxs) {
			result[`tooluse_${idx}`] = new LanguageModelToolResult([new LanguageModelTextPart('success')]);
		}
		return result;
	}

	function getSnapshotFile(promptType: TestPromptType, name: string): string {
		return `./__snapshots__/summarization-${name}-${promptType}.spec.snap`;
	}

	const tools: IBuildPromptContext['tools'] = {
		availableTools: [],
		toolInvocationToken: null as never,
		toolReferences: [],
	};

	test('continuation turns are not rendered in conversation history', async () => {
		const firstTurn = new Turn('id1', { type: 'user', message: 'previous turn message' });
		const continuationTurn = new Turn('id2', { type: 'user', message: 'continuation turn message' }, undefined, [], undefined, undefined, true);

		const promptContext: IBuildPromptContext = {
			chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
			history: [firstTurn, continuationTurn],
			query: 'edit this file',
			toolCallRounds: [],
			tools,
		};

		const rendered = await agentPromptToString(
			accessor,
			promptContext,
			{ enableCacheBreakpoints: true },
			TestPromptType.Agent
		);

		expect(rendered).toContain('previous turn message');
		expect(rendered).not.toContain('continuation turn message');
	});

	test('cannot summarize with no history', async () => {
		const promptContextNoHistory: IBuildPromptContext = {
			chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
			history: [],
			query: 'edit this file',
			toolCallRounds: [],
			tools,
		};
		await expect(() => agentPromptToString(
			accessor, promptContextNoHistory, undefined, TestPromptType.FullSummarization)).rejects.toThrow();
		await expect(() => agentPromptToString(
			accessor,
			{
				...promptContextNoHistory,
				toolCallRounds: [
					new ToolCallRound('ok', [createEditFileToolCall(1)]),
				],
				toolCallResults: createEditFileToolResult(1),
				tools,
			}, undefined, TestPromptType.FullSummarization)).rejects.toThrow();
	});

	async function testTriggerSummarizationDuringToolCalling(promptType: TestPromptType) {
		chatResponse[0] = 'summarized!';
		const toolCallRounds = [
			new ToolCallRound('ok', [createEditFileToolCall(1)]),
			new ToolCallRound('ok 2', [createEditFileToolCall(2)]),
			new ToolCallRound('ok 3', [createEditFileToolCall(3)]),
		];
		await expect(await agentPromptToString(
			accessor,
			{
				chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
				history: [],
				query: 'edit this file',
				toolCallRounds,
				toolCallResults: createEditFileToolResult(1, 2, 3),
				tools
			},
			{
				enableCacheBreakpoints: true,
				triggerSummarize: true,
			}, promptType)).toMatchFileSnapshot(getSnapshotFile(promptType, 'duringToolCalling'));
		if (promptType === TestPromptType.Agent) {
			expect(toolCallRounds.at(-2)?.summary).toBe('summarized!');
		}
	}

	// Summarization for rounds in current turn
	test('trigger summarization during tool calling', async () => await testTriggerSummarizationDuringToolCalling(TestPromptType.Agent));
	test('FullSummarization - trigger summarization during tool calling', async () => await testTriggerSummarizationDuringToolCalling(TestPromptType.FullSummarization));
	test('SimpleSummarization - trigger summarization during tool calling', async () => await testTriggerSummarizationDuringToolCalling(TestPromptType.SimpleSummarization));

	async function testSummaryCurrentTurn(promptType: TestPromptType) {
		const excludedPreviousRound = new ToolCallRound('previous round EXCLUDED', [createEditFileToolCall(1)]);
		const round = new ToolCallRound('ok', [createEditFileToolCall(2)]);
		round.summary = 'summarized!';
		await expect(await agentPromptToString(
			accessor,
			{
				chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
				history: [],
				query: 'edit this file',
				toolCallRounds: [
					excludedPreviousRound,
					round
				],
				toolCallResults: createEditFileToolResult(1, 2),
				tools
			},
			{
				enableCacheBreakpoints: true,
			}, promptType)).toMatchFileSnapshot(getSnapshotFile(promptType, 'currentTurn'));
	}

	// SummarizationPrompt test is not relevant when the last round was summarized
	test('render summary in current turn', async () => await testSummaryCurrentTurn(TestPromptType.Agent));

	async function testSummaryCurrentTurnEarlierRound(promptType: TestPromptType) {
		const round = new ToolCallRound('round 1', [createEditFileToolCall(1)]);
		round.summary = 'summarized!';
		const round2 = new ToolCallRound('round 2', [createEditFileToolCall(2)]);
		const round3 = new ToolCallRound('round 3', [createEditFileToolCall(3)]);
		await expect(await agentPromptToString(
			accessor,
			{
				chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
				history: [],
				query: 'edit this file',
				toolCallRounds: [
					round,
					round2,
					round3
				],
				toolCallResults: createEditFileToolResult(1, 2, 3),
				tools
			},
			{
				enableCacheBreakpoints: true,
			}, promptType)).toMatchFileSnapshot(getSnapshotFile(promptType, 'currentTurnEarlierRound'));
	}

	test('render summary in previous turn', async () => await testSummaryCurrentTurnEarlierRound(TestPromptType.Agent));
	test('FullSummarization - render summary in previous turn', async () => await testSummaryCurrentTurnEarlierRound(TestPromptType.FullSummarization));
	test('SimpleSummarization - render summary in previous turn', async () => await testSummaryCurrentTurnEarlierRound(TestPromptType.SimpleSummarization));

	async function testSummaryPrevTurnMultiple(promptType: TestPromptType) {
		const previousTurn = new Turn('id', { type: 'user', message: 'previous turn excluded' });
		const previousTurnResult: ICopilotChatResultIn = {
			metadata: {
				summary: {
					text: 'summarized 1!',
					toolCallRoundId: 'toolCallRoundId1'
				},
				toolCallRounds: [
					new ToolCallRound('response', [createEditFileToolCall(1)], undefined, 'toolCallRoundId1'),
				],
				toolCallResults: createEditFileToolResult(1),
			}
		};
		previousTurn.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', previousTurnResult);

		const turn = new Turn('id', { type: 'user', message: 'hello' });
		const result: ICopilotChatResultIn = {
			metadata: {
				summary: {
					text: 'summarized 2!',
					toolCallRoundId: 'toolCallRoundId3'
				},
				toolCallRounds: [
					new ToolCallRound('response excluded', [createEditFileToolCall(2)], undefined, 'toolCallRoundId2'),
					new ToolCallRound('response with summary', [createEditFileToolCall(3)], undefined, 'toolCallRoundId3'),
					new ToolCallRound('next response', [createEditFileToolCall(4)], undefined, 'toolCallRoundId4'),
				],
				toolCallResults: createEditFileToolResult(2, 3, 4),
			}
		};
		turn.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', result);

		await expect(await agentPromptToString(
			accessor,
			{
				chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
				history: [previousTurn, turn],
				query: 'edit this file',
				toolCallRounds: [(new ToolCallRound('hello next round', [createEditFileToolCall(5)]))],
				toolCallResults: createEditFileToolResult(5),
				tools
			},
			{
				enableCacheBreakpoints: true,
			}, promptType)).toMatchFileSnapshot(getSnapshotFile(promptType, 'previousTurnMultiple'));
	}

	test('render summary in previous turn (with multiple)', () => testSummaryPrevTurnMultiple(TestPromptType.Agent));
	test('FullSummarization - render summary in previous turn (with multiple)', () => testSummaryPrevTurnMultiple(TestPromptType.FullSummarization));
	test('SimpleSummarization - render summary in previous turn (with multiple)', () => testSummaryPrevTurnMultiple(TestPromptType.SimpleSummarization));

	async function testSummarizeWithNoRoundsInCurrentTurn(promptType: TestPromptType) {
		const previousTurn1 = new Turn('id', { type: 'user', message: 'previous turn 1' });
		previousTurn1.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', {});

		const previousTurn2 = new Turn('id', { type: 'user', message: 'previous turn 2' });
		const previousTurn2Result: ICopilotChatResultIn = {
			metadata: {
				toolCallRounds: [],
				summary: {
					toolCallRoundId: 'previous',
					text: 'previous turn 1 summary'
				}
			}
		};
		previousTurn2.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', previousTurn2Result);

		await expect(await agentPromptToString(
			accessor,
			{
				chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
				history: [previousTurn1, previousTurn2],
				query: 'hello',
				tools
			},
			{
				enableCacheBreakpoints: true,
			}, promptType)).toMatchFileSnapshot(getSnapshotFile(promptType, 'previousTurnNoRounds'));
	}

	test('summary for previous turn, no tool call rounds', async () => testSummarizeWithNoRoundsInCurrentTurn(TestPromptType.Agent));
	test('FullSummarization - summary for previous turn, no tool call rounds', async () => testSummarizeWithNoRoundsInCurrentTurn(TestPromptType.FullSummarization));
	test('SimpleSummarization - summary for previous turn, no tool call rounds', async () => testSummarizeWithNoRoundsInCurrentTurn(TestPromptType.SimpleSummarization));
});
