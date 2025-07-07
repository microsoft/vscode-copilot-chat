/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, assert, beforeAll, beforeEach, expect, suite, test } from 'vitest';
import { IChatMLFetcher } from '../../../../../platform/chat/common/chatMLFetcher';
import { ChatLocation } from '../../../../../platform/chat/common/commonTypes';
import { StaticChatMLFetcher } from '../../../../../platform/chat/test/common/staticChatMLFetcher';
import { CodeGenerationTextInstruction, ConfigKey, IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { MockEndpoint } from '../../../../../platform/endpoint/test/node/mockEndpoint';
import { messageToMarkdown } from '../../../../../platform/log/common/messageStringify';
import { IResponseDelta } from '../../../../../platform/networking/common/fetch';
import { rawMessageToCAPI } from '../../../../../platform/networking/common/openai';
import { ITestingServicesAccessor } from '../../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { ExtHostDocumentData } from '../../../../../util/common/test/shims/textDocument';
import { URI } from '../../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../../vscodeTypes';
import { addCacheBreakpoints } from '../../../../intents/node/agentIntent';
import { ChatVariablesCollection } from '../../../../prompt/common/chatVariablesCollection';
import { Conversation, ICopilotChatResultIn, Turn, TurnStatus } from '../../../../prompt/common/conversation';
import { IBuildPromptContext, IToolCall } from '../../../../prompt/common/intents';
import { ToolCallRound } from '../../../../prompt/common/toolCallRound';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ToolName } from '../../../../tools/common/toolNames';
import { IToolsService } from '../../../../tools/common/toolsService';
import { PromptRenderer } from '../../base/promptRenderer';
import { TerminalAndTaskStatePromptElement } from '../../base/terminalAndTaskState';
import { AgentPrompt, AgentPromptProps } from '../agentPrompt';

