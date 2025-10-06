/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, expect, suite, test } from 'vitest';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IMemoryItem, IMemoryListOptions, IMemorySearchOptions, IMemorySearchResult, IMemoryService, IMemoryStoreOptions } from '../../../memory/common/memoryService';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ToolName } from '../../common/toolNames';
import { IToolsService } from '../../common/toolsService';
import { toolResultToString } from './toolTestUtils';

// Mock memory service for testing
class MockMemoryService implements IMemoryService {
	_serviceBrand: undefined;

	private memories: IMemoryItem[] = [];
	private nextId = 1;

	async storeMemory(memory: Omit<IMemoryItem, 'id' | 'embedding'>, options?: IMemoryStoreOptions): Promise<IMemoryItem> {
		const storedMemory: IMemoryItem = {
			id: `memory-${this.nextId++}`,
			...memory
		};
		this.memories.push(storedMemory);
		return storedMemory;
	}

	async searchMemories(query: string, options?: IMemorySearchOptions): Promise<IMemorySearchResult[]> {
		const filtered = this.memories.filter(m =>
			m.content.toLowerCase().includes(query.toLowerCase()) &&
			(!options?.tags || options.tags.every(tag => m.tags.includes(tag)))
		);

		return filtered.slice(0, options?.maxResults || 10).map(memory => ({
			memory,
			similarity: 0.9,
			matchType: 'text' as const
		}));
	}

	async listMemories(options?: IMemoryListOptions): Promise<IMemoryItem[]> {
		let filtered = this.memories;
		if (options?.tags) {
			filtered = filtered.filter(m => options.tags!.every(tag => m.tags.includes(tag)));
		}
		return filtered.slice(0, options?.limit || 100);
	}

	async getMemory(id: string): Promise<IMemoryItem | undefined> {
		return this.memories.find(m => m.id === id);
	}

	async updateMemory(id: string, updates: Partial<Omit<IMemoryItem, 'id'>>): Promise<IMemoryItem> {
		const memory = this.memories.find(m => m.id === id);
		if (!memory) {
			throw new Error(`Memory with ID ${id} not found`);
		}
		Object.assign(memory, updates);
		return memory;
	}

	async deleteMemory(id: string): Promise<void> {
		const index = this.memories.findIndex(m => m.id === id);
		if (index === -1) {
			throw new Error(`Memory with ID ${id} not found`);
		}
		this.memories.splice(index, 1);
	}

	async getTags(): Promise<string[]> {
		const allTags = this.memories.flatMap(m => m.tags);
		return [...new Set(allTags)];
	}

	async clearMemories(tags?: string[]): Promise<void> {
		if (tags) {
			this.memories = this.memories.filter(m => !tags.some(tag => m.tags.includes(tag)));
		} else {
			this.memories = [];
		}
	}

	async exportMemories(format: 'json' | 'markdown', options?: IMemoryListOptions): Promise<string> {
		const memories = await this.listMemories(options);
		if (format === 'json') {
			return JSON.stringify(memories, null, 2);
		} else {
			return memories.map(m => `# ${m.content}\nTags: ${m.tags.join(', ')}\n`).join('\n');
		}
	}

	async importMemories(data: string, format: 'json' | 'markdown'): Promise<IMemoryItem[]> {
		if (format === 'json') {
			const memories = JSON.parse(data) as IMemoryItem[];
			this.memories.push(...memories);
			return memories;
		}
		throw new Error('Markdown import not implemented in mock');
	}
}

suite('MemoryTool', () => {
	let accessor: ITestingServicesAccessor;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		services.define(IMemoryService, new SyncDescriptor(MockMemoryService));
		accessor = services.createTestingAccessor();
	});

	afterAll(() => {
		accessor.dispose();
	});

	test('stores memory successfully', async () => {
		const toolsService = accessor.get(IToolsService);

		const input = {
			action: 'store' as const,
			content: 'This is a test memory',
			tags: ['test', 'example']
		};

		const result = await toolsService.invokeTool(
			ToolName.Memory,
			{ input, toolInvocationToken: null as never },
			CancellationToken.None
		);

		const resultString = await toolResultToString(accessor, result);
		expect(resultString).toMatch(/Memory stored successfully with ID: memory-\d+/);
	});

	test('searches memories successfully', async () => {
		// First store a memory through the tool
		const toolsService = accessor.get(IToolsService);

		await toolsService.invokeTool(
			ToolName.Memory,
			{
				input: {
					action: 'store' as const,
					content: 'This is about TypeScript programming',
					tags: ['programming', 'typescript']
				},
				toolInvocationToken: null as never
			},
			CancellationToken.None
		);

		const input = {
			action: 'search' as const,
			query: 'TypeScript',
			maxResults: 5
		};

		const result = await toolsService.invokeTool(
			ToolName.Memory,
			{ input, toolInvocationToken: null as never },
			CancellationToken.None
		);

		const resultString = await toolResultToString(accessor, result);
		expect(resultString).toContain('Found 1 memory results');
		expect(resultString).toContain('TypeScript programming');
	});

	test('lists memories successfully', async () => {
		const toolsService = accessor.get(IToolsService);

		const input = {
			action: 'list' as const,
			maxResults: 10
		};

		const result = await toolsService.invokeTool(
			ToolName.Memory,
			{ input, toolInvocationToken: null as never },
			CancellationToken.None
		);

		const resultString = await toolResultToString(accessor, result);
		expect(resultString).toMatch(/Memory list \(\d+ items\):/);
	});

	test('throws error for invalid store action', async () => {
		const toolsService = accessor.get(IToolsService);

		const input = {
			action: 'store' as const,
			// Missing required content
			tags: ['test']
		};

		await expect(
			toolsService.invokeTool(
				ToolName.Memory,
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			)
		).rejects.toThrow('Content is required for storing memory');
	});

	test('throws error for invalid search action', async () => {
		const toolsService = accessor.get(IToolsService);

		const input = {
			action: 'search' as const,
			// Missing required query
			maxResults: 5
		};

		await expect(
			toolsService.invokeTool(
				ToolName.Memory,
				{ input, toolInvocationToken: null as never },
				CancellationToken.None
			)
		).rejects.toThrow('Query is required for searching memory');
	});
});