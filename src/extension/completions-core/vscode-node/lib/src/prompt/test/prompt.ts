/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createCompletionState } from '../../completionState';
import { Context } from '../../context';
import { getGhostText } from '../../ghostText/ghostText';
import { ContextProviderBridge } from '../components/contextProviderBridge';
import { extractPrompt, ExtractPromptOptions } from '../prompt';
import { TelemetryWithExp } from '../../telemetry';
import { IPosition, ITextDocument } from '../../textDocument';
import { CancellationToken } from 'vscode-languageserver-protocol';

export async function extractPromptInternal(
	ctx: Context,
	completionId: string,
	textDocument: ITextDocument,
	position: IPosition,
	telemetryWithExp: TelemetryWithExp,
	promptOpts: ExtractPromptOptions = {}
) {
	const completionState = createCompletionState(textDocument, position);
	ctx.get(ContextProviderBridge).schedule(completionState, completionId, 'opId', telemetryWithExp);
	return extractPrompt(ctx, completionId, completionState, telemetryWithExp, undefined, promptOpts);
}

export async function getGhostTextInternal(
	ctx: Context,
	textDocument: ITextDocument,
	position: IPosition,
	token?: CancellationToken
) {
	return getGhostText(ctx, createCompletionState(textDocument, position), token, { opportunityId: 'opId' });
}
