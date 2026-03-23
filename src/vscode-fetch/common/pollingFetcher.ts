/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, IDisposable, IFetchLogger, PollingFetcherConfig } from './types';

/**
 * Minimal event emitter for use within the self-contained vscode-fetch module.
 * Structurally compatible with VS Code's `Emitter<T>`.
 */
class Emitter<T> implements IDisposable {
	private _listeners: Array<(e: T) => void> = [];

	/** The event that consumers subscribe to. */
	readonly event: Event<T> = listener => {
		this._listeners.push(listener);
		return {
			dispose: () => {
				const idx = this._listeners.indexOf(listener);
				if (idx >= 0) {
					this._listeners.splice(idx, 1);
				}
			},
		};
	};

	fire(value: T): void {
		for (const listener of [...this._listeners]) {
			listener(value);
		}
	}

	dispose(): void {
		this._listeners.length = 0;
	}
}

/**
 * A background polling utility that periodically invokes an async function
 * and exposes the latest result as an observable value.
 *
 * Features:
 * - **Observable**: Subscribe to value changes via {@link onDidChange}.
 * - **Initial value**: Optionally provide a cached value so {@link value} is
 *   available synchronously before the first poll completes.
 * - **Configurable polling interval**
 * - **Window state awareness**: Skips polling when the window is inactive
 *   and resumes immediately when it becomes active.
 * - **Usage tracking**: Optionally skips polling when the result hasn't
 *   been consumed since the last fetch.
 *
 * Designed as a reusable, self-contained utility within the vscode-fetch module.
 * Implements {@link IDisposable} for resource cleanup.
 */
export class PollingFetcher<T> implements IDisposable {
	private _value: T | undefined;
	private _lastError: Error | undefined;
	private _fetchPromise: Promise<void> | undefined;
	private _usedSinceLastFetch = false;
	private _skippedPollSinceLastUse = false;
	private _timerId: ReturnType<typeof setTimeout> | undefined;
	private _disposed = false;
	private _pollInFlight = false;
	private readonly _windowStateDisposable: IDisposable | undefined;
	private readonly _onDidChange = new Emitter<T>();

	/**
	 * Fires whenever the polled value changes (including the initial fetch).
	 * Subscribe to reactively receive new values.
	 */
	readonly onDidChange: Event<T> = this._onDidChange.event;

	constructor(
		private readonly _fetchFn: () => Promise<T>,
		private readonly _config: PollingFetcherConfig<T>,
		private readonly _logger?: IFetchLogger,
	) {
		// Seed with cached initial value if provided
		if (_config.initialValue !== undefined) {
			this._value = _config.initialValue;
		}

		if (_config.windowStateProvider) {
			this._windowStateDisposable = _config.windowStateProvider.onDidChangeWindowState(state => {
				if (!state.active || !this._shouldResumeOnWindowActive()) {
					return;
				}

				// Avoid starting a new poll if one is already in-flight
				if (this._pollInFlight) {
					return;
				}

				// Cancel any previously scheduled timer before polling immediately
				if (this._timerId !== undefined) {
					clearTimeout(this._timerId);
					this._timerId = undefined;
				}

				this._fetchPromise = this._poll();
			});
		}
		// Start first poll immediately
		this._fetchPromise = this._poll();
	}

	/**
	 * The current value, or undefined if no value has been fetched yet
	 * and no initial value was provided.
	 * Reading this marks the value as "used" for skip-when-unused tracking.
	 */
	get value(): T | undefined {
		if (this._value !== undefined) {
			this._usedSinceLastFetch = true;
			this._skippedPollSinceLastUse = false;
		}
		return this._value;
	}

