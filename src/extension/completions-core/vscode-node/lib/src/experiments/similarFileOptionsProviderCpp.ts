/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defaultCppSimilarFilesOptions, SimilarFilesOptions } from '../../../prompt/src/snippetInclusion/similarFiles';
import { ICompletionsContextService } from '../context';
import { TelemetryWithExp } from '../telemetry';
import { useSubsetMatching } from './similarFileOptionsProvider';

export function getCppSimilarFilesOptions(ctx: ICompletionsContextService, telemetryWithExp: TelemetryWithExp): SimilarFilesOptions {
	return {
		...defaultCppSimilarFilesOptions,
		useSubsetMatching: useSubsetMatching(ctx, telemetryWithExp),
	};
}

export function getCppNumberOfSnippets(telemetryWithExp: TelemetryWithExp): number {
	return defaultCppSimilarFilesOptions.maxTopSnippets;
}
