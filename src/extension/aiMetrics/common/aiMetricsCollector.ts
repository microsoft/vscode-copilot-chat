/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService, TelemetryDestination, TelemetryEventMeasurements, TelemetryEventProperties } from '../../../platform/telemetry/common/telemetry';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAiMetricsStorageService } from './aiMetricsStorageService';
import { AiMetricEventType, IAiMetricEvent } from './metrics';

/**
 * Telemetry collector that wraps the existing ITelemetryService to intercept
 * and store metric-relevant events locally when metrics collection is enabled.
 * All telemetry events are passed through to the original service unchanged.
 */
export class AiMetricsCollector extends Disposable implements ITelemetryService {
	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly originalTelemetryService: ITelemetryService,
		private readonly storageService: IAiMetricsStorageService,
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService,
	) {
		super();
	}

	private isMetricsEnabled(): boolean {
		return this.configurationService.getConfig({
			key: 'github.copilot.metrics.enabled',
			defaultValue: false
		});
	}

	private async interceptEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): Promise<void> {
		if (!this.isMetricsEnabled()) {
			return;
		}

		try {
			const event = this.extractMetricEvent(eventName, properties, measurements);
			if (event) {
				await this.storageService.addEvent(event);
			}
		} catch (error) {
			this.logService.error('[AiMetrics] Failed to intercept telemetry event', error);
		}
	}

	private extractMetricEvent(
		eventName: string,
		properties?: TelemetryEventProperties,
		measurements?: TelemetryEventMeasurements
	): IAiMetricEvent | null {
		const timestamp = Date.now();

		// Token usage events from language model requests
		if (eventName.includes('request.response') || eventName.includes('conversation.message')) {
			const tokens = measurements?.tokens ?? 0;
			const cachedTokens = measurements?.cachedTokens ?? 0;

			if (tokens > 0) {
				return {
					timestamp,
					eventName,
					eventType: AiMetricEventType.TokenUsage,
					data: {
						tokens,
						cachedTokens,
						model: this.extractStringProperty(properties, 'model'),
						feature: this.extractFeatureFromEventName(eventName)
					}
				};
			}
		}

		// Model usage events
		if (eventName.includes('request.response') || eventName.includes('provideInlineEdit')) {
			const model = this.extractStringProperty(properties, 'model');
			if (model) {
				return {
					timestamp,
					eventName,
					eventType: AiMetricEventType.ModelUsage,
					data: {
						model,
						provider: this.extractProviderFromModel(model)
					}
				};
			}
		}

		// Code acceptance events from NES and completions
		if (eventName.includes('ghostText.accept') || eventName.includes('provideInlineEdit.accept')) {
			return {
				timestamp,
				eventName,
				eventType: AiMetricEventType.CodeAcceptance,
				data: {
					suggestionType: eventName.includes('provideInlineEdit') ? 'nes' : 'completion',
					accepted: true
				}
			};
		}

		// Code rejection events
		if (eventName.includes('ghostText.reject') || eventName.includes('provideInlineEdit.reject')) {
			return {
				timestamp,
				eventName,
				eventType: AiMetricEventType.CodeAcceptance,
				data: {
					suggestionType: eventName.includes('provideInlineEdit') ? 'nes' : 'completion',
					accepted: false,
					rejectionReason: this.extractStringProperty(properties, 'reason') ?? 'unknown'
				}
			};
		}

		// Feature usage events
		if (eventName.includes('conversation.message') || eventName.includes('ghostText.') || eventName.includes('provideInlineEdit.')) {
			return {
				timestamp,
				eventName,
				eventType: AiMetricEventType.FeatureUsage,
				data: {
					feature: this.extractFeatureFromEventName(eventName)
				}
			};
		}

		// Performance events
		if (measurements && (measurements.ttft || measurements.fetchTime || measurements.debounceTime)) {
			return {
				timestamp,
				eventName,
				eventType: AiMetricEventType.Performance,
				data: {
					ttft: measurements.ttft,
					fetchTime: measurements.fetchTime,
					debounceTime: measurements.debounceTime
				}
			};
		}

		return null;
	}

	private extractStringProperty(properties: TelemetryEventProperties | undefined, key: string): string | undefined {
		if (!properties) {
			return undefined;
		}
		const value = properties[key];
		if (typeof value === 'string') {
			return value;
		}
		// Handle TelemetryTrustedValue
		if (value && typeof value === 'object' && 'value' in value) {
			return String(value.value);
		}
		return undefined;
	}

	private extractFeatureFromEventName(eventName: string): string {
		if (eventName.includes('conversation') || eventName.includes('chat')) {
			return 'chat';
		}
		if (eventName.includes('provideInlineEdit') || eventName.includes('nes')) {
			return 'nes';
		}
		if (eventName.includes('ghostText') || eventName.includes('completion')) {
			return 'completion';
		}
		return 'unknown';
	}

	private extractProviderFromModel(model: string): string {
		if (model.includes('gpt') || model.includes('openai')) {
			return 'openai';
		}
		if (model.includes('claude') || model.includes('anthropic')) {
			return 'anthropic';
		}
		if (model.includes('gemini') || model.includes('google')) {
			return 'google';
		}
		return 'unknown';
	}

	// ITelemetryService implementation - all methods delegate to original service
	// and intercept relevant events

	sendInternalMSFTTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendInternalMSFTTelemetryEvent(eventName, properties, measurements);
	}

	sendMSFTTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendMSFTTelemetryEvent(eventName, properties, measurements);
	}

	sendMSFTTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendMSFTTelemetryErrorEvent(eventName, properties, measurements);
	}

	sendGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendGHTelemetryEvent(eventName, properties, measurements);
	}

	sendGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendGHTelemetryErrorEvent(eventName, properties, measurements);
	}

	sendGHTelemetryException(maybeError: unknown, origin: string): void {
		this.originalTelemetryService.sendGHTelemetryException(maybeError, origin);
	}

	sendEnhancedGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendEnhancedGHTelemetryEvent(eventName, properties, measurements);
	}

	sendEnhancedGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendEnhancedGHTelemetryErrorEvent(eventName, properties, measurements);
	}

	sendTelemetryEvent(eventName: string, destination: TelemetryDestination, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendTelemetryEvent(eventName, destination, properties, measurements);
	}

	sendTelemetryErrorEvent(eventName: string, destination: TelemetryDestination, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.interceptEvent(eventName, properties, measurements);
		this.originalTelemetryService.sendTelemetryErrorEvent(eventName, destination, properties, measurements);
	}

	setAdditionalExpAssignments(expAssignments: string[]): void {
		this.originalTelemetryService.setAdditionalExpAssignments(expAssignments);
	}

	setSharedProperty(name: string, value: string): void {
		this.originalTelemetryService.setSharedProperty(name, value);
	}

	postEvent(eventName: string, props: Map<string, string>): void {
		this.originalTelemetryService.postEvent(eventName, props);
	}

	dispose(): void {
		super.dispose();
	}
}
