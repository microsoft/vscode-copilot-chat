/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { ToolCategory, getToolsForCategory } from '../toolNames';
import { VIRTUAL_TOOL_NAME_PREFIX, VirtualTool } from './virtualTool';
import * as Constant from './virtualToolsConstants';

const BUILT_IN_GROUP = 'builtin';
const SUMMARY_PREFIX = 'Call this tool when you need access to a new category of tools. The category of tools is described as follows:\n\n';
const SUMMARY_SUFFIX = '\n\nBe sure to call this tool if you need a capability related to the above.';

/**
 * Get the summary description for a tool category.
 * For RedundantButSpecific, dynamically includes the list of tool names.
 */
function getCategorySummary(category: ToolCategory): string {
	switch (category) {
		case ToolCategory.JupyterNotebook:
			return 'Call tools from this group when you need to work with Jupyter notebooks - creating, editing, running cells, and managing notebook operations.';
		case ToolCategory.WebInteraction:
			return 'Call tools from this group when you need to interact with web content, browse websites, or access external resources.';
		case ToolCategory.VSCodeInteraction:
			return 'Call tools from this group when you need to interact with the VS Code workspace and access VS Code features.';
		case ToolCategory.Testing:
			return 'Call tools from this group when you need to run tests, analyze test failures, and manage test workflows.';
		case ToolCategory.RedundantButSpecific: {
			const toolNames = getToolsForCategory(category);
			return `These tools have overlapping functionalities but are highly specialized for certain tasks. Tools: ${toolNames.join(', ')}`;
		}
		case ToolCategory.Core:
			return 'Core tools that should always be available without grouping.';
		default:
			return 'Tools in this category.';
	}
}

export class BuiltInToolGroupHandler {
	constructor(
		private readonly _telemetryService: ITelemetryService,
	) { }

	/** Creates groups for built-in tools based on the type-safe categorization system */
	createBuiltInToolGroups(tools: LanguageModelToolInformation[]): (VirtualTool | LanguageModelToolInformation)[] {
		// If there are too few tools, don't group them
		if (tools.length <= Constant.MIN_TOOLSET_SIZE_TO_GROUP) {
			return tools;
		}

		const toolMap = new Map(tools.map(tool => [tool.name, tool]));
		const virtualTools: VirtualTool[] = [];
		const usedTools = new Set<string>();

		// Process each tool category (except Core which should not be grouped)
		for (const category of Object.values(ToolCategory)) {
			if (category === ToolCategory.Core) {
				continue; // Core tools are not grouped
			}

			// Get all tools for this category using the type-safe mapping
			const categoryToolNames = getToolsForCategory(category);
			const groupTools = categoryToolNames
				.map(toolName => toolMap.get(toolName))
				.filter((tool): tool is LanguageModelToolInformation => tool !== undefined);

			if (groupTools.length > 0) {
				// Mark each tool that has already been added to a group
				groupTools.forEach(tool => usedTools.add(tool.name));

				const virtualTool = new VirtualTool(
					VIRTUAL_TOOL_NAME_PREFIX + category.toLowerCase().replace(/\s+/g, '_'),
					SUMMARY_PREFIX + getCategorySummary(category) + SUMMARY_SUFFIX,
					0,
					{
						toolsetKey: BUILT_IN_GROUP,
						groups: [],
						possiblePrefix: 'builtin_'
					},
					groupTools
				);
				virtualTools.push(virtualTool);
			}
		}

		// Add any remaining uncategorized tools individually
		const uncategorizedTools = tools.filter(tool => !usedTools.has(tool.name));

		// Send telemetry for built-in tool grouping
		this._telemetryService.sendMSFTTelemetryEvent('virtualTools.generate', {
			groupKey: BUILT_IN_GROUP,
		}, {
			uncategorized: uncategorizedTools.length,
			toolsBefore: tools.length,
			toolsAfter: virtualTools.length,
			retries: 0, // No retries for predefined groups
			durationMs: 0, // Instant for predefined groups
		});

		return [...virtualTools, ...uncategorizedTools];
	}

	static get BUILT_IN_GROUP_KEY(): string {
		return BUILT_IN_GROUP;
	}
}