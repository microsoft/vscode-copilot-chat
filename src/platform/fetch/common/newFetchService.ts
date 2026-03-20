/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { FetchModule } from '../../../vscode-fetch/common/fetchModule';
import { CachedFetchResponse } from '../../../vscode-fetch/common/responseCache';
import { FetchModuleConfig, FetchModuleOptions, IExperimentation, IFetcher } from '../../../vscode-fetch/common/types';
import { FetchOptions, IFetcherService, PaginationOptions, Response, WebSocketConnection, WebSocketConnectOptions } from '../../networking/common/fetcherService';

/**
 * A background polling utility that periodically fetches a value and
 * exposes it as an observable. Returned by {@link INewFetchService.createPollingFetcher}.
 */
export interface IPollingFetcher<T> extends IDisposable {
	/** The current value, or undefined if not yet fetched and no initial value was provided. */
	readonly value: T | undefined;
	/** Fires whenever the polled value changes (including the initial fetch). */
	readonly onDidChange: Event<T>;
	/** Get the latest result, fetching if none is available yet. */
	getResult(): Promise<T>;
}

/** Configuration for creating a {@link PollingFetcher} via the fetch service. */
export interface PollingFetcherOptions<T> {
	/** Polling interval in milliseconds. */
	readonly intervalMs: number;
	/**
	 * Optional callback to compute a dynamic interval from the latest value.
	 * Return `undefined` to fall back to {@link intervalMs}.
	 */
	readonly getNextIntervalMs?: (value: T) => number | undefined;
	/**
	 * Window state provider for skipping polls while the window is inactive.
	 * Compatible with {@link IEnvService}.
	 */
	readonly windowStateProvider?: {
		readonly isActive: boolean;
		onDidChangeWindowState(listener: (state: { readonly active: boolean }) => void): IDisposable;
	};
	/** If true, skip polling when the result hasn't been consumed since the last fetch. */
	readonly skipWhenUnused?: boolean;
	/**
	 * Optional predicate called when the window becomes active to decide whether
	 * to immediately re-fetch. Receives the current value (or undefined if none).
	 * Return `true` to trigger a fetch, `false` to skip.
	 */
	readonly shouldResumeOnWindowActive?: (currentValue: T | undefined) => boolean;
	/** Initial cached value so consumers can access `value` synchronously before the first poll. */
	readonly initialValue?: T;
}

export interface INewFetchService {
	readonly _serviceBrand: undefined;

	/**
	 * Performs a fetch request, subject to experiment-based callsite kill-switching,
	 * circuit breaking, concurrency limiting, retry, and caching.
	 *
	 * When caching is enabled via `cacheTtlMs` on a GET request, the returned
	 * response may be a `CachedFetchResponse` instead of a full platform
	 * `Response`. To check, use the `isCachedFetchResponse()` helper exported
	 * from `vscode-fetch/common/responseCache`, or structurally check for the
	 * absence of platform-specific properties.
	 */
	fetch(url: string, options: FetchOptions): Promise<Response | CachedFetchResponse>;

	/**
	 * Checks whether a given callsite is currently disabled via experiment.
	 */
	isCallsiteDisabled(callSite: string): boolean;

	/**
	 * Fetches paginated data from a URL, accumulating results across pages.
	 * Delegates to the underlying fetcher service.
	 */
	fetchWithPagination<T>(baseUrl: string, options: PaginationOptions<T>): Promise<T[]>;

	/**
	 * Creates a WebSocket connection to the given URL.
	 * Delegates to the underlying fetcher service.
	 */
	createWebSocket(url: string, options?: WebSocketConnectOptions): WebSocketConnection;

	/**
	 * Creates a background polling utility that periodically invokes the given
	 * function and exposes the latest result as an observable value.
	 *
	 * The returned {@link PollingFetcher} is disposable and must be cleaned up
	 * by the caller (e.g. via `_register`).
	 *
	 * Callsite kill-switching is handled by the fetch service layer that the
	 * {@link fetchFn} should be calling into, so there is no separate callsite
	 * parameter here.
	 */
	createPollingFetcher<T>(fetchFn: () => Promise<T>, options: PollingFetcherOptions<T>): IPollingFetcher<T>;
}

export const INewFetchService = createServiceIdentifier<INewFetchService>('INewFetchService');

export abstract class BaseNewFetchService extends Disposable implements INewFetchService {
	readonly _serviceBrand: undefined;

	protected readonly fetchModule: FetchModule<FetchModuleOptions, Response>;

	constructor(
		private readonly _fetcherService: IFetcherService,
		experimentationService: IExperimentation,
		config?: FetchModuleConfig,
	) {
		super();
		// Adapt IFetcherService to IFetcher. The platform's FetchOptions and
		// FetchModuleOptions differ in minor type narrowing (signal, method) but
		// are structurally compatible at runtime.
		const fetcher: IFetcher<FetchModuleOptions, Response> = {
			fetch: (url, opts) => this._fetcherService.fetch(url, opts as unknown as FetchOptions),
		};
		this.fetchModule = new FetchModule(fetcher, experimentationService, config);
		this._register(this.fetchModule);
	}

	fetch(url: string, options: FetchOptions): Promise<Response | CachedFetchResponse> {
		return this.fetchModule.fetch(url, options as unknown as FetchModuleOptions);
	}

	isCallsiteDisabled(callSite: string): boolean {
		return this.fetchModule.isCallsiteDisabled(callSite);
	}

	fetchWithPagination<T>(baseUrl: string, options: PaginationOptions<T>): Promise<T[]> {
		return this._fetcherService.fetchWithPagination(baseUrl, options);
	}

	createWebSocket(url: string, options?: WebSocketConnectOptions): WebSocketConnection {
		return this._fetcherService.createWebSocket(url, options);
	}

	createPollingFetcher<T>(fetchFn: () => Promise<T>, options: PollingFetcherOptions<T>): IPollingFetcher<T> {
		return this.fetchModule.createPollingFetcher(fetchFn, options);
	}
}
