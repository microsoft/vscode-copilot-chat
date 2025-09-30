/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { CHAT_MODEL, ConfigKey, HARD_TOOL_LIMIT, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IEmbeddingsComputer } from '../../../../platform/embeddings/common/embeddingsComputer';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../../platform/log/common/logService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { TelemetryCorrelationId } from '../../../../util/common/telemetryCorrelationId';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { groupBy } from '../../../../util/vs/base/common/collections';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { StopWatch } from '../../../../util/vs/base/common/stopwatch';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelToolExtensionSource, LanguageModelToolMCPSource } from '../../../../vscodeTypes';
import { EMBEDDING_TYPE_FOR_TOOL_GROUPING, ToolEmbeddingsComputer } from './toolEmbeddingsCache';
import { EMBEDDINGS_GROUP_NAME, VIRTUAL_TOOL_NAME_PREFIX, VirtualTool } from './virtualTool';
import { divideToolsIntoExistingGroups, divideToolsIntoGroups, summarizeToolGroup } from './virtualToolSummarizer';
import { ISummarizedToolCategory, IToolCategorization, IToolGroupingCache } from './virtualToolTypes';
import * as Constant from './virtualToolsConstants';

const BUILT_IN_GROUP = 'builtin';
const CATEGORIZATION_ENDPOINT = CHAT_MODEL.GPT4OMINI;
const SUMMARY_PREFIX = 'Call this tool when you need access to a new category of tools. The category of tools is described as follows:\n\n';
const SUMMARY_SUFFIX = '\n\nBe sure to call this tool if you need a capability related to the above.';

export class VirtualToolGrouper implements IToolCategorization {
	private readonly toolEmbeddingsComputer: ToolEmbeddingsComputer;

	constructor(
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@IToolGroupingCache private readonly _cache: IToolGroupingCache,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
		@IEmbeddingsComputer private readonly embeddingsComputer: IEmbeddingsComputer,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		this.toolEmbeddingsComputer = _instantiationService.createInstance(ToolEmbeddingsComputer);
	}

