/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { IDisposable } from '../../../../util/vs/base/common/lifecycle';
import { ILogService } from '../../../log/common/logService';

// Sliding window that holds at least N entries and all entries in the time window.
// This allows the sliding window to always hold some entries if inserts are infrequent,
// but if inserts are frequent enough then time window behavior takes over.
class SlidingTimeAndNWindow implements IDisposable {
	private values: number[] = [];
	private times: number[] = [];
	private sumValues = 0;
	private numEntries: number;
	private windowDurationMs: number;
	private cleanupInterval: ReturnType<typeof setInterval> | undefined;

	constructor(numEntries: number, windowDurationMs: number) {
		this.numEntries = numEntries;
		this.windowDurationMs = windowDurationMs;
		this.startPeriodicCleanup();
	}

	dispose(): void {
		if (typeof this.cleanupInterval !== 'undefined') {
			clearInterval(this.cleanupInterval);
		}
	}

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

	last(): number {
		if (this.values.length === 0) {
			return 0;
		}
		return this.values[this.values.length - 1];
	}

	size(): number {
		return this.values.length;
	}

	windowDuration(): number {
		if (this.times.length < 2) {
			// Don't return 0 so that divide-by-zero doesn't happen
			return 1;
		}
		return this.times[this.times.length - 1] - this.times[0];
	}

	reset(): void {
		this.values = [];
		this.times = [];
		this.sumValues = 0;
	}

	private startPeriodicCleanup(): void {
		this.cleanupInterval = setInterval(() => {
			const tooOldTime = Date.now() - this.windowDurationMs;
			while (
				this.times.length > this.numEntries &&
				this.times[0] < tooOldTime
			) {
				this.sumValues -= this.values[0];
				this.values.shift();
				this.times.shift();
			}
		}, 100);
	}
}

class Throttler {
	private target: number;
	private lastSendTime: number;
	private totalQuotaUsedWindow: SlidingTimeAndNWindow;
	private sendPeriodWindow: SlidingTimeAndNWindow;
	private numOutstandingRequests = 0;

	constructor(target: number) {
		this.target = target;
		this.lastSendTime = Date.now();
		this.totalQuotaUsedWindow = new SlidingTimeAndNWindow(5, 2000);
		this.sendPeriodWindow = new SlidingTimeAndNWindow(5, 2000);
	}

	reset(): void {
		if (this.numOutstandingRequests === 0) {
			this.lastSendTime = Date.now();
			this.totalQuotaUsedWindow.dispose();
			this.sendPeriodWindow.dispose();
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

		// This will probably result in sending a request. We want to send a request occasionally,
		// even if it would otherwise fail, so that we can update our quota information.
		if (now > this.lastSendTime + 5 * 60 * 1000) {
			this.reset();
		}

		let shouldSend = false;

		// If there have been no requests, send one.
		if (this.totalQuotaUsedWindow.get() === 0) {
			shouldSend = true;
		}

		// This is modeled on a PID controller, where we are trying to target a certain quota usage
		// by adjusting the request frequency. The time from the last request (delayMs) is determined
		// by taking the average of the recent "delays" as the baseline, and then adding an integral
		// term (the recent quota usage - the target, converted into a duration) and a derivative term
		// (error - previous error, which ends up being just the difference in the total quota used at
		// different times, then converted into a duration as well).
		if (this.sendPeriodWindow.average() > 0) {
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

		// If this is the start of the throttler, then let's send the first N requests slowly
		// so that we can build up some state based on the server, prior to potentially sending
		// a bunch of concurrent requests.
		if (
			this.totalQuotaUsedWindow.size() < 5 &&
			this.numOutstandingRequests > 0
		) {
			shouldSend = false;
		}

		if (shouldSend) {
			this.sendPeriodWindow.increment(now - this.lastSendTime);
			this.lastSendTime = now;
		}
		return shouldSend;
	}

	dispose(): void {
		this.totalQuotaUsedWindow.dispose();
		this.sendPeriodWindow.dispose();
	}
}

export const githubHeaders = Object.freeze({
	requestId: 'x-github-request-id',
	totalQuotaUsed: 'x-github-total-quota-used',
});

/**
 * This API client performs requests and will manage back-off when being rate limited
 */
export class ApiClient implements IDisposable {
	private readonly throttler: Throttler | null;

	constructor(
		target: number | null = 80,
		@ILogService private readonly logService: ILogService,
	) {
		if (target === null) {
			this.throttler = null;
		} else {
			this.throttler = new Throttler(target);
		}
	}

	async makeRequest(
		url: string,
		headers: Record<string, string>,
		method: string,
		body: unknown | undefined,
		token: CancellationToken,
	): Promise<Response> {
		if (this.throttler) {
			while (!this.throttler.shouldSendRequest()) {
				// Sleep a little while so that we don't have a constantly running loop.
				// We probably shouldn't send requests more than this frequently anyway.
				await raceCancellationError(sleep(5), token);
			}
			this.throttler.requestStarted();
		}

		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		try {
			const res = await fetch(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
			});
			if (!res.ok) {
				const requestId = res.headers.get(githubHeaders.requestId);
				const responseBody = await res.text();
				this.logService.error(`${method} to ${url} request failed with status: '${res.status}', requestId: '${requestId}', body: ${responseBody}`);
				return res;
			}
			const quotaUsedHeader = res.headers.get(githubHeaders.totalQuotaUsed);
			const quotaUsed = quotaUsedHeader ? parseFloat(quotaUsedHeader) : 0;
			if (this.throttler && quotaUsed > 0) {
				this.throttler.recordQuotaUsed(quotaUsed);
			}
			return res;
		} catch (e) {
			this.logService.error(`${method} to ${url} request threw with error: ${e}`);
			throw e;
		} finally {
			this.throttler?.requestFinished();
		}
	}

	dispose(): void {
		this.throttler?.dispose();
	}
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
