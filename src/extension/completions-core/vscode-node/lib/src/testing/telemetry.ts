/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CompletionsTelemetryServiceBridge } from '../../../bridge/src/completionsTelemetryServiceBridge';
import { Context } from '../context';
import { TelemetryReporters } from '../telemetry';
import { PromiseQueue } from '../util/promiseQueue';
import { TelemetrySpy } from './telemetrySpy';

export type EventData = {
	baseType: 'EventData';
	baseData: {
		ver: number;
		name: string;
		properties: {
			copilot_build: string;
			common_os: string;
			[key: string]: string;
		};
		measurements: {
			timeSinceIssuedMs: number;
			[key: string]: number;
		};
	};
};

export type ExceptionData = {
	baseType: 'ExceptionData';
	baseData: {
		ver: number;
		exceptions: [
			{
				hasFullStack: boolean;
				parsedStack: [
					{
						sizeInBytes: number;
						level: number;
						method: string;
						assembly: string;
						fileName: string;
						line: number;
					}?,
				];
				message: string;
				typeName: string;
			},
		];
		properties: {
			copilot_build: string;
			common_os: string;
			[key: string]: string;
		};
		measurements: {
			timeSinceIssuedMs: number;
			[key: string]: number;
		};
		severityLevel: number;
	};
};

export type CapturedTelemetry<Event = Record<string, unknown>> = {
	ver: number;
	sampleRate: number;
	tags: { [key: string]: string };
	data: Event;
	iKey: string;
	name: string;
	time: string;
};

export type AuthorizationHeader = string | undefined;

export class TestPromiseQueue extends PromiseQueue {
	async awaitPromises() {
		// Distinct from flush() in that errors are thrown
		await Promise.all(this.promises);
	}
}

// export function isStandardTelemetryMessage(message: CapturedTelemetry<unknown>): boolean {
//     return message.iKey === APP_INSIGHTS_KEY;
// }

// export function isEnhancedTelemetryMessage(message: CapturedTelemetry<unknown>): boolean {
//     return message.iKey === APP_INSIGHTS_KEY_SECURE;
// }

export function isEvent(message: CapturedTelemetry): message is CapturedTelemetry<EventData> {
	return message.data.baseType === 'EventData';
}

export function isException(message: CapturedTelemetry): message is CapturedTelemetry<ExceptionData> {
	return message.data.baseType === 'ExceptionData';
}

export function allEvents(messages: CapturedTelemetry[]): messages is CapturedTelemetry<EventData>[] {
	for (const message of messages) {
		if (!isEvent(message)) {
			return false;
		}
	}
	return true;
}

export async function withInMemoryTelemetry<T>(
	ctx: Context,
	work: (localCtx: Context) => T | Promise<T>
): Promise<{ reporter: TelemetrySpy; enhancedReporter: TelemetrySpy; result: T }> {
	const reporter = new TelemetrySpy();
	const enhancedReporter = new TelemetrySpy();

	const serviceBridge = ctx.get(CompletionsTelemetryServiceBridge);
	try {
		serviceBridge.setSpyReporters(reporter, enhancedReporter);
		ctx.get(TelemetryReporters).setReporter(reporter);
		ctx.get(TelemetryReporters).setEnhancedReporter(enhancedReporter);
		const queue = new TestPromiseQueue();
		ctx.forceSet(PromiseQueue, queue);

		const result = await work(ctx);
		await queue.awaitPromises();

		return { reporter, enhancedReporter: enhancedReporter, result };
	} finally {
		serviceBridge.clearSpyReporters();
	}
}

/*
export async function withTelemetryCapture<T>(
	ctx: Context,
	work: () => T | Promise<T>
): Promise<[CapturedTelemetry<EventData | ExceptionData>[], T, AuthorizationHeader]> {
	return _withTelemetryCapture(ctx, true, work);
}

export async function withDisabledTelemetryCapture<T>(
	ctx: Context,
	work: () => T | Promise<T>
): Promise<[CapturedTelemetry<EventData | ExceptionData>[], T, AuthorizationHeader]> {
	return _withTelemetryCapture(ctx, false, work);
}

async function _withTelemetryCapture<T>(
	ctx: Context,
	enabled: boolean,
	work: () => T | Promise<T>
): Promise<[CapturedTelemetry<EventData | ExceptionData>[], T, AuthorizationHeader]> {
	let authorization: AuthorizationHeader;
	const messages: CapturedTelemetry<EventData | ExceptionData>[] = [];
	const server = createServer((req, res) => {
		if (req.method !== 'POST') { return; }
		authorization = req.headers['authorization'];
		let body = '';
		req.on('end', () => {
			const items = <typeof messages>JSON.parse(body);
			messages.push(...items);
			res.writeHead(204);
			res.end();
		});
		req.on('data', chunk => {
			body += String(chunk);
		});
	});
	server.unref(); // don't keep the process alive for this server
	const port = await new Promise<number>((resolve, reject) => {
		server.on('error', err => reject(err));
		server.listen(() => resolve((server.address() as net.AddressInfo).port));
	});

	// ensure we don't have a proxy setup in place from other tests
	delete process.env.http_proxy;
	delete process.env.https_proxy;

	const telemetryInit = ctx.get(TelemetryInitialization);
	telemetryInit.overrideEndpointUrlForTesting = `http://localhost:${port}/`;
	telemetryInit.initialize(enabled);

	try {
		const queue = new TestPromiseQueue();
		ctx.forceSet(PromiseQueue, queue);
		const result = await work();
		await queue.awaitPromises();
		await telemetryInit.shutdown();
		await waitForCapturedTelemetryWithRetry(messages);
		return [messages, result, authorization];
	} finally {
		telemetryInit.overrideEndpointUrlForTesting = undefined;
		server.close();
	}
}

async function waitForCapturedTelemetryWithRetry(messages: unknown[]): Promise<void> {
	for (let waitTimeMultiplier = 1; waitTimeMultiplier < 3; waitTimeMultiplier++) {
		await new Promise(resolve => setTimeout(resolve, waitTimeMultiplier * 50));
		if (messages.length > 0) { return; }
		console.warn('Retrying to collect telemetry messages #' + waitTimeMultiplier);
	}
}

export function assertHasProperty(
	messages: CapturedTelemetry<EventData>[],
	assertion: (m: { [key: string]: string }) => boolean
) {
	assert.ok(
		messages
			.filter(message => message.data.baseData.name.split('/')[1] !== 'ghostText.produced')
			.every(message => {
				const props = message.data.baseData.properties;
				return assertion.call(props, props);
			})
	);
}
*/
