/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Ajv, { ValidateFunction } from 'ajv';
import type * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { LRUCache } from '../../../util/common/cache';
import { createServiceIdentifier } from '../../../util/common/services';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ToolName } from './toolNames';
import { ICopilotTool } from './toolsRegistry';

export const IToolsService = createServiceIdentifier<IToolsService>('IToolsService');

export type IToolValidationResult = IValidatedToolInput | IToolValidationError;

export interface IValidatedToolInput {
	inputObj: unknown;
}

export interface IToolValidationError {
	error: string;
}

export class ToolCallCancelledError extends Error {
	constructor(cause: vscode.CancellationError) {
		super(cause.message, { cause });
	}
}

export interface IOnWillInvokeToolEvent {
	toolName: string;
}

export interface IToolsService {
	readonly _serviceBrand: undefined;

	onWillInvokeTool: Event<IOnWillInvokeToolEvent>;

	/**
	 * All registered LanguageModelToolInformations (vscode.lm.tools)
	 */
	tools: ReadonlyArray<vscode.LanguageModelToolInformation>;

	/**
	 * Tool implementations from tools in this extension
	 */
	copilotTools: ReadonlyMap<ToolName, ICopilotTool<any>>;
	getCopilotTool(name: string): ICopilotTool<any> | undefined;

	invokeTool(name: string, options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult2>;
	getTool(name: string): vscode.LanguageModelToolInformation | undefined;
	getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined;

	/**
	 * Validates the input to the tool, returning an error if it's invalid.
	 */
	validateToolInput(name: string, input: string): IToolValidationResult;

	validateToolName(name: string): string | undefined;

	/**
	 * Gets tools that should be enabled for the given request. You can optionally
	 * pass `filter` function that can explicitl enable (true) or disable (false)
	 * a tool, or use the default logic (undefined).
	 */
	getEnabledTools(request: vscode.ChatRequest, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): vscode.LanguageModelToolInformation[];
}

export function ajvValidateForTool(toolName: string, fn: ValidateFunction, inputObj: unknown): IToolValidationResult {
	// Empty output can be valid when the schema only has optional properties
	if (fn(inputObj ?? {})) {
		return { inputObj };
	}

	const errors = fn.errors!.map(e => e.message || `${e.instancePath} is invalid}`);
	return { error: `ERROR: Your input to the tool was invalid (${errors.join(', ')})` };
}

export abstract class BaseToolsService extends Disposable implements IToolsService {
	abstract readonly _serviceBrand: undefined;

	protected readonly _onWillInvokeTool = this._register(new Emitter<IOnWillInvokeToolEvent>());
	public get onWillInvokeTool() { return this._onWillInvokeTool.event; }

	abstract tools: ReadonlyArray<vscode.LanguageModelToolInformation>;
	abstract copilotTools: ReadonlyMap<ToolName, ICopilotTool<any>>;

	private readonly ajv = new Ajv({ coerceTypes: true });
	private didWarnAboutValidationError?: Set<string>;
	private readonly schemaCache = new LRUCache<ValidateFunction>(16);

	abstract getCopilotTool(name: string): ICopilotTool<any> | undefined;
	abstract invokeTool(name: string, options: vscode.LanguageModelToolInvocationOptions<Object>, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult2>;
	abstract getTool(name: string): vscode.LanguageModelToolInformation | undefined;
	abstract getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined;
	abstract getEnabledTools(request: vscode.ChatRequest, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): vscode.LanguageModelToolInformation[];

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	validateToolInput(name: string, input: string): IToolValidationResult {
		const tool = this.tools.find(tool => tool.name === name);
		if (!tool) {
			return { error: `ERROR: The tool "${name}" does not exist` };
		}

		let inputObj: unknown;
		try {
			inputObj = JSON.parse(input) ?? {};
		} catch (err) {
			if (input) {
				return { error: `ERROR: Your input to the tool was invalid (${err.toString()})` };
			}
		}

		if (!tool?.inputSchema) {
			return { inputObj: inputObj };
		}

		let fn = this.schemaCache.get(tool.name);
		if (fn === undefined) {
			try {
				fn = this.ajv.compile(tool.inputSchema);
			} catch (e) {
				if (!this.didWarnAboutValidationError?.has(tool.name)) {
					this.didWarnAboutValidationError ??= new Set();
					this.didWarnAboutValidationError.add(tool.name);
					this.logService.warn(`Error compiling input schema for tool ${tool.name}: ${e}`);
				}

				return { inputObj };
			}

			this.schemaCache.put(tool.name, fn);
		}

		return ajvValidateForTool(tool.name, fn, inputObj);
	}

	validateToolName(name: string): string | undefined {
		const tool = this.tools.find(tool => tool.name === name);
		if (!tool) {
			return name.replace(/[^\w-]/g, '_');
		}
	}
}

export class NullToolsService extends BaseToolsService implements IToolsService {
	_serviceBrand: undefined;
	tools: readonly vscode.LanguageModelToolInformation[] = [];
	copilotTools = new Map();

	async invokeTool(id: string, options: vscode.LanguageModelToolInvocationOptions<Object>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult2> {
		return {
			content: [],
		};
	}

	getTool(id: string): vscode.LanguageModelToolInformation | undefined {
		return undefined;
	}

	override getCopilotTool(name: string): ICopilotTool<any> | undefined {
		return undefined;
	}

	getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined {
		return undefined;
	}

	getEnabledTools(): vscode.LanguageModelToolInformation[] {
		return [];
	}
}
