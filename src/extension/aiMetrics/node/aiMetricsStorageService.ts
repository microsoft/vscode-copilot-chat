/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAiMetricsStorageService } from '../common/aiMetricsStorageService';
import {
	AiMetricEventType,
	formatDateKey,
	IAggregatedMetrics,
	IAiMetricEvent,
	ICodeAcceptanceMetrics,
	IFeatureUsageMetrics,
	IModelDistributionMetrics,
	IPerformanceMetrics,
	ITokenUsageMetrics
} from '../common/metrics';

/**
 * Implementation of the AI metrics storage service
 */
export class AiMetricsStorageService extends Disposable implements IAiMetricsStorageService {
	declare readonly _serviceBrand: undefined;

	private static readonly STORAGE_PREFIX = 'aiMetrics.events.';

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async addEvent(event: IAiMetricEvent): Promise<void> {
		const dateKey = formatDateKey(new Date(event.timestamp));
		const storageKey = AiMetricsStorageService.STORAGE_PREFIX + dateKey;

		try {
			// Get existing events for this day
			const existingEvents = this.extensionContext.globalState.get<IAiMetricEvent[]>(storageKey, []);

			// Append new event
			existingEvents.push(event);

			// Save back to storage
			await this.extensionContext.globalState.update(storageKey, existingEvents);

			this.logService.trace('[AiMetrics] Added event', { eventType: event.eventType, dateKey });
		} catch (error) {
			this.logService.error('[AiMetrics] Failed to add event', error);
		}
	}

	async getEventsInRange(startDate: Date, endDate: Date): Promise<IAiMetricEvent[]> {
		const events: IAiMetricEvent[] = [];

		try {
			// Generate all date keys in range
			const currentDate = new Date(startDate);
			while (currentDate <= endDate) {
				const dateKey = formatDateKey(currentDate);
				const storageKey = AiMetricsStorageService.STORAGE_PREFIX + dateKey;

				// Get events for this day
				const dayEvents = this.extensionContext.globalState.get<IAiMetricEvent[]>(storageKey, []);
				events.push(...dayEvents);

				// Move to next day
				currentDate.setDate(currentDate.getDate() + 1);
			}

			this.logService.trace('[AiMetrics] Retrieved events in range', { count: events.length });
		} catch (error) {
			this.logService.error('[AiMetrics] Failed to get events in range', error);
		}

		return events;
	}

	async pruneOldData(): Promise<void> {
		try {
			const retentionDays = this.configurationService.getConfig({
				key: 'github.copilot.metrics.retentionDays',
				defaultValue: 90
			});

			const cutoffDate = new Date();
			cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

			// Get all keys from global state
			const allKeys = this.extensionContext.globalState.keys();
			const metricsKeys = allKeys.filter(key => key.startsWith(AiMetricsStorageService.STORAGE_PREFIX));

			let prunedCount = 0;
			for (const key of metricsKeys) {
				// Extract date from key (format: aiMetrics.events.YYYY-MM-DD)
				const dateStr = key.substring(AiMetricsStorageService.STORAGE_PREFIX.length);
				const keyDate = new Date(dateStr);

				if (keyDate < cutoffDate) {
					await this.extensionContext.globalState.update(key, undefined);
					prunedCount++;
				}
			}

			this.logService.info('[AiMetrics] Pruned old data', { prunedCount, retentionDays });
		} catch (error) {
			this.logService.error('[AiMetrics] Failed to prune old data', error);
		}
	}

	computeMetrics(events: IAiMetricEvent[], startDate: Date, endDate: Date): IAggregatedMetrics {
		const tokenUsage = this.computeTokenUsageMetrics(events);
		const modelDistribution = this.computeModelDistributionMetrics(events);
		const codeAcceptance = this.computeCodeAcceptanceMetrics(events);
		const featureUsage = this.computeFeatureUsageMetrics(events);
		const performance = this.computePerformanceMetrics(events);

		return {
			startDate,
			endDate,
			tokenUsage,
			modelDistribution,
			codeAcceptance,
			featureUsage,
			performance,
			eventCount: events.length
		};
	}

	private computeTokenUsageMetrics(events: IAiMetricEvent[]): ITokenUsageMetrics {
		const tokenEvents = events.filter(e => e.eventType === AiMetricEventType.TokenUsage);

		let totalTokens = 0;
		let cachedTokens = 0;
		const tokensByModel: Record<string, number> = {};
		const tokensByFeature: Record<string, number> = {};

		for (const event of tokenEvents) {
			const tokens = Number(event.data.tokens ?? 0);
			const cached = Number(event.data.cachedTokens ?? 0);
			const model = String(event.data.model ?? 'unknown');
			const feature = String(event.data.feature ?? 'unknown');

			totalTokens += tokens;
			cachedTokens += cached;

			tokensByModel[model] = (tokensByModel[model] ?? 0) + tokens;
			tokensByFeature[feature] = (tokensByFeature[feature] ?? 0) + tokens;
		}

		return {
			totalTokens,
			tokensByModel,
			tokensByFeature,
			cachedTokensRatio: totalTokens > 0 ? cachedTokens / totalTokens : 0,
			cachedTokens
		};
	}

