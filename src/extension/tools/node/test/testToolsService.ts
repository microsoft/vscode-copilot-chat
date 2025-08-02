/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { packageJson } from '../../../../platform/env/common/packagejson';
import { ILanguageDiagnosticsService } from '../../../../platform/languages/common/languageDiagnosticsService';
import { ILogService } from '../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { Lazy } from '../../../../util/vs/base/common/lazy';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelToolInformation, LanguageModelToolResult2 } from '../../../../vscodeTypes';
import { getContributedToolName, getToolName, mapContributedToolNamesInSchema, mapContributedToolNamesInString, ToolName } from '../../common/toolNames';
import { ICopilotTool, ICopilotToolCtor, ToolRegistry } from '../../common/toolsRegistry';
import { BaseToolsService, IToolsService } from '../../common/toolsService';

export class TestToolsService extends BaseToolsService implements IToolsService {
	_serviceBrand: undefined;

	private static readonly ExcludedTools = [
		ToolName.GetScmChanges,
		ToolName.UpdateUserPreferences,
		ToolName.Usages
	];

	private static readonly ContainerOnlyTools = [
		ToolName.CoreRunInTerminal,
		ToolName.CoreGetTerminalOutput
	];

	private readonly _tools = new Map<string, LanguageModelToolInformation>();
	get tools(): LanguageModelToolInformation[] {
		return Array.from(this._tools.values()).map(tool => {
			const owned = this._copilotTools.get(getToolName(tool.name) as ToolName);
			return owned?.value.alternativeDefinition?.() ?? tool;
		});
	}

	private readonly _copilotTools: Map<ToolName, Lazy<ICopilotTool<any>>>;
	get copilotTools() {
		return new Map(Iterable.map(this._copilotTools.entries(),
			([name, tool]) => [name, tool.value]));
	}

	constructor(
		disabledTools: Set<string>,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
	) {
		super(logService);

		const filteredTools = this.getFilteredTools(disabledTools);
		this._copilotTools = new Map(filteredTools
			.map(t => [t.toolName, new Lazy(() => instantiationService.createInstance(t))] as const));

		for (const tool of filteredTools) {
			if (TestToolsService.ExcludedTools.includes(tool.toolName)) {
				continue;
			}

			const contributedName = getContributedToolName(tool.toolName);
			const contributedTool = packageJson.contributes.languageModelTools.find(contributedTool => contributedTool.name === contributedName);
			if (!contributedTool) {
				throw new Error(`Tool ${contributedName} is not in package.json`);
			}

			if (tool.toolName === ToolName.GetErrors) {
				// Some tests don't have ILanguageDiagnosticsService configured. Hacky, not sure how else to handle this
				try {
					instantiationService.invokeFunction(acc => acc.get(ILanguageDiagnosticsService));
				} catch (e) {
					continue;
				}
			}

			const info: LanguageModelToolInformation = {
				name: tool.toolName,
				description: mapContributedToolNamesInString(contributedTool.modelDescription),
				source: undefined,
				inputSchema: contributedTool.inputSchema && mapContributedToolNamesInSchema(contributedTool.inputSchema),
				tags: contributedTool.tags ?? []
			};
			this._tools.set(info.name, info);
		}
	}

	protected getFilteredTools(disabledTools: Set<string>): readonly ICopilotToolCtor[] {
		// Checking in a quick fix- needs a better check
		const isSwebenchContainer = process.env.HOME === '/root';
		const filteredTools = ToolRegistry.getTools()
			.filter(t => !disabledTools.has(t.toolName))
			.filter(t => !TestToolsService.ExcludedTools.includes(t.toolName))
			.filter(t => isSwebenchContainer || !TestToolsService.ContainerOnlyTools.includes(t.toolName));

		return filteredTools;
	}

	async invokeTool(name: string, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: CancellationToken): Promise<LanguageModelToolResult2> {
		name = getToolName(name);
		const tool = this._copilotTools.get(name as ToolName)?.value;
		if (tool) {
			this._onWillInvokeTool.fire({ toolName: name });
			const result = await tool.invoke(options, token);
			if (!result) {
				throw new CancellationError();
			}

			return result;
		}

		throw new Error('unknown tool: ' + name);
	}

	override getCopilotTool(name: string): ICopilotTool<any> | undefined {
		const tool = this._copilotTools.get(name as ToolName)?.value;
		return tool;
	}

	getTool(name: string): LanguageModelToolInformation | undefined {
		const tool = this._tools.get(name);
		return tool;
	}

	getToolByToolReferenceName(toolReferenceName: string): LanguageModelToolInformation | undefined {
		const contributedTool = packageJson.contributes.languageModelTools.find(tool => tool.toolReferenceName === toolReferenceName && tool.canBeReferencedInPrompt);
		if (contributedTool) {
			return {
				name: contributedTool.name,
				description: contributedTool.modelDescription,
				inputSchema: contributedTool.inputSchema,
				tags: [],
				source: undefined,
			};
		}

		return undefined;
	}

	getEnabledTools(request: vscode.ChatRequest, filter?: (tool: LanguageModelToolInformation) => boolean | undefined): LanguageModelToolInformation[] {
		const toolMap = new Map(this.tools.map(t => [t.name, t]));

		const packageJsonTools = getPackagejsonToolsForTest();
		return this.tools.filter(tool => {
			// 0. Check if the tool was enabled or disabled via the tool picker
			const toolPickerSelection = request.tools.get(getContributedToolName(tool.name));
			if (typeof toolPickerSelection === 'boolean') {
				return toolPickerSelection;
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

			return packageJsonTools.has(tool.name);
		});

	}

	addTestToolOverride(info: LanguageModelToolInformation, tool: vscode.LanguageModelTool<unknown>): void {
		this._tools.set(info.name, info);
		this._copilotTools.set(info.name as ToolName, new Lazy(() => tool));
	}
}

export class NoopTestToolsService extends TestToolsService {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
	) {
		super(new Set(), instantiationService, logService);
	}

	override invokeTool(name: string, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: CancellationToken): Promise<LanguageModelToolResult2> {
		throw new Error('NoopTestToolsService does not support invoking tools');
	}

	protected override getFilteredTools(_disabledTools: Set<string>): readonly ICopilotToolCtor[] {
		return ToolRegistry.getTools();
	}
}

export function getPackagejsonToolsForTest() {
	// Simulate what vscode would do- enable all tools that would be in the picker (tools in a toolset or with canBeReferencedInPrompt)
	const toolsetReferenceNames = new Set(packageJson.contributes.languageModelToolSets
		.flatMap(toolset => toolset.tools));
	const tools = new Set(packageJson.contributes.languageModelTools
		.filter(tool => (tool.canBeReferencedInPrompt || toolsetReferenceNames.has(tool.toolReferenceName)))
		.map(tool => getToolName(tool.name)));

	// Add core tools that should be enabled for the agent.
	// Normally, vscode is in control of deciding which tools are enabled for a chat request, but in the simulator, the extension has to decide this.
	// Since it can't get info like `canBeReferencedInPrompt` from the extension API, we have to hardcode tool names here.
	tools.add(ToolName.CoreRunInTerminal);
	tools.add(ToolName.CoreGetTerminalOutput);
	tools.add(ToolName.CoreCreateAndRunTask);
	tools.add(ToolName.CoreGetTaskOutput);
	tools.add(ToolName.CoreRunTask);
	tools.add(ToolName.CoreRunTest);

	return tools;
}
