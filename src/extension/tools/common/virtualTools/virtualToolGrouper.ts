/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { CHAT_MODEL, HARD_TOOL_LIMIT } from '../../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { groupBy } from '../../../../util/vs/base/common/collections';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { LanguageModelToolExtensionSource, LanguageModelToolMCPSource } from '../../../../vscodeTypes';
import { VIRTUAL_TOOL_NAME_PREFIX, VirtualTool } from './virtualTool';
import { divideToolsIntoGroups, summarizeToolGroup } from './virtualToolSummarizer';
import { IToolCategorization, IToolGroupingCache } from './virtualToolTypes';
import * as Constant from './virtualToolsConstants';

const BUILT_IN_GROUP = 'builtin';
const CATEGORIZATION_ENDPOINT = CHAT_MODEL.GPT4OMINI;
const SUMMARY_PREFIX = 'Call this tool when you need access to a new category of tools. The category of tools is described as follows:\n\n';
const SUMMARY_SUFFIX = '\n\nBe sure to call this tool if you need a capability related to the above.';

export class VirtualToolGrouper implements IToolCategorization {
	constructor(
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@IToolGroupingCache private readonly _cache: IToolGroupingCache,
	) {
	}

	async addGroups(root: VirtualTool, tools: LanguageModelToolInformation[], token: CancellationToken): Promise<void> {
		// If there's no need to group tools, just add them all directly;
		if (tools.length < Constant.START_GROUPING_AFTER_TOOL_COUNT) {
			root.contents = tools;
			return;
		}

		const byToolset = groupBy(tools, t => {
			if (t.source instanceof LanguageModelToolExtensionSource) {
				return 'ext_' + t.source.id;
			} else if (t.source instanceof LanguageModelToolMCPSource) {
				return 'mcp_' + t.source.label;
			} else {
				return BUILT_IN_GROUP;
			}
		});

		const grouped = await Promise.all(Object.entries(byToolset).map(([key, tools]) => {
			if (key === BUILT_IN_GROUP) {
				return tools;
			} else {
				return this._generateGroupsFromToolset(tools, token);
			}
		}));

		const previousGroups = new Map</* name */ string, VirtualTool>();
		for (const tool of root.all()) {
			if (tool instanceof VirtualTool) {
				previousGroups.set(tool.name, tool);
			}
		}

		this._cache.flush();
		root.contents = grouped.flat();

		for (const tool of root.all()) {
			if (tool instanceof VirtualTool) {
				const prev = previousGroups.get(tool.name);
				if (prev) {
					tool.isExpanded = prev.isExpanded;
					tool.lastUsedOnTurn = prev.lastUsedOnTurn;
				}
			}
		}

		this.reExpandToolsToHitBudget(root);
	}

	/**
	 * Eagerly expand small groups when possible just to reduce the number of indirections.
	 * Later we should rank this based on query/embedding similarity to the request.
	 *
	 * Note: when this is made smarter, we should increase `MIN_TOOLSET_SIZE_TO_GROUP`,
	 * which is right now because tiny toolsets are likely to automatically be included.
	 */
	private reExpandToolsToHitBudget(root: VirtualTool): void {
		let toolCount = Iterable.length(root.tools());
		if (toolCount > Constant.EXPAND_UNTIL_COUNT) {
			return; // No need to expand further.
		}

		// Get unexpanded virtual tools, sorted ascending by their size.
		const expandable = root.contents
			.filter((t): t is VirtualTool => t instanceof VirtualTool && !t.isExpanded)
			.sort((a, b) => a.contents.length - b.contents.length);

		// Expand them until we hit the minimum EXPAND_UNTIL_COUNT
		for (const vtool of expandable) {
			const nextCount = toolCount - 1 + vtool.contents.length;
			if (nextCount > HARD_TOOL_LIMIT) {
				break;
			}

			vtool.isExpanded = true;
			toolCount = nextCount;

			if (toolCount > Constant.EXPAND_UNTIL_COUNT) {
				break;
			}
		}
	}

	/** Top-level request to categorize a group of tools from a single source. */
	private async _generateGroupsFromToolset(tools: LanguageModelToolInformation[], token: CancellationToken): Promise<(VirtualTool | LanguageModelToolInformation)[]> {
		if (tools.length <= Constant.MIN_TOOLSET_SIZE_TO_GROUP) {
			return tools;
		}

		const virts = await this._cache.getOrInsert(tools, () =>
			tools.length <= Constant.GROUP_WITHIN_TOOLSET
				? this._summarizeToolGroup(tools, token)
				: this._divideToolsIntoGroups(tools, token)
		);

		return virts?.map(v => {
			const vt = new VirtualTool(VIRTUAL_TOOL_NAME_PREFIX + v.name, SUMMARY_PREFIX + v.summary + SUMMARY_SUFFIX, 0, undefined);
			vt.contents = v.tools;
			return vt;
		}) || tools;
	}

	/** Makes multiple sub-groups from the given tool list. */
	protected async _divideToolsIntoGroups(tools: LanguageModelToolInformation[], token: CancellationToken) {
		const endpoint = await this._endpointProvider.getChatEndpoint(CATEGORIZATION_ENDPOINT);

		const summarized = await divideToolsIntoGroups(endpoint, tools, token);
		if (!summarized) {
			return undefined;
		}

		return summarized;
	}

	/** Summarizes the given tool list into a single tool group. */
	protected async _summarizeToolGroup(tools: LanguageModelToolInformation[], token: CancellationToken) {
		const endpoint = await this._endpointProvider.getChatEndpoint(CATEGORIZATION_ENDPOINT);

		const summarized = await summarizeToolGroup(endpoint, tools, token);
		return summarized && [summarized];
	}
}
