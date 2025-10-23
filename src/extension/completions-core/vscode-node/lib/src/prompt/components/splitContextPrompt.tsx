/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** @jsxRuntime automatic */
/** @jsxImportSource ../../../../prompt/jsx-runtime/ */

import { Context } from '../../context';
import { Features } from '../../experiments/features';
import { CodeSnippets } from './codeSnippets';
import { AdditionalCompletionsContext, StableCompletionsContext } from './completionsContext';
import { DocumentPrefix, DocumentSuffix } from './currentFile';
import { DocumentMarker } from './marker';
import { RecentEdits } from './recentEdits';
import { SimilarFiles } from './similarFiles';
import { Traits } from './traits';
import { TelemetryWithExp } from '../../telemetry';

export function shouldUseSplitContextPrompt(ctx: Context, telemetry: TelemetryWithExp): boolean {
	return (
		ctx.get(Features).enablePromptContextProxyField(telemetry)
	);
}

/**
 * Function that returns the prompt structure for a code completion request following the split context prompt design
 * that optimizes for cache hits.
 */
export function splitContextCompletionsPrompt(ctx: Context) {
	return (
		<>
			<StableCompletionsContext>
				<DocumentMarker ctx={ctx} weight={0.7} />
				<Traits weight={0.6} />
				<CodeSnippets ctx={ctx} weight={0.9} />
				<SimilarFiles ctx={ctx} weight={0.8} />
			</StableCompletionsContext>
			<DocumentSuffix weight={1} />
			<AdditionalCompletionsContext>
				<RecentEdits ctx={ctx} weight={0.99} />
			</AdditionalCompletionsContext>
			<DocumentPrefix weight={1} />
		</>
	);
}
