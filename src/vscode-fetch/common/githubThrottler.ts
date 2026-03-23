/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { abortableSleep } from './abortableSleep';
import { FetchModuleResponse, IFetchLogger } from './types';

/**
 * Response header names used by GitHub's quota system.
 */
export const githubQuotaHeaders = Object.freeze({
	totalQuotaUsed: 'x-github-total-quota-used',
	quotaBucketName: 'x-github-quota-bucket-name',
});

/**
 * Returns `true` if the URL targets a GitHub API (github.com or ghe.com).
 */
export function isGitHubUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host === 'github.com' || host.endsWith('.github.com')
			|| host === 'ghe.com' || host.endsWith('.ghe.com');
	} catch {
		return false;
	}
}

/**
 * Sliding window that holds at least N entries and all entries in the time window.
 * If inserts are infrequent, the minimum-entry guarantee ensures there is always
 * some history to work with; when inserts are frequent the time window dominates.
 */
class SlidingTimeAndNWindow {
	private values: number[] = [];
	private times: number[] = [];
	private _startIdx = 0;
	private sumValues = 0;

	constructor(
		private readonly numEntries: number,
		private readonly windowDurationMs: number,
	) { }

	increment(n: number): void {
		this.values.push(n);
		this.times.push(Date.now());
		this.sumValues += n;
	}

	get(): number {
		return this.sumValues;
	}

	average(): number {
		const len = this.values.length - this._startIdx;
		if (len === 0) {
			return 0;
		}
		return this.sumValues / len;
	}

	delta(): number {
		const len = this.values.length - this._startIdx;
		if (len === 0) {
			return 0;
		}
		return this.values[this.values.length - 1] - this.values[this._startIdx];
	}

	size(): number {
		return this.values.length - this._startIdx;
	}

	reset(): void {
		this.values = [];
		this.times = [];
		this._startIdx = 0;
		this.sumValues = 0;
	}

	/**
	 * Removes entries that are both outside the time window and exceed the
	 * minimum entry count. Uses an advancing start index to avoid O(n)
	 * array shifts, and compacts when dead space grows too large.
	 */
	cleanUpOldValues(now: number): void {
		const tooOldTime = now - this.windowDurationMs;
		while (
			(this.values.length - this._startIdx) > this.numEntries &&
			this.times[this._startIdx] < tooOldTime
		) {
			this.sumValues -= this.values[this._startIdx];
			this._startIdx++;
		}
		// Compact when accumulated dead space is large
		if (this._startIdx > 64) {
			this.values = this.values.slice(this._startIdx);
			this.times = this.times.slice(this._startIdx);
			this._startIdx = 0;
		}
	}
}

/**
 * PID-controller–inspired throttler for a single quota bucket.
 * Uses sliding windows of recent quota usage and send periods to compute
 * proportional, integral, and differential terms that determine a dynamic
 * delay before sending the next request.
 */
class BucketThrottler {
	private lastSendTime: number;
	private totalQuotaUsedWindow: SlidingTimeAndNWindow;
	private sendPeriodWindow: SlidingTimeAndNWindow;
	private numOutstandingRequests = 0;

	constructor(private readonly target: number) {
		this.lastSendTime = Date.now();
		this.totalQuotaUsedWindow = new SlidingTimeAndNWindow(5, 2000);
		this.sendPeriodWindow = new SlidingTimeAndNWindow(5, 2000);
	}

	reset(): void {
		if (this.numOutstandingRequests === 0) {
			this.lastSendTime = Date.now();
			this.totalQuotaUsedWindow.reset();
			this.sendPeriodWindow.reset();
		}
	}

	recordQuotaUsed(used: number): void {
		this.totalQuotaUsedWindow.increment(used);
	}

	requestStarted(): void {
		this.numOutstandingRequests += 1;
	}

	requestFinished(): void {
		this.numOutstandingRequests -= 1;
	}

	/**
	 * Returns the number of milliseconds to wait before sending a request.
	 * A return value of `0` means the request can be sent immediately.
	 * This is a pure query — call {@link commitSend} after confirming the
	 * request will proceed.
	 */
	getDelayMs(): number {
		const now = Date.now();

		// Send a request occasionally even if throttled, to refresh quota info.
		if (now > this.lastSendTime + 5 * 60 * 1000) {
			this.reset();
		}

		this.totalQuotaUsedWindow.cleanUpOldValues(now);
		this.sendPeriodWindow.cleanUpOldValues(now);

		// Ramp up slowly at start so the throttler can calibrate based on
		// server feedback before allowing concurrent requests.
		if (
			this.totalQuotaUsedWindow.size() < 5 &&
			this.numOutstandingRequests > 0
		) {
			return THROTTLE_POLL_MS;
		}

		let remainingMs = 0;

		if (this.totalQuotaUsedWindow.get() === 0 || this.sendPeriodWindow.size() === 0) {
			remainingMs = 0;
		} else if (this.sendPeriodWindow.average() > 0) {
			const integral =
				(this.totalQuotaUsedWindow.average() - this.target) / 100;
			const differential = this.totalQuotaUsedWindow.delta();
			const delayMs =
				this.sendPeriodWindow.average() *
				Math.max(1 + 20 * integral + 0.5 * differential, 0.2);
			remainingMs = Math.max(0, (this.lastSendTime + delayMs) - now);
		}

		return Math.max(remainingMs, 0);
	}

