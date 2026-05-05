/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import type { ILogService } from '../../../../platform/log/common/logService';
import type { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import {
	LanguageModelDataPart,
	LanguageModelPartAudience,
	LanguageModelTextPart,
	LanguageModelTextPart2,
	LanguageModelToolResult,
} from '../../../../vscodeTypes';
import { IToolResultFilter, ToolResultCompressorService } from '../toolResultCompressor';

const TOOL = 'run_in_terminal';

function makeService(opts: {
	enabled: boolean;
	warnings?: string[];
}): ToolResultCompressorService {
	const config = {
		getConfig: (_key: unknown) => opts.enabled,
	} as unknown as IConfigurationService;
	const telemetry = {
		sendMSFTTelemetryEvent: () => { /* noop */ },
	} as unknown as ITelemetryService;
	const log = {
		warn: (msg: string) => { opts.warnings?.push(msg); },
	} as unknown as ILogService;
	return new ToolResultCompressorService(config, telemetry, log);
}

function longText(prefix: string): string {
	// Must exceed MIN_COMPRESSIBLE_LENGTH (80) so filters get a chance to run.
	return prefix + ' ' + 'x'.repeat(200);
}

const replaceWithFooFilter: IToolResultFilter = {
	id: 'test.replaceWithFoo',
	toolNames: [TOOL],
	matches: () => true,
	apply: () => ({ text: 'foo', compressed: true }),
};

describe('ToolResultCompressorService', () => {
	it('returns undefined when disabled', () => {
		const svc = makeService({ enabled: false });
		svc.registerFilter(replaceWithFooFilter);
		const result = new LanguageModelToolResult([new LanguageModelTextPart(longText('hello'))]);
		expect(svc.maybeCompress(TOOL, {}, result)).toBeUndefined();
	});

	it('returns undefined when no filters registered', () => {
		const svc = makeService({ enabled: true });
		const result = new LanguageModelToolResult([new LanguageModelTextPart(longText('hello'))]);
		expect(svc.maybeCompress(TOOL, {}, result)).toBeUndefined();
	});

	it('returns undefined when no filters match', () => {
		const svc = makeService({ enabled: true });
		svc.registerFilter({
			id: 'no-match',
			toolNames: [TOOL],
			matches: () => false,
			apply: () => ({ text: 'foo', compressed: true }),
		});
		const result = new LanguageModelToolResult([new LanguageModelTextPart(longText('hello'))]);
		expect(svc.maybeCompress(TOOL, {}, result)).toBeUndefined();
	});

	it('disables a throwing filter for the rest of the pass and warns once', () => {
		const warnings: string[] = [];
		const svc = makeService({ enabled: true, warnings });
		let calls = 0;
		svc.registerFilter({
			id: 'thrower',
			toolNames: [TOOL],
			matches: () => true,
			apply: () => { calls++; throw new Error('boom'); },
		});
		svc.registerFilter(replaceWithFooFilter);
		const result = new LanguageModelToolResult([
			new LanguageModelTextPart(longText('a')),
			new LanguageModelTextPart(longText('b')),
			new LanguageModelTextPart(longText('c')),
		]);
		const out = svc.maybeCompress(TOOL, {}, result)!;
		expect(out).toBeDefined();
		// Throwing filter is invoked exactly once on the first text part, then disabled.
		expect(calls).toBe(1);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('thrower');
		// The other filter still rewrites every text part. Each emitted part starts
		// with the compression banner and ends with the filter's replacement text.
		for (const part of out.content) {
			expect(part).toBeInstanceOf(LanguageModelTextPart);
			const value = (part as LanguageModelTextPart).value;
			expect(value).toMatch(/^\[Output compressed by test\.replaceWithFoo /);
			expect(value.endsWith('\nfoo')).toBe(true);
		}
	});

	it('preserves non-text parts unchanged', () => {
		const svc = makeService({ enabled: true });
		svc.registerFilter(replaceWithFooFilter);
		const dataPart = new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'application/octet-stream');
		const textPart = new LanguageModelTextPart(longText('hello'));
		const result = new LanguageModelToolResult([dataPart, textPart]);
		const out = svc.maybeCompress(TOOL, {}, result)!;
		expect(out.content[0]).toBe(dataPart);
		expect(out.content[1]).toBeInstanceOf(LanguageModelTextPart);
		const value = (out.content[1] as LanguageModelTextPart).value;
		expect(value).toMatch(/^\[Output compressed by test\.replaceWithFoo /);
		expect(value.endsWith('\nfoo')).toBe(true);
	});

	it('preserves LanguageModelTextPart2 audience metadata when rewriting', () => {
		const svc = makeService({ enabled: true });
		svc.registerFilter(replaceWithFooFilter);
		const audience = [LanguageModelPartAudience.Assistant, LanguageModelPartAudience.User];
		const part = new LanguageModelTextPart2(longText('hello'), audience);
		const result = new LanguageModelToolResult([part]);
		const out = svc.maybeCompress(TOOL, {}, result)!;
		expect(out.content[0]).toBeInstanceOf(LanguageModelTextPart2);
		const rewritten = out.content[0] as LanguageModelTextPart2;
		expect(rewritten.value).toMatch(/^\[Output compressed by test\.replaceWithFoo /);
		expect(rewritten.value.endsWith('\nfoo')).toBe(true);
		expect(rewritten.audience).toEqual(audience);
	});

	it('skips text parts shorter than the minimum compressible length', () => {
		const svc = makeService({ enabled: true });
		svc.registerFilter(replaceWithFooFilter);
		const result = new LanguageModelToolResult([new LanguageModelTextPart('tiny')]);
		// Nothing was compressed because the part was below the threshold.
		expect(svc.maybeCompress(TOOL, {}, result)).toBeUndefined();
	});
});
