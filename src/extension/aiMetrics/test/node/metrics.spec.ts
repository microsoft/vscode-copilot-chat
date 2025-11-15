/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { AiMetricEventType, formatDateKey, getDateRangeFromTimeRange, TimeRange } from '../../common/metrics';

suite('AI Metrics - Domain Model', () => {
	test('formatDateKey formats dates correctly', () => {
		const date = new Date('2025-01-15T12:30:45.000Z');
		const key = formatDateKey(date);
		expect(key).toBe('2025-01-15');
	});

	test('formatDateKey pads month and day', () => {
		const date = new Date('2025-02-05T00:00:00.000Z');
		const key = formatDateKey(date);
		expect(key).toBe('2025-02-05');
	});

	test('getDateRangeFromTimeRange - Today', () => {
		const { startDate, endDate } = getDateRangeFromTimeRange(TimeRange.Today);

		// Start should be at midnight today
		expect(startDate.getHours()).toBe(0);
		expect(startDate.getMinutes()).toBe(0);
		expect(startDate.getSeconds()).toBe(0);

		// End should be now
		expect(endDate.getTime()).toBeGreaterThan(startDate.getTime());
	});

	test('getDateRangeFromTimeRange - Week', () => {
		const { startDate, endDate } = getDateRangeFromTimeRange(TimeRange.Week);

		const daysDiff = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
		expect(daysDiff).toBeGreaterThanOrEqual(6);
		expect(daysDiff).toBeLessThanOrEqual(7);
	});

	test('getDateRangeFromTimeRange - Month', () => {
		const { startDate, endDate } = getDateRangeFromTimeRange(TimeRange.Month);

		const daysDiff = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
		expect(daysDiff).toBeGreaterThanOrEqual(29);
		expect(daysDiff).toBeLessThanOrEqual(30);
	});

	test('getDateRangeFromTimeRange - All', () => {
		const { startDate, endDate } = getDateRangeFromTimeRange(TimeRange.All);

		// Start should be far in the past
		expect(startDate.getFullYear()).toBe(2020);
		expect(endDate.getTime()).toBeGreaterThan(startDate.getTime());
	});
});

suite('AI Metrics - Event Types', () => {
	test('AiMetricEventType enum has expected values', () => {
		expect(AiMetricEventType.TokenUsage).toBe('tokenUsage');
		expect(AiMetricEventType.ModelUsage).toBe('modelUsage');
		expect(AiMetricEventType.CodeAcceptance).toBe('codeAcceptance');
		expect(AiMetricEventType.FeatureUsage).toBe('featureUsage');
		expect(AiMetricEventType.Performance).toBe('performance');
	});
});