	private computeModelDistributionMetrics(events: IAiMetricEvent[]): IModelDistributionMetrics {
		const modelEvents = events.filter(e => e.eventType === AiMetricEventType.ModelUsage);

		const modelUsageCount: Record<string, number> = {};
		const providerDistribution: Record<string, number> = {};

		for (const event of modelEvents) {
			const model = String(event.data.model ?? 'unknown');
			const provider = String(event.data.provider ?? 'unknown');

			modelUsageCount[model] = (modelUsageCount[model] ?? 0) + 1;
			providerDistribution[provider] = (providerDistribution[provider] ?? 0) + 1;
		}

		return {
			modelUsageCount,
			providerDistribution
		};
	}

	private computeCodeAcceptanceMetrics(events: IAiMetricEvent[]): ICodeAcceptanceMetrics {
		const acceptanceEvents = events.filter(e => e.eventType === AiMetricEventType.CodeAcceptance);

		let nesTotal = 0;
		let nesAccepted = 0;
		let completionsTotal = 0;
		let completionsAccepted = 0;
		const rejectionReasonBreakdown: Record<string, number> = {};

		for (const event of acceptanceEvents) {
			const suggestionType = String(event.data.suggestionType ?? 'unknown');
			const accepted = Boolean(event.data.accepted);
			const rejectionReason = String(event.data.rejectionReason ?? '');

			if (suggestionType === 'nes') {
				nesTotal++;
				if (accepted) {
					nesAccepted++;
				}
			} else if (suggestionType === 'completion') {
				completionsTotal++;
				if (accepted) {
					completionsAccepted++;
				}
			}

			if (!accepted && rejectionReason) {
				rejectionReasonBreakdown[rejectionReason] = (rejectionReasonBreakdown[rejectionReason] ?? 0) + 1;
			}
		}

		return {
			nesAcceptanceRate: nesTotal > 0 ? nesAccepted / nesTotal : 0,
			completionAcceptanceRate: completionsTotal > 0 ? completionsAccepted / completionsTotal : 0,
			rejectionReasonBreakdown,
			nesTotal,
			nesAccepted,
			completionsTotal,
			completionsAccepted
		};
	}

	private computeFeatureUsageMetrics(events: IAiMetricEvent[]): IFeatureUsageMetrics {
		const featureEvents = events.filter(e => e.eventType === AiMetricEventType.FeatureUsage);

		let chatMessageCount = 0;
		let nesOpportunityCount = 0;
		let completionCount = 0;
		const featureBreakdown: Record<string, number> = {};

		for (const event of featureEvents) {
			const feature = String(event.data.feature ?? 'unknown');

			featureBreakdown[feature] = (featureBreakdown[feature] ?? 0) + 1;

			if (feature === 'chat') {
				chatMessageCount++;
			} else if (feature === 'nes') {
				nesOpportunityCount++;
			} else if (feature === 'completion') {
				completionCount++;
			}
		}

		return {
			chatMessageCount,
			nesOpportunityCount,
			completionCount,
			featureBreakdown
		};
	}

	private computePerformanceMetrics(events: IAiMetricEvent[]): IPerformanceMetrics {
		const perfEvents = events.filter(e => e.eventType === AiMetricEventType.Performance);

		const ttftSamples: number[] = [];
		const fetchTimeSamples: number[] = [];
		const debounceSamples: number[] = [];

		for (const event of perfEvents) {
			const ttft = Number(event.data.ttft ?? 0);
			const fetchTime = Number(event.data.fetchTime ?? 0);
			const debounceTime = Number(event.data.debounceTime ?? 0);

			if (ttft > 0) {
				ttftSamples.push(ttft);
			}
			if (fetchTime > 0) {
				fetchTimeSamples.push(fetchTime);
			}
			if (debounceTime > 0) {
				debounceSamples.push(debounceTime);
			}
		}

		const avgTTFT = ttftSamples.length > 0 ? ttftSamples.reduce((a, b) => a + b, 0) / ttftSamples.length : 0;
		const avgFetchTime = fetchTimeSamples.length > 0 ? fetchTimeSamples.reduce((a, b) => a + b, 0) / fetchTimeSamples.length : 0;
		const avgDebounceTime = debounceSamples.length > 0 ? debounceSamples.reduce((a, b) => a + b, 0) / debounceSamples.length : 0;

		// Calculate p95
		const p95TTFT = this.calculatePercentile(ttftSamples, 0.95);
		const p95FetchTime = this.calculatePercentile(fetchTimeSamples, 0.95);

		return {
			avgTTFT,
			avgFetchTime,
			avgDebounceTime,
			p95TTFT,
			p95FetchTime,
			sampleCount: perfEvents.length
		};
	}

	private calculatePercentile(values: number[], percentile: number): number {
		if (values.length === 0) {
			return 0;
		}

		const sorted = [...values].sort((a, b) => a - b);
		const index = Math.ceil(sorted.length * percentile) - 1;
		return sorted[Math.max(0, index)];
	}
}