suite('AgentPrompt', () => {
	let accessor: ITestingServicesAccessor;
	let chatResponse: (string | IResponseDelta[])[] = [];
	const fileTsUri = URI.file('/workspace/file.ts');

	let conversation: Conversation;

	beforeAll(() => {
		const testDoc = ExtHostDocumentData.create(fileTsUri, 'line 1\nline 2\n\nline 4\nline 5', 'ts').document;

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

	async function agentPromptToString(accessor: ITestingServicesAccessor, promptContext: IBuildPromptContext, otherProps?: Partial<AgentPromptProps>): Promise<string> {
		const instaService = accessor.get(IInstantiationService);
		const endpoint = instaService.createInstance(MockEndpoint);
		if (!promptContext.conversation) {
			promptContext = { ...promptContext, conversation };
		}

		const baseProps = {
			priority: 1,
			endpoint,
			location: ChatLocation.Panel,
			promptContext,
			...otherProps
		};

		const props: AgentPromptProps = baseProps;
		const renderer = PromptRenderer.create(instaService, endpoint, AgentPrompt, props);

		const r = await renderer.render();
		addCacheBreakpoints(r.messages);
		return rawMessageToCAPI(r.messages)
			.map(messageToMarkdown)
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


	test('simple case', async () => {
		expect(await agentPromptToString(accessor, {
			chatVariables: new ChatVariablesCollection(),
			history: [],
			query: 'hello',
		}, undefined)).toMatchSnapshot();
	});

	test('all tools, apply_patch', async () => {
		const toolsService = accessor.get(IToolsService);
		expect(await agentPromptToString(accessor, {
			chatVariables: new ChatVariablesCollection(),
			history: [],
			query: 'hello',
			tools: {
				availableTools: toolsService.tools.filter(tool => tool.name !== ToolName.ReplaceString && tool.name !== ToolName.EditFile),
				toolInvocationToken: null as never,
				toolReferences: [],
			}
		}, undefined)).toMatchSnapshot();
	});

	test('all tools, replace_string/insert_edit', async () => {
		const toolsService = accessor.get(IToolsService);
		expect(await agentPromptToString(accessor, {
			chatVariables: new ChatVariablesCollection(),
			history: [],
			query: 'hello',
			tools: {
				availableTools: toolsService.tools.filter(tool => tool.name !== ToolName.ApplyPatch),
				toolInvocationToken: null as never,
				toolReferences: [],
			}
		}, undefined)).toMatchSnapshot();
	});

	test('one attachment', async () => {
		expect(await agentPromptToString(accessor, {
			chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
			history: [],
			query: 'hello',
		}, undefined)).toMatchSnapshot();
	});

	const tools: IBuildPromptContext['tools'] = {
		availableTools: [],
		toolInvocationToken: null as never,
		toolReferences: [],
	};

	test('tool use', async () => {
		expect(await agentPromptToString(
			accessor,
			{
				chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
				history: [],
				query: 'edit this file',
				toolCallRounds: [
					new ToolCallRound('ok', [createEditFileToolCall(1)]),
				],
				toolCallResults: createEditFileToolResult(1),
				tools,
			}, undefined)).toMatchSnapshot();
	});

	test('cache BPs', async () => {
		expect(await agentPromptToString(
			accessor,
			{
				chatVariables: new ChatVariablesCollection([{ id: 'vscode.file', name: 'file', value: fileTsUri }]),
				history: [],
				query: 'edit this file',
			},
			{
				enableCacheBreakpoints: true,
			})).toMatchSnapshot();
	});

	test('cache BPs with multi tool call rounds', async () => {
		let toolIdx = 0;
		const previousTurn = new Turn('id', { type: 'user', message: 'previous turn' });
		const previousTurnResult: ICopilotChatResultIn = {
			metadata: {
				toolCallRounds: [
					new ToolCallRound('response', [
						createEditFileToolCall(toolIdx++),
						createEditFileToolCall(toolIdx++),
					], undefined, 'toolCallRoundId1'),
					new ToolCallRound('response 2', [
						createEditFileToolCall(toolIdx++),
						createEditFileToolCall(toolIdx++),
					], undefined, 'toolCallRoundId1'),
				],
				toolCallResults: createEditFileToolResult(0, 1, 2, 3),
			}
		};
		previousTurn.setResponse(TurnStatus.Success, { type: 'user', message: 'response' }, 'responseId', previousTurnResult);

		expect(await agentPromptToString(
			accessor,
			{
				chatVariables: new ChatVariablesCollection([]),
				history: [previousTurn],
				query: 'edit this file',
				toolCallRounds: [
					new ToolCallRound('ok', [
						createEditFileToolCall(toolIdx++),
						createEditFileToolCall(toolIdx++),
					]),
					new ToolCallRound('ok', [
						createEditFileToolCall(toolIdx++),
						createEditFileToolCall(toolIdx++),
					]),
				],
				toolCallResults: createEditFileToolResult(4, 5, 6, 7),
				tools,
			},
			{
				enableCacheBreakpoints: true,
			})).toMatchSnapshot();
	});

	suite('TerminalAndTaskStatePromptElement', () => {
		test('Copilot terminals and tasks', async () => {
			const tasksService: any = {};
			const terminalService: any = {};

			tasksService.getTasks = () => [[null, [
				{
					label: 'npm: build',
					isBackground: false,
					type: 'npm',
					command: 'build',
					script: 'build',
					problemMatcher: ['matcher1'],
					group: { isDefault: true, kind: 'build' },
					dependsOn: 'prebuild',
				},
				{
					label: 'npm: watch',
					isBackground: true,
					type: 'npm',
					command: 'watch',
					script: 'watch',
					problemMatcher: [],
					group: { isDefault: false, kind: 'test' },
				},
			]]];
			tasksService.isTaskActive = () => true;

			terminalService.terminals = [
				{ name: 'Terminal 1', id: '1' },
				{ name: 'Terminal 2', id: '2' },
			];
			terminalService.getCopilotTerminals = async () => [
				{ name: 'Terminal 1', id: '1' },
				{ name: 'Terminal 2', id: '2' },
			];
			terminalService.getLastCommandForTerminal = (term: { id: string }) => {
				if (term.id === '1') {
					return { commandLine: 'npm run build', cwd: '/workspace', exitCode: 0 };
				} else if (term.id === '2') {
					return { commandLine: 'npm test', cwd: '/workspace', exitCode: 1 };
				}
				return undefined;
			};

			const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
			const rendered = await prompt.render();
			const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
			assert(output.includes('Active Tasks:'));
			assert(output.includes('npm: build'));
			assert(output.includes('npm: watch'));
			assert(output.includes('Terminal 1'));
			assert(output.includes('Terminal 2'));
			assert(output.includes('npm run build'));
			assert(output.includes('npm test'));
			assert(output.includes('/workspace'));
		});
		test('Terminals (non-Copilot) and active tasks', async () => {
			const tasksService: any = {};
			const terminalService: any = {};

			tasksService.getTasks = () => [[null, [
				{
					label: 'npm: build',
					isBackground: false,
					type: 'npm',
					command: 'build',
					script: 'build',
					problemMatcher: ['matcher1'],
					group: { isDefault: true, kind: 'build' },
					dependsOn: 'prebuild',
				},
				{
					label: 'npm: watch',
					isBackground: true,
					type: 'npm',
					command: 'watch',
					script: 'watch',
					problemMatcher: [],
					group: { isDefault: false, kind: 'test' },
				},
			]]];
			tasksService.isTaskActive = () => true;

			terminalService.terminals = [
				{ name: 'Terminal 1', id: '1' },
				{ name: 'Terminal 2', id: '2' },
			];
			terminalService.getCopilotTerminals = async () => [];
			terminalService.getLastCommandForTerminal = (term: { id: string }) => {
				if (term.id === '1') {
					return { commandLine: 'npm run build', cwd: '/workspace', exitCode: 0 };
				} else if (term.id === '2') {
					return { commandLine: 'npm test', cwd: '/workspace', exitCode: 1 };
				}
				return undefined;
			};

			const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
			const rendered = await prompt.render();

			const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
			assert(output.includes('Active Tasks:'));
			assert(output.includes('npm: build'));
			assert(output.includes('npm: watch'));
			assert(output.includes('No active terminals found.'));
		});
		test('Copilot terminals and no active tasks', async () => {

			const tasksService: any = {};
			const terminalService: any = {};

			// Mock getTasks and isTaskActive
			const uri = URI.from({ path: 'workspace:/', scheme: 'file' });
			const tasks: any[] = [];
			tasksService.getTasks = ((workspaceFolder?: URI) => {
				if (workspaceFolder) {
					return tasks;
				}
				return [[uri, tasks]];
			}) as typeof tasksService.getTasks;
			tasksService.isTaskActive = () => true;

			terminalService.terminals = [
				{ name: 'Terminal 1', id: '1' },
				{ name: 'Terminal 2', id: '2' },
			];
			terminalService.getCopilotTerminals = async () => [
				{ name: 'Terminal 1', id: '1' },
				{ name: 'Terminal 2', id: '2' },
			];
			terminalService.getLastCommandForTerminal = (term: any) => {
				if (term.id === '1') {
					return { commandLine: 'npm run build', cwd: '/workspace', exitCode: 0 };
				} else if (term.id === '2') {
					return { commandLine: 'npm test', cwd: '/workspace', exitCode: 1 };
				}
				return undefined;
			};

			const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
			const rendered = await prompt.render();

			// Convert rendered output to string for assertions
			const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
			assert(output.includes('No active tasks found.'));
			assert(output.includes('Terminal 1'));
			assert(output.includes('Terminal 2'));
			assert(output.includes('npm run build'));
			assert(output.includes('npm test'));
			assert(output.includes('/workspace'));
		});
		test('Neither Copilot terminals nor active tasks', async () => {
			const tasksService: any = {};
			const terminalService: any = {};

			tasksService.getTasks = () => [];
			tasksService.isTaskActive = () => true;

			terminalService.terminals = [
				{ name: 'Terminal 1', id: '1' },
				{ name: 'Terminal 2', id: '2' },
			];
			terminalService.getCopilotTerminals = async () => [];
			terminalService.getLastCommandForTerminal = (term: any) => {
				return undefined;
			};

			const prompt = new TerminalAndTaskStatePromptElement({}, tasksService, terminalService);
			const rendered = await prompt.render();

			// Convert rendered output to string for assertions
			const output = typeof rendered === 'string' ? rendered : JSON.stringify(rendered) ?? '';
			assert(output.includes('No active tasks or terminals found.'));
		});
	});
});