	/**
	 * Records that a send is happening now. Must be called once after
	 * {@link getDelayMs} returns `0` and the caller commits to sending.
	 */
	commitSend(): void {
		const now = Date.now();
		this.sendPeriodWindow.increment(now - this.lastSendTime);
		this.lastSendTime = now;
	}
}

/** Delay between throttle poll iterations, in milliseconds. */
const THROTTLE_POLL_MS = 5;

/**
 * Registry that manages GitHub quota-bucket throttlers.
 * Activated automatically when the fetch URL targets a GitHub API.
 *
 * Mirrors the PID-controller throttling from `GithubApiFetcherService` but
 * is integrated into the generic {@link FetchModule} pipeline.
 */
export class GitHubThrottlerRegistry {
	/**
	 * The target percentage usage of each throttler. Higher is faster but
	 * too close to 100 and requests can be rejected.
	 */
	private readonly _target: number;
	/** Quota-bucket name → throttler. */
	private readonly _throttlers = new Map<string, BucketThrottler>();
	/** `"METHOD pathname"` → quota-bucket name, learned from response headers. */
	private readonly _endpointBuckets = new Map<string, string>();

	constructor(target: number = 80, private readonly _logger?: IFetchLogger) {
		this._target = target;
	}

	/**
	 * Waits until the throttler for the given endpoint allows a request.
	 * Sleeps for the exact computed delay instead of busy-polling.
	 * Returns a cleanup function that MUST be called when the request finishes.
	 *
	 * If the endpoint's bucket is not yet known (first request), returns
	 * immediately without blocking.
	 */
	async acquireSlot(method: string | undefined, url: string, signal?: AbortSignal): Promise<{ release: () => void }> {
		const throttler = this._getThrottlerForEndpoint(method ?? 'GET', url);
		if (throttler) {
			let delay: number;
			while ((delay = throttler.getDelayMs()) > 0) {
				signal?.throwIfAborted();
				await abortableSleep(delay, signal);
			}
			signal?.throwIfAborted();
			throttler.commitSend();
			throttler.requestStarted();
			return { release: () => throttler.requestFinished() };
		}
		return { release: () => { } };
	}

	/**
	 * Records quota-usage information from a GitHub API response and learns
	 * the endpoint → bucket mapping.
	 */
	recordResponse(method: string | undefined, url: string, response: FetchModuleResponse): void {
		const bucketNameHeader = response.headers?.get(githubQuotaHeaders.quotaBucketName);
		const bucketName = bucketNameHeader || '__global__';
		const quotaUsedHeader = response.headers?.get(githubQuotaHeaders.totalQuotaUsed);

		let quotaUsed = 0;
		if (quotaUsedHeader !== null && quotaUsedHeader !== undefined) {
			const parsed = parseFloat(quotaUsedHeader);
			if (Number.isFinite(parsed) && parsed >= 0) {
				quotaUsed = parsed;
			}
		}

		// Always learn endpoint → bucket when a bucket-name header is present,
		// even if the quota-used value is 0 or missing.
		if (bucketNameHeader) {
			this._updateThrottler(method ?? 'GET', url, bucketName, quotaUsed);
			return;
		}

		// For the implicit global bucket (no bucket-name header), preserve the
		// existing behavior of only updating when quota-used is > 0.
		if (quotaUsed > 0) {
			this._updateThrottler(method ?? 'GET', url, bucketName, quotaUsed);
		}
	}

	clear(): void {
		this._throttlers.clear();
		this._endpointBuckets.clear();
	}

	// --- Private ---

	private _getEndpointKey(method: string, url: string): string {
		try {
			const parsed = new URL(url);
			return `${method} ${parsed.pathname}`;
		} catch {
			return `${method} ${url}`;
		}
	}

	private _getThrottlerForEndpoint(method: string, url: string): BucketThrottler | undefined {
		const endpointKey = this._getEndpointKey(method, url);
		const bucket = this._endpointBuckets.get(endpointKey);
		return bucket ? this._throttlers.get(bucket) : undefined;
	}

	private _updateThrottler(method: string, url: string, bucket: string, quotaUsed: number): void {
		let throttler = this._throttlers.get(bucket);
		if (!throttler) {
			throttler = new BucketThrottler(this._target);
			this._throttlers.set(bucket, throttler);
			this._logger?.warn(`GitHubThrottler: new bucket '${bucket}' for ${method} ${url}`);
		}
		throttler.recordQuotaUsed(quotaUsed);
		const endpointKey = this._getEndpointKey(method, url);
		this._endpointBuckets.set(endpointKey, bucket);
	}
}
