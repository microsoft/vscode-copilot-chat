/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
		if (this.values.length === 0) {
			return 0;
		}
		return this.sumValues / this.values.length;
	}

	delta(): number {
		if (this.values.length === 0) {
			return 0;
		}
		return this.values[this.values.length - 1] - this.values[0];
	}

	size(): number {
		return this.values.length;
	}

	reset(): void {
		this.values = [];
		this.times = [];
		this.sumValues = 0;
	}

	/**
	 * Removes entries that are both outside the time window and exceed the
	 * minimum entry count. Called explicitly before throttle decisions so
	 * that the window reflects the current state.
	 */
	cleanUpOldValues(now: number): void {
		const tooOldTime = now - this.windowDurationMs;
		while (
			this.times.length > this.numEntries &&
			this.times[0] < tooOldTime
		) {
			this.sumValues -= this.values[0];
			this.values.shift();
			this.times.shift();
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
			this.totalQuotaUsedWindow = new SlidingTimeAndNWindow(5, 2000);
			this.sendPeriodWindow = new SlidingTimeAndNWindow(5, 2000);
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

	shouldSendRequest(): boolean {
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
			return false;
		}

		let shouldSend = false;

		if (this.totalQuotaUsedWindow.get() === 0 || this.sendPeriodWindow.size() === 0) {
			shouldSend = true;
		} else if (this.sendPeriodWindow.average() > 0) {
			const integral =
				(this.totalQuotaUsedWindow.average() - this.target) / 100;
			const differential = this.totalQuotaUsedWindow.delta();
			const delayMs =
				this.sendPeriodWindow.average() *
				Math.max(1 + 20 * integral + 0.5 * differential, 0.2);
			if (now > this.lastSendTime + delayMs) {
				shouldSend = true;
			}
		}

		if (shouldSend) {
			this.sendPeriodWindow.increment(now - this.lastSendTime);
			this.lastSendTime = now;
		}
		return shouldSend;
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
	 * Returns a cleanup function that MUST be called when the request finishes.
	 *
	 * If the endpoint's bucket is not yet known (first request), returns
	 * immediately without blocking.
	 */
	async acquireSlot(method: string | undefined, url: string): Promise<{ release: () => void }> {
		const throttler = this._getThrottlerForEndpoint(method ?? 'GET', url);
		if (throttler) {
			while (!throttler.shouldSendRequest()) {
				await sleep(THROTTLE_POLL_MS);
			}
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

		// Learn endpoint → bucket even when quota-used is absent.
		if (bucketNameHeader && quotaUsedHeader === null) {
			this._updateThrottler(method ?? 'GET', url, bucketName, 0);
		}

		if (quotaUsedHeader !== null && quotaUsedHeader !== undefined) {
			const quotaUsed = parseFloat(quotaUsedHeader);
			if (Number.isFinite(quotaUsed) && quotaUsed > 0) {
				this._updateThrottler(method ?? 'GET', url, bucketName, quotaUsed);
			}
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
		if (!this._throttlers.has(bucket)) {
			this._throttlers.set(bucket, new BucketThrottler(this._target));
			this._logger?.warn(`GitHubThrottler: new bucket '${bucket}' for ${method} ${url}`);
		}
		this._throttlers.get(bucket)!.recordQuotaUsed(quotaUsed);
		const endpointKey = this._getEndpointKey(method, url);
		this._endpointBuckets.set(endpointKey, bucket);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