	/**
	 * Get the latest result, fetching if none is available yet.
	 * Marks the result as "used" for skip-when-unused tracking.
	 * @throws if the poller has been disposed.
	 */
	async getResult(): Promise<T> {
		if (this._disposed) {
			throw new Error('PollingFetcher: cannot get result after dispose');
		}
		// When skipWhenUnused is enabled and poll cycles were actually
		// skipped, the held value may be arbitrarily stale. Force a fresh
		// fetch so callers (e.g. auth token consumers) always get an
		// up-to-date result.
		if (this._value !== undefined && this._skippedPollSinceLastUse) {
			this._fetchPromise = this._poll(true);
			await this._fetchPromise;
		}
		if (this._value === undefined) {
			if (this._fetchPromise) {
				await this._fetchPromise;
			}
			// If we still don't have a result (e.g. the first poll failed), force a new fetch
			if (this._value === undefined) {
				this._fetchPromise = this._poll(true);
				await this._fetchPromise;
			}
		}
		if (this._value === undefined) {
			throw this._lastError ?? new Error('PollingFetcher: failed to fetch result after retry');
		}
		this._usedSinceLastFetch = true;
		this._skippedPollSinceLastUse = false;
		return this._value;
	}

	dispose(): void {
		this._disposed = true;
		if (this._timerId !== undefined) {
			clearTimeout(this._timerId);
			this._timerId = undefined;
		}
		this._windowStateDisposable?.dispose();
		this._onDidChange.dispose();
	}

	private _shouldRefetch(): boolean {
		if (this._config.skipWhenUnused && !this._usedSinceLastFetch) {
			return false;
		}
		return true;
	}

	/**
	 * Determines whether to re-fetch when the window becomes active.
	 * If {@link PollingFetcherConfig.shouldResumeOnWindowActive} is provided,
	 * it gates the decision. Otherwise falls back to {@link _shouldRefetch}.
	 */
	private _shouldResumeOnWindowActive(): boolean {
		if (!this._shouldRefetch()) {
			return false;
		}
		if (this._config.shouldResumeOnWindowActive) {
			return this._config.shouldResumeOnWindowActive(this._value);
		}
		return true;
	}

	private async _poll(force?: boolean): Promise<void> {
		if (this._disposed) {
			return;
		}
		try {
			// Skip if window is inactive (unless forced), but keep the polling loop alive
			if (!force && this._config.windowStateProvider && !this._config.windowStateProvider.isActive) {
				return;
			}
			this._pollInFlight = true;
			const newValue = await this._fetchFn();
			this._value = newValue;
			this._lastError = undefined;
			this._usedSinceLastFetch = false;
			this._onDidChange.fire(newValue);
		} catch (e) {
			// When a callsite is disabled, preserve the current value so
			// consumers keep working with the last known good result.
			const isDisabled = e instanceof Error && e.name === 'FetchCallsiteDisabledError';
			this._lastError = e instanceof Error ? e : new Error(String(e));
			if (isDisabled) {
				this._logger?.warn('PollingFetcher: poll skipped (callsite disabled)', e);
			} else {
				this._logger?.warn('PollingFetcher: poll failed', e);
				if (!this._config.preserveValueOnError) {
					this._value = undefined;
				}
			}
		} finally {
			this._pollInFlight = false;
			this._fetchPromise = undefined;
			this._scheduleNext();
		}
	}

	private _scheduleNext(): void {
		if (this._disposed) {
			return;
		}
		// Clear any previously scheduled timer to avoid overlapping polls
		if (this._timerId !== undefined) {
			clearTimeout(this._timerId);
		}
		const dynamicMs = this._value !== undefined
			? this._config.getNextIntervalMs?.(this._value)
			: undefined;
		const intervalMs = Math.max(dynamicMs ?? this._config.intervalMs, 1000);
		this._timerId = setTimeout(() => {
			if (this._disposed) {
				return;
			}
			// Guard against overlapping polls: if a previous poll (or a
			// forced getResult() fetch) is still in-flight, reschedule
			// instead of starting a concurrent one.
			if (this._pollInFlight) {
				this._scheduleNext();
				return;
			}
			if (!this._shouldRefetch()) {
				// Not consumed since last fetch — skip this cycle and wait for
				// the next interval instead of spinning.  The value is kept so
				// that `getResult()` can still force a fresh fetch on demand.
				this._skippedPollSinceLastUse = true;
				this._scheduleNext();
				return;
			}
			this._fetchPromise = this._poll();
		}, intervalMs);
	}
}
