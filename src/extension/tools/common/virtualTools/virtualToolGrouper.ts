/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { CHAT_MODEL, HARD_TOOL_LIMIT } from '../../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../../platform/log/common/logService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { groupBy } from '../../../../util/vs/base/common/collections';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { StopWatch } from '../../../../util/vs/base/common/stopwatch';
import { LanguageModelToolExtensionSource, LanguageModelToolMCPSource } from '../../../../vscodeTypes';
import { VIRTUAL_TOOL_NAME_PREFIX, VirtualTool } from './virtualTool';
import { divideToolsIntoExistingGroups, divideToolsIntoGroups, summarizeToolGroup } from './virtualToolSummarizer';
import { ISummarizedToolCategory, IToolCategorization, IToolGroupingCache } from './virtualToolTypes';
import * as Constant from './virtualToolsConstants';

const BUILT_IN_GROUP = 'builtin';
const CATEGORIZATION_ENDPOINT = CHAT_MODEL.GPT4OMINI;
const SUMMARY_PREFIX = 'Call this tool when you need access to a new category of tools. The category of tools is described as follows:\n\n';
const SUMMARY_SUFFIX = '\n\nBe sure to call this tool if you need a capability related to the above.';

export class VirtualToolGrouper implements IToolCategorization {
	constructor(
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@IToolGroupingCache private readonly _cache: IToolGroupingCache,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
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

		const previousGroups = new Map</* name */ string, VirtualTool>();
		const previousCategorizations = new Map<string, ISummarizedToolCategory[]>();
		for (const tool of root.all()) {
			if (tool instanceof VirtualTool) {
				previousGroups.set(tool.name, tool);
				if (tool.metadata?.toolsetKey) {
					previousCategorizations.set(tool.metadata.toolsetKey, tool.metadata.groups);
				}
			}
		}

		const grouped = await Promise.all(Object.entries(byToolset).map(([key, tools]) => {
			if (key === BUILT_IN_GROUP) {
				return tools;
			} else {
				return this._generateGroupsFromToolset(key, tools, previousCategorizations.get(key), token);
			}
		}));

		this._cache.flush();
		root.contents = VirtualToolGrouper.deduplicateGroups(grouped.flat());

		for (const tool of root.all()) {
			if (tool instanceof VirtualTool) {
				const prev = previousGroups.get(tool.name);
				if (prev) {
					tool.isExpanded = prev.isExpanded;
					tool.metadata.preExpanded = prev.metadata.preExpanded;
					tool.lastUsedOnTurn = prev.lastUsedOnTurn;
				}
			}
		}

		this._reExpandToolsToHitBudget(root);
	}

	public static deduplicateGroups(grouped: readonly (VirtualTool | LanguageModelToolInformation)[]) {
		const seen = new Map<string, VirtualTool | LanguageModelToolInformation>();

		for (const item of grouped) {
			const saw = seen.get(item.name);
			if (!saw) {
				seen.set(item.name, item);
				continue;
			}

			if (saw instanceof VirtualTool && saw.metadata.possiblePrefix) {
				seen.delete(saw.name);
				const replacement = saw.cloneWithPrefix(saw.metadata.possiblePrefix);
				seen.set(replacement.name, replacement);
				seen.set(item.name, item);
			} else if (item instanceof VirtualTool && item.metadata.possiblePrefix) {
				const next = item.cloneWithPrefix(item.metadata.possiblePrefix);
				seen.set(next.name, next);
			}
		}

		return [...seen.values()];
	}

