/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { ContextKind, type ContextItem, type ILanguageContextService } from '../../../platform/languageServer/common/languageContextService';
import * as protocol from '../common/serverProtocol';

export type ResolvedRunnableResult = {
	id: protocol.ContextRunnableResultId;
	state: protocol.ContextRunnableState;
	priority: number;
	items: protocol.FullContextItem[];
	cache?: protocol.CacheInfo;
}
export namespace ResolvedRunnableResult {
	export function from(result: protocol.ContextRunnableResult, items: protocol.FullContextItem[]): ResolvedRunnableResult {
		return {
			id: result.id,
			state: result.state,
			priority: result.priority,
			items: items,
			cache: result.cache
		};
	}
}

export type ContextComputedEvent = {
	document: vscode.TextDocument;
	position: vscode.Position;
	results: ReadonlyArray<ResolvedRunnableResult>;
	summary: ContextItemSummary;
}

export type OnCachePopulatedEvent = ContextComputedEvent;
export type OnContextComputedEvent = ContextComputedEvent;
export type OnContextComputedOnTimeoutEvent = ContextComputedEvent;

export interface IInternalLanguageContextService extends ILanguageContextService {
	onCachePopulated: vscode.Event<OnCachePopulatedEvent>;
	onContextComputed: vscode.Event<OnContextComputedEvent>;
	onContextComputedOnTimeout: vscode.Event<OnContextComputedOnTimeoutEvent>;
}

export type Stats = {
	total: number;
	totalSize: number;
	snippets: number;
	traits: number;
	yielded: number;
	items: { [runnable: string]: [state: string, numberOfItems: number, sizeInChars: number, emitMode: string, cacheScope: string] };
};

export namespace Stats {
	export function create(): Stats {
		return {
			total: 0,
			totalSize: 0,
			snippets: 0,
			traits: 0,
			yielded: 0,
			items: {
			},
		};
	}
	export function update(stats: Stats, runnableResult: ResolvedRunnableResult): void {
		let size: number = 0;
		for (const item of runnableResult.items) {
			stats.total++;
			switch (item.kind) {
				case protocol.ContextKind.Snippet:
					stats.snippets++;
					size = protocol.CodeSnippet.sizeInChars(item);
					break;
				case protocol.ContextKind.Trait:
					stats.traits++;
					size = protocol.Trait.sizeInChars(item);
					break;
			}
		}
		stats.items[runnableResult.id] = [runnableResult.state, runnableResult.items.length, size, runnableResult.cache?.emitMode ?? 'none', runnableResult.cache?.scope.kind ?? 'notCached'];
		stats.totalSize += size;
	}
	export function yielded(stats: Stats): void {
		stats.yielded++;
	}
}

export interface ContextItemSummary {
	path?: number[];
	errorData: protocol.ErrorData[] | undefined;
	stats: Stats;
	cancelled: boolean;
	timedOut: boolean;
	tokenBudgetExhausted: boolean;
	cachedItems: number;
	referencedItems: number;
	fromCache: boolean;
	serverComputed: Set<string> | undefined;
	serverTime: number;
	contextComputeTime: number;
	totalTime: number;
}
export namespace ContextItemSummary {
	export const DefaultExhausted: ContextItemSummary = Object.freeze<ContextItemSummary>({
		path: [0],
		errorData: undefined,
		stats: Stats.create(),
		cancelled: false,
		timedOut: false,
		tokenBudgetExhausted: true,
		cachedItems: 0,
		referencedItems: 0,
		fromCache: false,
		serverComputed: undefined,
		serverTime: -1,
		contextComputeTime: -1,
		totalTime: 0,
	});
}

export class ContextItemResultBuilder implements ContextItemSummary {

	private readonly seenRunnableResults: Set<protocol.ContextRunnableResultId>;
	private readonly seenContextItems: Set<protocol.ContextItemKey>;

	public path?: number[];
	public errorData: protocol.ErrorData[] | undefined;
	public stats: Stats;
	public cancelled: boolean;
	public timedOut: boolean;
	public tokenBudgetExhausted: boolean;
	public cachedItems: number;
	public referencedItems: number;
	public serverComputed: Set<string> | undefined;
	public fromCache: boolean;
	public serverTime: number;
	public contextComputeTime: number;
	public totalTime: number;

	constructor(totalTime: number) {
		this.seenRunnableResults = new Set();
		this.seenContextItems = new Set();

		this.path = [0];
		this.errorData = undefined;
		this.stats = Stats.create();
		this.cancelled = false;
		this.timedOut = false;
		this.tokenBudgetExhausted = false;
		this.cachedItems = 0;
		this.referencedItems = 0;
		this.fromCache = false;
		this.serverComputed = undefined;
		this.serverTime = -1;
		this.contextComputeTime = -1;
		this.totalTime = totalTime;
	}

	public updateResponse(result: protocol.ContextRequestResult, token: vscode.CancellationToken): void {
		this.timedOut = result.timedOut;
		this.tokenBudgetExhausted = result.exhausted;
		this.serverTime = result.timings?.totalTime ?? -1;
		this.contextComputeTime = result.timings?.computeTime ?? -1;
		this.path = result.path;
		this.cancelled = token.isCancellationRequested;
	}

	public *update(runnableResult: ResolvedRunnableResult, fromCache: boolean = false): IterableIterator<ContextItem> {
		if (this.seenRunnableResults.has(runnableResult.id)) {
			return;
		}
		this.seenRunnableResults.add(runnableResult.id);
		Stats.update(this.stats, runnableResult);
		for (const item of runnableResult.items) {
			if (protocol.ContextItem.hasKey(item)) {
				if (this.seenContextItems.has(item.key)) {
					continue;
				}
				this.seenContextItems.add(item.key);
			}
			const converted = ContextItemResultBuilder.doConvert(item, runnableResult.priority);
			if (converted === undefined) {
				continue;
			}
			Stats.yielded(this.stats);
			yield converted;
		}
	}

	public *convert(runnableResult: ResolvedRunnableResult): IterableIterator<ContextItem> {
		Stats.update(this.stats, runnableResult);
		for (const item of runnableResult.items) {
			const converted = ContextItemResultBuilder.doConvert(item, runnableResult.priority);
			if (converted === undefined) {
				continue;
			}
			Stats.yielded(this.stats);
			yield converted;
		}
	}

	private static doConvert(item: protocol.ContextItem, priority: number): ContextItem | undefined {
		switch (item.kind) {
			case protocol.ContextKind.Snippet:
				return {
					kind: ContextKind.Snippet,
					priority: priority,
					uri: vscode.Uri.file(item.fileName),
					additionalUris: item.additionalFileNames?.map(uri => vscode.Uri.file(uri)),
					value: item.value
				};
			case protocol.ContextKind.Trait:
				return {
					kind: ContextKind.Trait,
					priority: priority,
					name: item.name,
					value: item.value
				};
		}
		return undefined;
	}
}