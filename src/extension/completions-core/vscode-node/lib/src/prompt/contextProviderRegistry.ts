/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource, DocumentSelector } from 'vscode-languageserver-protocol';
import type { ILanguageContextProviderService } from '../../../../../../platform/languageContextProvider/common/languageContextProviderService';
import { isCancellationError } from '../../../../../../util/vs/base/common/errors';
import {
	ContextItemUsageDetails,
	ContextProvider,
	DocumentContext,
	ResolutionStatus,
	ResolveRequest,
	ResolveResult,
	SupportedContextItem,
	UsageStatus,
} from '../../../types/src';
import { ConfigKey, getConfig } from '../config';
import { Context } from '../context';
import { Features } from '../experiments/features';
import { LRUCacheMap } from '../helpers/cache';
import { logger } from '../logger';
import { TelemetryWithExp } from '../telemetry';
import { isDebugEnabled, isRunningInSimulation } from '../testing/runtimeMode';
import { isArrayOfT, resolveAll } from './asyncUtils';
import { fillInCppVSCodeActiveExperiments } from './contextProviderRegistryCpp';
import { fillInCSharpActiveExperiments } from './contextProviderRegistryCSharp';
import { fillInMultiLanguageActiveExperiments } from './contextProviderRegistryMultiLanguage';
import { fillInTsActiveExperiments } from './contextProviderRegistryTs';
import {
	addOrValidateContextItemsIDs,
	filterSupportedContextItems,
	SupportedContextItemWithId,
} from './contextProviders/contextItemSchemas';
import { ContextProviderStatistics } from './contextProviderStatistics';

export interface ResolvedContextItem<T extends SupportedContextItemWithId = SupportedContextItemWithId> {
	providerId: string;
	matchScore: number;
	resolution: ResolutionStatus;
	resolutionTimeMs: number;
	data: T[];
}

export interface ContextProviderTelemetry {
	providerId: string;
	matched: boolean;
	resolution: ResolutionStatus;
	resolutionTimeMs: number;
	usage: UsageStatus;
	usageDetails?: ContextItemUsageDetails[];
	numResolvedItems: number;
	numUsedItems?: number;
	numPartiallyUsedItems?: number;
}

export abstract class ContextProviderRegistry {
	abstract registerContextProvider<T extends SupportedContextItem>(provider: ContextProvider<T>): void;
	abstract unregisterContextProvider(providerId: string): void;
	abstract get providers(): ContextProvider<SupportedContextItem>[];
	abstract resolveAllProviders(
		completionId: string,
		opportunityId: string,
		documentContext: DocumentContext,
		telemetryData: TelemetryWithExp,
		completionToken?: CancellationToken,
		// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#completionItem
		data?: unknown
	): Promise<ResolvedContextItem[]>;
}

export type ActiveExperiments = Map<string, string | number | boolean | string[]>;

export abstract class DefaultContextProviders {
	abstract getIds(): string[];
	abstract add(id: string): void;
}

export class DefaultContextProvidersContainer extends DefaultContextProviders {
	private ids: string[] = [];

	constructor() {
		super();
	}

	add(id: string) {
		this.ids.push(id);
	}

	getIds(): string[] {
		return this.ids;
	}
}

class CoreContextProviderRegistry extends ContextProviderRegistry {
	constructor(
		protected ctx: Context,
		private match: (
			ctx: Context,
			documentSelector: DocumentSelector,
			documentContext: DocumentContext
		) => Promise<number> | number,
		private registryService: ILanguageContextProviderService
	) {
		super();
	}

	registerContextProvider<T extends SupportedContextItem>(_provider: ContextProvider<T>) {
		throw new Error(`Should not be call. Use ILanguageContextProviderService`);
	}

	unregisterContextProvider(_providerId: string) {
		throw new Error(`Should not be call. Use ILanguageContextProviderService`);
	}

	get providers(): ContextProvider<SupportedContextItem>[] {
		return this.registryService.getAllProviders().slice() as ContextProvider<SupportedContextItem>[];
	}

