/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { type PushMetricExporter, type ResourceMetrics, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import * as fs from 'node:fs';

function safeStringify(data: unknown): string {
	try {
		return JSON.stringify(data);
	} catch {
		return '{}';
	}
}

function serializeSpan(span: ReadableSpan): Record<string, unknown> {
	if (typeof span.spanContext !== 'function') {
		return span as unknown as Record<string, unknown>;
	}
	const spanContext = span.spanContext();
	return {
		resource: {
			attributes: span.resource.attributes,
		},
		instrumentationScope: span.instrumentationScope,
		traceId: spanContext.traceId,
		spanId: spanContext.spanId,
		traceFlags: spanContext.traceFlags,
		traceState: spanContext.traceState?.serialize(),
		parentSpanId: span.parentSpanContext?.spanId,
		name: span.name,
		kind: span.kind,
		startTime: span.startTime,
		endTime: span.endTime,
		duration: span.duration,
		status: span.status,
		attributes: span.attributes,
		links: span.links,
		events: span.events,
		ended: span.ended,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	};
}

abstract class BaseFileExporter {
	protected readonly writeStream: fs.WriteStream;

	constructor(filePath: string) {
		this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });
	}

	shutdown(): Promise<void> {
		return new Promise(resolve => this.writeStream.end(resolve));
	}

	forceFlush(): Promise<void> {
		return Promise.resolve();
	}
}

export class FileSpanExporter extends BaseFileExporter implements SpanExporter {
	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		const data = spans.map(s => safeStringify(serializeSpan(s)) + '\n').join('');
		this.writeStream.write(data, err => {
			resultCallback({ code: err ? ExportResultCode.FAILED : ExportResultCode.SUCCESS, error: err ?? undefined });
		});
	}
}

export class FileLogExporter extends BaseFileExporter implements LogRecordExporter {
	export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
		const data = logs.map(l => safeStringify(l) + '\n').join('');
		this.writeStream.write(data, err => {
			resultCallback({ code: err ? ExportResultCode.FAILED : ExportResultCode.SUCCESS, error: err ?? undefined });
		});
	}
}

export class FileMetricExporter extends BaseFileExporter implements PushMetricExporter {
	export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
		const data = safeStringify(metrics) + '\n';
		this.writeStream.write(data, err => {
			resultCallback({ code: err ? ExportResultCode.FAILED : ExportResultCode.SUCCESS, error: err ?? undefined });
		});
	}

	selectAggregationTemporality(): AggregationTemporality {
		return AggregationTemporality.CUMULATIVE;
	}
}
