/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SweCustomAgent } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IVSCodeExtensionContext } from '../../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../../platform/log/common/logService';
import { PromptFileParser, type ParsedPromptFile } from '../../../../../platform/promptFiles/common/promptsService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { Emitter, Event } from '../../../../../util/vs/base/common/event';
import { Disposable, DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../../util/vs/base/common/uri';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { IChatCustomAgentsService } from '../../../common/chatCustomAgentsService';
import { CopilotCLIAgents, type ICopilotCLISDK } from '../copilotCli';

const CopilotCLIAgentsConstructor = CopilotCLIAgents as unknown as new (
	chatCustomAgentsService: IChatCustomAgentsService,
	copilotCLISDK: ICopilotCLISDK,
	extensionContext: IVSCodeExtensionContext,
	logService: ILogService,
	workspaceService: IWorkspaceService,
) => CopilotCLIAgents;

function createMockExtensionContext(): IVSCodeExtensionContext {
	const workspaceState = new Map<string, unknown>();
	return {
		extensionPath: '/mock',
		globalState: {
			get: <T>(_key: string, defaultValue?: T) => defaultValue as T,
			update: async () => { },
			keys: () => []
		},
		workspaceState: {
			get: <T>(key: string, defaultValue?: T) => (workspaceState.get(key) as T) ?? defaultValue,
			update: async (key: string, value: unknown) => {
				workspaceState.set(key, value);
			},
			keys: () => [...workspaceState.keys()]
		}
	} as unknown as IVSCodeExtensionContext;
}

class TestChatCustomAgentsService extends Disposable implements IChatCustomAgentsService {
	declare _serviceBrand: undefined;
	private readonly _onDidChangeCustomAgents = this._register(new Emitter<void>());
	readonly onDidChangeCustomAgents: Event<void> = this._onDidChangeCustomAgents.event;

	constructor(private customAgents: ParsedPromptFile[] = []) {
		super();
	}

	getCustomAgents(): ParsedPromptFile[] {
		return [...this.customAgents];
	}

	setCustomAgents(customAgents: ParsedPromptFile[]): void {
		this.customAgents = customAgents;
		this._onDidChangeCustomAgents.fire();
	}
}

function parsePromptFile(fileName: string, content: string): ParsedPromptFile {
	return new PromptFileParser().parse(URI.file(`/workspace/.github/agents/${fileName}`), content);
}

function createMockSDK(agentsByCall: ReadonlyArray<ReadonlyArray<SweCustomAgent>>): ICopilotCLISDK {
	let index = 0;
	const getCustomAgents = vi.fn(async () => {
		const result = agentsByCall[Math.min(index, agentsByCall.length - 1)] ?? [];
		index += 1;
		return result;
	});

	return {
		_serviceBrand: undefined,
		getPackage: vi.fn(async () => ({ getCustomAgents })),
		getAuthInfo: vi.fn(async () => ({ type: 'token' as const, token: 'test-token', host: 'https://github.com' })),
		getRequestId: vi.fn(() => undefined),
		setRequestId: vi.fn(),
	} as unknown as ICopilotCLISDK;
}

function createWorkspaceService(): IWorkspaceService {
	return {
		_serviceBrand: undefined,
		onDidChangeWorkspaceFolders: Event.None,
		getWorkspaceFolders: () => [URI.file('/workspace')]
	} as unknown as IWorkspaceService;
}

describe('CopilotCLIAgents', () => {
	const disposables = new DisposableStore();
	let logService: ILogService;

	beforeEach(() => {
		const services = disposables.add(createExtensionUnitTestingServices());
		logService = services.createTestingAccessor().get(ILogService);
	});

	afterEach(() => {
		disposables.clear();
	});

	function createAgents(options: { sdkAgentsByCall: ReadonlyArray<ReadonlyArray<SweCustomAgent>>; promptAgents?: ParsedPromptFile[] }): { agents: CopilotCLIAgents; chatCustomAgentsService: TestChatCustomAgentsService; sdk: ICopilotCLISDK } {
		const chatCustomAgentsService = new TestChatCustomAgentsService(options.promptAgents ?? []);
		const sdk = createMockSDK(options.sdkAgentsByCall);
		const agents = new CopilotCLIAgentsConstructor(
			chatCustomAgentsService,
			sdk,
			createMockExtensionContext(),
			logService,
			createWorkspaceService(),
		);
		disposables.add(chatCustomAgentsService);
		disposables.add(agents);
		return { agents, chatCustomAgentsService, sdk };
	}

	it('prefers prompt-derived agents over SDK agents with the same name', async () => {
		const promptAgent = parsePromptFile('merge.agent.md', `---
name: MergeMe
description: Prompt description
tools: []
model: ['gpt-4.1', 'gpt-4o']
disable-model-invocation: true
---
Prompt body`);
		const { agents } = createAgents({
			sdkAgentsByCall: [[{
				name: 'mergeme',
				displayName: 'SDK MergeMe',
				description: 'SDK description',
				tools: ['sdk-tool'],
				prompt: async () => 'sdk body',
				disableModelInvocation: false,
			}]],
			promptAgents: [promptAgent]
		});

		const result = await agents.getAgents();

		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('MergeMe');
		expect(result[0].displayName).toBe('MergeMe');
		expect(result[0].description).toBe('Prompt description');
		expect(result[0].tools).toBeNull();
		expect(result[0].model).toBe('gpt-4.1');
		expect(result[0].disableModelInvocation).toBe(true);
		expect(await result[0].prompt()).toBe('Prompt body');
	});

	it('derives agent name from filename when frontmatter name is missing', async () => {
		const { agents } = createAgents({
			sdkAgentsByCall: [[]],
			promptAgents: [parsePromptFile('invalid.agent.md', `---
description: Missing name
tools: ['read_file']
---
Body`)]
		});

		const result = await agents.getAgents();
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('invalid');
		expect(result[0].displayName).toBe('invalid');
		expect(result[0].description).toBe('Missing name');
		expect(result[0].tools).toEqual(['read_file']);
	});

	it('refreshes cached agents when custom agents change', async () => {
		const { agents, chatCustomAgentsService, sdk } = createAgents({
			sdkAgentsByCall: [[], []],
			promptAgents: [parsePromptFile('first.agent.md', `---
name: First
description: First prompt agent
---
First body`)]
		});

		const first = await agents.getAgents();
		chatCustomAgentsService.setCustomAgents([parsePromptFile('second.agent.md', `---
name: Second
description: Second prompt agent
---
Second body`)]);
		const second = await agents.getAgents();

		expect(first.map(agent => agent.name)).toEqual(['First']);
		expect(second.map(agent => agent.name)).toEqual(['Second']);
		expect(sdk.getPackage).toHaveBeenCalled();
	});
});
