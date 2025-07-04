/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Ajv, { ValidateFunction } from 'ajv';
import type * as vscode from 'vscode';
import { Embedding, IEmbeddingsComputer, rankEmbeddings } from '../../../platform/embeddings/common/embeddingsComputer';
import { ILogService } from '../../../platform/log/common/logService';
import { LRUCache } from '../../../util/common/cache';
import { createServiceIdentifier } from '../../../util/common/services';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ToolEmbeddingData, ToolEmbeddingsCache } from './toolEmbeddingsCache';
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
	getEnabledTools(request: vscode.ChatRequest, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): vscode.LanguageModelToolInformation[] | Promise<vscode.LanguageModelToolInformation[]>;

	/**
	 * Gets tools that are semantically similar to the given query.
	 * @param query The semantic query to match tools against
	 * @param maxResults Maximum number of tools to return (default: 128)
	 * @param minSimilarity Minimum similarity score (0-1) to include a tool (default: 0.5)
	 */
	getSemanticallySimilarTools(query: string, maxResults?: number, minSimilarity?: number, cancellationToken?: vscode.CancellationToken): Promise<vscode.LanguageModelToolInformation[]>;
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
	protected toolEmbeddingsCache: ToolEmbeddingsCache | undefined;

	abstract getCopilotTool(name: string): ICopilotTool<any> | undefined;
	abstract invokeTool(name: string, options: vscode.LanguageModelToolInvocationOptions<Object>, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult2>;
	abstract getTool(name: string): vscode.LanguageModelToolInformation | undefined;
	abstract getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined;
	abstract getEnabledTools(request: vscode.ChatRequest, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): vscode.LanguageModelToolInformation[] | Promise<vscode.LanguageModelToolInformation[]>;

	constructor(
		@ILogService protected readonly logService: ILogService,
		@IEmbeddingsComputer protected readonly embeddingsComputer: IEmbeddingsComputer | undefined
	) {
		super();
		if (this.embeddingsComputer) {
			this.toolEmbeddingsCache = new ToolEmbeddingsCache(this.embeddingsComputer);
		}
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
					this.logService.logger.warn(`Error compiling input schema for tool ${tool.name}: ${e}`);
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

	async getSemanticallySimilarTools(
		query: string,
		maxResults: number = 128,
		minSimilarity: number = 0.5,
		cancellationToken?: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolInformation[]> {
		if (!this.toolEmbeddingsCache) {
			// Fallback: return all tools if embeddings are not available
			return this.tools.slice(0, maxResults);
		}

		try {
			// Get query embedding
			const queryEmbedding = await this.toolEmbeddingsCache.getQueryEmbedding(query, cancellationToken);
			if (!queryEmbedding || cancellationToken?.isCancellationRequested) {
				return this.tools.slice(0, maxResults);
			}

			// Prepare tool data for embedding
			const toolData: ToolEmbeddingData[] = this.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				schema: tool.inputSchema
			}));

			// Get tool embeddings
			const toolEmbeddings = await this.toolEmbeddingsCache.getToolEmbeddings(toolData, cancellationToken);
			if (cancellationToken?.isCancellationRequested) {
				return this.tools.slice(0, maxResults);
			}

			// Create items for ranking
			const items: Array<[vscode.LanguageModelToolInformation, Embedding]> = [];
			for (const tool of this.tools) {
				const embedding = toolEmbeddings.get(tool.name);
				if (embedding) {
					items.push([tool, embedding]);
				}
			}

			// Rank tools by similarity
			const rankedResults = rankEmbeddings(
				queryEmbedding,
				items,
				maxResults,
				{ minDistance: minSimilarity }
			);

			return rankedResults.map(result => result.value);
		} catch (error) {
			this.logService.logger.error('Failed to get semantically similar tools', error);
			// Fallback: return all tools
			return this.tools.slice(0, maxResults);
		}
	}
}

export class NullToolsService extends BaseToolsService implements IToolsService {
	_serviceBrand: undefined;
	tools: readonly vscode.LanguageModelToolInformation[] = [];
	copilotTools = new Map();

	constructor(
		logService: ILogService,
		embeddingsComputer?: IEmbeddingsComputer
	) {
		super(logService, embeddingsComputer);
	}

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

	override async getSemanticallySimilarTools(): Promise<vscode.LanguageModelToolInformation[]> {
		return [];
	}
}
