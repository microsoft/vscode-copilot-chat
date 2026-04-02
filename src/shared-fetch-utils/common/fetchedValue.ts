/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface FetchedValueOptions<T> {
	/**
	 * The async function that fetches the value from the network.
	 */
	fetch: () => Promise<T>;

	/**
	 * Determines whether the current cached value is stale and should be re-fetched.
	 * Called by {@link FetchedValue.resolve} to decide if a new fetch is needed.
	 *
	 * When `value` is `undefined` (no cached value), the value is always considered stale
	 * and this function is not called.
	 */
	isStale: (value: T) => boolean;
}

/**
 * A cached value backed by an async fetch operation.
 *
 * Provides both a synchronous {@link value} accessor (returns the current cached value
 * or `undefined`) and an asynchronous {@link resolve} method that only fetches when the
 * value is stale, as determined by the caller-supplied {@link FetchedValueOptions.isStale}
 * predicate.
 *
 * Concurrent calls to {@link resolve} are coalesced into a single in-flight fetch so the
 * network is hit at most once per staleness window.
 *
 * @example
 * ```ts
 * const token = new FetchedValue({
 *     fetch: () => fetchTokenFromServer(),
 *     isStale: (t) => t.expires_at - 300 < nowSeconds(),
 * });
 *
 * // Synchronous read — may be undefined before first resolve
 * const current = token.value;
 *
 * // Async — fetches only when stale
 * const fresh = await token.resolve();
 * ```
 */
export class FetchedValue<T> {
	private _value: T | undefined;
	private _inflightFetch: Promise<T> | undefined;
	private _disposed = false;

	private readonly _fetch: () => Promise<T>;
	private readonly _isStale: (value: T) => boolean;

	constructor(options: FetchedValueOptions<T>) {
		this._fetch = options.fetch;
		this._isStale = options.isStale;
	}

	/**
	 * The current cached value, or `undefined` if no value has been fetched yet
	 * (or the value has been {@link reset}).
	 *
	 * This is a synchronous accessor — it never triggers a fetch.
	 */
	get value(): T | undefined {
		return this._value;
	}

	/**
	 * Returns the cached value if it is still fresh, otherwise fetches a new value.
	 *
	 * Concurrent calls while a fetch is in-flight share the same promise, so the
	 * network is never hit more than once per staleness window.
	 *
	 * @param force When `true`, bypasses the staleness check and always fetches.
	 */
	async resolve(force?: boolean): Promise<T> {
		this._throwIfDisposed();
		if (!force && this._value !== undefined && !this._isStale(this._value)) {
			return this._value;
		}
		if (this._inflightFetch) {
			return this._inflightFetch;
		}
		this._inflightFetch = this._doFetch();
		try {
			return await this._inflightFetch;
		} finally {
			this._inflightFetch = undefined;
		}
	}

	dispose(): void {
		this._disposed = true;
		this._value = undefined;
		this._inflightFetch = undefined;
	}

	private async _doFetch(): Promise<T> {
		const newValue = await this._fetch();
		this._throwIfDisposed();
		this._value = newValue;
		return newValue;
	}

	private _throwIfDisposed(): void {
		if (this._disposed) {
			throw new Error('FetchedValue has been disposed');
		}
	}
}


