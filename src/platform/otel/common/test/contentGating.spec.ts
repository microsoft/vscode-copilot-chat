/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CapturingOTelService } from './capturingOTelService';

/**
 * CapturingOTelService correctly exposes the captureContent config flag.
 *
 * Integration tests that exercise the real ToolCallingLoop code path live in
 * src/extension/intents/test/node/toolCallingLoopContentGating.spec.ts.
 */
describe('CapturingOTelService captureContent config', () => {
	it('defaults captureContent to false when OTEL is enabled without explicit flag', () => {
		const otel = new CapturingOTelService();
		expect(otel.config.captureContent).toBe(false);
	});

	it('respects captureContent=true override', () => {
		const otel = new CapturingOTelService({ captureContent: true });
		expect(otel.config.captureContent).toBe(true);
	});

	it('respects captureContent=false override', () => {
		const otel = new CapturingOTelService({ captureContent: false });
		expect(otel.config.captureContent).toBe(false);
	});
});
