/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ComponentStatistics, PromptMetadata } from '../../../../prompt/src/components/components';
import { findEditDistanceScore } from '../../../../prompt/src/suffixMatchCriteria';
import { ApproximateTokenizer, getTokenizer, Tokenizer, TokenizerName } from '../../../../prompt/src/tokenization';
import { DocumentUri } from '../../../../types/src';
import { Context } from '../../context';
import { Features } from '../../experiments/features';
import { LRUCacheMap } from '../../helpers/cache';
import { TextDocumentManager } from '../../textDocumentManager';
import { setDefault } from '../../util/map';
import { CompletionsPromptOptions } from '../completionsPromptFactory/completionsPromptFactory';
import { CodeSnippetWithId, TraitWithId } from '../contextProviders/contextItemSchemas';
import {
	EMPTY_NODE,
	IVirtualNode,
	NodeId,
	rectifyWeights,
	render,
	RenderedText,
	RenderNode,
	snapshot,
} from '../render/renderNode';
import { getAvailableNodeId, NodeCostFunction } from '../render/utils';
import { MAX_EDIT_DISTANCE_LENGTH } from './currentFile';

/* How many lines of prefix/suffix should have cached token costs */
const NUM_CACHED_LINE_COSTS = 20_000;

export type RenderedComponent = {
	root: RenderNode;
	renderedNodes: Map<NodeId, RenderNode>;
	text: string;
	cost: number;
	metadata: PromptMetadata;
};

export type ComponentSnapshot = {
	root: RenderNode;
	// A set of node IDs to exclude from rendering (e.g. because they are already included elsewhere in the prompt, or are invalid for this request).
	mask?: NodeId[];
	// Nodes to be tracked for telemetry statistics
	statistics?: Map<NodeId, ComponentStatistics>;
};

export type ValidatedContextItems = {
	traits: TraitWithId[];
	codeSnippets: CodeSnippetWithId[];
};

export interface VirtualPromptComponent {
	name: string;
	snapshot(options: CompletionsPromptOptions, context?: ValidatedContextItems): ComponentSnapshot;
	estimatedCost?(options: CompletionsPromptOptions, context?: ValidatedContextItems): number;
}

let renderId = 0; // Unique across all render calls, used for telemetry
const renderCache = new LRUCacheMap<
	NodeId,
	{ budget: number; mask: Set<NodeId>; tokenizer: TokenizerName; render: RenderedText }
>();
export function renderWithMetadata(
	component: VirtualPromptComponent,
	budget: number,
	options: CompletionsPromptOptions,
	context?: ValidatedContextItems
): RenderedComponent {
	renderId++;
	const tokenizerName = options.promptOpts?.tokenizer ?? TokenizerName.o200k;
	const start = performance.now();
	const { root, mask, statistics } = component.snapshot(options, context);
	const renderEnd = performance.now();

	const maskSet = new Set(mask);
	const cachedRender = renderCache?.get(root.id);
	let renderedText: RenderedText;
	if (
		cachedRender &&
		cachedRender.budget >= budget &&
		cachedRender.render.cost <= budget &&
		cachedRender.tokenizer === tokenizerName &&
		maskSet.size === cachedRender.mask.size &&
		[...maskSet].every(id => cachedRender.mask.has(id))
	) {
		// If we have a cached render, use it if we expect the same result
		// (identical masks and tokenizer, cost within budget, and previous budget at least as large as current budget)
		renderedText = cachedRender.render;
	} else {
		// Otherwise, render the node
		const tokenizer = getTokenizer(tokenizerName);
		const costFunction = (text: string) => tokenizer.tokenLength(text);
		renderedText = render(root, { budget, mask, costFunction });
		renderCache.set(root.id, {
			budget,
			mask: maskSet,
			tokenizer: tokenizerName,
			render: renderedText,
		});
	}
	const { text, cost, renderedNodes } = renderedText;
	const elisionEnd = performance.now();
	for (const [id, stat] of statistics?.entries() ?? []) {
		// Note that we are currently only recording the cost of the node itself, not the costs of its children.
		// This is enough for existing telemetry, since we put CodeSnippets and Traits in their own nodes.
		stat.actualTokens = renderedNodes.get(id)?.cost ?? 0;
	}
	const metadata: PromptMetadata = {
		renderId: renderId,
		rendererName: 'renderNode',
		tokenizer: tokenizerName,
		elisionTimeMs: elisionEnd - renderEnd,
		renderTimeMs: renderEnd - start,
		updateDataTimeMs: 0,
		componentStatistics: [{ componentPath: component.name, actualTokens: cost }],
	};
	return { root, renderedNodes, text, cost, metadata };
}

