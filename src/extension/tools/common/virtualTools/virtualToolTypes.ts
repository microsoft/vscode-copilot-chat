/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation, LanguageModelToolResult } from 'vscode';
import { createServiceIdentifier } from '../../../../util/common/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { VirtualTool } from './virtualTool';

export interface IToolGrouping {
	/**
	 * Gets or sets the list of tools available for the group.
	 */
	tools: readonly LanguageModelToolInformation[];

	/**
	 * Should be called for each model tool call. Returns a tool result if the
	 * call was a virtual tool call that was expanded.
	 */
	didCall(toolCallName: string): LanguageModelToolResult | undefined;

	/**
	 * Should be called for each conversation turn. This is used to monitor
	 * recency of tools and collapse older.
	 */
	didTakeTurn(): void;

	/**
	 * Should be called when something happens to invalidate the conversation
	 * cache. This is an opportunity for the grouping to groom its toolset
	 * without invalidating the cache.
	 */
	didInvalidateCache(): void;

	/**
	 * Returns a list of tools that should be used for the given request.
	 * Internally re-reads the request and conversation state.
	 */
	compute(token: CancellationToken): Promise<LanguageModelToolInformation[]>;

	/**
	 * Returns the complete tree of tools, used for diagnostic purposes.
	 */
	computeAll(token: CancellationToken): Promise<(LanguageModelToolInformation | VirtualTool)[]>;
}

export interface IToolGroupingService {
	_serviceBrand: undefined;
	/**
	 * Creates a tool grouping for a request, based on its conversation and the
	 * initial set of tools.
	 */
	create(tools: readonly LanguageModelToolInformation[]): IToolGrouping;
}

export const IToolGroupingService = createServiceIdentifier<IToolGroupingService>('IToolGroupingService');

export interface IToolGroupingCache {
	_serviceBrand: undefined;

	/**
	 * Clears the tool group cache.
	 */
	clear(): Promise<void>;

	/**
	 * Saves the state of the cache.
	 */
	flush(): Promise<void>;

	/**
	 * Gets or inserts the grouping for the given set of tools.
	 */
	getOrInsert(tools: LanguageModelToolInformation[], factory: () => Promise<ISummarizedToolCategory[] | undefined>): Promise<ISummarizedToolCategory[] | undefined>;
}

export const IToolGroupingCache = createServiceIdentifier<IToolGroupingCache>('IToolGroupingCache');


export interface IToolCategorization {
	/**
	 * Called whenever new tools are added. The function should add each tool into
	 * the appropriate virtual tool or top-level tool in the `root`.
	 */
	addGroups(root: VirtualTool, tools: LanguageModelToolInformation[], token: CancellationToken): Promise<void>;
}

export interface ISummarizedToolCategory {
	summary: string;
	name: string;
	tools: LanguageModelToolInformation[];
}

export class SummarizerError extends Error { }
