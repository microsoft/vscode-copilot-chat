/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { ICompletionsContextService } from '../context';
import { Features } from '../experiments/features';
import { logger, LogTarget } from '../logger';
import { TelemetryWithExp } from '../telemetry';
import { ActiveExperiments } from './contextProviderRegistry';

interface ContextProviderParams {
	[key: string]: string | number | boolean;
}

export function fillInCSharpActiveExperiments(
	accessor: ServicesAccessor,
	activeExperiments: ActiveExperiments,
	telemetryData: TelemetryWithExp
): boolean {
	const ctx = accessor.get(ICompletionsContextService);
	try {
		const features = ctx.get(Features);
		const csharpContextProviderParams = features.csharpContextProviderParams(telemetryData);
		if (csharpContextProviderParams) {
			const params = JSON.parse(csharpContextProviderParams) as ContextProviderParams;
			for (const [key, value] of Object.entries(params)) { activeExperiments.set(key, value); }
		} else {
			const params = features.getContextProviderExpSettings('csharp')?.params;
			if (params) {
				for (const [key, value] of Object.entries(params)) { activeExperiments.set(key, value); }
			}
		}
	} catch (e) {
		logger.debug(ctx.get(LogTarget), `Failed to get the active C# experiments for the Context Provider API`, e);
		return false;
	}
	return true;
}