function cachedLineCostFunction(tokenizer: Tokenizer, cache: Map<string, number>): NodeCostFunction {
	return (node: IVirtualNode) => {
		const key = node.text.join('') + '\n';
		// since actual token costs aren't known until we concatenate the lines,
		// we slightly overestimate the cost to increase likelihood of respecting budget on first try
		return setDefault(cache, key, () => tokenizer.tokenLength(key) + 1);
	};
}

function getLinewiseNode(raw: string, costFunction: NodeCostFunction, reversed: boolean): RenderNode {
	const lines = raw.split('\n');
	const children = lines.map(line => ({ id: getAvailableNodeId(), text: [line], children: [], canMerge: true }));
	const seps = [''];
	if (children.length >= 1) {
		seps.push(...Array<string>(children.length - 1).fill('\n'), '');
	}
	const virtualNode = { id: getAvailableNodeId(), text: seps, children, canMerge: true };
	// Don't include elision marker in node cost, since there will be at most one such marker
	const nodeCostFunction = (node: IVirtualNode) => (node.id === virtualNode.id ? 0 : costFunction(node));
	const root = snapshot(virtualNode, nodeCostFunction);
	// Weight lines so that each line is has less value than the following one
	// (Or more value, if reversed)
	let valueTarget = reversed ? children.length : 1;
	for (const child of root.children) {
		child.weight = valueTarget * Math.max(1, child.cost);
		valueTarget += reversed ? -1 : 1;
	}
	return root;
}

export class BasicPrefixComponent implements VirtualPromptComponent {
	readonly name = 'basicPrefix';
	private costCache = new LRUCacheMap<string, number>(NUM_CACHED_LINE_COSTS);

	snapshot(options: CompletionsPromptOptions): ComponentSnapshot {
		const { completionState, promptOpts } = options;
		const rawPrefix = completionState.textDocument.getText({
			start: { line: 0, character: 0 },
			end: completionState.position,
		});
		const tokenizer = getTokenizer(promptOpts?.tokenizer);
		const costFunction = cachedLineCostFunction(tokenizer, this.costCache);
		const root = getLinewiseNode(rawPrefix, costFunction, false);
		return { root };
	}
}

type CachedSuffix = {
	root: RenderNode;
	text: string;
	cost: number;
};
const NULL_SUFFIX: CachedSuffix = {
	root: EMPTY_NODE,
	text: '',
	cost: 0,
};

export class CachedSuffixComponent implements VirtualPromptComponent {
	readonly name = 'cachedSuffix';

	private cache = new LRUCacheMap<DocumentUri, CachedSuffix>(5);
	private costCache = new LRUCacheMap<string, number>(NUM_CACHED_LINE_COSTS);
	constructor(private readonly ctx: Context) { }

	snapshot(options: CompletionsPromptOptions): ComponentSnapshot {
		const cachedSuffix = this.getCachedSuffix(options);
		return { root: cachedSuffix.root };
	}

	estimatedCost(options: CompletionsPromptOptions, context?: ValidatedContextItems): number {
		const cachedSuffix = this.getCachedSuffix(options);
		return cachedSuffix.cost;
	}