	private get virtualToolEmbeddingRankingEnabled() {
		return this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.VirtualToolEmbeddingRanking, this._expService);
	}

	async addGroups(query: string, root: VirtualTool, tools: LanguageModelToolInformation[], token: CancellationToken): Promise<void> {
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

		const predictedToolsSw = new StopWatch();
		const predictedToolsPromise = this.virtualToolEmbeddingRankingEnabled && this._getPredictedTools(query, tools, token).then(tools => ({ tools, durationMs: predictedToolsSw.elapsed() }));

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
					tool.metadata.wasExpandedByDefault = prev.metadata.wasExpandedByDefault;
					tool.lastUsedOnTurn = prev.lastUsedOnTurn;
				}
			}
		}

		await this._reExpandTools(root, predictedToolsPromise);
	}

	async recomputeEmbeddingRankings(query: string, root: VirtualTool, token: CancellationToken): Promise<void> {
		if (!this.virtualToolEmbeddingRankingEnabled) {
			return;
		}

		const predictedToolsSw = new StopWatch();

		await this._reExpandTools(root, this._getPredictedTools(query, [...root.tools()], token).then(tools => ({
			tools,
			durationMs: predictedToolsSw.elapsed()
		})));
	}

	private _addPredictedToolsGroup(root: VirtualTool, predictedTools: LanguageModelToolInformation[]): void {
		const newGroup = new VirtualTool(EMBEDDINGS_GROUP_NAME, 'Tools with high predicted relevancy for this query', Infinity, {
			toolsetKey: EMBEDDINGS_GROUP_NAME,
			wasExpandedByDefault: true,
			canBeCollapsed: false,
			groups: [],
		});

		newGroup.isExpanded = true;
		for (const tool of predictedTools) {
			newGroup.contents.push(tool);
		}

		const idx = root.contents.findIndex(t => t.name === EMBEDDINGS_GROUP_NAME);
		if (idx >= 0) {
			root.contents[idx] = newGroup;
		} else {
			root.contents.unshift(newGroup);
		}
	}

	private async _reExpandTools(root: VirtualTool, predictedToolsPromise: Promise<{ tools: LanguageModelToolInformation[]; durationMs: number }> | false): Promise<void> {
		if (predictedToolsPromise) {
			// Aggressively expand groups with predicted tools up to hard limit
			const sw = new StopWatch();
			let error: Error | undefined;
			let computeMs: number | undefined;
			try {
				const { tools, durationMs } = await predictedToolsPromise;
				computeMs = durationMs;
				this._addPredictedToolsGroup(root, tools);
			} catch (e) {
				error = e;
			} finally {
				// Telemetry for predicted tool re-expansion
				/* __GDPR__
					"virtualTools.expandEmbedding" : {
						"owner": "connor4312",
						"comment": "Expansion of virtual tool groups using embedding-based ranking.",
						"error": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "Error message if expansion failed" },
						"blockingMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Blocking duration of the expansion operation in milliseconds", "isMeasurement": true },
						"computeMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Duration of the expansion operation in milliseconds", "isMeasurement": true },
						"hadError": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the operation had an error", "isMeasurement": true }
					}
				*/
				this._telemetryService.sendMSFTTelemetryEvent('virtualTools.expandEmbedding', { error: error ? error.message : undefined }, {
					blockingMs: sw.elapsed(),
					computeMs,
					hadError: error ? 1 : 0,
				});
			}
		}

		this._reExpandToolsToHitBudget(root, g => g.contents.length);
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
	 * Eagerly expand groups when possible just to reduce the number of indirections.
	 * Uses the provided ranker function to determine expansion priority.
	 *
	 * @param root The root virtual tool containing groups to expand
	 * @param ranker Function to rank groups (lower scores = higher priority)
	 * @param targetLimit Maximum number of tools to expand to (defaults to EXPAND_UNTIL_COUNT)
	 *
	 * Note: when this is made smarter, we should increase `MIN_TOOLSET_SIZE_TO_GROUP`,
	 * which is right now because tiny toolsets are likely to automatically be included.
	 */
	private _reExpandToolsToHitBudget(root: VirtualTool, ranker: (group: VirtualTool) => number, targetLimit: number = Constant.EXPAND_UNTIL_COUNT): void {
		let toolCount = Iterable.length(root.tools());
		if (toolCount > targetLimit) {
			return; // No need to expand further.
		}

		// Get unexpanded virtual tools, sorted by the ranker function (ascending order).
		const expandable = root.contents
			.filter((t): t is VirtualTool => t instanceof VirtualTool && !t.isExpanded)
			.sort((a, b) => ranker(a) - ranker(b));

		// Expand them until we hit the target limit
		for (const vtool of expandable) {
			const nextCount = toolCount - 1 + vtool.contents.length;
			if (nextCount > HARD_TOOL_LIMIT) {
				break;
			}

			vtool.isExpanded = true;
			vtool.metadata.wasExpandedByDefault = true;
			toolCount = nextCount;

			if (toolCount > targetLimit) {
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

	private async _getPredictedTools(query: string, tools: LanguageModelToolInformation[], token: CancellationToken): Promise<LanguageModelToolInformation[]> {
		// compute the embeddings for the query
		const queryEmbedding = await this.embeddingsComputer.computeEmbeddings(EMBEDDING_TYPE_FOR_TOOL_GROUPING, [query], {}, new TelemetryCorrelationId('VirtualToolGrouper::_getPredictedTools'), token);
		if (!queryEmbedding || queryEmbedding.values.length === 0) {
			return [];
		}
		const queryEmbeddingVector = queryEmbedding.values[0];

		// Filter out built-in tools. Only consider extension and MCP tools for similarity computation
		const nonBuiltInTools = tools.filter(tool =>
			tool.source instanceof LanguageModelToolExtensionSource ||
			tool.source instanceof LanguageModelToolMCPSource
		);

		// Get the top 10 tool embeddings for the non-built-in tools
		const availableToolNames = new Set(nonBuiltInTools.map(tool => tool.name));
		const toolEmbeddings = await this.toolEmbeddingsComputer.retrieveSimilarEmbeddingsForAvailableTools(queryEmbeddingVector, availableToolNames, 10, token);
		if (!toolEmbeddings) {
			return [];
		}

		// Filter the tools by the top 10 tool embeddings, maintaining order
		const toolNameToTool = new Map(tools.map(tool => [tool.name, tool]));
		const predictedTools = toolEmbeddings
			.map((toolName: string) => toolNameToTool.get(toolName))
			.filter((tool: LanguageModelToolInformation | undefined): tool is LanguageModelToolInformation => tool !== undefined);
		return predictedTools;
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
