/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEmbeddingsComputer } from '../../../platform/embeddings/common/embeddingsComputer';
import { ILogService } from '../../../platform/log/common/logService';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { getContributedToolName, getToolName, mapContributedToolNamesInSchema, mapContributedToolNamesInString, ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { BaseToolsService } from '../common/toolsService';

export class ToolsService extends BaseToolsService {
	declare _serviceBrand: undefined;

	private readonly _copilotTools: Lazy<Map<ToolName, ICopilotTool<any>>>;

	get tools(): ReadonlyArray<vscode.LanguageModelToolInformation> {
		const contributedTools = [...vscode.lm.tools]
			.sort((a, b) => {
				// Sort builtin tools to the top
				const aIsBuiltin = a.name.startsWith('vscode_') || a.name.startsWith('copilot_');
				const bIsBuiltin = b.name.startsWith('vscode_') || b.name.startsWith('copilot_');
				if (aIsBuiltin && bIsBuiltin) {
					return a.name.localeCompare(b.name);
				} else if (!aIsBuiltin && !bIsBuiltin) {
					return a.name.localeCompare(b.name);
				}

				return aIsBuiltin ? -1 : 1;
			})
			.map(tool => {
				const owned = this._copilotTools.value.get(getToolName(tool.name) as ToolName);
				return owned?.alternativeDefinition?.() ?? tool;
			});

		return contributedTools.map(tool => {
			return {
				...tool,
				name: getToolName(tool.name),
				description: mapContributedToolNamesInString(tool.description),
				inputSchema: tool.inputSchema && mapContributedToolNamesInSchema(tool.inputSchema),
			};
		});
	}

	public get copilotTools() {
		return this._copilotTools.value;
	}

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IEmbeddingsComputer embeddingsComputer: IEmbeddingsComputer | undefined,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super(logService, embeddingsComputer);
		this._copilotTools = new Lazy(() => new Map(ToolRegistry.getTools().map(t => [t.toolName, instantiationService.createInstance(t)] as const)));
	}

	invokeTool(name: string | ToolName, options: vscode.LanguageModelToolInvocationOptions<Object>, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult | vscode.LanguageModelToolResult2> {
		this._onWillInvokeTool.fire({ toolName: name });
		return vscode.lm.invokeTool(getContributedToolName(name), options, token);
	}

	override getCopilotTool(name: string): ICopilotTool<any> | undefined {
		const tool = this._copilotTools.value.get(name as ToolName);
		return tool;
	}

	getTool(name: string | ToolName): vscode.LanguageModelToolInformation | undefined {
		return this.tools.find(tool => tool.name === name);
	}

	getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined {
		// Can't actually implement this in prod, name is not exposed
		throw new Error('This method for tests only');
	}
	async getEnabledTools(request: vscode.ChatRequest, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): Promise<vscode.LanguageModelToolInformation[]> {
		const toolMap = new Map(this.tools.map(t => [t.name, t]));

		// First, apply explicit filtering to reduce the tool set
		let candidateTools = this.tools.filter(tool => {
			// 0. Check if the tool was disabled via the tool picker. If so, it must be disabled here
			const toolPickerSelection = request.tools.get(getContributedToolName(tool.name));
			if (toolPickerSelection === false) {
				return false;
			}

			// 1. Check for what the consumer wants explicitly
			const explicit = filter?.(tool);
			if (explicit !== undefined) {
				return explicit;
			}

			// 2. Check if the request's tools explicitly asked for this tool to be enabled
			for (const ref of request.toolReferences) {
				const usedTool = toolMap.get(ref.name);
				if (usedTool?.tags.includes(`enable_other_tool_${tool.name}`)) {
					return true;
				}
			}

			// 3. If this tool is neither enabled nor disabled, then consumer didn't have opportunity to enable/disable it.
			// This can happen when a tool is added during another tool call (e.g. installExt tool installs an extension that contributes tools).
			if (toolPickerSelection === undefined && tool.tags.includes('extension_installed_by_tool')) {
				return true;
			}

			// Tool was enabled via tool picker
			if (toolPickerSelection === true) {
				return true;
			}

			return false;
		});

		// Extract semantic query from the request if available
		let semanticQuery: string | undefined;
		if (request.prompt) {
			// Use the user's prompt as the semantic query
			semanticQuery = request.prompt;
		}

		// After explicit filtering, apply semantic filtering if we still have too many tools
		// Only apply semantic filtering to tools tagged with 'mcp'
		const isSemanticSearchEnabled = this.configurationService.getConfig(ConfigKey.ToolsSemanticSearchEnabled);
		if (semanticQuery && candidateTools.length > 128 && isSemanticSearchEnabled) {
			try {
				// Separate MCP tools from other tools
				const mcpTools = candidateTools.filter(tool => tool.tags.includes('mcp'));
				const otherTools = candidateTools.filter(tool => !tool.tags.includes('mcp'));

				// Calculate the maximum number of MCP tools we can keep based on the other tools count
				const maxMcpTools = Math.max(0, 128 - otherTools.length);

				const start = performance.now();
				// Get semantic similarity only for MCP tools, with dynamic limit
				const semanticallyFilteredMcpTools = await this.getSemanticallySimilarTools(semanticQuery, maxMcpTools, 0.3);
				// Keep only MCP tools that passed both explicit and semantic filtering
				const filteredMcpTools = mcpTools.filter(tool =>
					semanticallyFilteredMcpTools.some(semanticTool => semanticTool.name === tool.name)
				);
				const semanticTime = performance.now() - start;

				// Combine filtered MCP tools with all other tools (non-MCP tools are not semantically filtered)
				candidateTools = [...filteredMcpTools, ...otherTools];

				// Log removed tools
				const removedTools = mcpTools.filter(tool => !filteredMcpTools.some(filteredTool => filteredTool.name === tool.name));
				console.log(`Removed ${removedTools.length} tools after semantic filtering (${semanticTime.toFixed(2)} ms): ${removedTools.map(tool => tool.name).join(', ')}`);
			} catch (error) {
				this.logService.logger.error('Failed to apply semantic filtering, using explicitly filtered tools', error);
			}
		}

		return candidateTools;
	}
}
