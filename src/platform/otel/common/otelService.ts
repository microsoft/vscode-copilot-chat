/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import type { OTelConfig } from './otelConfig';

export const IOTelService = createServiceIdentifier<IOTelService>('IOTelService');

/**
 * Abstracts the OpenTelemetry SDK so consumers don't import OTel directly.
 * When disabled, all methods are no-ops with zero overhead.
 */
export interface IOTelService {
	readonly _serviceBrand: undefined;
	readonly config: OTelConfig;

	/**
	 * Start a new span. Returns a handle to set attributes and end the span.
	 * If OTel is disabled, returns a no-op handle.
	 */
	startSpan(name: string, options?: SpanOptions): ISpanHandle;

	/**
	 * Start a span and set it as active context so child spans are parented.
	 * Calls `fn` within the active span context.
	 */
	startActiveSpan<T>(name: string, options: SpanOptions, fn: (span: ISpanHandle) => Promise<T>): Promise<T>;

	/**
	 * Record a histogram metric value.
	 */
	recordMetric(name: string, value: number, attributes?: Record<string, string | number | boolean>): void;

	/**
	 * Increment a counter metric.
	 */
	incrementCounter(name: string, value?: number, attributes?: Record<string, string | number | boolean>): void;

	/**
	 * Emit an OTel log record / event.
	 */
	emitLogRecord(body: string, attributes?: Record<string, unknown>): void;

	/**
	 * Force flush all pending telemetry data.
	 */
	flush(): Promise<void>;

	/**
	 * Gracefully shut down the OTel SDK.
	 */
	shutdown(): Promise<void>;
}

export const enum SpanKind {
	INTERNAL = 0,
	CLIENT = 2,
}

export const enum SpanStatusCode {
	UNSET = 0,
	OK = 1,
	ERROR = 2,
}

export interface SpanOptions {
	kind?: SpanKind;
	attributes?: Record<string, string | number | boolean | string[]>;
}

/**
 * Lightweight handle for a span, independent of the OTel SDK types.
 */
export interface ISpanHandle {
	setAttribute(key: string, value: string | number | boolean | string[]): void;
	setAttributes(attrs: Record<string, string | number | boolean | string[] | undefined>): void;
	setStatus(code: SpanStatusCode, message?: string): void;
	recordException(error: unknown): void;
	end(): void;
}
