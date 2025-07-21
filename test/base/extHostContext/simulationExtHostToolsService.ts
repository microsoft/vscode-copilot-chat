/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Allow importing vscode here. eslint does not let us exclude this path: https://github.com/import-js/eslint-plugin-import/issues/2800
/* eslint-disable import/no-restricted-paths */

import type { CancellationToken, ChatRequest, LanguageModelTool, LanguageModelToolInformation, LanguageModelToolInvocationOptions, LanguageModelToolResult } from 'vscode';
import { getToolName, ToolName } from '../../../src/extension/tools/common/toolNames';
import { ICopilotTool } from '../../../src/extension/tools/common/toolsRegistry';
import { BaseToolsService, IToolsService } from '../../../src/extension/tools/common/toolsService';
import { McpToolsService } from '../../../src/extension/tools/vscode-node/mcpToolsService';
import { ToolsContribution } from '../../../src/extension/tools/vscode-node/tools';
import { ToolsService } from '../../../src/extension/tools/vscode-node/toolsService';
import { packageJson } from '../../../src/platform/env/common/packagejson';
import { ILogService } from '../../../src/platform/log/common/logService';
import { CancellationError } from '../../../src/util/vs/base/common/errors';
import { Iterable } from '../../../src/util/vs/base/common/iterator';
import { IInstantiationService } from '../../../src/util/vs/platform/instantiation/common/instantiation';
import { logger } from '../../simulationLogger';
import { raceTimeout } from '../../../src/util/vs/base/common/async';
import { getPackagejsonToolsForTest } from '../../../src/extension/tools/node/test/testToolsService';

export class SimulationExtHostToolsService extends BaseToolsService implements IToolsService {
	declare readonly _serviceBrand: undefined;

	private readonly _inner: IToolsService;
	private readonly _mcpToolService: IToolsService;
	private readonly _overrides = new Map<ToolName | string, { info: LanguageModelToolInformation; tool: ICopilotTool<any> }>();
	private _lmToolRegistration?: ToolsContribution;
	private counter: number;

	override get onWillInvokeTool() {
		return this._inner.onWillInvokeTool;
	}

	get tools() {
		this.ensureToolsRegistered();
		return [
			...this._inner.tools.filter(t => !this._disabledTools.has(t.name) && !this._overrides.has(t.name)),
			...Iterable.map(this._overrides.values(), i => i.info),
			...this._mcpToolService.tools.filter(t => !this._disabledTools.has(t.name) && !this._overrides.has(t.name)),
		];
	}

	get copilotTools() {
		const r = new Map([
			...this._inner.copilotTools,
			...Iterable.map(this._overrides, ([k, v]): [ToolName, ICopilotTool<any>] => [k as ToolName, v.tool]),
		]);
		for (const name of this._disabledTools) {
			r.delete(name as ToolName);
		}
		return r;
	}

	constructor(
		private readonly _disabledTools: Set<string>,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(logService);
		this._inner = instantiationService.createInstance(ToolsService);
		this._mcpToolService = instantiationService.createInstance(McpToolsService);

		// register the contribution so that our tools are on vscode.lm.tools
		setImmediate(() => this.ensureToolsRegistered());
		this.counter = 0;
	}

	private ensureToolsRegistered() {
		this._lmToolRegistration ??= new ToolsContribution(this, {} as any);
	}

	getCopilotTool(name: string): ICopilotTool<any> | undefined {
		return this._disabledTools.has(name) ? undefined : (this._overrides.get(name)?.tool || this._inner.getCopilotTool(name) || this._mcpToolService.getCopilotTool(name));
	}

	async invokeTool(name: string, options: LanguageModelToolInvocationOptions<unknown>, token: CancellationToken): Promise<LanguageModelToolResult> {
		logger.debug('SimulationExtHostToolsService.invokeTool', name, JSON.stringify(options.input));
		const start = Date.now();
		let err: Error | undefined;
		try {
			const toolName = getToolName(name) as ToolName;
			const tool = this._overrides.get(toolName)?.tool;
			if (tool) {
				this._onWillInvokeTool.fire({ toolName });
				const result = await tool.invoke(options, token);
				if (!result) {
					throw new CancellationError();
				}

				return result;
			}

			const mcpTool = this._mcpToolService.getTool(name);
			if (mcpTool) {
				const result = await this._mcpToolService.invokeTool(name, options, token);
				if (!result) {
					throw new CancellationError();
				}

				return result;
			}

			const invokeToolTimeout = process.env.SIMULATION_INVOKE_TOOL_TIMEOUT || 60_000;
			logger.debug('SimulationExtHostToolsService.invokeToolTimeout', invokeToolTimeout);
			const r = await raceTimeout(Promise.resolve(this._inner.invokeTool(name, options, token)), <number>invokeToolTimeout);
			if (!r) {
				throw new Error(`Tool call timed out after ${invokeToolTimeout} minutes`);
			}
			return r;
		} catch (e) {
			err = e;
			throw e;
		} finally {
			logger.debug(`SimulationExtHostToolsService.invokeTool ${name} done in ${Date.now() - start}ms` + (err ? ` with error: ${err.message}` : ''));
		}
	}

	getTool(name: string): LanguageModelToolInformation | undefined {
		return this._disabledTools.has(name) ? undefined : (this._overrides.get(name)?.info || this._inner.getTool(name) || this._mcpToolService.getTool(name));
	}

	getToolByToolReferenceName(toolReferenceName: string): LanguageModelToolInformation | undefined {
		const contributedTool = packageJson.contributes.languageModelTools.find(tool => tool.toolReferenceName === toolReferenceName && tool.canBeReferencedInPrompt);
		if (contributedTool) {
			return {
				name: contributedTool.name,
				description: contributedTool.modelDescription,
				inputSchema: contributedTool.inputSchema,
				source: undefined,
				tags: []
			};
		}

		return undefined;
	}

	getEnabledTools(request: ChatRequest, filter?: (tool: LanguageModelToolInformation) => boolean | undefined): LanguageModelToolInformation[] {
		const packageJsonTools = getPackagejsonToolsForTest();
		const tools = this.tools.filter(tool => filter?.(tool) ?? (!this._disabledTools.has(getToolName(tool.name)) && packageJsonTools.has(tool.name)));
		const mcpTools = this._mcpToolService.tools.filter(tool => filter?.(tool) ?? (!this._disabledTools.has(getToolName(tool.name))));
		const result = [
			...tools,
			...mcpTools
		];
		if (this.counter === 0) {
			result.forEach(tool => {
				logger.debug('SimulationExtHostToolsService.getEnabledTool', tool.name, JSON.stringify(tool));
			});
			this.counter += 1;
		}
		return result;
	}

	addTestToolOverride(info: LanguageModelToolInformation, tool: LanguageModelTool<unknown>): void {
		if (!this._disabledTools.has(info.name)) {
			this._overrides.set(info.name as ToolName, { tool, info });
		}
	}
}
