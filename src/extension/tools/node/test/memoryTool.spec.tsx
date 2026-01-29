/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, expect, suite, test } from 'vitest';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { IAgentMemoryService, RepoMemoryEntry } from '../../common/agentMemoryService';
import { ContributedToolName } from '../../common/toolNames';
import { IToolsService } from '../../common/toolsService';
import { toolResultToString } from './toolTestUtils';

/**
 * Simplified memory parameters matching the new memory tool API.
 */
interface ISimplifiedMemoryParams {
	subject: string;
	fact: string;
	citations: string;
	reason: string;
	category: string;
}

/**
 * Mock AgentMemoryService that enables memory for testing.
 */
class MockAgentMemoryService implements IAgentMemoryService {
	declare readonly _serviceBrand: undefined;
	private storedMemories: RepoMemoryEntry[] = [];

	async checkMemoryEnabled(): Promise<boolean> {
		return true;
	}

	async getRepoMemories(_limit?: number): Promise<RepoMemoryEntry[] | undefined> {
		return this.storedMemories;
	}

	async storeRepoMemory(memory: RepoMemoryEntry): Promise<boolean> {
		this.storedMemories.push(memory);
		return true;
	}

	clearMemories(): void {
		this.storedMemories = [];
	}
}

/**
 * Mock AgentMemoryService that simulates memory being disabled.
 */
class DisabledMockAgentMemoryService implements IAgentMemoryService {
	declare readonly _serviceBrand: undefined;

	async checkMemoryEnabled(): Promise<boolean> {
		return false;
	}

	async getRepoMemories(_limit?: number): Promise<RepoMemoryEntry[] | undefined> {
		return undefined;
	}

	async storeRepoMemory(_memory: RepoMemoryEntry): Promise<boolean> {
		return false;
	}
}

suite('MemoryTool', () => {
	let accessor: ITestingServicesAccessor;
	let mockMemoryService: MockAgentMemoryService;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		// Override AgentMemoryService with a mock that enables memory
		mockMemoryService = new MockAgentMemoryService();
		services.define(IAgentMemoryService, mockMemoryService);
		accessor = services.createTestingAccessor();
	});

	afterAll(() => {
		accessor.dispose();
	});

	test('store memory successfully', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: ISimplifiedMemoryParams = {
			subject: 'build-command',
			fact: 'npm run build',
			citations: 'package.json:10',
			reason: 'Build command for the project',
			category: 'bootstrap_and_build'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('Successfully stored memory');
		expect(resultStr).toContain('build-command');
	});

	test('store memory with minimal fields', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: ISimplifiedMemoryParams = {
			subject: 'test-pattern',
			fact: 'Jest is used for testing',
			citations: 'package.json:15',
			reason: 'Testing framework preference',
			category: 'testing'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('Successfully stored memory');
	});

	test('store coding style preference', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: ISimplifiedMemoryParams = {
			subject: 'indentation',
			fact: 'Uses tabs for indentation',
			citations: '.editorconfig:3',
			reason: 'Coding style preference',
			category: 'code_style'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('Successfully stored memory');
		expect(resultStr).toContain('indentation');
	});
});

suite('MemoryTool when disabled', () => {
	let accessor: ITestingServicesAccessor;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		// Override AgentMemoryService with a mock that disables memory
		services.define(IAgentMemoryService, new DisabledMockAgentMemoryService());
		accessor = services.createTestingAccessor();
	});

	afterAll(() => {
		accessor.dispose();
	});

	test('returns error when memory is not enabled', async () => {
		const toolsService = accessor.get(IToolsService);

		const input: ISimplifiedMemoryParams = {
			subject: 'test',
			fact: 'test fact',
			citations: 'file.ts:1',
			reason: 'test reason',
			category: 'general'
		};

		const result = await toolsService.invokeTool(ContributedToolName.Memory, { input, toolInvocationToken: null as never }, CancellationToken.None);
		const resultStr = await toolResultToString(accessor, result);

		expect(resultStr).toContain('Error');
		expect(resultStr).toContain('Copilot Memory is not enabled');
	});
});
