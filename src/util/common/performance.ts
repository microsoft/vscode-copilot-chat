/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../vs/base/common/lifecycle';

function _detailMatchesAny(entryDetail: unknown, filters?: Record<string, unknown>[]): boolean {
	if (!filters || filters.length === 0) {
		return true;
	}
	if (entryDetail === undefined || entryDetail === null) {
		return true; // marks with no detail are always cleared when the prefix matches
	}
	if (typeof entryDetail !== 'object') {
		return false;
	}
	const detail = entryDetail as Record<string, unknown>;
	return filters.some(filter => {
		for (const key of Object.keys(filter)) {
			if (detail[key] !== filter[key]) {
				return false;
			}
		}
		return true;
	});
}

/**
 * Clears all performance marks whose name starts with the given prefix.
 * If `details` is provided, only clears marks whose detail matches any of the given filters.
 */
export function clearMarks(prefix: string, details?: Record<string, unknown>[]): void {
	const toRemove = new Set<string>();
	for (const entry of performance.getEntriesByType('mark')) {
		if (entry.name.startsWith(prefix) && _detailMatchesAny((entry as unknown as { detail?: unknown }).detail, details)) {
			toRemove.add(entry.name);
		}
	}
	for (const name of toRemove) {
		performance.clearMarks(name);
	}
}

const _tracers = new Map<string, PerfTracer>();

/**
 * Creates a new {@link PerfTracer} with the given prefix.
 * A trailing `/` is appended to the prefix automatically (e.g. `'code/chat/ext'` → `'code/chat/ext/'`).
 *
 * By default, the tracer is registered in the global registry so that downstream code can
 * look it up via {@link getPerfTracer}. If a tracer with the same prefix already exists,
 * it is disposed and replaced.
 *
 * When `local` is `true`, the tracer is not registered globally. Use this for multi-instance
 * components (e.g. widgets) where multiple tracers may share the same prefix.
 */
export function createPerfTracer(prefix: string, options?: { local?: boolean }): PerfTracer {
	const normalizedPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
	const tracer = new PerfTracer(normalizedPrefix);
	if (!options?.local) {
		_tracers.get(normalizedPrefix)?.dispose();
		_tracers.set(normalizedPrefix, tracer);
	}
	return tracer;
}

/**
 * Returns the globally registered {@link PerfTracer} for the given prefix, or `undefined` if none exists.
 * A trailing `/` is appended to the prefix automatically.
 */
export function getPerfTracer(prefix: string): PerfTracer | undefined {
	const normalizedPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
	return _tracers.get(normalizedPrefix);
}

/**
 * A reusable performance tracing helper that manages mark lifecycle within a given prefix namespace.
 * Use {@link createPerfTracer} to create an instance (globally registered or local).
 *
 * Lifecycle:
 * - The **owner** calls `tracer.start(detail?)` to create a new trace (and clean up completed ones).
 * - The owner calls `trace.registerCorrelation(key, value)` once a correlation ID is known (e.g., requestId).
 * - **Downstream code** calls `getPerfTracer(prefix)?.findTraceByCorrelation(key, value)` to join an existing trace and emit marks to it.
 * - The owner calls `trace.done()` when the operation completes. Marks are cleaned on the next `start()`.
 * - The owner calls `tracer.dispose()` when the component is torn down, clearing all remaining marks.
 *
 * ```
 * // Owner (e.g. chatParticipants)
 * const tracer = createPerfTracer('code/chat/ext');
 * const trace = tracer.start({ sessionResource: '...' });
 * trace.mark('willHandleParticipant');
 * trace.registerCorrelation('requestId', request.id);
 * // ...
 * trace.done();
 * tracer.dispose(); // on component teardown
 *
 * // Downstream (e.g. toolCallingLoop)
 * const trace = getPerfTracer('code/chat/ext')?.findTraceByCorrelation('requestId', id);
 * trace?.mark('willRunLoop');
 * trace?.mark('didRunLoop');
 * // NO .done() — doesn't own the lifecycle
 * ```
 */
class PerfTracer implements IDisposable {

	private static _nextTraceId = 0;

	private readonly _doneTraceIds = new Set<string>();
	private readonly _activeTraces = new Map<string, PerfTrace>(); // "key:value" -> trace
	private _disposed = false;

	constructor(private readonly _prefix: string) { }

	/**
	 * Starts a new trace. Clears marks from any previously completed traces.
	 * Returns a {@link PerfTrace} that can be used to emit marks and signal completion.
	 */
	start(detail?: Record<string, unknown>): PerfTrace {
		if (this._disposed) {
			throw new Error('PerfTracer is disposed');
		}
		if (this._doneTraceIds.size > 0) {
			clearMarks(this._prefix, [...this._doneTraceIds].map(traceId => ({ traceId })));
			this._doneTraceIds.clear();
		}
		const traceId = String(PerfTracer._nextTraceId++);
		return new PerfTrace(this._prefix, traceId, detail, this._doneTraceIds, this._activeTraces);
	}

	/**
	 * Finds an active trace registered with the given key/value pair.
	 * Returns `undefined` if no matching trace is found or if the value is not a string.
	 */
	findTraceByCorrelation(key: string, value: unknown): PerfTrace | undefined {
		if (this._disposed || typeof value !== 'string') {
			return undefined;
		}
		return this._activeTraces.get(`${key}:${value}`);
	}

	/**
	 * Disposes this tracer: clears all marks with this prefix, unregisters all active traces,
	 * and removes the tracer from the global registry (if registered via {@link createPerfTracer}).
	 */
	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		clearMarks(this._prefix);
		this._doneTraceIds.clear();
		this._activeTraces.clear();
		if (_tracers.get(this._prefix) === this) {
			_tracers.delete(this._prefix);
		}
	}
}

export class PerfTrace implements IDisposable {

	private readonly _registrations: string[] = [];

	constructor(
		private readonly _prefix: string,
		private readonly _traceId: string,
		private readonly _detail: Record<string, unknown> | undefined,
		private readonly _doneTraceIds: Set<string>,
		private readonly _activeTraces: Map<string, PerfTrace>,
	) { }

	/**
	 * Registers this trace so downstream code can find it via `tracer.findTraceByCorrelation(key, value)`.
	 */
	registerCorrelation(key: string, value: string): void {
		const registrationKey = `${key}:${value}`;
		this._registrations.push(registrationKey);
		this._activeTraces.set(registrationKey, this);
	}

	/**
	 * Emits a performance mark with the trace's prefix, traceId, and any additional detail.
	 */
	mark(name: string, detail?: Record<string, unknown>): void {
		performance.mark(this._prefix + name, { detail: { traceId: this._traceId, ...this._detail, ...detail } });
	}

	/**
	 * Marks this trace as done. Its marks will be cleared when the next trace starts.
	 * Also unregisters this trace from the lookup map.
	 */
	done(): void {
		this._doneTraceIds.add(this._traceId);
		for (const key of this._registrations) {
			this._activeTraces.delete(key);
		}
		this._registrations.length = 0;
	}

	dispose(): void {
		this.done();
	}
}
