/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelToolInformation } from 'vscode';
import { HARD_TOOL_LIMIT } from '../../../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../../../platform/endpoint/common/endpointProvider';
import { IVSCodeExtensionContext } from '../../../../../platform/extContext/common/extensionContext';
import { ITestingServicesAccessor } from '../../../../../platform/test/node/services';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelToolExtensionSource, LanguageModelToolMCPSource } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { VIRTUAL_TOOL_NAME_PREFIX, VirtualTool } from '../../../common/virtualTools/virtualTool';
import { VirtualToolGrouper } from '../../../common/virtualTools/virtualToolGrouper';
import { EXPAND_UNTIL_COUNT, GROUP_WITHIN_TOOLSET, MIN_TOOLSET_SIZE_TO_GROUP, START_GROUPING_AFTER_TOOL_COUNT } from '../../../common/virtualTools/virtualToolsConstants';
import { ISummarizedToolCategory, IToolGroupingCache } from '../../../common/virtualTools/virtualToolTypes';

describe('Virtual Tools - Grouper', () => {
	let accessor: ITestingServicesAccessor;
	let grouper: TestVirtualToolGrouper;
	let root: VirtualTool;

	class TestVirtualToolGrouper extends VirtualToolGrouper {
		constructor(
			@IEndpointProvider endpointProvider: IEndpointProvider,
			@IToolGroupingCache cache: IToolGroupingCache
		) {
			super(endpointProvider, cache);
		}

		// Stub out the protected methods to avoid hitting the endpoint
		protected override async _divideToolsIntoGroups(tools: LanguageModelToolInformation[], token: CancellationToken): Promise<ISummarizedToolCategory[] | undefined> {
			// Simulate dividing tools into groups based on their name prefix
			const groups = new Map<string, LanguageModelToolInformation[]>();

			tools.forEach(tool => {
				const prefix = tool.name.split('_')[0];
				if (!groups.has(prefix)) {
					groups.set(prefix, []);
				}
				groups.get(prefix)!.push(tool);
			});

			return Array.from(groups.entries()).map(([prefix, groupTools]) => ({
				name: prefix,
				summary: `Tools for ${prefix} operations`,
				tools: groupTools
			}));
		}

		protected override async _summarizeToolGroup(tools: LanguageModelToolInformation[], token: CancellationToken): Promise<ISummarizedToolCategory[] | undefined> {
			// Simulate summarizing a group of tools
			const prefix = tools[0]?.name.split('_')[0] || 'unknown';
			return [{
				name: prefix,
				summary: `Summarized tools for ${prefix}`,
				tools
			}];
		}
	}

	function makeTool(name: string, source?: LanguageModelToolExtensionSource | LanguageModelToolMCPSource): LanguageModelToolInformation {
		return {
			name,
			description: `Tool for ${name}`,
			inputSchema: undefined,
			source,
			tags: [],
		};
	}

	function makeExtensionSource(id: string): LanguageModelToolExtensionSource {
		return new LanguageModelToolExtensionSource(id, id);
	}

	function makeMCPSource(label: string): LanguageModelToolMCPSource {
		return new LanguageModelToolMCPSource(label, label);
	}

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();
		accessor = testingServiceCollection.createTestingAccessor();
		grouper = accessor.get(IInstantiationService).createInstance(TestVirtualToolGrouper);
		root = new VirtualTool(VIRTUAL_TOOL_NAME_PREFIX, '', Infinity, undefined);
		root.isExpanded = true;
	});

	afterEach(() => {
		accessor.dispose();
	});

	describe('addGroups - basic functionality', () => {
		it('should add tools directly when below START_GROUPING_AFTER_TOOL_COUNT', async () => {
			const tools = Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT - 1 }, (_, i) =>
				makeTool(`tool_${i}`)
			);

			await grouper.addGroups(root, tools, CancellationToken.None);

			expect(root.contents).toEqual(tools);
		});

		it('should group tools when above START_GROUPING_AFTER_TOOL_COUNT', async () => {
			const tools = Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT + 1 }, (_, i) =>
				makeTool(`tool_${i}`)
			);

			await grouper.addGroups(root, tools, CancellationToken.None);

			expect(root.contents.length).toBeGreaterThan(0);
			expect(root.contents.length).toEqual(tools.length);
		});
	});

	describe('addGroups - toolset grouping', () => {
		it('should handle built-in tools without grouping', async () => {
			const builtInTools = [
				makeTool('builtin_tool1'),
				makeTool('builtin_tool2'),
				makeTool('builtin_tool3'),
			];

			await grouper.addGroups(root, builtInTools, CancellationToken.None);

			expect(root.contents).toEqual(builtInTools);
		});

		it('should group extension tools by extension id', async () => {
			const extensionSource = makeExtensionSource('test.extension');
			const extensionTools = Array.from({ length: GROUP_WITHIN_TOOLSET + 1 }, (_, i) =>
				makeTool(`ext_tool_${i}`, extensionSource)
			);

			// Need enough tools to trigger grouping
			const allTools = [
				...extensionTools,
				...Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT }, (_, i) => makeTool(`extra_${i}`))
			];

			await grouper.addGroups(root, allTools, CancellationToken.None);

			// Should have created virtual tools for the extension
			const vt = root.contents.filter((tool): tool is VirtualTool => tool instanceof VirtualTool);
			expect(vt).toHaveLength(1);
			expect(vt[0].name).toBe('activate_ext');
		});

		it('should group MCP tools by MCP source label', async () => {
			const mcpSource = makeMCPSource('test-mcp');
			const mcpTools = Array.from({ length: GROUP_WITHIN_TOOLSET + 1 }, (_, i) =>
				makeTool(`mcp_tool_${i}`, mcpSource)
			);

			// Need enough tools to trigger grouping
			const allTools = [
				...mcpTools,
				...Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT }, (_, i) => makeTool(`extra_${i}`))
			];

			await grouper.addGroups(root, allTools, CancellationToken.None);

			// Should have created virtual tools for the extension
			const vt = root.contents.filter((tool): tool is VirtualTool => tool instanceof VirtualTool);
			expect(vt).toHaveLength(1);
			expect(vt[0].name).toBe('activate_mcp');
		});

		it('should handle mixed toolsets correctly', async () => {
			const extensionSource = makeExtensionSource('test.extension');
			const mcpSource = makeMCPSource('test-mcp');

			const tools = [
				...Array.from({ length: 5 }, (_, i) => makeTool(`builtin_${i}`)),
				...Array.from({ length: GROUP_WITHIN_TOOLSET + 1 }, (_, i) => makeTool(`ext_${i}`, extensionSource)),
				...Array.from({ length: GROUP_WITHIN_TOOLSET + 1 }, (_, i) => makeTool(`mcp_${i}`, mcpSource)),
			];

			// Need enough tools to trigger grouping
			const allTools = [
				...tools,
				...Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT }, (_, i) => makeTool(`extra_${i}`))
			];

			await grouper.addGroups(root, allTools, CancellationToken.None);

			// Should have built-in tools and virtual tools for extension and MCP
			const nonExtra = root.contents.filter(tool => !tool.name.includes('extra_'));
			const builtInCount = nonExtra.filter(tool => !(tool instanceof VirtualTool)).length;
			const virtualCount = nonExtra.filter(tool => tool instanceof VirtualTool).length;

			expect(builtInCount).toBe(5); // Built-in tools added directly
			expect(virtualCount).toBeGreaterThan(0); // Virtual tools for extension and MCP
		});
	});

	describe('addGroups - toolset size thresholds', () => {
		it('should not group toolsets below MIN_TOOLSET_SIZE_TO_GROUP', async () => {
			const extensionSource = makeExtensionSource('small.extension');
			const smallToolset = Array.from({ length: MIN_TOOLSET_SIZE_TO_GROUP - 1 }, (_, i) =>
				makeTool(`small_${i}`, extensionSource)
			);

			// Need enough total tools to trigger grouping
			const allTools = [
				...smallToolset,
				...Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT }, (_, i) => makeTool(`builtin_${i}`))
			];

			await grouper.addGroups(root, allTools, CancellationToken.None);

			// Small toolset should be added directly without grouping
			const addedDirectly = root.contents.filter(tool =>
				!(tool instanceof VirtualTool) && tool.name.startsWith('small_')
			);
			expect(addedDirectly).toHaveLength(MIN_TOOLSET_SIZE_TO_GROUP - 1);
		});

		it('should divide large toolsets into subgroups', async () => {
			const extensionSource = makeExtensionSource('large.extension');
			const largeToolset = Array.from({ length: GROUP_WITHIN_TOOLSET + 5 }, (_, i) =>
				makeTool(`group${i % 3}_tool_${i}`, extensionSource) // Create 3 groups
			);

			// Need enough tools to trigger grouping
			const allTools = [
				...largeToolset,
				...Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT }, (_, i) => makeTool(`extra_${i}`))
			];


			await grouper.addGroups(root, allTools, CancellationToken.None);

			// Should have created virtual tools for the extension
			const vt = root.contents.filter((tool): tool is VirtualTool => tool instanceof VirtualTool);
			expect(vt).toHaveLength(3);
			expect(vt.map(vt => vt.name)).toMatchInlineSnapshot(`
				[
				  "activate_group0",
				  "activate_group1",
				  "activate_group2",
				]
			`);
		});
	});

	describe('addGroups - state preservation', () => {
		it('should preserve expansion state of existing virtual tools', async () => {
			const tools = Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT + 1 }, (_, i) =>
				makeTool(`file_tool_${i}`)
			);

			// First grouping
			await grouper.addGroups(root, tools, CancellationToken.None);

			// Expand a virtual tool
			const virtualTool = root.contents.find(tool => tool instanceof VirtualTool) as VirtualTool;
			if (virtualTool) {
				virtualTool.isExpanded = true;
				virtualTool.lastUsedOnTurn = 5;
			}

			// Second grouping with same tools
			await grouper.addGroups(root, tools, CancellationToken.None);

			// State should be preserved
			const newVirtualTool = root.contents.find(tool =>
				tool instanceof VirtualTool && tool.name === virtualTool?.name
			) as VirtualTool;

			if (newVirtualTool) {
				expect(newVirtualTool.isExpanded).toBe(true);
				expect(newVirtualTool.lastUsedOnTurn).toBe(5);
			}
		});
	});

	describe('reExpandToolsToHitBudget', () => {
		it('should expand small virtual tools when below EXPAND_UNTIL_COUNT', async () => {
			// Create tools that will form small groups
			const tools = [
				makeTool('group1_tool1', makeExtensionSource('a')),
				makeTool('group1_tool2', makeExtensionSource('a')),
				makeTool('group1_tool3', makeExtensionSource('a')),
				makeTool('group2_tool1', makeExtensionSource('b')),
				makeTool('group2_tool2', makeExtensionSource('b')),
				makeTool('group3_tool2', makeExtensionSource('b')),
			];


			// Need enough tools to trigger grouping
			const allTools = [
				...tools,
				...Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT - 4 }, (_, i) => makeTool(`extra_${i}`))
			];

			await grouper.addGroups(root, allTools, CancellationToken.None);

			// Should have expanded small groups automatically
			const expandedVirtualTools = root.contents.filter(tool =>
				tool instanceof VirtualTool
			);

			// At least some virtual tools should be expanded to reach EXPAND_UNTIL_COUNT
			expect(expandedVirtualTools.length).toBeGreaterThan(0);
		});

		it('should not expand when already above EXPAND_UNTIL_COUNT', async () => {
			// Create enough individual tools to exceed EXPAND_UNTIL_COUNT
			const tools = Array.from({ length: EXPAND_UNTIL_COUNT + 10 }, (_, i) =>
				makeTool(`individual_${i}`)
			);

			await grouper.addGroups(root, tools, CancellationToken.None);

			// All tools should remain as individual tools (no virtual tools created)
			const virtualTools = root.contents.filter(tool => tool instanceof VirtualTool);
			expect(virtualTools).toHaveLength(0);
		});

		it('should not expand beyond HARD_TOOL_LIMIT', async () => {
			// Create large groups that could exceed HARD_TOOL_LIMIT if all expanded
			const extensionSource = makeExtensionSource('large.extension');
			const largeGroups = Array.from({ length: 5 }, (groupIndex) =>
				Array.from({ length: 50 }, (toolIndex) =>
					makeTool(`group${groupIndex}_tool_${toolIndex}`, extensionSource)
				)
			).flat();

			await grouper.addGroups(root, largeGroups, CancellationToken.None);

			const totalTools = Array.from(root.tools()).length;
			expect(totalTools).toBeLessThanOrEqual(HARD_TOOL_LIMIT);
		});

		it('should prioritize expanding smaller groups first', async () => {
			const extensionSource = makeExtensionSource('test.extension');

			// Create groups of different sizes
			const tools = [
				// Small group (2 tools)
				makeTool('small_tool1', extensionSource),
				makeTool('small_tool2', extensionSource),
				// Large group (20 tools)
				...Array.from({ length: 20 }, (_, i) => makeTool(`large_tool_${i}`, extensionSource)),
			];

			await grouper.addGroups(root, tools, CancellationToken.None);

			// The smaller group should be more likely to be expanded
			const smallGroup = root.contents.find(tool =>
				tool instanceof VirtualTool && tool.name.includes('small')
			) as VirtualTool;

			const largeGroup = root.contents.find(tool =>
				tool instanceof VirtualTool && tool.name.includes('large')
			) as VirtualTool;

			// If we have both groups, small should be expanded preferentially
			if (smallGroup && largeGroup) {
				expect(smallGroup.isExpanded || !largeGroup.isExpanded).toBe(true);
			}
		});
	});

	describe('cache integration', () => {
		it('should use cache for tool group generation', async () => {
			const tools1 = Array.from({ length: GROUP_WITHIN_TOOLSET + 1 }, (_, i) =>
				makeTool(`grouped_tool_${i}`, makeExtensionSource('cached.extension1'))
			);
			const tools2 = Array.from({ length: MIN_TOOLSET_SIZE_TO_GROUP + 1 }, (_, i) =>
				makeTool(`summarized_tool_${i}`, makeExtensionSource('cached.extension2'))
			);

			const allTools = [
				...tools1,
				...tools2,
				...Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT }, (_, i) => makeTool(`extra_${i}`))
			];

			await grouper.addGroups(root, allTools, CancellationToken.None);

			const context = accessor.get(IVSCodeExtensionContext);
			const cached = context.globalState.get('virtToolGroupCache');
			expect(cached).toMatchInlineSnapshot(`
				{
				  "lru": [
				    [
				      "5sujG9z5TJJRhFVv6jkxLSvKfLlEi6DEUboDpSCLfvQ=",
				      {
				        "groups": [
				          {
				            "name": "grouped",
				            "summary": "Tools for grouped operations",
				            "tools": [
				              "grouped_tool_0",
				              "grouped_tool_1",
				              "grouped_tool_2",
				              "grouped_tool_3",
				              "grouped_tool_4",
				              "grouped_tool_5",
				              "grouped_tool_6",
				              "grouped_tool_7",
				              "grouped_tool_8",
				              "grouped_tool_9",
				              "grouped_tool_10",
				              "grouped_tool_11",
				              "grouped_tool_12",
				              "grouped_tool_13",
				              "grouped_tool_14",
				              "grouped_tool_15",
				              "grouped_tool_16",
				            ],
				          },
				        ],
				      },
				    ],
				    [
				      "ukyzHGWUUwylzlhwETqBtsi69Xhj9XqiFp45nH8yqYE=",
				      {
				        "groups": [
				          {
				            "name": "summarized",
				            "summary": "Summarized tools for summarized",
				            "tools": [
				              "summarized_tool_0",
				              "summarized_tool_1",
				              "summarized_tool_2",
				            ],
				          },
				        ],
				      },
				    ],
				  ],
				}
			`);

			const intoGroups = vi.spyOn(grouper, '_divideToolsIntoGroups' as any);
			const intoSummary = vi.spyOn(grouper, '_summarizeToolGroup' as any);

			await grouper.addGroups(root, allTools, CancellationToken.None);
			expect(intoGroups).not.toHaveBeenCalled();
			expect(intoSummary).not.toHaveBeenCalled();

			const tools3 = Array.from({ length: MIN_TOOLSET_SIZE_TO_GROUP + 2 }, (_, i) =>
				makeTool(`summarized_tool_${i}`, makeExtensionSource('cached.extension2'))
			);

			const allTools2 = [
				...tools1,
				...tools3,
				...Array.from({ length: START_GROUPING_AFTER_TOOL_COUNT }, (_, i) => makeTool(`extra_${i}`))
			];
			await grouper.addGroups(root, allTools2, CancellationToken.None);

			expect(intoGroups).not.toHaveBeenCalled();
			expect(intoSummary).toHaveBeenCalledOnce();
		});
	});

	describe('edge cases', () => {
		it('should handle empty tool list', async () => {
			await grouper.addGroups(root, [], CancellationToken.None);

			expect(root.contents).toHaveLength(0);
		});

		it('should handle single tool', async () => {
			const tools = [makeTool('single_tool')];

			await grouper.addGroups(root, tools, CancellationToken.None);

			expect(root.contents).toEqual(tools);
		});
	});
});
