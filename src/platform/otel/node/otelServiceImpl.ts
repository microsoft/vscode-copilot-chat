/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OTelConfig } from '../common/otelConfig';
import { type IOTelService, type ISpanHandle, type SpanOptions, type TraceContext, SpanKind, SpanStatusCode } from '../common/otelService';

// Type-only imports — erased by esbuild, zero bundle impact
import type { Attributes, Context, Meter, Span, SpanContext, Tracer } from '@opentelemetry/api';
import type { AnyValueMap, Logger } from '@opentelemetry/api-logs';
import type { ExportResult } from '@opentelemetry/core';
import type { BatchLogRecordProcessor, LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { PeriodicExportingMetricReader, PushMetricExporter } from '@opentelemetry/sdk-metrics';
import type { BatchSpanProcessor, ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';

interface ExporterSet {
	spanExporter: SpanExporter;
	logExporter: LogRecordExporter;
	metricExporter: PushMetricExporter;
}

const noopSpanHandle: ISpanHandle = {
	setAttribute() { },
	setAttributes() { },
	setStatus() { },
	recordException() { },
	end() { },
};

/**
 * Real OTel service implementation, only instantiated when OTel is enabled.
 * Uses dynamic imports so the OTel SDK is not loaded when disabled.
 */
export class NodeOTelService implements IOTelService {
	declare readonly _serviceBrand: undefined;
	readonly config: OTelConfig;

	private _tracer: Tracer | undefined;
	private _meter: Meter | undefined;
	private _logger: Logger | undefined;
	private _spanProcessor: BatchSpanProcessor | undefined;
	private _logProcessor: BatchLogRecordProcessor | undefined;
	private _metricReader: PeriodicExportingMetricReader | undefined;
	// OTel API reference for context propagation (stored after dynamic import)
	private _otelApi: typeof import('@opentelemetry/api') | undefined;
	private _initialized = false;
	private _initFailed = false;
	private static readonly _MAX_BUFFER_SIZE = 1000;

	// Buffer events until SDK is ready
	private readonly _buffer: Array<() => void> = [];

	constructor(config: OTelConfig) {
		this.config = config;
		// Start async initialization immediately
		void this._initialize();
	}

	private async _initialize(): Promise<void> {
		if (this._initialized || !this.config.enabled) {
			return;
		}

		try {
			// Dynamic imports — only loaded when OTel is enabled
			const [
				api,
				apiLogs,
				traceSDK,
				logsSDK,
				metricsSDK,
				resourcesMod,
			] = await Promise.all([
				import('@opentelemetry/api'),
				import('@opentelemetry/api-logs'),
				import('@opentelemetry/sdk-trace-node'),
				import('@opentelemetry/sdk-logs'),
				import('@opentelemetry/sdk-metrics'),
				import('@opentelemetry/resources'),
			]);

			const BSP = traceSDK.BatchSpanProcessor;
			const BLRP = logsSDK.BatchLogRecordProcessor;
			const PEMR = metricsSDK.PeriodicExportingMetricReader;
			const NodeTracerProvider = traceSDK.NodeTracerProvider;
			const MeterProvider = metricsSDK.MeterProvider;
			const LoggerProvider = logsSDK.LoggerProvider;

			// Use resourceFromAttributes (available in @opentelemetry/resources v2+)
			const resource = resourcesMod.resourceFromAttributes({
				'service.name': this.config.serviceName,
				'service.version': this.config.serviceVersion,
				'session.id': this.config.sessionId,
				...this.config.resourceAttributes,
			});

			// Create exporters based on config
			const { spanExporter, logExporter, metricExporter } = await this._createExporters();

			// Wrap span exporter with diagnostics to confirm end-to-end connectivity
			const diagnosticSpanExporter = new DiagnosticSpanExporter(spanExporter, this.config.exporterType);

			// Trace provider — pass spanProcessors in constructor (SDK v2 API)
			this._spanProcessor = new BSP(diagnosticSpanExporter);
			const tracerProvider = new NodeTracerProvider({
				resource,
				spanProcessors: [this._spanProcessor],
			});
			tracerProvider.register();
			this._tracer = api.trace.getTracer(this.config.serviceName, this.config.serviceVersion);
			this._otelApi = api;

			// Log provider — pass processors in constructor (SDK v2 uses 'processors' key)
			this._logProcessor = new BLRP(logExporter, {
				scheduledDelayMillis: 1000,
				maxExportBatchSize: 512,
			});
			const loggerProvider = new LoggerProvider({
				resource,
				processors: [this._logProcessor],
			} as ConstructorParameters<typeof LoggerProvider>[0]);
			apiLogs.logs.setGlobalLoggerProvider(loggerProvider);
			this._logger = apiLogs.logs.getLogger(this.config.serviceName, this.config.serviceVersion);

			// Metric provider
			this._metricReader = new PEMR({
				exporter: metricExporter,
				exportIntervalMillis: 10000,
			});
			const meterProvider = new MeterProvider({
				resource,
				readers: [this._metricReader],
			});
			api.metrics.setGlobalMeterProvider(meterProvider);
			this._meter = api.metrics.getMeter(this.config.serviceName, this.config.serviceVersion);

			this._initialized = true;

			// Flush buffered events in batches to avoid blocking the event loop
			const batch = this._buffer.splice(0);
			const BATCH_SIZE = 50;
			for (let i = 0; i < batch.length; i += BATCH_SIZE) {
				const chunk = batch.slice(i, i + BATCH_SIZE);
				for (const fn of chunk) {
					try { fn(); } catch { /* swallow */ }
				}
				if (i + BATCH_SIZE < batch.length) {
					// Yield to event loop between batches
					await new Promise<void>(resolve => setTimeout(resolve, 0));
				}
			}

		} catch (err) {
			// OTel init failure should never break the extension
			this._initFailed = true;
			this._buffer.length = 0; // Discard buffered events on failure
			console.error('[OTel] Failed to initialize:', err);
		}
	}

	private async _createExporters(): Promise<ExporterSet> {
		const { config } = this;

		if (config.exporterType === 'file' && config.fileExporterPath) {
			const { FileSpanExporter, FileLogExporter, FileMetricExporter } = await import('./fileExporters');
			return {
				spanExporter: new FileSpanExporter(config.fileExporterPath),
				logExporter: new FileLogExporter(config.fileExporterPath),
				metricExporter: new FileMetricExporter(config.fileExporterPath),
			};
		}

		if (config.exporterType === 'console') {
			const [traceSDK, logsSDK, metricsSDK] = await Promise.all([
				import('@opentelemetry/sdk-trace-node'),
				import('@opentelemetry/sdk-logs'),
				import('@opentelemetry/sdk-metrics'),
			]);
			return {
				spanExporter: new traceSDK.ConsoleSpanExporter(),
				logExporter: new logsSDK.ConsoleLogRecordExporter(),
				metricExporter: new metricsSDK.ConsoleMetricExporter(),
			};
		}

		if (config.exporterType === 'otlp-grpc') {
			const [
				{ OTLPTraceExporter },
				{ OTLPLogExporter },
				{ OTLPMetricExporter },
			] = await Promise.all([
				import('@opentelemetry/exporter-trace-otlp-grpc'),
				import('@opentelemetry/exporter-logs-otlp-grpc'),
				import('@opentelemetry/exporter-metrics-otlp-grpc'),
			]);
			const opts = { url: config.otlpEndpoint };
			return {
				spanExporter: new OTLPTraceExporter(opts),
				logExporter: new OTLPLogExporter(opts),
				metricExporter: new OTLPMetricExporter(opts),
			};
		}

		// Default: otlp-http
		const [
			{ OTLPTraceExporter },
			{ OTLPLogExporter },
			{ OTLPMetricExporter },
		] = await Promise.all([
			import('@opentelemetry/exporter-trace-otlp-http'),
			import('@opentelemetry/exporter-logs-otlp-http'),
			import('@opentelemetry/exporter-metrics-otlp-http'),
		]);
		const base = config.otlpEndpoint.replace(/\/$/, '');
		return {
			spanExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
			logExporter: new OTLPLogExporter({ url: `${base}/v1/logs` }),
			metricExporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
		};
	}

	// ── Span API ──

	startSpan(name: string, options?: SpanOptions): ISpanHandle {
		if (!this._tracer) {
			if (this._initFailed || this._buffer.length >= NodeOTelService._MAX_BUFFER_SIZE) {
				return noopSpanHandle;
			}
			const handle = new BufferedSpanHandle();
			this._buffer.push(() => {
				const real = this._createSpan(name, options);
				handle.replay(real);
			});
			return handle;
		}
		return this._createSpan(name, options);
	}

	async startActiveSpan<T>(name: string, options: SpanOptions, fn: (span: ISpanHandle) => Promise<T>): Promise<T> {
		if (!this._tracer) {
			const handle = this.startSpan(name, options);
			try {
				return await fn(handle);
			} finally {
				handle.end();
			}
		}

		const spanOpts = { kind: toOTelSpanKind(options?.kind), attributes: options?.attributes as Attributes };

		// If a parent trace context is provided, create a remote context and start span within it
		if (options.parentTraceContext && this._otelApi) {
			const parentCtx = this._createRemoteContext(options.parentTraceContext);
			return this._tracer.startActiveSpan(
				name,
				spanOpts,
				parentCtx,
				async (span: Span) => {
					const handle = new RealSpanHandle(span);
					try {
						return await fn(handle);
					} finally {
						handle.end();
					}
				}
			);
		}

		return this._tracer.startActiveSpan(
			name,
			spanOpts,
			async (span: Span) => {
				const handle = new RealSpanHandle(span);
				try {
					return await fn(handle);
				} finally {
					handle.end();
				}
			}
		);
	}

	getActiveTraceContext(): TraceContext | undefined {
		if (!this._otelApi) {
			return undefined;
		}
		const activeSpan = this._otelApi.trace.getSpan(this._otelApi.context.active());
		if (!activeSpan) {
			return undefined;
		}
		const ctx = activeSpan.spanContext();
		if (!ctx.traceId || !ctx.spanId) {
			return undefined;
		}
		return { traceId: ctx.traceId, spanId: ctx.spanId };
	}

	// ── Trace Context Store ── (for cross-boundary propagation)

	private readonly _traceContextStore = new Map<string, TraceContext>();

	storeTraceContext(key: string, context: TraceContext): void {
		this._traceContextStore.set(key, context);
		// Auto-cleanup after 5 minutes to prevent memory leaks
		setTimeout(() => this._traceContextStore.delete(key), 5 * 60 * 1000);
	}

	getStoredTraceContext(key: string): TraceContext | undefined {
		const ctx = this._traceContextStore.get(key);
		if (ctx) {
			this._traceContextStore.delete(key);
		}
		return ctx;
	}

	/**
	 * Creates an OTel Context with a remote span context as parent,
	 * allowing spans created within it to be children of the remote span.
	 */
	private _createRemoteContext(tc: TraceContext): Context {
		const api = this._otelApi!;
		const remoteSpanContext: SpanContext = {
			traceId: tc.traceId,
			spanId: tc.spanId,
			traceFlags: 1, // SAMPLED
			isRemote: true,
		};
		const remoteCtx = api.trace.setSpanContext(api.context.active(), remoteSpanContext);
		return remoteCtx;
	}

	async runWithTraceContext<T>(traceContext: TraceContext, fn: () => Promise<T>): Promise<T> {
		if (!this._otelApi) {
			return fn();
		}
		const parentCtx = this._createRemoteContext(traceContext);
		return this._otelApi.context.with(parentCtx, fn);
	}

	private _createSpan(name: string, options?: SpanOptions): ISpanHandle {
		const span = this._tracer!.startSpan(name, {
			kind: toOTelSpanKind(options?.kind),
			attributes: options?.attributes as Attributes,
		});
		return new RealSpanHandle(span);
	}

	// ── Metric API ──

	private readonly _histograms = new Map<string, ReturnType<Meter['createHistogram']>>();
	private readonly _counters = new Map<string, ReturnType<Meter['createCounter']>>();

	recordMetric(name: string, value: number, attributes?: Record<string, string | number | boolean>): void {
		if (!this._meter) {
			if (!this._initFailed && this._buffer.length < NodeOTelService._MAX_BUFFER_SIZE) {
				this._buffer.push(() => this.recordMetric(name, value, attributes));
			}
			return;
		}
		let histogram = this._histograms.get(name);
		if (!histogram) {
			histogram = this._meter.createHistogram(name);
			this._histograms.set(name, histogram);
		}
		histogram.record(value, attributes);
	}

	incrementCounter(name: string, value = 1, attributes?: Record<string, string | number | boolean>): void {
		if (!this._meter) {
			if (!this._initFailed && this._buffer.length < NodeOTelService._MAX_BUFFER_SIZE) {
				this._buffer.push(() => this.incrementCounter(name, value, attributes));
			}
			return;
		}
		let counter = this._counters.get(name);
		if (!counter) {
			counter = this._meter.createCounter(name);
			this._counters.set(name, counter);
		}
		counter.add(value, attributes);
	}

	// ── Log API ──

	private _logEmitCount = 0;

	emitLogRecord(body: string, attributes?: Record<string, unknown>): void {
		if (!this._logger) {
			if (!this._initFailed && this._buffer.length < NodeOTelService._MAX_BUFFER_SIZE) {
				this._buffer.push(() => this.emitLogRecord(body, attributes));
			}
			return;
		}
		// Pass the active context so the log record inherits the trace ID from
		// the current span (if any). Without this, logs emitted inside a span
		// created via startSpan() (rather than startActiveSpan()) lack trace context.
		const ctx = this._otelApi?.context.active();
		this._logger.emit({ body, attributes: attributes as AnyValueMap, ...(ctx ? { context: ctx } : {}) });
		this._logEmitCount++;
		if (this._logEmitCount === 1) {
			console.info(`[OTel] First log record emitted: ${body}`);
		}
	}

	// ── Lifecycle ──

	async flush(): Promise<void> {
		await Promise.all([
			this._spanProcessor?.forceFlush(),
			this._logProcessor?.forceFlush(),
		]);
	}

	async shutdown(): Promise<void> {
		try {
			await this.flush();
			const api = await import('@opentelemetry/api');
			const apiLogs = await import('@opentelemetry/api-logs');
			api.trace.disable();
			api.metrics.disable();
			apiLogs.logs.disable();
		} catch {
			// Swallow shutdown errors
		}
	}
}

// ── Span Handle Implementations ──

class RealSpanHandle implements ISpanHandle {
	constructor(private readonly _span: Span) { }

	setAttribute(key: string, value: string | number | boolean | string[]): void {
		this._span.setAttribute(key, value);
	}

	setAttributes(attrs: Record<string, string | number | boolean | string[] | undefined>): void {
		for (const k in attrs) {
			if (Object.prototype.hasOwnProperty.call(attrs, k)) {
				const v = attrs[k];
				if (v !== undefined) {
					this._span.setAttribute(k, v);
				}
			}
		}
	}

	setStatus(code: SpanStatusCode, message?: string): void {
		const otelCode = code === SpanStatusCode.OK ? 1 : code === SpanStatusCode.ERROR ? 2 : 0;
		this._span.setStatus({ code: otelCode, message });
	}

	recordException(error: unknown): void {
		if (error instanceof Error) {
			this._span.recordException(error);
		} else {
			this._span.recordException(new Error(String(error)));
		}
	}

	end(): void {
		this._span.end();
	}
}

/**
 * Buffers span operations until the SDK is initialized, then replays them.
 */
class BufferedSpanHandle implements ISpanHandle {
	private readonly _ops: Array<(span: ISpanHandle) => void> = [];
	private _real: ISpanHandle | undefined;

	constructor() { }

	setAttribute(key: string, value: string | number | boolean | string[]): void {
		if (this._real) { this._real.setAttribute(key, value); return; }
		this._ops.push(s => s.setAttribute(key, value));
	}

	setAttributes(attrs: Record<string, string | number | boolean | string[] | undefined>): void {
		if (this._real) { this._real.setAttributes(attrs); return; }
		this._ops.push(s => s.setAttributes(attrs));
	}

	setStatus(code: SpanStatusCode, message?: string): void {
		if (this._real) { this._real.setStatus(code, message); return; }
		this._ops.push(s => s.setStatus(code, message));
	}

	recordException(error: unknown): void {
		if (this._real) { this._real.recordException(error); return; }
		this._ops.push(s => s.recordException(error));
	}

	end(): void {
		if (this._real) { this._real.end(); return; }
		this._ops.push(s => s.end());
	}

	replay(real: ISpanHandle): void {
		this._real = real;
		for (const op of this._ops) {
			op(real);
		}
		this._ops.length = 0;
	}
}

function toOTelSpanKind(kind: SpanKind | undefined): number {
	switch (kind) {
		case SpanKind.CLIENT: return 2; // OTel SpanKind.CLIENT
		case SpanKind.INTERNAL: return 0; // OTel SpanKind.INTERNAL
		default: return 0; // INTERNAL
	}
}

/**
 * Wraps a SpanExporter to log diagnostic info about export results.
 * Logs once on first successful export (info), and on every failure (warn).
 */
class DiagnosticSpanExporter implements SpanExporter {
	private _firstSuccessLogged = false;
	private readonly _inner: SpanExporter;
	private readonly _exporterType: string;

	constructor(inner: SpanExporter, exporterType: string) {
		this._inner = inner;
		this._exporterType = exporterType;
	}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		this._inner.export(spans, result => {
			// ExportResultCode.SUCCESS === 0
			if (result.code === 0) {
				if (!this._firstSuccessLogged) {
					this._firstSuccessLogged = true;
					console.info(`[OTel] First span batch exported successfully via ${this._exporterType} (${spans.length} spans)`);
				}
			} else {
				console.warn(`[OTel] Span export failed via ${this._exporterType}: ${result.error ?? 'unknown error'}`);
			}
			resultCallback(result);
		});
	}

	shutdown(): Promise<void> {
		return this._inner.shutdown?.() ?? Promise.resolve();
	}

	forceFlush(): Promise<void> {
		return this._inner.forceFlush?.() ?? Promise.resolve();
	}
}
