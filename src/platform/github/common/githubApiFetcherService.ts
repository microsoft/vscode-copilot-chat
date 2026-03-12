/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { CallTracker } from '../../../util/common/telemetryCorrelationId';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError, isCancellationError } from '../../../util/vs/base/common/errors';
import { Disposable, dispose, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService } from '../../telemetry/common/telemetry';

export const IGithubApiFetcherService = createServiceIdentifier<IGithubApiFetcherService>('IGithubApiFetcherService');

export interface GithubRequestOptions {
	readonly method: string;
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly body?: unknown;
	readonly authToken: string;

	readonly telemetry: {
		readonly urlId: string; // A stable identifier for the URL, used for telemetry and logging. Should not contain sensitive information.
		readonly callerInfo: CallTracker;
	};

	/** Number of retries on 5xx errors. Defaults to 0 (no retries). */
	readonly retriesOn500?: number;
}

export const githubHeaders = Object.freeze({
	requestId: 'x-github-request-id',
	totalQuotaUsed: 'x-github-total-quota-used',
});

/**
 * Provides standardized throttling and retry behavior for GitHub API requests.
 */
export interface IGithubApiFetcherService extends IDisposable {
	readonly _serviceBrand: undefined;

	makeRequest(options: GithubRequestOptions, token: CancellationToken): Promise<Response>;
}

/**
 * Sliding window that holds at least N entries and all entries in the time window.
 * If inserts are infrequent, the minimum-entry guarantee ensures there is always
 * some history to work with; when inserts are frequent the time window dominates.
 */
class SlidingTimeAndNWindow implements IDisposable {
	private values: number[] = [];
	private times: number[] = [];
	private sumValues = 0;
	private readonly numEntries: number;
	private readonly windowDurationMs: number;
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

	size(): number {
		return this.values.length;
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

class Throttler implements IDisposable {
	private readonly target: number;
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

	/**
	 * PID-controller–inspired gate that decides whether a request should be
	 * sent right now or deferred. It uses sliding windows of recent quota
	 * usage and send periods to compute proportional, integral, and
	 * differential terms, which in turn determine a dynamic delay before
	 * sending the next request. The ramp-up logic at the end ensures we
	 * start slowly and calibrate based on server feedback before allowing
	 * higher concurrency.
	 */
	shouldSendRequest(): boolean {
		const now = Date.now();

		// Send a request occasionally even if throttled, to refresh quota info.
		if (now > this.lastSendTime + 5 * 60 * 1000) {
			this.reset();
		}

		let shouldSend = false;

		if (this.totalQuotaUsedWindow.get() === 0) {
			shouldSend = true;
		}

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

		// Ramp up slowly at start so the throttler can calibrate based on
		// server feedback before allowing concurrent requests.
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

export class GithubApiFetcherService extends Disposable implements IGithubApiFetcherService {
	declare readonly _serviceBrand: undefined;

	private readonly throttlers = new Map<string, Throttler>();

	constructor(
		private readonly throttlerTarget: number = 80,
		@IEnvService private readonly envService: IEnvService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
	}

	override dispose(): void {
		super.dispose();
		dispose(this.throttlers.values());
		this.throttlers.clear();
	}

	async makeRequest(options: GithubRequestOptions, token: CancellationToken): Promise<Response> {
		return this.makeRequestWithRetries(options, token, options.retriesOn500 ?? 0);
	}

	private async makeRequestWithRetries(
		options: GithubRequestOptions,
		token: CancellationToken,
		retriesRemaining: number,
	): Promise<Response> {
		const throttler = this.getThrottler(options.url);

		// Throttle
		while (!throttler.shouldSendRequest()) {
			await raceCancellationError(sleep(5), token);
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		throttler.requestStarted();
		try {
			const res = await fetch(options.url, {
				method: options.method,
				headers: {
					...options.headers,
					'Authorization': `Bearer ${options.authToken}`,
					...getGithubMetadataHeaders(options.telemetry.callerInfo, this.envService),
				},
				body: options.body ? JSON.stringify(options.body) : undefined,
			});

			// Record quota usage for throttle calibration
			const quotaUsedHeader = res.headers.get(githubHeaders.totalQuotaUsed);
			const quotaUsed = quotaUsedHeader ? parseFloat(quotaUsedHeader) : 0;
			if (quotaUsed > 0) {
				throttler.recordQuotaUsed(quotaUsed);
			}

			if (!res.ok) {
				const willRetry = res.status >= 500 && res.status < 600 && retriesRemaining > 0;
				const requestId = res.headers.get(githubHeaders.requestId);

				if (willRetry) {
					this.logService.warn(`GithubApiFetcherService: ${options.method} ${options.telemetry.urlId} returned ${res.status}, github requestId: '${requestId}'. Retrying (${retriesRemaining} retries remaining)`,);
				} else {
					let responseBody = '';
					try {
						responseBody = await res.text();
					} catch {
						// noop
					}
					this.logService.error(`GithubApiFetcherService: ${options.method} ${options.telemetry.urlId} failed with status '${res.status}', github requestId: '${requestId}', body: ${responseBody}`,);
				}

				/* __GDPR__
					"githubApiFetcherService.request.error" : {
						"owner": "copilot-core",
						"comment": "Logging when a GitHub API request fails",
						"urlId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "A stable identifier for the URL" },
						"method": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The HTTP method used" },
						"caller": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Caller" },
						"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The response status code" },
						"willRetry": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the request will be retried" }
					}
				*/
				this.telemetryService.sendMSFTTelemetryEvent('githubApiFetcherService.request.error', {
					urlId: options.telemetry.urlId,
					method: options.method,
					caller: options.telemetry.callerInfo.toString(),
				}, {
					statusCode: res.status,
					willRetry: willRetry ? 1 : 0,
				});

				if (willRetry) {
					return this.makeRequestWithRetries(options, token, retriesRemaining - 1);
				}
			}

			return res;
		} catch (e) {
			if (!isCancellationError(e)) {
				this.logService.error(`GithubApiFetcherService: ${options.method} ${options.telemetry.urlId} threw: ${e}`);
			}
			throw e;
		} finally {
			throttler.requestFinished();
		}
	}

	private getThrottler(urlId: string): Throttler {
		const existingThrottler = this.throttlers.get(urlId);
		if (existingThrottler) {
			return existingThrottler;
		}

		const throttler = new Throttler(this.throttlerTarget);
		this.throttlers.set(urlId, throttler);
		return throttler;
	}
}

async function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function getGithubMetadataHeaders(callerInfo: CallTracker, envService: IEnvService): Record<string, string> | undefined {
	const editorInfo = envService.getEditorInfo();

	// Try converting vscode/1.xxx-insiders to vscode-insiders/1.xxx
	const versionNumberAndSubName = editorInfo.version.match(/^(?<version>.+?)(\-(?<subName>\w+?))?$/);
	const application = versionNumberAndSubName && versionNumberAndSubName.groups?.subName
		? `${editorInfo.name}-${versionNumberAndSubName.groups.subName}/${versionNumberAndSubName.groups.version}`
		: editorInfo.format();

	return {
		'X-Client-Application': application,
		'X-Client-Source': envService.getEditorPluginInfo().format(),
		'X-Client-Feature': callerInfo.toAscii().slice(0, 1000),
	};
}
