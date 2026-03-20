/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CircuitBreakerConfig, IDisposable, IFetchLogger } from './types';

type CircuitState = 'closed' | 'open' | 'half-open';

const DEFAULT_THRESHOLD = 5;
const DEFAULT_HALF_OPEN_AFTER_MS = 30_000;

/**
 * Error thrown when a request is rejected because the callsite's circuit breaker is open.
 */
export class CircuitOpenError extends Error {
	constructor(readonly callSite: string) {
		super(`Circuit breaker for callsite '${callSite}' is open — requests are being rejected`);
		this.name = 'CircuitOpenError';
	}
}

/**
 * Circuit breaker for a single callsite.
 *
 * Tracks consecutive failures and transitions through three states:
 * - **Closed**: Requests pass through. Transitions to open after {@link threshold} consecutive failures.
 * - **Open**: Requests are rejected. Transitions to half-open after {@link halfOpenAfterMs}.
 * - **Half-Open**: Allows one probe request. Success → closed, failure → open.
 */
class CallsiteCircuitBreaker {
	private _state: CircuitState = 'closed';
	private _consecutiveFailures = 0;
	private _openedAt = 0;
	private _halfOpenProbeInFlight = false;

	readonly threshold: number;
	readonly halfOpenAfterMs: number;

	constructor(config?: CircuitBreakerConfig) {
		this.threshold = config?.threshold ?? DEFAULT_THRESHOLD;
		this.halfOpenAfterMs = config?.halfOpenAfterMs ?? DEFAULT_HALF_OPEN_AFTER_MS;
	}

	get state(): CircuitState {
		return this._state;
	}

	/**
	 * Check whether a request should be allowed through.
	 * Returns true if the request can proceed, false if it should be rejected.
	 */
	canRequest(): boolean {
		switch (this._state) {
			case 'closed':
				return true;
			case 'open':
				if (Date.now() - this._openedAt >= this.halfOpenAfterMs) {
					this._state = 'half-open';
					this._halfOpenProbeInFlight = true;
					return true;
				}
				return false;
			case 'half-open':
				// Only allow one probe request at a time
				if (!this._halfOpenProbeInFlight) {
					this._halfOpenProbeInFlight = true;
					return true;
				}
				return false;
		}
	}

	recordSuccess(): void {
		this._consecutiveFailures = 0;
		this._state = 'closed';
		this._halfOpenProbeInFlight = false;
	}

	recordFailure(): void {
		this._halfOpenProbeInFlight = false;
		this._consecutiveFailures++;
		if (this._state === 'half-open' || this._consecutiveFailures >= this.threshold) {
			this._state = 'open';
			this._openedAt = Date.now();
			this._consecutiveFailures = 0;
		}
	}
}

/**
 * Manages per-callsite circuit breakers.
 * Each callsite gets its own independent circuit breaker instance.
 */
export class CircuitBreakerRegistry implements IDisposable {
	private readonly _breakers = new Map<string, CallsiteCircuitBreaker>();

	constructor(
		private readonly _config?: CircuitBreakerConfig,
		private readonly _logger?: IFetchLogger,
	) { }

	/**
	 * Dispose all circuit breaker state.
	 */
	dispose(): void {
		this._breakers.clear();
	}

	/**
	 * Check whether a request to the given callsite should be allowed.
	 * @throws {CircuitOpenError} if the circuit is open and the request should be rejected.
	 */
	checkCallsite(callSite: string): void {
		const breaker = this._getOrCreate(callSite);
		if (!breaker.canRequest()) {
			this._logger?.warn(`Circuit breaker open for '${callSite}' — rejecting request`);
			throw new CircuitOpenError(callSite);
		}
	}

	/**
	 * Non-mutating check: returns `true` when the circuit for the given
	 * callsite is fully open (not half-open, not closed). Use this for
	 * rechecks that must not consume a half-open probe slot.
	 */
	isOpen(callSite: string): boolean {
		const breaker = this._breakers.get(callSite);
		return breaker?.state === 'open';
	}

	recordSuccess(callSite: string): void {
		this._getOrCreate(callSite).recordSuccess();
	}

	recordFailure(callSite: string): void {
		const breaker = this._getOrCreate(callSite);
		breaker.recordFailure();
		if (breaker.state === 'open') {
			this._logger?.warn(
				`Circuit breaker tripped for '${callSite}' after ${breaker.threshold} consecutive failures — will retry after ${breaker.halfOpenAfterMs}ms`,
			);
		}
	}

	private _getOrCreate(callSite: string): CallsiteCircuitBreaker {
		let breaker = this._breakers.get(callSite);
		if (!breaker) {
			breaker = new CallsiteCircuitBreaker(this._config);
			this._breakers.set(callSite, breaker);
		}
		return breaker;
	}
}
