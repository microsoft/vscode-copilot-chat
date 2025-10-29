/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_NUM_SNIPPETS } from '../../../prompt/src/prompt';
import { defaultSimilarFilesOptions, SimilarFilesOptions } from '../../../prompt/src/snippetInclusion/similarFiles';
import { ConfigKey, getConfig } from '../config';
import { ICompletionsContextService } from '../context';
import { TelemetryWithExp } from '../telemetry';
import { ExpTreatmentVariables } from './expConfig';
import { getCppNumberOfSnippets, getCppSimilarFilesOptions } from './similarFileOptionsProviderCpp';

type SimilarFilesOptionsProvider = (ctx: ICompletionsContextService, exp: TelemetryWithExp) => SimilarFilesOptions;
// Add here for more options for other language ids.
const languageSimilarFilesOptions: ReadonlyMap<string, SimilarFilesOptionsProvider> = new Map<
	string,
	SimilarFilesOptionsProvider
>([['cpp', getCppSimilarFilesOptions]]);

export function getSimilarFilesOptions(ctx: ICompletionsContextService, exp: TelemetryWithExp, langId: string): SimilarFilesOptions {
	const optionsProvider: SimilarFilesOptionsProvider | undefined = languageSimilarFilesOptions.get(langId);
	if (optionsProvider) {
		return optionsProvider(ctx, exp);
	} else {
		return {
			...defaultSimilarFilesOptions,
			useSubsetMatching: useSubsetMatching(ctx, exp),
		};
	}
}

type NumberOfSnippetsProvider = (exp: TelemetryWithExp) => number;
// Add here for more values for other language ids.
const numberOfSnippets: ReadonlyMap<string, NumberOfSnippetsProvider> = new Map<string, NumberOfSnippetsProvider>([
	['cpp', getCppNumberOfSnippets],
]);

export function getNumberOfSnippets(exp: TelemetryWithExp, langId: string): number {
	const provider: NumberOfSnippetsProvider | undefined = numberOfSnippets.get(langId);
	return provider ? provider(exp) : DEFAULT_NUM_SNIPPETS;
}

export function useSubsetMatching(ctx: ICompletionsContextService, telemetryWithExp: TelemetryWithExp): boolean {
	return (
		((telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.UseSubsetMatching] as boolean) ||
			getConfig(ctx, ConfigKey.UseSubsetMatching)) ??
		false
	);
}