	private getCachedSuffix(options: CompletionsPromptOptions): CachedSuffix {
		const { completionState, telemetryData, promptOpts } = options;
		const rawSuffix = completionState.textDocument.getText({
			start: completionState.position,
			end: { line: Number.MAX_VALUE, character: Number.MAX_VALUE },
		});
		// Start the suffix at the beginning of the next line. This allows for consistent reconciliation of trailing punctuation.
		const trimmedSuffix = rawSuffix.replace(/^.*/, '').trimStart();
		if (trimmedSuffix === '') {
			return NULL_SUFFIX;
		}

		const cachedSuffix = this.cache.get(completionState.textDocument.uri) || NULL_SUFFIX;
		// Cache hit
		if (cachedSuffix.text === trimmedSuffix) {
			return cachedSuffix;
		}

		const matchThreshold = this.ctx.get(Features).suffixMatchThreshold(telemetryData);
		if (cachedSuffix.text !== '') {
			const tokenizer = new ApproximateTokenizer();
			const firstSuffixTokens = tokenizer.takeFirstTokens(trimmedSuffix, MAX_EDIT_DISTANCE_LENGTH);
			// Check if the suffix is similar to the cached suffix.
			// See docs/suffix_caching.md for some background about why we do this.
			if (firstSuffixTokens.tokens.length > 0) {
				// Calculate the distance between the computed and cached suffixed using Levenshtein distance.
				// Only compare the first MAX_EDIT_DISTANCE_LENGTH tokens to speed up.
				const dist = findEditDistanceScore(
					firstSuffixTokens.tokens,
					tokenizer.takeFirstTokens(cachedSuffix.text, MAX_EDIT_DISTANCE_LENGTH).tokens
				)?.score;
				if (100 * dist < matchThreshold * firstSuffixTokens.tokens.length) {
					return cachedSuffix;
				}
			}
		}

		// Otherwise, use the new suffix

		const tokenizer = getTokenizer(promptOpts?.tokenizer);
		const costFunction = cachedLineCostFunction(tokenizer, this.costCache);
		const root = getLinewiseNode(trimmedSuffix, costFunction, true);
		const cost = root.children.reduce((sum, child) => sum + child.cost + 1, 0);
		return { root, cost, text: trimmedSuffix };
	}
}

export class TraitComponent implements VirtualPromptComponent {
	readonly name = 'traitProvider';

	snapshot(options: CompletionsPromptOptions, context?: ValidatedContextItems): ComponentSnapshot {
		const { promptOpts } = options;
		const tokenizer = getTokenizer(promptOpts?.tokenizer);
		if (!context || context.traits.length === 0) {
			return { root: EMPTY_NODE };
		}
		const weights: Map<number, number> = new Map();
		let totalWeight = 0;
		const children: RenderNode[] = [];
		const statistics: Map<NodeId, ComponentStatistics> = new Map();
		for (const trait of context.traits) {
			const id = getAvailableNodeId();
			const text = `${trait.name}: ${trait.value}`;
			const child: RenderNode = {
				id,
				text: [text],
				children: [],
				cost: tokenizer.tokenLength(text),
				weight: 0,
				elisionMarker: '',
				canMerge: true,
				requireRenderedChild: true,
			};
			children.push(child);
			statistics.set(id, {
				componentPath: trait.id,
				source: trait,
				expectedTokens: child.cost,
			});
			weights.set(id, trait.importance ?? 0);
			totalWeight += trait.importance ?? 0;
		}
		totalWeight = Math.max(totalWeight, 1);
		const header = `Related context:\n`;
		const text: string[] = [header, ...new Array<string>(children.length).fill('\n')];
		const root: RenderNode = {
			id: getAvailableNodeId(),
			text,
			children,
			cost: 0,
			weight: 0,
			elisionMarker: '',
			canMerge: true,
			requireRenderedChild: true,
		};
		rectifyWeights(root, node => (weights.get(node.id) ?? 0) / totalWeight);
		return { root, statistics };
	}
}

