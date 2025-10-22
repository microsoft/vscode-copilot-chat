/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TelemetryStore } from '../../lib/src/telemetry';
import type { TelemetrySpy } from '../../lib/src/testing/telemetrySpy';
import { ITelemetryService, TelemetryEventMeasurements, TelemetryEventProperties } from '../../../../../platform/telemetry/common/telemetry';
import { wrapEventNameForPrefixRemoval } from '../../../../../platform/telemetry/node/azureInsightsReporter';

export class CompletionsTelemetryServiceBridge {

	private reporter: TelemetrySpy | undefined;
	private enhancedReporter: TelemetrySpy | undefined;

	constructor(
		@ITelemetryService private readonly telemetryService: ITelemetryService
	) {
		this.reporter = undefined;
		this.enhancedReporter = undefined;
	}

	sendGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.telemetryService.sendGHTelemetryEvent(wrapEventNameForPrefixRemoval(`copilot/${eventName}`), properties, measurements);
	}

	sendGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.telemetryService.sendGHTelemetryErrorEvent(wrapEventNameForPrefixRemoval(`copilot/${eventName}`), properties, measurements);
	}

	sendGHTelemetryException(maybeError: unknown, origin: string): void {
		this.telemetryService.sendGHTelemetryException(maybeError, origin);
	}

	setSpyReporters(reporter: TelemetrySpy, enhancedReporter: TelemetrySpy) {
		this.reporter = reporter;
		this.enhancedReporter = enhancedReporter;
	}

	clearSpyReporters() {
		this.reporter = undefined;
		this.enhancedReporter = undefined;
	}

	getSpyReporters(store: TelemetryStore): TelemetrySpy | undefined {
		if (TelemetryStore.isEnhanced(store)) {
			return this.enhancedReporter;
		} else {
			return this.reporter;
		}
	}
}