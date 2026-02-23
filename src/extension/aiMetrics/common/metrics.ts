/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Domain model for AI metrics collected from GitHub Copilot usage.
 * Metrics are organized into categories: Token Usage, Model Distribution, Code Acceptance,
 * Feature Usage, and Performance.
 */

/**
 * Base interface for all metric events stored in the system
 */
export interface IAiMetricEvent {
	/**
	 * Timestamp when the event occurred
	 */
	readonly timestamp: number;

	/**
	 * Name of the telemetry event that triggered this metric
	 */
	readonly eventName: string;

	/**
	 * Type of event for categorization
	 */
	readonly eventType: AiMetricEventType;

	/**
	 * Additional data specific to each event type
	 */
	readonly data: Record<string, string | number | boolean | undefined>;
}

/**
 * Categories of metric events we track
 */
export enum AiMetricEventType {
	TokenUsage = 'tokenUsage',
	ModelUsage = 'modelUsage',
	CodeAcceptance = 'codeAcceptance',
	FeatureUsage = 'featureUsage',
	Performance = 'performance'
}

/**
 * Token usage metrics
 */
export interface ITokenUsageMetrics {
	/**
	 * Total tokens consumed across all requests
	 */
	totalTokens: number;

	/**
	 * Tokens consumed grouped by model name
	 */
	tokensByModel: Record<string, number>;

	/**
	 * Tokens consumed grouped by feature (chat, completions, NES, etc.)
	 */
	tokensByFeature: Record<string, number>;

	/**
	 * Ratio of cached tokens to total tokens (0-1)
	 */
	cachedTokensRatio: number;

	/**
	 * Total cached tokens
	 */
	cachedTokens: number;
}

/**
 * Model distribution metrics
 */
export interface IModelDistributionMetrics {
	/**
	 * Count of requests grouped by model name
	 */
	modelUsageCount: Record<string, number>;

	/**
	 * Count of requests grouped by provider (OpenAI, Anthropic, etc.)
	 */
	providerDistribution: Record<string, number>;
}

/**
 * Code acceptance metrics
 */
export interface ICodeAcceptanceMetrics {
	/**
	 * Next Edit Suggestions acceptance rate (0-1)
	 */
	nesAcceptanceRate: number;

	/**
	 * Completion acceptance rate (0-1)
	 */
	completionAcceptanceRate: number;

	/**
	 * Count of rejections grouped by reason
	 */
	rejectionReasonBreakdown: Record<string, number>;

	/**
	 * Total NES suggestions shown
	 */
	nesTotal: number;

	/**
	 * Total NES suggestions accepted
	 */
	nesAccepted: number;

	/**
	 * Total completions shown
	 */
	completionsTotal: number;

	/**
	 * Total completions accepted
	 */
	completionsAccepted: number;
}

/**
 * Feature usage metrics
 */
export interface IFeatureUsageMetrics {
	/**
	 * Total number of chat messages sent
	 */
	chatMessageCount: number;

	/**
	 * Total number of NES opportunities (times NES was triggered)
	 */
	nesOpportunityCount: number;

	/**
	 * Total number of completions shown
	 */
	completionCount: number;

	/**
	 * Count of requests grouped by feature type
	 */
	featureBreakdown: Record<string, number>;
}

/**
 * Performance metrics
 */
export interface IPerformanceMetrics {
	/**
	 * Average time to first token (ms)
	 */
	avgTTFT: number;

	/**
	 * Average fetch time for requests (ms)
	 */
	avgFetchTime: number;

	/**
	 * Average debounce time before triggering (ms)
	 */
	avgDebounceTime: number;

	/**
	 * P95 time to first token (ms)
	 */
	p95TTFT: number;

	/**
	 * P95 fetch time (ms)
	 */
	p95FetchTime: number;

	/**
	 * Count of performance samples
	 */
	sampleCount: number;
}

/**
 * Aggregated metrics for a time period
 */
export interface IAggregatedMetrics {
	/**
	 * Start of the time period
	 */
	startDate: Date;

	/**
	 * End of the time period
	 */
	endDate: Date;

	/**
	 * Token usage metrics
	 */
	tokenUsage: ITokenUsageMetrics;

	/**
	 * Model distribution metrics
	 */
	modelDistribution: IModelDistributionMetrics;

	/**
	 * Code acceptance metrics
	 */
	codeAcceptance: ICodeAcceptanceMetrics;

	/**
	 * Feature usage metrics
	 */
	featureUsage: IFeatureUsageMetrics;

	/**
	 * Performance metrics
	 */
	performance: IPerformanceMetrics;

	/**
	 * Total number of events in this period
	 */
	eventCount: number;
}

/**
 * Time range selector options for the dashboard
 */
export enum TimeRange {
	Today = 'today',
	Week = 'week',
	Month = 'month',
	All = 'all'
}

/**
 * Helper to get date range from TimeRange enum
 */
export function getDateRangeFromTimeRange(range: TimeRange): { startDate: Date; endDate: Date } {
	const endDate = new Date();
	const startDate = new Date();

	switch (range) {
		case TimeRange.Today:
			startDate.setHours(0, 0, 0, 0);
			break;
		case TimeRange.Week:
			startDate.setDate(startDate.getDate() - 7);
			startDate.setHours(0, 0, 0, 0);
			break;
		case TimeRange.Month:
			startDate.setDate(startDate.getDate() - 30);
			startDate.setHours(0, 0, 0, 0);
			break;
		case TimeRange.All:
			startDate.setFullYear(2020, 0, 1); // Far in the past
			break;
	}

	return { startDate, endDate };
}

/**
 * Helper to format date as YYYY-MM-DD for storage keys
 */
export function formatDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}
