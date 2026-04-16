/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExportResultCode } from '@opentelemetry/core';
import { AggregationTemporality } from '@opentelemetry/sdk-metrics';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLogExporter, FileMetricExporter, FileSpanExporter } from '../fileExporters';

describe('FileSpanExporter', () => {
	let tmpFile: string;
	let exporter: FileSpanExporter;

	beforeEach(() => {
		tmpFile = path.join(os.tmpdir(), `otel-test-spans-${Date.now()}.jsonl`);
		exporter = new FileSpanExporter(tmpFile);
	});

	afterEach(async () => {
		await exporter.shutdown();
		try { fs.unlinkSync(tmpFile); } catch { }
	});

	it('writes span data as JSON lines', async () => {
		const fakeSpan = { name: 'test-span', kind: 0, attributes: { a: 1 } };
		await new Promise<void>((resolve, reject) => {
			exporter.export([fakeSpan as any], result => {
				result.code === ExportResultCode.SUCCESS ? resolve() : reject(result.error);
			});
		});
		await exporter.shutdown();
		const content = fs.readFileSync(tmpFile, 'utf-8');
		const parsed = JSON.parse(content.trim());
		expect(parsed.name).toBe('test-span');
		expect(parsed.attributes).toEqual({ a: 1 });
	});

	it('appends multiple exports', async () => {
		for (let i = 0; i < 3; i++) {
			await new Promise<void>((resolve, reject) => {
				exporter.export([{ name: `span-${i}` } as any], result => {
					result.code === ExportResultCode.SUCCESS ? resolve() : reject(result.error);
				});
			});
		}
		await exporter.shutdown();
		const lines = fs.readFileSync(tmpFile, 'utf-8').trim().split('\n');
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0]).name).toBe('span-0');
		expect(JSON.parse(lines[2]).name).toBe('span-2');
	});

	it('serializes class-based spans without writing empty objects', async () => {
		class FakeReadableSpan {
			readonly #ctx = { traceId: 'trace-id', spanId: 'span-id', traceFlags: 1, traceState: undefined };
			readonly #resource = { attributes: { 'service.name': 'copilot-chat' } };
			readonly #instrumentationScope = { name: 'copilot-chat', version: '0.44.0' };
			readonly #status = { code: 1 };
			readonly #attributes = { a: 1 };
			readonly #links: unknown[] = [];
			readonly #events: unknown[] = [];
			readonly #time: [number, number] = [1, 2];
			readonly #parentSpanContext = { traceId: 'trace-id', spanId: 'parent-span-id', traceFlags: 1, traceState: undefined };

			spanContext() { return this.#ctx; }
			get resource() { return this.#resource; }
			get instrumentationScope() { return this.#instrumentationScope; }
			get parentSpanContext() { return this.#parentSpanContext; }
			get name() { return 'hidden-span'; }
			get kind() { return 0; }
			get startTime() { return this.#time; }
			get endTime() { return this.#time; }
			get duration() { return this.#time; }
			get status() { return this.#status; }
			get attributes() { return this.#attributes; }
			get links() { return this.#links; }
			get events() { return this.#events; }
			get ended() { return true; }
			get droppedAttributesCount() { return 0; }
			get droppedEventsCount() { return 0; }
			get droppedLinksCount() { return 0; }
		}

		expect(JSON.stringify(new FakeReadableSpan())).toBe('{}');

		await new Promise<void>((resolve, reject) => {
			exporter.export([new FakeReadableSpan() as any], result => {
				result.code === ExportResultCode.SUCCESS ? resolve() : reject(result.error);
			});
		});
		await exporter.shutdown();
		const content = fs.readFileSync(tmpFile, 'utf-8');
		const parsed = JSON.parse(content.trim());
		expect(parsed.name).toBe('hidden-span');
		expect(parsed.traceId).toBe('trace-id');
		expect(parsed.parentSpanId).toBe('parent-span-id');
		expect(parsed.instrumentationScope).toEqual({ name: 'copilot-chat', version: '0.44.0' });
		expect(parsed.resource.attributes).toEqual({ 'service.name': 'copilot-chat' });
		expect(parsed.attributes).toEqual({ a: 1 });
	});
});

describe('FileLogExporter', () => {
	let tmpFile: string;
	let exporter: FileLogExporter;

	beforeEach(() => {
		tmpFile = path.join(os.tmpdir(), `otel-test-logs-${Date.now()}.jsonl`);
		exporter = new FileLogExporter(tmpFile);
	});

	afterEach(async () => {
		await exporter.shutdown();
		try { fs.unlinkSync(tmpFile); } catch { }
	});

	it('writes log records as JSON lines', async () => {
		const fakeLog = { body: 'test log', severityText: 'INFO' };
		await new Promise<void>((resolve, reject) => {
			exporter.export([fakeLog as any], result => {
				result.code === ExportResultCode.SUCCESS ? resolve() : reject(result.error);
			});
		});
		await exporter.shutdown();
		const content = fs.readFileSync(tmpFile, 'utf-8');
		const parsed = JSON.parse(content.trim());
		expect(parsed.body).toBe('test log');
	});
});

describe('FileMetricExporter', () => {
	let tmpFile: string;
	let exporter: FileMetricExporter;

	beforeEach(() => {
		tmpFile = path.join(os.tmpdir(), `otel-test-metrics-${Date.now()}.jsonl`);
		exporter = new FileMetricExporter(tmpFile);
	});

	afterEach(async () => {
		await exporter.shutdown();
		try { fs.unlinkSync(tmpFile); } catch { }
	});

	it('writes metric data as JSON lines', async () => {
		const fakeMetrics = { resource: {}, scopeMetrics: [{ metrics: [{ name: 'test' }] }] };
		await new Promise<void>((resolve, reject) => {
			exporter.export(fakeMetrics as any, result => {
				result.code === ExportResultCode.SUCCESS ? resolve() : reject(result.error);
			});
		});
		await exporter.shutdown();
		const content = fs.readFileSync(tmpFile, 'utf-8');
		const parsed = JSON.parse(content.trim());
		expect(parsed.scopeMetrics[0].metrics[0].name).toBe('test');
	});

	it('returns CUMULATIVE aggregation temporality', () => {
		expect(exporter.selectAggregationTemporality()).toBe(AggregationTemporality.CUMULATIVE);
	});
});
