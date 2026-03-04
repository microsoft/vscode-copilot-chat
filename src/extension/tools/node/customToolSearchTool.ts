/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { CUSTOM_TOOL_SEARCH_NAME, CUSTOM_TOOL_SEARCH_RESULT_MARKER } from '../../../platform/networking/common/anthropic';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ICopilotModelSpecificTool, ToolRegistry } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { IToolEmbeddingsComputer } from '../common/virtualTools/toolEmbeddingsComputer';

export interface ICustomToolSearchParams {
	query: string;
}

const DEFAULT_SEARCH_LIMIT = 10;

export class CustomToolSearchTool implements ICopilotModelSpecificTool<ICustomToolSearchParams> {
	constructor(
		@IToolEmbeddingsComputer private readonly _toolEmbeddingsComputer: IToolEmbeddingsComputer,
		@IToolsService private readonly _toolsService: IToolsService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ICustomToolSearchParams>, token: vscode.CancellationToken) {
		const { query } = options.input;

		if (!query) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('Error: query parameter is required'),
			]);
		}

		const availableTools = this._toolsService.tools;
		const matchedToolNames = await this._toolEmbeddingsComputer.searchToolsByQuery(
			query,
			availableTools,
			DEFAULT_SEARCH_LIMIT,
			token,
		);

		this._logService.trace(`[custom-tool-search] Query "${query}" matched ${matchedToolNames.length} tools: ${JSON.stringify(matchedToolNames)}`);

		// Return a JSON marker that rawMessagesToMessagesAPI() will detect
		// and convert into Anthropic tool_reference content blocks
		const result = JSON.stringify({
			[CUSTOM_TOOL_SEARCH_RESULT_MARKER]: true,
			tool_names: matchedToolNames,
		});

		return new LanguageModelToolResult([
			new LanguageModelTextPart(result),
		]);
	}
}

ToolRegistry.registerModelSpecificTool(
	{
		name: CUSTOM_TOOL_SEARCH_NAME,
		displayName: 'Search Tools',
		description: 'Search for relevant tools by describing what you need. Returns tool references for tools matching your query. Use this when you need to find a tool but aren\'t sure of its exact name.',
		tags: [],
		source: undefined,
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'Natural language description of what tool capability you are looking for.',
				},
			},
			required: ['query'],
		},
		models: [{ family: 'claude' }, { family: 'Anthropic' }],
	},
	CustomToolSearchTool,
);
