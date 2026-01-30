/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AppInsightsClientOptions, TelemetryReporter } from '@vscode/extension-telemetry';
import * as os from 'os';
import { env, TelemetryLogger, TelemetrySender } from 'vscode';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { BaseGHTelemetrySender } from '../common/ghTelemetrySender';
import { ITelemetryUserConfig } from '../common/telemetry';
import { AzureInsightReporter, unwrapEventNameFromPrefix } from '../node/azureInsightsReporter';

/**
 * Adapter that wraps both old and new telemetry reporters to implement VS Code's TelemetrySender interface.
 * Supports lazy flag evaluation to avoid circular dependencies during service initialization.
 */
class TelemetryReporterAdapter implements TelemetrySender {
	private readonly oldReporter: AzureInsightReporter;
	private readonly newReporter?: TelemetryReporter;
	private readonly tokenStore?: ICopilotTokenStore;
	private readonly useNewTelemetryLibGetter: () => boolean;
	private cachedFlagValue: boolean | undefined;

	constructor(
		oldReporter: AzureInsightReporter,
		newReporter: TelemetryReporter | undefined,
		tokenStore: ICopilotTokenStore | undefined,
		useNewTelemetryLibGetter: () => boolean
	) {
		this.oldReporter = oldReporter;
		this.newReporter = newReporter;
		this.tokenStore = tokenStore;
		this.useNewTelemetryLibGetter = useNewTelemetryLibGetter;
	}

	/**
	 * Lazily evaluates the flag and caches the result.
	 * This allows the experimentation service to be initialized after TelemetryService.
	 */
	private get useNewTelemetryLib(): boolean {
		if (this.cachedFlagValue === undefined) {
			this.cachedFlagValue = this.useNewTelemetryLibGetter();
		}
		return this.cachedFlagValue;
	}

	/**
	 * Extracts properties (strings) and measurements (numbers) from telemetry data.
	 * Handles both separate properties/measurements format and mixed format.
	 */
	private extractPropertiesAndMeasurements(data?: Record<string, unknown>): { properties: Record<string, string>; measurements: Record<string, number> } {
		const properties: Record<string, string> = {};
		const measurements: Record<string, number> = {};

		if (data) {
			// Handle both formats: separate properties/measurements or mixed
			if (data.properties !== undefined || data.measurements !== undefined) {
				Object.assign(properties, (data.properties || {}) as Record<string, string>);
				Object.assign(measurements, (data.measurements || {}) as Record<string, number>);
			} else {
				// Mixed format - separate by type
				for (const [key, value] of Object.entries(data)) {
					if (typeof value === 'number') {
						measurements[key] = value;
					} else if (value !== undefined) {
						properties[key] = String(value);
					}
				}
			}
		}

		return { properties, measurements };
	}

	sendEventData(eventName: string, data?: Record<string, unknown>): void {
		const { properties, measurements } = this.extractPropertiesAndMeasurements(data);

		// Use either NEW or OLD API based on experiment flag (not both)
		if (this.useNewTelemetryLib && this.newReporter) {
			// Unwrap event name - VS Code's TelemetryLogger adds extension prefix, we need to remove it
			// to avoid double-prefixing (backend also adds prefix)
			const unwrappedEventName = unwrapEventNameFromPrefix(eventName);

			// Get dynamic tracking ID (changes per event) - NEW API: per-event tag overrides
			const trackingId = this.tokenStore?.copilotToken?.getTokenValue('tid');
			const tagOverrides = trackingId ? { 'ai.user.id': trackingId } : undefined;

			// Use sendDangerousTelemetryEvent to bypass TelemetryReporter's internal TelemetryLogger.
			// This avoids double-prefixing: the outer TelemetryLogger already added the prefix,
			// and the inner one would add it again if we used sendTelemetryEvent.
			// This is safe because: (1) opt-in/settings check is handled by our outer TelemetryLogger,
			// and (2) sanitization is also handled by the outer TelemetryLogger before data reaches here.
			this.newReporter.sendDangerousTelemetryEvent(unwrappedEventName, properties, measurements, tagOverrides);
		} else {
			// Default: use OLD API
			// Pass original eventName - AzureInsightReporter.massageEventName() handles the wrapped marker
			// to avoid double-prefixing
			const oldPayload = {
				properties,
				measurements,
				...data
			};
			this.oldReporter.sendEventData(eventName, oldPayload);
		}
	}