	/**
	 * Resolves all context providers for the given context.
	 * Items returned will need to be filtered by schema.
	 */
	async resolveAllProviders(
		completionId: string,
		opportunityId: string,
		documentContext: DocumentContext,
		telemetryData: TelemetryWithExp,
		completionCancellationToken?: CancellationToken,
		data?: unknown
	): Promise<ResolvedContextItem[]> {
		if (completionCancellationToken?.isCancellationRequested) {
			logger.debug(this.ctx, `Resolving context providers cancelled`);
			return [];
		}
		// Pass experiments here if needed.
		const activeExperiments: ActiveExperiments = new Map();
		fillInCSharpActiveExperiments(this.ctx, activeExperiments, telemetryData);
		const resolvedContextItems: ResolvedContextItem[] = [];

		const _providers = this.providers;
		if (_providers.length === 0) {
			return resolvedContextItems;
		}

		const providersWithMatchScore = await this.matchProviders(_providers, documentContext, telemetryData);
		const matchedProviders = providersWithMatchScore.filter(p => p[1] > 0);
		const unmatchedProviders = providersWithMatchScore.filter(p => p[1] <= 0);

		// For the unmatched providers, we still want to create a context item, but with an empty data array.
		unmatchedProviders.forEach(([provider, score]) => {
			const item: ResolvedContextItem = {
				providerId: provider.id,
				matchScore: score,
				resolution: 'none',
				resolutionTimeMs: 0,
				data: [],
			};
			resolvedContextItems.push(item);
		});

		if (matchedProviders.length === 0) {
			return resolvedContextItems;
		}
		if (completionCancellationToken?.isCancellationRequested) {
			logger.debug(this.ctx, `Resolving context providers cancelled`);
			return [];
		}

		// Fill in the active experiments for the matched providers.
		fillInCppVSCodeActiveExperiments(
			this.ctx,
			matchedProviders.map(p => p[0].id),
			activeExperiments,
			telemetryData
		);
		fillInMultiLanguageActiveExperiments(
			this.ctx,
			matchedProviders.map(p => p[0].id),
			activeExperiments,
			telemetryData
		);
		fillInTsActiveExperiments(
			this.ctx,
			matchedProviders.map(p => p[0].id),
			activeExperiments,
			telemetryData
		);

		const providerCancellationTokenSource = new CancellationTokenSource();
		if (completionCancellationToken) {
			const disposable = completionCancellationToken.onCancellationRequested(_ => {
				providerCancellationTokenSource.cancel();
				disposable.dispose();
			});
		}

		// Overriding this config with a value of 0 will create an infinite timeout (useful for debugging)
		const timeBudget =
			isDebugEnabled(this.ctx) && !isRunningInSimulation(this.ctx)
				? 0
				: getContextProviderTimeBudget(this.ctx, telemetryData);
		const timeoutEnd = timeBudget > 0 ? Date.now() + timeBudget : Number.MAX_SAFE_INTEGER;
		let timeoutId: TimeoutHandle | undefined;
		if (timeBudget > 0) {
			timeoutId = setTimeout(() => {
				providerCancellationTokenSource.cancel();
				providerCancellationTokenSource.dispose();
			}, timeBudget);
		}

		const resolutionMap: Map<string, ResolveResult<SupportedContextItem>> = new Map();
		const request: ResolveRequest = {
			completionId,
			opportunityId,
			documentContext,
			activeExperiments,
			timeBudget,
			timeoutEnd,
			data,
		};
		for (const [provider] of matchedProviders) {
			const stats = this.ctx
				.get(ContextProviderStatistics)
				.getPreviousStatisticsForCompletion(completionId)
				?.get(provider.id);

			if (stats) {
				request.previousUsageStatistics = stats;
			}

			const pendingContextItem = provider.resolver.resolve(request, providerCancellationTokenSource.token);
			resolutionMap.set(provider.id, pendingContextItem);
		}
		const results = await resolveAll(resolutionMap, providerCancellationTokenSource.token);

		// Once done, clear the timeout so that we don't cancel the request once it has finished.
		if (timeoutId) {
			clearTimeout(timeoutId);
		}

		for (const [provider, score] of matchedProviders) {
			const result = results.get(provider.id);
			if (result) {
				if (result.status === 'error') {
					if (!isCancellationError(result.reason)) {
						logger.error(this.ctx, `Error resolving context from ${provider.id}: `, result.reason);
					}
					resolvedContextItems.push({
						providerId: provider.id,
						matchScore: score,
						resolution: result.status,
						resolutionTimeMs: result.resolutionTime,
						data: [],
					});
				} else {
					const mergedItems: SupportedContextItem[] = [...(result.value ?? [])];
					if (result.status === 'none' || result.status === 'partial') {
						logger.info(
							this.ctx,
							`Context provider ${provider.id} exceeded time budget of ${timeBudget}ms`
						);
						if (provider.resolver.resolveOnTimeout) {
							try {
								const fallbackItems = provider.resolver.resolveOnTimeout(request);

								if (isArrayOfT(fallbackItems)) {
									mergedItems.push(...fallbackItems);
								} else if (fallbackItems) {
									mergedItems.push(fallbackItems);
								}

								if (mergedItems.length > 0) {
									result.status = 'partial';
								}
							} catch (error) {
								logger.error(
									this.ctx,
									`Error in fallback logic for context provider ${provider.id}: `,
									error
								);
							}
						}
					}
					const [supportedItems, invalidItems] = filterSupportedContextItems(mergedItems);
					if (invalidItems) {
						logger.error(
							this.ctx,
							`Dropped ${invalidItems} context items from ${provider.id} due to invalid schema`
						);
					}
					const filteredItemsWithId = addOrValidateContextItemsIDs(this.ctx, supportedItems);

					const resolvedContextItem: ResolvedContextItem = {
						providerId: provider.id,
						matchScore: score,
						resolution: result.status,
						resolutionTimeMs: result.resolutionTime,
						data: filteredItemsWithId,
					};

					resolvedContextItems.push(resolvedContextItem);
				}
				this.ctx
					.get(ContextProviderStatistics)
					.getStatisticsForCompletion(completionId)
					.setLastResolution(provider.id, result.status);
			} else {
				// This can't happen
				logger.error(this.ctx, `Context provider ${provider.id} not found in results`);
			}
		}
		// Sort the results by match score, so that the highest match score is first.
		return resolvedContextItems.sort((a, b) => b.matchScore - a.matchScore);
	}

