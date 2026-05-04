/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCurrentDateContext } from '../currentDateContext';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';

function createMockConfigService(overrides: { timeFormat?: string; showWeekday?: boolean; showTimezone?: boolean } = {}): IConfigurationService {
	return {
		_serviceBrand: undefined,
		getConfig(key: unknown) {
			if (key === ConfigKey.Advanced.TimeFormat) { return overrides.timeFormat ?? 'off'; }
			if (key === ConfigKey.Advanced.ShowWeekday) { return overrides.showWeekday ?? false; }
			if (key === ConfigKey.Advanced.ShowTimezone) { return overrides.showTimezone ?? false; }
			return undefined;
		},
	} as unknown as IConfigurationService;
}

describe('formatCurrentDateContext', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('TZ', 'UTC');
		// Monday, June 15, 2026 14:30:45 UTC
		vi.setSystemTime(new Date('2026-06-15T14:30:45.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('returns date only by default (all settings off)', () => {
		const result = formatCurrentDateContext(createMockConfigService());
		expect(result).toBe('The current date is June 15, 2026.');
	});

	it('includes time in 24h format', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h' }));
		expect(result).toBe('The current date is June 15, 2026. The current time is 14:30:45.');
	});

	it('includes time in 12h format', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '12h' }));
		expect(result).toBe('The current date is June 15, 2026. The current time is 02:30:45 PM.');
	});

	it('includes weekday when showWeekday is enabled', () => {
		const result = formatCurrentDateContext(createMockConfigService({ showWeekday: true }));
		expect(result).toBe('The current date is Monday, June 15, 2026.');
	});

	it('includes timezone when both time and showTimezone are enabled', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h', showTimezone: true }));
		expect(result).toBe('The current date is June 15, 2026. The current time is 14:30:45 GMT+0.');
	});

	it('does not include timezone when time is off', () => {
		const result = formatCurrentDateContext(createMockConfigService({ showTimezone: true }));
		expect(result).toBe('The current date is June 15, 2026.');
	});

	it('includes all parts when all settings are enabled (24h)', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h', showWeekday: true, showTimezone: true }));
		expect(result).toBe('The current date is Monday, June 15, 2026. The current time is 14:30:45 GMT+0.');
	});

	it('includes all parts when all settings are enabled (12h)', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '12h', showWeekday: true, showTimezone: true }));
		expect(result).toBe('The current date is Monday, June 15, 2026. The current time is 02:30:45 PM GMT+0.');
	});

	it('weekday + time without timezone', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h', showWeekday: true }));
		expect(result).toBe('The current date is Monday, June 15, 2026. The current time is 14:30:45.');
	});

	it('treats unknown timeFormat values as 24h', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: 'garbage' as any }));
		expect(result).toBe('The current date is June 15, 2026. The current time is 14:30:45.');
	});
});

describe('formatCurrentDateContext (US Eastern timezone)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('TZ', 'America/New_York');
		vi.setSystemTime(new Date('2026-06-15T14:30:45.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('shows local time and GMT-4 timezone', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h', showTimezone: true }));
		expect(result).toBe('The current date is June 15, 2026. The current time is 10:30:45 GMT-4.');
	});

	it('shows all parts in Eastern timezone', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '12h', showWeekday: true, showTimezone: true }));
		expect(result).toBe('The current date is Monday, June 15, 2026. The current time is 10:30:45 AM GMT-4.');
	});
});

describe('formatCurrentDateContext (Tokyo timezone)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('TZ', 'Asia/Tokyo');
		vi.setSystemTime(new Date('2026-06-15T14:30:45.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('shows local time in Tokyo timezone', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h', showTimezone: true }));
		expect(result).toBe('The current date is June 15, 2026. The current time is 23:30:45 GMT+9.');
	});
});

describe('formatCurrentDateContext (US Pacific winter — PST)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('TZ', 'America/Los_Angeles');
		// January = PST (no daylight saving)
		vi.setSystemTime(new Date('2026-01-15T20:30:45.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('shows GMT-8 in LA winter', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h', showTimezone: true }));
		expect(result).toBe('The current date is January 15, 2026. The current time is 12:30:45 GMT-8.');
	});
});

describe('formatCurrentDateContext (India — non-whole-hour offset)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('TZ', 'Asia/Kolkata');
		vi.setSystemTime(new Date('2026-06-15T14:30:45.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('shows GMT+5:30 offset', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h', showTimezone: true }));
		expect(result).toBe('The current date is June 15, 2026. The current time is 20:00:45 GMT+5:30.');
	});
});

describe('formatCurrentDateContext (date rollover — UTC night → Tokyo next day)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('TZ', 'Asia/Tokyo');
		// UTC Sunday 23:30 → Tokyo Monday 08:30, date rolls to June 16
		vi.setSystemTime(new Date('2026-06-15T23:30:45.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('shows correct local date and weekday after rollover', () => {
		const result = formatCurrentDateContext(createMockConfigService({ timeFormat: '24h', showWeekday: true, showTimezone: true }));
		expect(result).toBe('The current date is Tuesday, June 16, 2026. The current time is 08:30:45 GMT+9.');
	});
});
