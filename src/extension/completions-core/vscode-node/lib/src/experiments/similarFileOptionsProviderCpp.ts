/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../context';
import { useSubsetMatching } from './similarFileOptionsProvider';
import { TelemetryWithExp } from '../telemetry';
import { defaultCppSimilarFilesOptions, SimilarFilesOptions } from '../../../prompt/src/snippetInclusion/similarFiles';

export function getCppSimilarFilesOptions(ctx: Context, telemetryWithExp: TelemetryWithExp): SimilarFilesOptions {
	return {
		...defaultCppSimilarFilesOptions,
		useSubsetMatching: useSubsetMatching(ctx, telemetryWithExp),
	};
}

export function getCppNumberOfSnippets(telemetryWithExp: TelemetryWithExp): number {
	return defaultCppSimilarFilesOptions.maxTopSnippets;
}