	private async matchProviders(
		providers: ContextProvider<SupportedContextItem>[],
		documentContext: DocumentContext,
		telemetryData: TelemetryWithExp
	): Promise<[ContextProvider<SupportedContextItem>, number][]> {
		const activeContextProviders = getActiveContextProviders(this.ctx, telemetryData);
		const enableAllProviders = activeContextProviders.length === 1 && activeContextProviders[0] === '*';

		const providersWithScore = await Promise.all(
			providers.map(async provider => {
				if (!enableAllProviders && !activeContextProviders.includes(provider.id)) {
					return [provider, 0] as [ContextProvider<SupportedContextItem>, number];
				}

				const matchScore = await this.match(this.ctx, provider.selector, documentContext);
				return [provider, matchScore] as [ContextProvider<SupportedContextItem>, number];
			})
		);
		return providersWithScore;
	}
}

class MutableContextProviderRegistry extends CoreContextProviderRegistry {

	private _providers: ContextProvider<SupportedContextItem>[] = [];

	constructor(
		ctx: Context,
		match: (
			ctx: Context,
			documentSelector: DocumentSelector,
			documentContext: DocumentContext
		) => Promise<number> | number,
		registryService: ILanguageContextProviderService
	) {
		super(ctx, match, registryService);
	}

	override registerContextProvider<T extends SupportedContextItem>(provider: ContextProvider<T>) {
		if (provider.id.includes(',') || provider.id.includes('*')) {
			throw new Error(
				`A context provider id cannot contain a comma or an asterisk. The id ${provider.id} is invalid.`
			);
		}
		if (this._providers.find(p => p.id === provider.id)) {
			throw new Error(`A context provider with id ${provider.id} has already been registered`);
		}
		this._providers.push(provider);
	}

	override unregisterContextProvider(_providerId: string) {
		throw new Error(`Should not be call. Use ILanguageContextProviderService`);
	}

	override get providers() {
		return this._providers.slice().concat(super.providers);
	}
}

class CachedContextProviderRegistry extends ContextProviderRegistry {
	// We don't need to cache many items, since initially we will only hold the cache for
	// the duration of a single completion request.
	private _cachedContextItems: LRUCacheMap<string, ResolvedContextItem[]> = new LRUCacheMap(5);

	constructor(private readonly delegate: CoreContextProviderRegistry) {
		super();
	}

	registerContextProvider<T extends SupportedContextItem>(provider: ContextProvider<T>): void {
		this.delegate.registerContextProvider(provider);
	}

	unregisterContextProvider(providerId: string): void {
		this.delegate.unregisterContextProvider(providerId);
	}

	get providers(): ContextProvider<SupportedContextItem>[] {
		return this.delegate.providers;
	}

	async resolveAllProviders(
		completionId: string,
		opportunityId: string,
		documentContext: DocumentContext,
		telemetryData: TelemetryWithExp,
		completionToken?: CancellationToken,
		data?: unknown
	): Promise<ResolvedContextItem[]> {
		const cachedItems = this._cachedContextItems.get(completionId);

		if (completionId && cachedItems && cachedItems.length > 0) {
			return cachedItems;
		}

		const resolvedContextItems = await this.delegate.resolveAllProviders(
			completionId,
			opportunityId,
			documentContext,
			telemetryData,
			completionToken,
			data
		);

		if (resolvedContextItems.length > 0 && completionId) {
			this._cachedContextItems.set(completionId, resolvedContextItems);
		}

		return resolvedContextItems;
	}
}

