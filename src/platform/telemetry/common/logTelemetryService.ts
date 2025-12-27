/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITelemetryService, TelemetryDestination, TelemetryEventMeasurements, TelemetryEventProperties } from './telemetry';

/**
 * A telemetry service implementation that logs all telemetry events to the console.
 * Useful for development and debugging to see what telemetry is being sent.
 */
export class LogTelemetryService implements ITelemetryService {
	declare readonly _serviceBrand: undefined;

	private readonly enableColors = true;
	private readonly colors = {
		reset: '\x1b[0m',
		bright: '\x1b[1m',
		dim: '\x1b[2m',

		// Foreground colors
		red: '\x1b[31m',
		green: '\x1b[32m',
		yellow: '\x1b[33m',
		blue: '\x1b[34m',
		magenta: '\x1b[35m',
		cyan: '\x1b[36m',
		white: '\x1b[37m',

		// Background colors
		bgRed: '\x1b[41m',
		bgGreen: '\x1b[42m',
		bgYellow: '\x1b[43m',
		bgBlue: '\x1b[44m',
	};

	constructor() {
		console.log(this.colorize(`${this.colors.bright}${this.colors.cyan}`, '='.repeat(80)));
		console.log(this.colorize(`${this.colors.bright}${this.colors.cyan}`, '🔍 LogTelemetryService initialized - All telemetry will be logged to console'));
		console.log(this.colorize(`${this.colors.bright}${this.colors.cyan}`, '='.repeat(80)));
	}

	dispose(): void {
		console.log(this.colorize(`${this.colors.dim}${this.colors.cyan}`, '🔌 LogTelemetryService disposed'));
	}

	private colorize(colorCode: string, text: string): string {
		if (!this.enableColors) {
			return text;
		}
		return `${colorCode}${text}${this.colors.reset}`;
	}

	private formatProperties(properties?: TelemetryEventProperties): string {
		if (!properties || Object.keys(properties).length === 0) {
			return this.colorize(this.colors.dim, '  (no properties)');
		}

		let result = '';
		for (const [key, value] of Object.entries(properties)) {
			// Handle TelemetryTrustedValue
			const displayValue = typeof value === 'object' && value !== null && 'value' in value
				? value.value
				: value;
			const truncated = String(displayValue).length > 100
				? String(displayValue).substring(0, 97) + '...'
				: displayValue;
			result += `\n    ${this.colorize(this.colors.cyan, key)}: ${this.colorize(this.colors.white, String(truncated))}`;
		}
		return result;
	}

	private formatMeasurements(measurements?: TelemetryEventMeasurements): string {
		if (!measurements || Object.keys(measurements).length === 0) {
			return this.colorize(this.colors.dim, '  (no measurements)');
		}

		let result = '';
		for (const [key, value] of Object.entries(measurements)) {
			result += `\n    ${this.colorize(this.colors.magenta, key)}: ${this.colorize(this.colors.yellow, String(value))}`;
		}
		return result;
	}

	private logEvent(
		eventType: string,
		destination: string,
		eventName: string,
		properties?: TelemetryEventProperties,
		measurements?: TelemetryEventMeasurements
	): void {
		const timestamp = new Date().toISOString();
		const typeColor = eventType.includes('Error') ? this.colors.red : this.colors.green;
		const destColor = destination.includes('MSFT') ? this.colors.blue : this.colors.magenta;

		console.log('');
		console.log(this.colorize(`${this.colors.bright}${typeColor}`, `📊 ${eventType}`));
		console.log(this.colorize(this.colors.dim, `   Time: ${timestamp}`));
		console.log(this.colorize(destColor, `   Destination: ${destination}`));
		console.log(this.colorize(`${this.colors.bright}${this.colors.yellow}`, `   Event: ${eventName}`));

		if (properties && Object.keys(properties).length > 0) {
			console.log(this.colorize(`${this.colors.bright}${this.colors.cyan}`, '   Properties:'));
			console.log(this.formatProperties(properties));
		}

		if (measurements && Object.keys(measurements).length > 0) {
			console.log(this.colorize(`${this.colors.bright}${this.colors.magenta}`, '   Measurements:'));
			console.log(this.formatMeasurements(measurements));
		}

		console.log(this.colorize(this.colors.dim, '  ' + '-'.repeat(78)));
	}

	sendInternalMSFTTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.logEvent('Internal MSFT Event', 'Microsoft (Internal)', eventName, properties, measurements);
	}

	sendMSFTTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.logEvent('MSFT Event', 'Microsoft (External)', eventName, properties, measurements);
	}

	sendMSFTTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.logEvent('MSFT Error Event', 'Microsoft (External)', eventName, properties, measurements);
	}

	sendGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.logEvent('GitHub Event', 'GitHub (Standard)', eventName, properties, measurements);
	}

	sendGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.logEvent('GitHub Error Event', 'GitHub (Standard)', eventName, properties, measurements);
	}

	sendGHTelemetryException(maybeError: unknown, origin: string): void {
		const timestamp = new Date().toISOString();
		console.log('');
		console.log(this.colorize(`${this.colors.bright}${this.colors.bgRed}${this.colors.white}`, '💥 GitHub Exception'));
		console.log(this.colorize(this.colors.dim, `   Time: ${timestamp}`));
		console.log(this.colorize(this.colors.magenta, `   Destination: GitHub (Standard)`));
		console.log(this.colorize(`${this.colors.bright}${this.colors.red}`, `   Origin: ${origin}`));
		console.log(this.colorize(this.colors.yellow, '   Error:'));

		if (maybeError instanceof Error) {
			console.log(this.colorize(this.colors.red, `    Name: ${maybeError.name}`));
			console.log(this.colorize(this.colors.red, `    Message: ${maybeError.message}`));
			if (maybeError.stack) {
				const stackLines = maybeError.stack.split('\n').slice(0, 5); // First 5 lines
				console.log(this.colorize(this.colors.dim, '    Stack (first 5 lines):'));
				stackLines.forEach(line => console.log(this.colorize(this.colors.dim, `      ${line}`)));
			}
		} else {
			console.log(this.colorize(this.colors.red, `    ${String(maybeError)}`));
		}

		console.log(this.colorize(this.colors.dim, '  ' + '-'.repeat(78)));
	}

	sendTelemetryEvent(eventName: string, destination: TelemetryDestination, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		const destLabel = destination.microsoft ? 'Microsoft' : 'GitHub';
		const destDetail = destination.github && typeof destination.github === 'object'
			? `GitHub (prefix: ${destination.github.eventNamePrefix})`
			: destLabel;
		this.logEvent('Generic Event', destDetail, eventName, properties, measurements);
	}

	sendTelemetryErrorEvent(eventName: string, destination: TelemetryDestination, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		const destLabel = destination.microsoft ? 'Microsoft' : 'GitHub';
		const destDetail = destination.github && typeof destination.github === 'object'
			? `GitHub (prefix: ${destination.github.eventNamePrefix})`
			: destLabel;
		this.logEvent('Generic Error Event', destDetail, eventName, properties, measurements);
	}

	setSharedProperty(name: string, value: string): void {
		console.log(this.colorize(this.colors.cyan, `🔧 Set Shared Property: ${name} = ${value}`));
	}

	setAdditionalExpAssignments(expAssignments: string[]): void {
		console.log(this.colorize(this.colors.cyan, `🧪 Set Experiment Assignments: [${expAssignments.join(', ')}]`));
	}

	postEvent(eventName: string, props: Map<string, string>): void {
		const timestamp = new Date().toISOString();
		console.log('');
		console.log(this.colorize(`${this.colors.bright}${this.colors.blue}`, `📮 Experimentation Event`));
		console.log(this.colorize(this.colors.dim, `   Time: ${timestamp}`));
		console.log(this.colorize(`${this.colors.bright}${this.colors.yellow}`, `   Event: ${eventName}`));

		if (props.size > 0) {
			console.log(this.colorize(`${this.colors.bright}${this.colors.cyan}`, '   Properties:'));
			props.forEach((value, key) => {
				console.log(`    ${this.colorize(this.colors.cyan, key)}: ${this.colorize(this.colors.white, value)}`);
			});
		}

		console.log(this.colorize(this.colors.dim, '  ' + '-'.repeat(78)));
	}

	sendEnhancedGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.logEvent('GitHub Enhanced Event', 'GitHub (Enhanced)', eventName, properties, measurements);
	}

	sendEnhancedGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void {
		this.logEvent('GitHub Enhanced Error Event', 'GitHub (Enhanced)', eventName, properties, measurements);
	}
}
