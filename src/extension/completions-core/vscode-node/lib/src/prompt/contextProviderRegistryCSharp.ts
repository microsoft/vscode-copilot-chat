/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../context';
import { Features } from '../experiments/features';
import { logger } from '../logger';
import { ActiveExperiments } from './contextProviderRegistry';
import { TelemetryWithExp } from '../telemetry';

interface ContextProviderParams {
	[key: string]: string | number | boolean;
}

export function fillInCSharpActiveExperiments(
	ctx: Context,
	activeExperiments: ActiveExperiments,
	telemetryData: TelemetryWithExp
): boolean {
	try {
		const csharpContextProviderParams = ctx.get(Features).csharpContextProviderParams(telemetryData);
		if (csharpContextProviderParams) {
			const params = JSON.parse(csharpContextProviderParams) as ContextProviderParams;
			for (const [key, value] of Object.entries(params)) { activeExperiments.set(key, value); }
		}
	} catch (e) {
		logger.debug(ctx, `Failed to get the active C# experiments for the Context Provider API`, e);
		return false;
	}
	return true;
}
