/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMarks, createPerfTracer, getPerfTracer, PerfTrace } from '../performance';

describe('performance', () => {

	const TEST_PREFIX = 'code/test/perfmod/';

	afterEach(() => {
		// Clean up any marks left by tests
		for (const entry of performance.getEntriesByType('mark')) {
			if (entry.name.startsWith(TEST_PREFIX) || entry.name.startsWith('code/test/')) {
				performance.clearMarks(entry.name);
			}
		}
		getPerfTracer('code/test/perfmod')?.dispose();
	});

	describe('clearMarks', () => {
		it('clears marks matching the prefix', () => {
			performance.mark(TEST_PREFIX + 'a');
			performance.mark(TEST_PREFIX + 'b');
			performance.mark('code/other/c');

			clearMarks(TEST_PREFIX);

			const remaining = performance.getEntriesByType('mark').filter(e => e.name.startsWith('code/test/'));
			expect(remaining).toHaveLength(0);
			expect(performance.getEntriesByType('mark').some(e => e.name === 'code/other/c')).toBe(true);
			performance.clearMarks('code/other/c');
		});

		it('clears only marks whose detail matches the filter', () => {
			performance.mark(TEST_PREFIX + 'a', { detail: { traceId: '0' } });
			performance.mark(TEST_PREFIX + 'b', { detail: { traceId: '1' } });

			clearMarks(TEST_PREFIX, [{ traceId: '0' }]);

			const remaining = performance.getEntriesByType('mark').filter(e => e.name.startsWith(TEST_PREFIX));
			expect(remaining).toHaveLength(1);
			expect(remaining[0].name).toBe(TEST_PREFIX + 'b');
		});

		it('clears marks with no detail when filters are provided', () => {
			performance.mark(TEST_PREFIX + 'nodetail');
			performance.mark(TEST_PREFIX + 'withdetail', { detail: { traceId: '1' } });

			clearMarks(TEST_PREFIX, [{ traceId: '0' }]);

			// marks with no detail are always cleared when prefix matches
			const remaining = performance.getEntriesByType('mark').filter(e => e.name.startsWith(TEST_PREFIX));
			expect(remaining).toHaveLength(1);
			expect(remaining[0].name).toBe(TEST_PREFIX + 'withdetail');
		});
	});

	describe('createPerfTracer / getPerfTracer', () => {
		it('creates a globally registered tracer', () => {
			const tracer = createPerfTracer('code/test/perfmod');
			expect(getPerfTracer('code/test/perfmod')).toBe(tracer);
		});

		it('normalizes prefix with trailing slash', () => {
			const tracer = createPerfTracer('code/test/perfmod/');
			expect(getPerfTracer('code/test/perfmod')).toBe(tracer);
		});

		it('replaces existing tracer with same prefix', () => {
			const first = createPerfTracer('code/test/perfmod');
			const second = createPerfTracer('code/test/perfmod');
			expect(getPerfTracer('code/test/perfmod')).toBe(second);
			expect(getPerfTracer('code/test/perfmod')).not.toBe(first);
		});

		it('local tracer is not registered globally', () => {
			createPerfTracer('code/test/perfmod', { local: true });
			expect(getPerfTracer('code/test/perfmod')).toBeUndefined();
		});
	});

	describe('PerfTracer', () => {
		it('start() returns a PerfTrace', () => {
			const tracer = createPerfTracer('code/test/perfmod');
			const trace = tracer.start();
			expect(trace).toBeInstanceOf(PerfTrace);
		});

		it('start() clears marks from previously done traces', () => {
			const tracer = createPerfTracer('code/test/perfmod');

			const trace1 = tracer.start();
			trace1.mark('event1');
			trace1.done();

			// Starting a new trace should clear marks from trace1
			const trace2 = tracer.start();
			trace2.mark('event2');

			const marks = performance.getEntriesByType('mark').filter(e => e.name.startsWith(TEST_PREFIX));
			const markNames = marks.map(m => m.name);
			expect(markNames).not.toContain(TEST_PREFIX + 'event1');
			expect(markNames).toContain(TEST_PREFIX + 'event2');

			trace2.done();
		});

		it('findTraceByCorrelation returns registered trace', () => {
			const tracer = createPerfTracer('code/test/perfmod');
			const trace = tracer.start();
			trace.registerCorrelation('requestId', 'abc123');

			expect(tracer.findTraceByCorrelation('requestId', 'abc123')).toBe(trace);
		});

		it('findTraceByCorrelation returns undefined for non-string value', () => {
			const tracer = createPerfTracer('code/test/perfmod');
			expect(tracer.findTraceByCorrelation('requestId', 42)).toBeUndefined();
		});

		it('findTraceByCorrelation returns undefined after done()', () => {
			const tracer = createPerfTracer('code/test/perfmod');
			const trace = tracer.start();
			trace.registerCorrelation('requestId', 'abc123');
			trace.done();

			expect(tracer.findTraceByCorrelation('requestId', 'abc123')).toBeUndefined();
		});

		it('dispose clears all marks and unregisters', () => {
			const tracer = createPerfTracer('code/test/perfmod');
			const trace = tracer.start();
			trace.mark('something');

			tracer.dispose();

			const marks = performance.getEntriesByType('mark').filter(e => e.name.startsWith(TEST_PREFIX));
			expect(marks).toHaveLength(0);
			expect(getPerfTracer('code/test/perfmod')).toBeUndefined();
		});

		it('throws on start() after dispose', () => {
			const tracer = createPerfTracer('code/test/perfmod');
			tracer.dispose();
			expect(() => tracer.start()).toThrow('PerfTracer is disposed');
		});
	});

	describe('PerfTrace', () => {
		let tracer: ReturnType<typeof createPerfTracer>;

		beforeEach(() => {
			tracer = createPerfTracer('code/test/perfmod');
		});

		it('mark() emits a performance mark with prefix and detail', () => {
			const trace = tracer.start({ session: 'sess1' });
			trace.mark('willFetch');

			const marks = performance.getEntriesByType('mark').filter(e => e.name === TEST_PREFIX + 'willFetch');
			expect(marks).toHaveLength(1);
			const detail = (marks[0] as unknown as { detail: Record<string, unknown> }).detail;
			expect(detail.session).toBe('sess1');
			expect(typeof detail.traceId).toBe('string');
		});

		it('mark() merges additional detail', () => {
			const trace = tracer.start({ session: 'sess1' });
			trace.mark('didFetch', { toolName: 'readFile' });

			const marks = performance.getEntriesByType('mark').filter(e => e.name === TEST_PREFIX + 'didFetch');
			const detail = (marks[0] as unknown as { detail: Record<string, unknown> }).detail;
			expect(detail.session).toBe('sess1');
			expect(detail.toolName).toBe('readFile');
		});

		it('done() unregisters correlations', () => {
			const trace = tracer.start();
			trace.registerCorrelation('id', 'x');
			trace.done();
			expect(tracer.findTraceByCorrelation('id', 'x')).toBeUndefined();
		});

		it('dispose() calls done()', () => {
			const trace = tracer.start();
			trace.registerCorrelation('id', 'y');
			trace.dispose();
			expect(tracer.findTraceByCorrelation('id', 'y')).toBeUndefined();
		});
	});
});
