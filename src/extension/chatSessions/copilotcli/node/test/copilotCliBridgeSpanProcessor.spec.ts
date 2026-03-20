/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CopilotCliBridgeSpanProcessor } from '../copilotCliBridgeSpanProcessor';
import type { IOTelService, ICompletedSpanData } from '../../../../../platform/otel/common/otelService';
import { Event } from '../../../../../util/vs/base/common/event';
import { resolveOTelConfig } from '../../../../../platform/otel/common/otelConfig';

function createMockOTelService(): IOTelService & { injectedSpans: ICompletedSpanData[] } {
	const injectedSpans: ICompletedSpanData[] = [];
	return {
		_serviceBrand: undefined!,
		config: resolveOTelConfig({ env: {}, extensionVersion: '1.0.0', sessionId: 'test' }),
		startSpan: vi.fn() as never,
		startActiveSpan: vi.fn() as never,
		getActiveTraceContext: vi.fn(),
		storeTraceContext: vi.fn(),
		getStoredTraceContext: vi.fn(),
		runWithTraceContext: vi.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()) as never,
		recordMetric: vi.fn(),
		incrementCounter: vi.fn(),
		emitLogRecord: vi.fn(),
		flush: vi.fn(),
		shutdown: vi.fn(),
		injectCompletedSpan(span: ICompletedSpanData) { injectedSpans.push(span); },
		onDidCompleteSpan: Event.None,
		onDidEmitSpanEvent: Event.None,
		injectedSpans,
	};
}

function makeReadableSpan(overrides: {
	name?: string;
	traceId?: string;
	spanId?: string;
	parentSpanContext?: { traceId: string; spanId: string } | undefined;
	attributes?: Record<string, unknown>;
	events?: { name: string; time: [number, number]; attributes?: Record<string, unknown> }[];
	status?: { code: number; message?: string };
	startTime?: [number, number];
	endTime?: [number, number];
} = {}) {
	return {
		name: overrides.name ?? 'test-span',
		startTime: overrides.startTime ?? [1000, 0] as [number, number],
		endTime: overrides.endTime ?? [1001, 0] as [number, number],
		attributes: overrides.attributes ?? {},
		events: overrides.events ?? [],
		status: overrides.status ?? { code: 0 },
		parentSpanContext: overrides.parentSpanContext,
		spanContext: () => ({
			traceId: overrides.traceId ?? 'trace-abc',
			spanId: overrides.spanId ?? 'span-123',
		}),
	};
}