	/**
	 * Eagerly expand small groups when possible just to reduce the number of indirections.
	 * Later we should rank this based on query/embedding similarity to the request.
	 *
	 * Note: when this is made smarter, we should increase `MIN_TOOLSET_SIZE_TO_GROUP`,
	 * which is right now because tiny toolsets are likely to automatically be included.
	 */
	private _reExpandToolsToHitBudget(root: VirtualTool): void {
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
			vtool.metadata.preExpanded = true;
			toolCount = nextCount;

			if (toolCount > Constant.EXPAND_UNTIL_COUNT) {
				break;
			}
		}
	}

	/** Top-level request to categorize a group of tools from a single source. */
	private async _generateGroupsFromToolset(key: string, tools: LanguageModelToolInformation[], previous: ISummarizedToolCategory[] | undefined, token: CancellationToken): Promise<(VirtualTool | LanguageModelToolInformation)[]> {
		if (tools.length <= Constant.MIN_TOOLSET_SIZE_TO_GROUP) {
			return tools;
		}

		let retries = 0;
		let virts: ISummarizedToolCategory[] | undefined;

		const sw = StopWatch.create();
		for (; !virts && retries < Constant.MAX_CATEGORIZATION_RETRIES; retries++) {
			try {
				virts = await this._cache.getOrInsert(tools, () =>
					tools.length <= Constant.GROUP_WITHIN_TOOLSET
						? this._summarizeToolGroup(tools, token)
						: this._divideToolsIntoGroups(tools, previous, token)
				);
			} catch (e) {
				this._logService.warn(`Failed to categorize tools: ${e}`);
			}
		}

		let uncategorized: LanguageModelToolInformation[] = [];
		if (!virts) {
			uncategorized = tools;
		} else {
			const group = virts.findIndex(g => g.name === Constant.UNCATEGORIZED_TOOLS_GROUP_NAME);
			if (group >= 0) {
				uncategorized = virts[group].tools;
				virts.splice(group, 1);
			}
		}

		/* __GDPR__
			"virtualTools.generate" : {
				"owner": "connor4312",
				"comment": "Reports information about the generation of virtual tools.",
				"groupKey": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Key of the categorized group (MCP or extension)" },

				"toolsBefore": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tools before categorization", "isMeasurement": true },
				"toolsAfter": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tools after categorization", "isMeasurement": true },
				"retries": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of retries to categorize the tools", "isMeasurement": true },
				"uncategorizedTools": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tools that could not be categorized", "isMeasurement": true },
				"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total duration of the operation in milliseconds", "isMeasurement": true }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('virtualTools.generate', {
			groupKey: key,
		}, {
			uncategorized: uncategorized?.length || 0,
			toolsBefore: tools.length,
			toolsAfter: virts?.length || 0,
			retries,
			durationMs: sw.elapsed(),
		});

		this._telemetryService.sendInternalMSFTTelemetryEvent('virtualTools.toolset', {
			uncategorized: JSON.stringify(uncategorized.map(t => t.name)),
			groups: JSON.stringify(virts?.map(v => ({ name: v.name, tools: v.tools.map(t => t.name) })) || []),
		}, { retries, durationMs: sw.elapsed() });

		const virtualTools: (VirtualTool | LanguageModelToolInformation)[] = virts?.map(v => {
			const src = tools[0].source;
			const possiblePrefix = src instanceof LanguageModelToolExtensionSource
				? (src.id.split('.').at(1) || src.id)
				: src?.label;
			const vt = new VirtualTool(VIRTUAL_TOOL_NAME_PREFIX + v.name, SUMMARY_PREFIX + v.summary + SUMMARY_SUFFIX, 0, {
				toolsetKey: key,
				groups: virts,
				possiblePrefix: possiblePrefix?.replaceAll(/[^a-zA-Z0-9]/g, '_').slice(0, 10) + '_'
			}, v.tools);
			return vt;
		}) || [];

		return virtualTools.concat(uncategorized);
	}

	/** Makes multiple sub-groups from the given tool list. */
	protected async _divideToolsIntoGroups(tools: LanguageModelToolInformation[], previous: ISummarizedToolCategory[] | undefined, token: CancellationToken) {
		const endpoint = await this._endpointProvider.getChatEndpoint(CATEGORIZATION_ENDPOINT);


		if (previous) {
			const newTools = new Set(tools.map(t => t.name));
			previous = previous
				.map(p => ({ ...p, tools: p.tools.filter(t => newTools.has(t.name)) }))
				.filter(p => p.tools.length > 0);
		}

		const summarized = previous?.length
			? await divideToolsIntoExistingGroups(endpoint, previous, tools, token)
			: await divideToolsIntoGroups(endpoint, tools, token);

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
