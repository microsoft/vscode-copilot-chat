/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../context';
import { Features } from '../experiments/features';
import { logger } from '../logger';
import { ActiveExperiments } from './contextProviderRegistry';
import { TelemetryWithExp } from '../telemetry';

interface CppContextProviderParams {
	[key: string]: string | number | boolean;
}

const cppContextProviderParamsDefault: CppContextProviderParams = {
	maxSnippetLength: 3000,
	maxSnippetCount: 7,
	enabledFeatures: 'Deferred',
	timeBudgetMs: 7,
	doAggregateSnippets: true,
};

const VSCodeCppContextProviderId = 'ms-vscode.cpptools';

export function fillInCppVSCodeActiveExperiments(
	ctx: Context,
	matchedContextProviders: string[],
	activeExperiments: ActiveExperiments,
	telemetryData: TelemetryWithExp
): void {
	if (
		(matchedContextProviders.length === 1 && matchedContextProviders[0] === '*') ||
		matchedContextProviders.includes(VSCodeCppContextProviderId)
	) {
		addActiveExperiments(ctx, activeExperiments, telemetryData);
	}
}

function addActiveExperiments(ctx: Context, activeExperiments: ActiveExperiments, telemetryData: TelemetryWithExp) {
	try {
		let params = cppContextProviderParamsDefault;
		const cppContextProviderParams = ctx.get(Features).cppContextProviderParams(telemetryData);
		if (cppContextProviderParams) {
			try {
				params = JSON.parse(cppContextProviderParams) as CppContextProviderParams;
			} catch (e) {
				logger.error(ctx, 'Failed to parse cppContextProviderParams', e);
			}
		}
		for (const [key, value] of Object.entries(params)) { activeExperiments.set(key, value); }
	} catch (e) {
		logger.exception(ctx, e, 'fillInCppActiveExperiments');
	}
}
