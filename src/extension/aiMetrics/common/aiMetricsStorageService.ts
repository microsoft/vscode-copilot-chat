/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { IAggregatedMetrics, IAiMetricEvent } from './metrics';

export const IAiMetricsStorageService = createServiceIdentifier<IAiMetricsStorageService>('IAiMetricsStorageService');

/**
 * Service for storing and retrieving AI metrics data using VS Code's global state.
 * Events are grouped by day using the schema: aiMetrics.events.<YYYY-MM-DD>[]
 */
export interface IAiMetricsStorageService {
	readonly _serviceBrand: undefined;

	/**
	 * Add a new metric event to storage
	 */
	addEvent(event: IAiMetricEvent): Promise<void>;

	/**
	 * Get all events within a date range
	 */
	getEventsInRange(startDate: Date, endDate: Date): Promise<IAiMetricEvent[]>;

	/**
	 * Remove events older than the configured retention period
	 */
	pruneOldData(): Promise<void>;

	/**
	 * Compute aggregated metrics from a set of events
	 */
	computeMetrics(events: IAiMetricEvent[], startDate: Date, endDate: Date): IAggregatedMetrics;
}
