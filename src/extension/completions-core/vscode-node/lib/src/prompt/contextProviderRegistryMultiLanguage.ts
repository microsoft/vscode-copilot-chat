/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../context';
import { Features } from '../experiments/features';
import { logger } from '../logger';
import { ActiveExperiments } from './contextProviderRegistry';
import { TelemetryWithExp } from '../telemetry';

const MULTI_LANGUAGE_CONTEXT_PROVIDER_ID = 'fallbackContextProvider';

/**
 * Parameters for configuring the multi-language context provider.
 */
interface MultiLanguageContextProviderParams {
	/**
	 * The maximum number of context items to include in the multi-language context.
	 * This controls the number of relevant context entries that can be retrieved
	 * and processed by the provider.
	 */
	mlcpMaxContextItems: number;

	/**
	 * The maximum number of symbol matches to include in the multi-language context.
	 * This determines the upper limit on the number of symbol-based matches that
	 * can be considered by the provider.
	 */
	mlcpMaxSymbolMatches: number;

	/**
	 * Enable imports in the multi-language context provider.
	 * If set to true, the provider will include import statements in the context.
	 */
	mlcpEnableImports: boolean;
}

const multiLanguageContextProviderParamsDefault: MultiLanguageContextProviderParams = {
	mlcpMaxContextItems: 20,
	mlcpMaxSymbolMatches: 20,
	mlcpEnableImports: false,
};

export function fillInMultiLanguageActiveExperiments(
	ctx: Context,
	matchedContextProviders: string[],
	activeExperiments: ActiveExperiments,
	telemetryData: TelemetryWithExp
): void {
	if (
		(matchedContextProviders.length === 1 && matchedContextProviders[0] === '*') ||
		matchedContextProviders.includes(MULTI_LANGUAGE_CONTEXT_PROVIDER_ID)
	) {
		addActiveExperiments(ctx, activeExperiments, telemetryData);
	}
}

function addActiveExperiments(ctx: Context, activeExperiments: ActiveExperiments, telemetryData: TelemetryWithExp) {
	try {
		const params = getMultiLanguageContextProviderParamsFromExp(ctx, telemetryData);
		for (const [key, value] of Object.entries(params)) { activeExperiments.set(key, value as number); }
	} catch (e) {
		logger.exception(ctx, e, 'fillInMultiLanguageActiveExperiments');
	}
}

function getMultiLanguageContextProviderParamsFromExp(
	ctx: Context,
	telemetryData: TelemetryWithExp
): MultiLanguageContextProviderParams {
	let params = multiLanguageContextProviderParamsDefault;

	const multiLanguageContextProviderParams = ctx.get(Features).multiLanguageContextProviderParams(telemetryData);

	if (multiLanguageContextProviderParams) {
		try {
			params = JSON.parse(multiLanguageContextProviderParams) as MultiLanguageContextProviderParams;
		} catch (e) {
			logger.error(ctx, 'Failed to parse multiLanguageContextProviderParams', e);
		}
	}

	return params;
}