	sendErrorData(error: Error, data?: Record<string, unknown>): void {
		const { properties, measurements } = this.extractPropertiesAndMeasurements(data);

		// Add error info to properties
		properties['error.name'] = error.name;
		properties['error.message'] = error.message;
		if (error.stack) {
			properties['error.stack'] = error.stack;
		}

		// Use either NEW or OLD API based on experiment flag (not both)
		if (this.useNewTelemetryLib && this.newReporter) {
			// Get dynamic tracking ID (changes per event) - NEW API: per-event tag overrides
			const trackingId = this.tokenStore?.copilotToken?.getTokenValue('tid');
			const tagOverrides = trackingId ? { 'ai.user.id': trackingId } : undefined;

			// Use sendDangerousTelemetryErrorEvent to bypass TelemetryReporter's internal TelemetryLogger
			// (same reason as sendDangerousTelemetryEvent - avoid double-prefixing)
			this.newReporter.sendDangerousTelemetryErrorEvent('error', properties, measurements, tagOverrides);
		} else {
			// Default: use OLD API
			const oldPayload = { properties, measurements, ...data };
			this.oldReporter.sendErrorData(error, oldPayload);
		}
	}

	flush(): void | Thenable<void> {
		if (this.useNewTelemetryLib && this.newReporter) {
			return this.newReporter.dispose();
		} else {
			return this.oldReporter.flush();
		}
	}
}

function createGitHubTelemetryReporter(
	key: string,
	capiClientService: ICAPIClientService,
	envService: IEnvService,
	useNewTelemetryLibGetter: () => boolean,
	tokenStore: ICopilotTokenStore,
	extensionName: string
): TelemetrySender {
	// Always create the OLD reporter (default)
	const oldReporter = new AzureInsightReporter(
		capiClientService,
		envService,
		tokenStore,
		extensionName,
		key
	);

	// Always create NEW reporter so it's ready when the flag is enabled

	// Match old implementation's property naming (common_* with underscore, not common.* with dot)
	const commonProps: Record<string, string> = {
		'common_os': os.platform(),
		'common_platformversion': os.release(),
		'common_arch': os.arch(),
		'common_cpu': Array.from(new Set(os.cpus().map(c => c.model))).join(),
		'common_vscodemachineid': envService.machineId,
		'common_vscodesessionid': envService.sessionId,
		'client_deviceid': envService.devDeviceId,
		'common_uikind': envService.uiKind,
		'common_remotename': envService.remoteName ?? 'none',
		'common_isnewappinstall': ''
	};

	const appInsightsOptions: AppInsightsClientOptions = {
		endpointUrl: capiClientService.copilotTelemetryURL,
		commonProperties: commonProps,
		// Static tag overrides (set once, applied to all events)
		tagOverrides: {
			'ai.cloud.roleInstance': 'REDACTED', // Do not want personal machine names to be sent
			'ai.session.id': envService.sessionId // Map session ID to Application Insights tag
		}
	};

	// TelemetryReporter handles XHR override internally for Node.js
	const newReporter = new TelemetryReporter(
		key,
		[], // replacementOptions - empty to disable redaction
		{
			ignoreBuiltInCommonProperties: true,
			ignoreUnhandledErrors: true
		},
		undefined, // customFetcher - use default
		appInsightsOptions
	);

	return new TelemetryReporterAdapter(oldReporter, newReporter, tokenStore, useNewTelemetryLibGetter);
}

export class GitHubTelemetrySender extends BaseGHTelemetrySender {
	constructor(
		configService: IConfigurationService,
		envService: IEnvService,
		telemetryConfig: ITelemetryUserConfig,
		domainService: IDomainService,
		capiClientService: ICAPIClientService,
		extensionName: string,
		standardTelemetryAIKey: string,
		enhancedTelemetryAIKey: string,
		tokenStore: ICopilotTokenStore,
		useNewTelemetryLibGetter: () => boolean
	) {
		const telemetryLoggerFactory = (enhanced: boolean): TelemetryLogger => {
			const key = enhanced ? enhancedTelemetryAIKey : standardTelemetryAIKey;
			const sender = createGitHubTelemetryReporter(
				key,
				capiClientService,
				envService,
				useNewTelemetryLibGetter,
				tokenStore,
				extensionName
			);
			const logger = env.createTelemetryLogger(sender, {
				ignoreBuiltInCommonProperties: true,
				ignoreUnhandledErrors: true
			});
			return logger;
		};
		super(tokenStore, telemetryLoggerFactory, configService, telemetryConfig, envService, domainService);
	}
}