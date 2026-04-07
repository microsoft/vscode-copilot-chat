/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { isCopilotOfflineMode } from '../copilotCliEnv';

describe('copilotCliEnv', () => {
	afterEach(() => {
		delete process.env['COPILOT_OFFLINE'];
	});

	it('returns false when COPILOT_OFFLINE is unset', () => {
		expect(isCopilotOfflineMode()).toBe(false);
	});

	it('returns true when COPILOT_OFFLINE is "true"', () => {
		process.env['COPILOT_OFFLINE'] = 'true';

		expect(isCopilotOfflineMode()).toBe(true);
	});

	it('returns false when COPILOT_OFFLINE is "false"', () => {
		process.env['COPILOT_OFFLINE'] = 'false';

		expect(isCopilotOfflineMode()).toBe(false);
	});
});