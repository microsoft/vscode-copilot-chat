/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import type * as vscode from 'vscode';
import { IChatHookService, type IPreToolUseHookResult } from '../../../../../platform/chat/common/chatHookService';
import { IEndpointProvider } from '../../../../../platform/endpoint/common/endpointProvider';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { Event } from '../../../../../util/vs/base/common/event';
import { constObservable } from '../../../../../util/vs/base/common/observable';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../../vscodeTypes';
import { ChatVariablesCollection } from '../../../../prompt/common/chatVariablesCollection';
import type { Conversation } from '../../../../prompt/common/conversation';
import type { IBuildPromptContext, IToolCallRound } from '../../../../prompt/common/intents';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { IToolsService, type IToolValidationResult } from '../../../../tools/common/toolsService';
import { renderPromptElement } from '../../base/promptRenderer';
import { ChatToolCalls } from '../toolCalling';

class CapturingChatHookService implements IChatHookService {
	declare readonly _serviceBrand: undefined;

	public lastPreToolUseCall: {
		readonly toolName: string;
		readonly toolInput: unknown;
		readonly toolCallId: string;
		readonly hooks: vscode.ChatRequestHooks | undefined;
		readonly sessionId: string | undefined;
		readonly token: vscode.CancellationToken | undefined;
	} | undefined;

	constructor(
		private readonly hookResult: IPreToolUseHookResult | undefined,
	) { }

	logConfiguredHooks(): void { }

	async executeHook(): Promise<never[]> {
		return [];
	}

	async executePreToolUseHook(
		toolName: string,
		toolInput: unknown,
		toolCallId: string,
		hooks: vscode.ChatRequestHooks | undefined,
		sessionId?: string,
		token?: vscode.CancellationToken,
	): Promise<IPreToolUseHookResult | undefined> {
		this.lastPreToolUseCall = { toolName, toolInput, toolCallId, hooks, sessionId, token };
		return this.hookResult;
	}

	async executePostToolUseHook(): Promise<undefined> {
		return undefined;
	}
}

class CapturingToolsService implements IToolsService {
	declare readonly _serviceBrand: undefined;

	onWillInvokeTool = Event.None;

	readonly tools: ReadonlyArray<vscode.LanguageModelToolInformation>;
	readonly copilotTools = new Map();
	readonly modelSpecificTools = constObservable([]);

	public lastInvocation: {
		readonly name: string;
		readonly options: vscode.LanguageModelToolInvocationOptions<unknown>;
		readonly endpointModel: string | undefined;
		readonly token: vscode.CancellationToken;
	} | undefined;

	public lastToolResult: vscode.LanguageModelToolResult2 | undefined;

	constructor(tool: vscode.LanguageModelToolInformation) {
		this.tools = [tool];
	}

	getCopilotTool(): undefined {
		return undefined;
	}

	invokeTool(): Thenable<vscode.LanguageModelToolResult2> {
		throw new Error('Not implemented in test');
	}

	async invokeToolWithEndpoint(
		name: string,
		options: vscode.LanguageModelToolInvocationOptions<unknown>,
		endpoint: { model: string } | undefined,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult2> {
		this.lastInvocation = { name, options, endpointModel: endpoint?.model, token };
		const result = new LanguageModelToolResult([new LanguageModelTextPart('tool-ok')]);
		this.lastToolResult = result;
		return result;
	}

	getTool(name: string): vscode.LanguageModelToolInformation | undefined {
		return this.tools.find(t => t.name === name);
	}

	getToolByToolReferenceName(): undefined {
		return undefined;
	}

	validateToolInput(_name: string, input: string): IToolValidationResult {
		return { inputObj: JSON.parse(input) };
	}

	validateToolName(): undefined {
		return undefined;
	}

	getEnabledTools(): vscode.LanguageModelToolInformation[] {
		return [];
	}
}

describe('ChatToolCalls (toolCalling.tsx)', () => {
	test('calls preToolUse hook with validated input and respects hook output', async () => {
		const toolName = 'myTool';
		const toolArgs = JSON.stringify({ x: 1 });
		const toolCallId = 'call-1';
		const hookContext = 'extra policy context';

		const updatedInput = { x: 2, safe: true };
		const hooks: vscode.ChatRequestHooks = { PreToolUse: [] };

		const hookResult: IPreToolUseHookResult = {
			permissionDecision: 'ask',
			permissionDecisionReason: 'Needs confirmation',
			updatedInput,
			additionalContext: [hookContext],
		};

		const toolInfo: vscode.LanguageModelToolInformation = {
			name: toolName,
			description: 'test tool',
			source: undefined,
			inputSchema: undefined,
			tags: [],
		};

		const testingServiceCollection = createExtensionUnitTestingServices();
		const toolsService = new CapturingToolsService(toolInfo);
		const hookService = new CapturingChatHookService(hookResult);
		testingServiceCollection.define(IToolsService, toolsService);
		testingServiceCollection.define(IChatHookService, hookService);

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		const endpointProvider = accessor.get(IEndpointProvider);
		const endpoint = await endpointProvider.getChatEndpoint('gpt-4.1');

		const round: IToolCallRound = {
			id: 'round-1',
			response: 'calling tool',
			toolInputRetry: 0,
			toolCalls: [{ name: toolName, arguments: toolArgs, id: toolCallId }],
		};

		const conversation = { sessionId: 'session-123' } as unknown as Conversation;
		const promptContext: IBuildPromptContext = {
			query: 'test',
			history: [],
			chatVariables: new ChatVariablesCollection(),
			conversation,
			request: { hooks } as unknown as vscode.ChatRequest,
			tools: {
				toolReferences: [],
				toolInvocationToken: {} as vscode.ChatParticipantToolToken,
				availableTools: [toolInfo],
			},
		};

		await renderPromptElement(instantiationService, endpoint, ChatToolCalls, {
			promptContext,
			toolCallRounds: [round],
			toolCallResults: undefined,
		});

		// Hook called with validated (original) input
		expect(hookService.lastPreToolUseCall).toEqual({
			toolName,
			toolInput: { x: 1 },
			toolCallId,
			hooks,
			sessionId: 'session-123',
			token: CancellationToken.None,
		});

		// Tool invoked with updatedInput from hook
		expect(toolsService.lastInvocation?.name).toBe(toolName);
		expect(toolsService.lastInvocation?.options.input).toEqual(updatedInput);
		expect(toolsService.lastInvocation?.options.preToolUseResult).toEqual({
			permissionDecision: 'ask',
			permissionDecisionReason: 'Needs confirmation',
			updatedInput,
		});

		// Hook additionalContext is appended to the tool result content
		const contentText = (toolsService.lastToolResult?.content ?? [])
			.filter((p): p is LanguageModelTextPart => p instanceof LanguageModelTextPart)
			.map(p => p.value)
			.join('\n');
		expect(contentText).toContain('<PreToolUse-context>');
		expect(contentText).toContain(hookContext);
	});
});
