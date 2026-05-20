/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';

/**
 * Formats the current date/time context string for inclusion in prompts.
 * Respects user settings for time, weekday, and timezone display.
 *
 * Default (all settings off): "The current date is May 3, 2026."
 * With all settings on: "The current date is Sunday, May 3, 2026. The current time is 23:06:32 GMT+2."
 * Timezone is always in GMT±N offset format for consistency across all regions.
 *
 * timeFormat values: "off" (default), "24h", "12h"
 */
export function formatCurrentDateContext(configurationService: IConfigurationService): string {
	const now = new Date();
	const parts: string[] = [];

	parts.push('The current date is ');

	if (configurationService.getConfig(ConfigKey.Advanced.ShowWeekday)) {
		parts.push(now.toLocaleDateString('en-US', { weekday: 'long' }));
		parts.push(', ');
	}

	parts.push(now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
	parts.push('.');

	const timeFormat = configurationService.getConfig(ConfigKey.Advanced.TimeFormat);
	if (timeFormat && timeFormat !== 'off') {
		const hour12 = timeFormat === '12h';
		const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12 });
		parts.push(` The current time is ${timeStr}`);

		if (configurationService.getConfig(ConfigKey.Advanced.ShowTimezone)) {
			const tz = new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value;
			if (tz) {
				parts.push(` ${tz}`);
			}
		}

		parts.push('.');
	}

	return parts.join('');
}
