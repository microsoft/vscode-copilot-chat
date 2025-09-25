/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { VIRTUAL_TOOL_NAME_PREFIX, VirtualTool } from './virtualTool';
import * as Constant from './virtualToolsConstants';

const BUILT_IN_GROUP = 'builtin';
const SUMMARY_PREFIX = 'Call this tool when you need access to a new category of tools. The category of tools is described as follows:\n\n';
const SUMMARY_SUFFIX = '\n\nBe sure to call this tool if you need a capability related to the above.';

// categorize all tools except for the 11 default tools
// 12 default tools = semantic_search, grep_search, read_file, create_file, apply_patch, replace_string_in_file,
// insert_edit_into_file, run_in_terminal, list_dir, think, get_terminal_output, manage_todo_list
const BUILT_IN_TOOL_GROUPS = {
	'Jupyter Notebook Tools': {
		summary: 'Call tools from this group when you need to work with Jupyter notebooks - creating, editing, running cells, and managing notebook operations.',
		tools: [
			'create_new_jupyter_notebook',
			'edit_notebook_file',
			'run_notebook_cell',
			'copilot_getNotebookSummary',
			'read_notebook_cell_output',
			'configure_notebook',
			'notebook_install_packages',
			'notebook_list_packages',
			'configure_python_environment',
			'get_python_environment_details',
			'get_python_executable_details'
		]
	},
	'Web Interaction': {
		summary: 'Call tools from this group when you need to interact with web content, browse websites, or access external resources.',
		tools: [
			'fetch_webpage',
			'open_simple_browser',
			'github_repo'
		]
	},
	'VS Code Interaction': {
		summary: 'Call tools from this group when you need to interact with the VS Code workspace and access VS Code features.',
		tools: [
			'search_workspace_symbols',
			'list_code_usages',
			'get_errors',
			'get_vscode_api',
			'get_changed_files',
			'create_new_workspace',
			'install_extension',
			'get_project_setup_info',
			'create_and_run_task',
			'run_task',
			'get_task_output',
			'run_vscode_command',
			'multi_replace_string_in_file',
			'install_python_packages',
			'get_search_view_results',
			'vscode_searchExtensions_internal',
			'read_project_structure'
		]
	},
	'Testing': {
		summary: 'Call tools from this group when you need to run tests, analyze test failures, and manage test workflows.',
		tools: [
			'run_tests',
			'test_failure',
			'test_search',
			'runTests'
		]
	},
	'Redundant but Specific': {
		summary: 'These tools have overlapping functionalities but are highly specialized for certain tasks. \nTools: file_search, get_terminal_selection, get_terminal_last_command, create_directory, get_doc_info',
		tools: [
			'file_search',
			'get_terminal_selection',
			'get_terminal_last_command',
			'create_directory',
			'get_doc_info'
		]
	}
} as const;

export class BuiltInToolGroupHandler {
	constructor(
		private readonly _telemetryService: ITelemetryService,
	) { }

	/** Creates groups for built-in tools based on the pre-defined enum above*/
	createBuiltInToolGroups(tools: LanguageModelToolInformation[]): (VirtualTool | LanguageModelToolInformation)[] {
		// If there are too few tools, don't group them
		if (tools.length <= Constant.MIN_TOOLSET_SIZE_TO_GROUP) {
			return tools;
		}

		// Create a map of tool names to tool objects for easy lookup
		const toolMap = new Map(tools.map(tool => [tool.name, tool]));

		const virtualTools: VirtualTool[] = [];
		const usedTools = new Set<string>();

		// Create virtual tools for each predefined group
		for (const [groupName, groupDef] of Object.entries(BUILT_IN_TOOL_GROUPS)) {
			const groupTools = groupDef.tools
				.map(toolName => toolMap.get(toolName))
				.filter((tool): tool is LanguageModelToolInformation => tool !== undefined);

			if (groupTools.length > 0) {
				// Mark each tool that has already been added to a group
				groupTools.forEach(tool => usedTools.add(tool.name));

				// Create the virtual tool group
				const virtualTool = new VirtualTool(
					VIRTUAL_TOOL_NAME_PREFIX + groupName.toLowerCase().replace(/\s+/g, '_'),
					SUMMARY_PREFIX + groupDef.summary + SUMMARY_SUFFIX,
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

		this._telemetryService.sendEnhancedGHTelemetryEvent('virtualTools.generate', {
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