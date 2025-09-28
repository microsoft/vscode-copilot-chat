/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';


export async function makeGitHubAPIRequest(fetcherService: IFetcherService, logService: ILogService, telemetry: ITelemetryService, host: string, routeSlug: string, method: 'GET' | 'POST', token: string | undefined, body?: { [key: string]: any }) {
	const headers: any = {
		'Accept': 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};
	if (token) {
		headers['Authorization'] = `Bearer ${token}`;
	}

	const response = await fetcherService.fetch(`${host}/${routeSlug}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined
	});
	if (!response.ok) {
		return undefined;
	}

	try {
		const result = await response.json();
		const rateLimit = Number(response.headers.get('x-ratelimit-remaining'));
		const logMessage = `[RateLimit] REST rate limit remaining: ${rateLimit}, ${routeSlug}`;
		if (rateLimit < 1000) {
			// Danger zone
			logService.warn(logMessage);
			telemetry.sendMSFTTelemetryEvent('githubAPI.approachingRateLimit', { rateLimit: rateLimit.toString() });
		} else {
			logService.debug(logMessage);
		}
		return result;
	} catch {
		return undefined;
	}
}