export class CodeSnippetComponent implements VirtualPromptComponent {
	readonly name = 'contextProvider';
	constructor(private readonly ctx: Context) { }

	snapshot(options: CompletionsPromptOptions, context?: ValidatedContextItems): ComponentSnapshot {
		const { promptOpts } = options;
		const tokenizer = getTokenizer(promptOpts?.tokenizer);
		if (!context || context.codeSnippets.length === 0) {
			return { root: EMPTY_NODE };
		}

		// Snippets with the same URI should appear together as a single snippet.
		const snippetsByUri = new Map<string, CodeSnippetWithId[]>();
		for (const snippet of context.codeSnippets) {
			const uri = snippet.uri;
			setDefault(snippetsByUri, uri, () => []).push(snippet);
		}
		const statistics: Map<NodeId, ComponentStatistics> = new Map();

		const uriNodes: RenderNode[] = [];
		const weights: Map<number, number> = new Map();
		let totalWeight = 0;
		const tdm = this.ctx.get(TextDocumentManager);
		for (const [uri, snippets] of snippetsByUri.entries()) {
			const relativeUri = tdm.getRelativePath({ uri }) ?? uri;
			const header = `Compare ${snippets.length > 1 ? 'these snippets' : 'this snippet'} from ${relativeUri}:\n`;
			const text: string[] = [header, ...new Array<string>(snippets.length).fill('\n')];
			const children: RenderNode[] = [];
			for (const snippet of snippets) {
				const id = getAvailableNodeId();
				weights.set(id, snippet.importance ?? 0);
				const child: RenderNode = {
					id,
					text: [snippet.value],
					children: [],
					cost: tokenizer.tokenLength(snippet.value),
					weight: snippet.importance ?? 0,
					elisionMarker: '',
					canMerge: true,
					requireRenderedChild: false,
				};
				children.push(child);
				totalWeight += snippet.importance ?? 0;
				statistics.set(id, {
					componentPath: snippet.id,
					source: snippet,
					expectedTokens: child.cost,
				});
			}
			uriNodes.push({
				id: getAvailableNodeId(),
				text,
				children,
				cost: tokenizer.tokenLength(text.join('')),
				weight: 0,
				elisionMarker: '',
				canMerge: true,
				requireRenderedChild: true,
			});
		}
		totalWeight = Math.max(totalWeight, 1);
		const text = new Array(uriNodes.length + 1).fill('');
		const root: RenderNode = {
			id: getAvailableNodeId(),
			text,
			children: uriNodes,
			cost: 0,
			weight: 0,
			elisionMarker: '',
			canMerge: true,
			requireRenderedChild: true,
		};
		// We set the weights here so they can be normalized
		rectifyWeights(root, node => (weights.get(node.id) ?? 0) / totalWeight);
		return { root, statistics };
	}
}

export class ConcatenatedContextComponent implements VirtualPromptComponent {
	constructor(
		readonly name: string,
		readonly components: VirtualPromptComponent[]
	) { }

	snapshot(options: CompletionsPromptOptions, context?: ValidatedContextItems): ComponentSnapshot {
		const snapshots = this.components.map(component => component.snapshot(options, context));
		const children = snapshots.map(s => s.root).filter(n => n.id !== EMPTY_NODE.id);
		if (children.length === 0) {
			return { root: EMPTY_NODE };
		}
		const text = ['', ...Array<string>(children.length - 1).fill('\n'), ''];
		const root: RenderNode = {
			id: getAvailableNodeId(),
			text,
			children,
			cost: 0,
			weight: 0,
			elisionMarker: '',
			canMerge: true,
			requireRenderedChild: false,
		};
		const mask: NodeId[] = [];
		const statistics = new Map<NodeId, ComponentStatistics>();
		for (const s of snapshots) {
			for (const [id, stat] of s.statistics?.entries() ?? []) {
				statistics.set(id, stat);
			}
			if (s.mask) {
				mask.push(...s.mask);
			}
		}
		return { root, mask, statistics };
	}
}