export function getContextProviderRegistry(
	ctx: Context,
	match: (
		ctx: Context,
		documentSelector: DocumentSelector,
		documentContext: DocumentContext
	) => Promise<number> | number,
	registryService: ILanguageContextProviderService,
	mutable: boolean = false
) {
	return new CachedContextProviderRegistry(
		mutable
			? new MutableContextProviderRegistry(ctx, match, registryService)
			: new CoreContextProviderRegistry(ctx, match, registryService)
	);
}

export function telemetrizeContextItems(
	ctx: Context,
	completionId: string,
	resolvedContextItems: ResolvedContextItem[]
) {
	const contextProviderStatistics = ctx.get(ContextProviderStatistics).getStatisticsForCompletion(completionId);
	const contextProviderTelemetry: ContextProviderTelemetry[] = resolvedContextItems.map(p => {
		const { providerId, resolution, resolutionTimeMs, matchScore, data } = p;

		const providerStatistics = contextProviderStatistics.get(providerId);
		let usage = providerStatistics?.usage ?? 'none';

		// Unmatched providers are special: we still want to telemetrize them, but we don't
		// rely on the statistics since those will refer to the last time it was matched!
		if (matchScore <= 0 || resolution === 'none' || resolution === 'error') {
			usage = 'none';
		}

		const contextProviderTelemetry: ContextProviderTelemetry = {
			providerId,
			resolution,
			resolutionTimeMs,
			usage,
			usageDetails: providerStatistics?.usageDetails,
			matched: matchScore > 0,
			numResolvedItems: data.length,
		};

		const numUsedItems =
			providerStatistics?.usageDetails !== undefined
				? providerStatistics?.usageDetails.filter(
					i => i.usage === 'full' || i.usage === 'partial' || i.usage === 'partial_content_excluded'
				).length
				: undefined;

		const numPartiallyUsedItems =
			providerStatistics?.usageDetails !== undefined
				? providerStatistics?.usageDetails.filter(
					i => i.usage === 'partial' || i.usage === 'partial_content_excluded'
				).length
				: undefined;

		// TODO: Inline this above once promptlib has been removed
		if (numUsedItems !== undefined) {
			contextProviderTelemetry.numUsedItems = numUsedItems;
		}
		if (numPartiallyUsedItems !== undefined) {
			contextProviderTelemetry.numPartiallyUsedItems = numPartiallyUsedItems;
		}

		return contextProviderTelemetry;
	});

	return contextProviderTelemetry;
}

export function matchContextItems(resolvedContextItem: ResolvedContextItem): boolean {
	return resolvedContextItem.matchScore > 0 && resolvedContextItem.resolution !== 'error';
}

function getActiveContextProviders(ctx: Context, telemetryData: TelemetryWithExp): string[] {
	const expContextProviders = getExpContextProviders(ctx, telemetryData);
	const configContextProviders: string[] = getConfig(ctx, ConfigKey.ContextProviders) ?? [];

	if (
		(expContextProviders.length === 1 && expContextProviders[0] === '*') ||
		(configContextProviders.length === 1 && configContextProviders[0] === '*')
	) {
		return ['*'];
	}

	// Merge the two arrays and deduplicate
	const defaultContextProviders = ctx.get(DefaultContextProviders).getIds();
	return Array.from(new Set([...defaultContextProviders, ...expContextProviders, ...configContextProviders]));
}

/**
 * This only returns the context providers that are enabled by EXP.
 * Use `getActiveContextProviders` to get the context providers that are enabled by both EXP and config.
 */
function getExpContextProviders(ctx: Context, telemetryData: TelemetryWithExp) {
	if (isDebugEnabled(ctx)) {
		return ['*'];
	}

	return ctx.get(Features).contextProviders(telemetryData);
}

export function useContextProviderAPI(ctx: Context, telemetryData: TelemetryWithExp) {
	return getActiveContextProviders(ctx, telemetryData).length > 0;
}

function getContextProviderTimeBudget(ctx: Context, telemetryData: TelemetryWithExp): number {
	const configTimeout = getConfig<number | undefined>(ctx, ConfigKey.ContextProviderTimeBudget);
	if (configTimeout !== undefined && typeof configTimeout === 'number') {
		return configTimeout;
	}

	return ctx.get(Features).contextProviderTimeBudget(telemetryData);
}