describe('CopilotCliBridgeSpanProcessor', () => {
	let otelService: ReturnType<typeof createMockOTelService>;
	let bridge: CopilotCliBridgeSpanProcessor;

	beforeEach(() => {
		otelService = createMockOTelService();
		bridge = new CopilotCliBridgeSpanProcessor(otelService);
	});

	it('forwards spans with registered traceId', () => {
		bridge.registerTrace('trace-abc', 'session-1');

		bridge.onEnd(makeReadableSpan({ name: 'chat model', traceId: 'trace-abc' }));

		expect(otelService.injectedSpans).toHaveLength(1);
		expect(otelService.injectedSpans[0].name).toBe('chat model');
		expect(otelService.injectedSpans[0].attributes['copilot_chat.chat_session_id']).toBe('session-1');
	});

	it('drops spans with unregistered traceId', () => {
		bridge.registerTrace('trace-abc', 'session-1');

		bridge.onEnd(makeReadableSpan({ traceId: 'trace-other' }));

		expect(otelService.injectedSpans).toHaveLength(0);
	});

	it('drops all spans when no traces are registered', () => {
		bridge.onEnd(makeReadableSpan());

		expect(otelService.injectedSpans).toHaveLength(0);
	});

	it('converts parentSpanContext to parentSpanId', () => {
		bridge.registerTrace('trace-abc', 'session-1');

		bridge.onEnd(makeReadableSpan({
			traceId: 'trace-abc',
			parentSpanContext: { traceId: 'trace-abc', spanId: 'parent-span-456' },
		}));

		expect(otelService.injectedSpans[0].parentSpanId).toBe('parent-span-456');
	});

	it('sets parentSpanId to undefined when no parent context', () => {
		bridge.registerTrace('trace-abc', 'session-1');

		bridge.onEnd(makeReadableSpan({ traceId: 'trace-abc' }));

		expect(otelService.injectedSpans[0].parentSpanId).toBeUndefined();
	});

	it('does not overwrite existing CHAT_SESSION_ID', () => {
		bridge.registerTrace('trace-abc', 'session-1');

		bridge.onEnd(makeReadableSpan({
			traceId: 'trace-abc',
			attributes: { 'copilot_chat.chat_session_id': 'existing-session' },
		}));

		expect(otelService.injectedSpans[0].attributes['copilot_chat.chat_session_id']).toBe('existing-session');
	});

	it('converts HrTime to milliseconds', () => {
		bridge.registerTrace('trace-abc', 'session-1');

		bridge.onEnd(makeReadableSpan({
			traceId: 'trace-abc',
			startTime: [1700000000, 500000000],
			endTime: [1700000001, 250000000],
		}));

		expect(otelService.injectedSpans[0].startTime).toBe(1700000000500);
		expect(otelService.injectedSpans[0].endTime).toBe(1700000001250);
	});

	it('converts span events', () => {
		bridge.registerTrace('trace-abc', 'session-1');

		bridge.onEnd(makeReadableSpan({
			traceId: 'trace-abc',
			events: [{
				name: 'user_message',
				time: [1700000000, 0],
				attributes: { content: 'hello' },
			}],
		}));

		expect(otelService.injectedSpans[0].events).toHaveLength(1);
		expect(otelService.injectedSpans[0].events[0].name).toBe('user_message');
		expect(otelService.injectedSpans[0].events[0].attributes?.content).toBe('hello');
	});

	it('flattens attribute values', () => {
		bridge.registerTrace('trace-abc', 'session-1');

		bridge.onEnd(makeReadableSpan({
			traceId: 'trace-abc',
			attributes: {
				string_attr: 'hello',
				number_attr: 42,
				bool_attr: true,
				array_attr: ['a', 'b'],
				object_attr: { nested: true },
				null_attr: null,
			},
		}));

		const attrs = otelService.injectedSpans[0].attributes;
		expect(attrs['string_attr']).toBe('hello');
		expect(attrs['number_attr']).toBe(42);
		expect(attrs['bool_attr']).toBe(true);
		expect(attrs['array_attr']).toEqual(['a', 'b']);
		expect(attrs['object_attr']).toBe('[object Object]');
		// null should not be in the result
		expect('null_attr' in attrs).toBe(false);
	});

	it('stops forwarding after unregisterTrace', () => {
		bridge.registerTrace('trace-abc', 'session-1');
		bridge.onEnd(makeReadableSpan({ traceId: 'trace-abc', name: 'span-1' }));
		expect(otelService.injectedSpans).toHaveLength(1);

		bridge.unregisterTrace('trace-abc');
		bridge.onEnd(makeReadableSpan({ traceId: 'trace-abc', name: 'span-2' }));
		expect(otelService.injectedSpans).toHaveLength(1);
	});

	it('stops forwarding after shutdown', async () => {
		bridge.registerTrace('trace-abc', 'session-1');
		await bridge.shutdown();

		bridge.onEnd(makeReadableSpan({ traceId: 'trace-abc' }));
		expect(otelService.injectedSpans).toHaveLength(0);
	});

	it('onStart is a no-op', () => {
		// Should not throw
		bridge.onStart({}, {});
	});

	it('forceFlush resolves immediately', async () => {
		await expect(bridge.forceFlush()).resolves.toBeUndefined();
	});
});
